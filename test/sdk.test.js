import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import Ravensight, {
  MemoryStorage,
  RavensightError,
  normalizeApiUrl,
  parseRetryAfterMs,
  chooseUnloadTransport,
  FEEDBACK_CATEGORIES,
  VERSION,
} from '../src/index.js';
import { startMockServer, fakeClock } from './helpers/mock-server.js';

const INGEST_KEY = 'gt_live_test_key';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function makeClient(server, overrides = {}) {
  return new Ravensight(
    Object.assign(
      {
        ingestKey: INGEST_KEY,
        apiUrl: server.url,
        gameVersion: '1.2.3',
        platform: 'test',
        autoFlushMs: 0,
        storage: new MemoryStorage(),
      },
      overrides,
    ),
  );
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

// --- Pure helpers ---------------------------------------------------------

test('normalizeApiUrl always yields a versioned base with no trailing slash', () => {
  assert.equal(normalizeApiUrl('https://api.ravensight.io'), 'https://api.ravensight.io/api/v1');
  assert.equal(normalizeApiUrl('https://api.ravensight.io/'), 'https://api.ravensight.io/api/v1');
  assert.equal(normalizeApiUrl('https://api.ravensight.io/api/v1'), 'https://api.ravensight.io/api/v1');
  assert.equal(normalizeApiUrl('https://api.ravensight.io/api/v1//'), 'https://api.ravensight.io/api/v1');
  assert.equal(normalizeApiUrl(undefined), 'https://api.ravensight.io/api/v1');
});

test('parseRetryAfterMs reads delta seconds and ignores junk', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs(' 30 '), 30000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(null), 0);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'), 0);
});

test('constructor rejects a missing ingest key', () => {
  assert.throws(() => new Ravensight({}), TypeError);
  assert.throws(() => new Ravensight({ ingestKey: '   ' }), TypeError);
});

// --- Init and the server kill switch --------------------------------------

test('init honors the server kill switch and stops tracking', async (t) => {
  const server = await startMockServer({ trackingEnabled: false });
  t.after(() => server.close());

  const rs = makeClient(server);
  rs.track('queued_before_init', { a: 1 });
  assert.equal(rs.queue.length, 1);

  const result = await rs.init();

  assert.equal(result.trackingEnabled, false);
  assert.equal(rs.isActive, false);
  assert.equal(rs.queue.length, 0, 'pending events are discarded when tracking is off');
  assert.equal(rs.track('after_init'), false);
  assert.equal(server.requestsTo('/api/v1/session').length, 0, 'no session is opened');

  await assert.rejects(() => rs.submitFeedback('hi'), (err) => err.code === 'tracking_disabled');
  rs.dispose();
});

test('init assumes tracking is enabled when settings are unreachable', async (t) => {
  const server = await startMockServer({ settingsStatus: 500 });
  t.after(() => server.close());

  const rs = makeClient(server);
  const result = await rs.init();

  assert.equal(result.trackingEnabled, true);
  assert.equal(result.sessionReady, true);
  assert.equal(server.requestsTo('/api/v1/session').length, 1);

  const sessionReq = server.requestsTo('/api/v1/session')[0];
  assert.equal(sessionReq.headers['x-api-key'], INGEST_KEY);
  assert.equal(sessionReq.body.gameVersion, '1.2.3');
  assert.equal(sessionReq.body.platform, 'test');
  assert.ok(sessionReq.body.deviceId, 'a device id is sent');
  rs.dispose();
});

// --- Batching -------------------------------------------------------------

test('events are batched at the 50 event server limit', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();

  for (let i = 0; i < 120; i++) rs.track('tick', { i });
  await rs.flush();
  await waitFor(() => server.state.events.length === 120);

  const batches = server.requestsTo('/api/v1/track/batch');
  assert.ok(batches.length >= 3, 'at least three batches were needed');
  for (const batch of batches) {
    assert.ok(batch.body.events.length <= 50, 'no batch exceeds the server limit');
    assert.equal(batch.headers['x-session-token'], server.state.tokens[server.state.tokens.length - 1]);
  }
  assert.equal(batches[0].body.events.length, 50, 'the first batch is a full 50');
  assert.equal(server.state.events.length, 120, 'every event is delivered exactly once');
  assert.equal(server.state.events[0].event, 'tick');
  assert.equal(server.state.events[0].data.i, 0);
  assert.equal(typeof server.state.events[0].timestamp, 'number');
  assert.ok(server.state.events[0].timestamp < 1e11, 'timestamps are unix seconds, not milliseconds');
  assert.equal(rs.queue.length, 0);
  rs.dispose();
});

// --- 401 re-session -------------------------------------------------------

test('a 401 on track re creates the session and re sends the queued events', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  assert.equal(server.state.tokens.length, 1);

  rs.track('a');
  rs.track('b');
  rs.track('c');

  // Rotate the accepted token behind the SDK's back so the next batch 401s.
  server.expireSession();

  const result = await rs.flush();

  assert.equal(result.sent, 3, 'nothing was lost across the re authentication');
  assert.equal(rs.queue.length, 0);
  assert.equal(server.requestsTo('/api/v1/session').length, 2, 'a second session was opened');
  assert.equal(server.state.events.length, 3);
  assert.deepEqual(
    server.state.events.map((e) => e.event),
    ['a', 'b', 'c'],
  );
  rs.dispose();
});

// --- 429 ------------------------------------------------------------------

test('a 429 honors Retry-After and never drops the queued events', async (t) => {
  const server = await startMockServer({
    batchOverrides: [{ status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '2' } }],
  });
  t.after(() => server.close());

  const clock = fakeClock();
  const rs = makeClient(server, { now: clock });
  await rs.init();

  rs.track('a');
  rs.track('b');

  const first = await rs.flush();
  assert.equal(first.sent, 0);
  assert.equal(rs.queue.length, 2, 'events stay queued through a rate limit');
  assert.equal(rs.retryInMs, 2000, 'Retry-After of 2 seconds is honored exactly');

  const attemptsAfterFirst = server.requestsTo('/api/v1/track/batch').length;
  const blocked = await rs.flush();
  assert.equal(blocked.skipped, 'backoff');
  assert.equal(
    server.requestsTo('/api/v1/track/batch').length,
    attemptsAfterFirst,
    'no request is made inside the Retry-After window',
  );

  clock.advance(2001);
  const second = await rs.flush();
  assert.equal(second.sent, 2);
  assert.equal(server.state.events.length, 2);
  assert.equal(rs.retryInMs, 0, 'backoff is cleared after a success');
  rs.dispose();
});

test('a 429 without Retry-After falls back to exponential backoff', async (t) => {
  const server = await startMockServer({
    batchOverrides: [
      { status: 429, body: { error: 'rate_limited' } },
      { status: 429, body: { error: 'rate_limited' } },
    ],
  });
  t.after(() => server.close());

  const clock = fakeClock();
  const rs = makeClient(server, { now: clock });
  await rs.init();
  rs.track('a');

  await rs.flush();
  assert.equal(rs.retryInMs, 10000, 'first backoff is the 10 second floor');

  clock.advance(10001);
  await rs.flush();
  assert.equal(rs.retryInMs, 20000, 'backoff doubles');
  assert.equal(rs.queue.length, 1);
  rs.dispose();
});

// --- 400 oversize ---------------------------------------------------------

test('a 400 oversize response splits the batch until it is accepted', async (t) => {
  const server = await startMockServer({ maxBatchAccept: 10 });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();

  for (let i = 0; i < 30; i++) rs.track('big', { i });
  await rs.flush();

  const batches = server.requestsTo('/api/v1/track/batch');
  const sizes = batches.map((b) => b.body.events.length);
  assert.ok(sizes.includes(30) || sizes.includes(50), 'the first attempt used the full batch');
  assert.ok(
    sizes.some((n) => n <= 10),
    'the batch was split down to an accepted size',
  );
  assert.equal(server.state.events.length, 30, 'every event still arrived');
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.stats.dropped, 0, 'splitting never drops events');
  rs.dispose();
});

test('an event the server always rejects with 400 is dropped so the queue unblocks', async (t) => {
  const server = await startMockServer({ maxBatchAccept: 0 });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();

  rs.track('poison_a');
  rs.track('poison_b');
  await rs.flush();

  assert.equal(rs.queue.length, 0, 'the queue is not blocked forever');
  assert.equal(rs.stats.dropped, 2);
  assert.equal(rs.retryInMs, 0, 'a rejected single event is not treated as a network outage');
  rs.dispose();
});

// --- Queue cap ------------------------------------------------------------

test('the offline queue caps at maxQueueSize and drops the oldest events', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server, { maxQueueSize: 5 });
  // No init, so nothing is ever sent. This is the offline path.
  for (let i = 0; i < 8; i++) rs.track('e', { i });

  assert.equal(rs.queue.length, 5);
  assert.deepEqual(
    rs.queue.map((e) => e.data.i),
    [3, 4, 5, 6, 7],
    'the newest events survive, the oldest are dropped',
  );
  assert.equal(rs.stats.dropped, 3);
  await rs.dispose({ flush: false });
});

test('the default queue cap is 500', () => {
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), autoFlushMs: 0 });
  assert.equal(rs.maxQueueSize, 500);
  rs.dispose();
});

// --- Page unload ----------------------------------------------------------

test('the unload request prefers fetch keepalive so the session header survives', () => {
  const rs = new Ravensight({
    ingestKey: INGEST_KEY,
    apiUrl: 'https://api.ravensight.io',
    storage: new MemoryStorage(),
    autoFlushMs: 0,
  });

  assert.equal(chooseUnloadTransport({ hasFetchKeepalive: true, hasBeacon: true }), 'fetch-keepalive');
  assert.equal(chooseUnloadTransport({ hasFetchKeepalive: false, hasBeacon: true }), 'beacon');
  assert.equal(chooseUnloadTransport({ hasFetchKeepalive: false, hasBeacon: false }), 'none');

  const events = [{ event: 'x', data: {}, timestamp: 1 }];

  const keepalive = rs._buildUnloadRequest(events, 'tok_1', { hasFetchKeepalive: true, hasBeacon: true });
  assert.equal(keepalive.transport, 'fetch-keepalive');
  assert.equal(keepalive.url, 'https://api.ravensight.io/api/v1/track/batch');
  assert.equal(keepalive.headers['X-Session-Token'], 'tok_1');
  assert.deepEqual(JSON.parse(keepalive.body).events, events);

  const beacon = rs._buildUnloadRequest(events, 'tok/1', { hasFetchKeepalive: false, hasBeacon: true });
  assert.equal(beacon.transport, 'beacon');
  assert.equal(beacon.headers, null, 'sendBeacon cannot carry headers');
  assert.ok(beacon.url.endsWith('/track/batch'), 'the URL stays clean, no token in it');
  const beaconBody = JSON.parse(beacon.body);
  assert.equal(beaconBody.sessionToken, 'tok/1', 'the token rides inside the JSON body');

  const none = rs._buildUnloadRequest(events, 'tok_1', { hasFetchKeepalive: false, hasBeacon: false });
  assert.equal(none.transport, 'none');
  rs.dispose();
});

test('the hidden page flush sends one batch and clears it from the queue', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();

  rs.track('near_exit_a');
  rs.track('near_exit_b');

  assert.equal(rs._flushOnHidden(), true);
  assert.equal(rs.queue.length, 0);
  await waitFor(() => server.state.events.length === 2);
  assert.deepEqual(
    server.state.events.map((e) => e.event),
    ['near_exit_a', 'near_exit_b'],
  );

  assert.equal(rs._flushOnHidden(), false, 'an empty queue is a no op');
  rs.dispose();
});

// --- Feedback and suggestions --------------------------------------------

test('submitFeedback posts to /feedback with the session token', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();

  const result = await rs.submitFeedback('the boss fight is too long', 'suggestion', 4);
  assert.deepEqual(result, { ok: true });
  assert.equal(server.state.feedback.length, 1);
  assert.deepEqual(server.state.feedback[0], {
    message: 'the boss fight is too long',
    category: 'suggestion',
    rating: 4,
  });

  const req = server.requestsTo('/api/v1/feedback')[0];
  assert.equal(req.headers['x-session-token'], server.state.tokens[0]);

  await assert.rejects(() => rs.submitFeedback('  '), (err) => err.code === 'empty_message');

  // A 401 on feedback also re authenticates rather than failing outright.
  server.expireSession();
  await rs.submitFeedback('second note');
  assert.equal(server.state.feedback.length, 2);
  rs.dispose();
});

test('fetchSuggestions uses the ingest key and returns the array', async (t) => {
  const server = await startMockServer({ suggestions: [{ id: 1, title: 'Shorten level 3' }] });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();

  const suggestions = await rs.fetchSuggestions();
  assert.deepEqual(suggestions, [{ id: 1, title: 'Shorten level 3' }]);
  assert.equal(server.requestsTo('/api/v1/agent/suggestions')[0].headers['x-api-key'], INGEST_KEY);

  const bad = makeClient(server, { ingestKey: 'not_a_live_key' });
  await assert.rejects(() => bad.fetchSuggestions(), RavensightError);
  rs.dispose();
  bad.dispose();
});

// --- Local opt out and disposal ------------------------------------------

test('setEnabled(false) is a real opt out: queue cleared, nothing sent', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  rs.track('b');

  rs.setEnabled(false);
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.isActive, false);
  assert.equal(rs.track('c'), false);
  assert.deepEqual(await rs.flush(), { sent: 0, queued: 0, skipped: 'inactive' });
  assert.equal(server.state.events.length, 0);

  rs.setEnabled(true);
  assert.equal(rs.track('d'), true);
  await rs.flush();
  assert.deepEqual(
    server.state.events.map((e) => e.event),
    ['d'],
  );

  rs.dispose();
  assert.equal(rs.isActive, false);
  assert.equal(rs.track('after_dispose'), false);
});

test('the device id persists across clients through the injected storage', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const storage = new MemoryStorage();
  const first = makeClient(server, { storage });
  const second = makeClient(server, { storage });
  assert.equal(first.deviceId, second.deviceId);
  assert.ok(first.deviceId.startsWith('dev_'));
  first.dispose();
  second.dispose();
});

// --- Dual build -----------------------------------------------------------

test('the generated CommonJS build exposes the same surface', () => {
  const require = createRequire(import.meta.url);
  const cjs = require(join(ROOT, 'dist', 'index.cjs'));

  assert.equal(typeof cjs, 'function', 'the module itself is the Ravensight class');
  assert.equal(cjs.name, 'Ravensight');
  assert.equal(cjs.Ravensight, cjs);
  assert.equal(cjs.default, cjs);
  assert.equal(cjs.VERSION, PKG.version, 'VERSION tracks package.json');
  assert.deepEqual(cjs.FEEDBACK_CATEGORIES, ['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);
  assert.ok(Object.isFrozen(cjs.FEEDBACK_CATEGORIES));
  assert.equal(typeof cjs.Ravensight.prototype.setDeviceId, 'function');
  assert.equal(typeof cjs.Ravensight.prototype.resetDeviceId, 'function');
  assert.equal(cjs.MAX_BATCH_SIZE, 50);
  assert.equal(typeof cjs.MemoryStorage, 'function');
  assert.equal(typeof cjs.RavensightError, 'function');
  assert.equal(cjs.normalizeApiUrl('https://x.test'), 'https://x.test/api/v1');

  const rs = new cjs({ ingestKey: INGEST_KEY, storage: new cjs.MemoryStorage(), autoFlushMs: 0 });
  assert.equal(rs.apiUrl, 'https://api.ravensight.io/api/v1');
  rs.dispose();
});

test('the ESM VERSION matches package.json', () => {
  assert.equal(VERSION, PKG.version);
});

// --- Feedback validation --------------------------------------------------

test('FEEDBACK_CATEGORIES is the six server values, frozen', () => {
  assert.deepEqual(FEEDBACK_CATEGORIES, ['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);
  assert.ok(Object.isFrozen(FEEDBACK_CATEGORIES));
});

test('submitFeedback rejects an unknown category or a bad rating before any request', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  const before = server.state.requests.length;

  for (const category of ['balance', 'BUG', 7]) {
    await assert.rejects(
      () => rs.submitFeedback('note', category),
      (err) => err instanceof RavensightError && err.code === 'invalid_category',
      'category ' + JSON.stringify(category),
    );
  }
  for (const rating of [0, 6, 3.5, '4', NaN, -1]) {
    await assert.rejects(
      () => rs.submitFeedback('note', 'bug', rating),
      (err) => err instanceof RavensightError && err.code === 'invalid_rating',
      'rating ' + JSON.stringify(rating),
    );
  }
  assert.equal(server.state.requests.length, before, 'no request was made for invalid input');

  for (const category of FEEDBACK_CATEGORIES) {
    await rs.submitFeedback('note', category, 5);
  }
  await rs.submitFeedback('no category or rating');
  await rs.submitFeedback('rating only', undefined, 1);
  assert.deepEqual(server.state.feedback.at(-1), { message: 'rating only', rating: 1 });
  // An empty string means "not given" for both, and is left out of the payload.
  await rs.submitFeedback('empty category', '', 2);
  assert.deepEqual(server.state.feedback.at(-1), { message: 'empty category', rating: 2 });
  await rs.submitFeedback('empty rating', 'bug', '');
  assert.deepEqual(server.state.feedback.at(-1), { message: 'empty rating', category: 'bug' });
  await rs.submitFeedback('null both', null, null);
  assert.deepEqual(server.state.feedback.at(-1), { message: 'null both' });
  assert.equal(server.state.feedback.length, FEEDBACK_CATEGORIES.length + 5);
  await rs.dispose();
});

// --- dispose --------------------------------------------------------------

test('dispose flushes the queue by default and the server receives the events', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  rs.track('b');
  rs.track('c');

  const pending = rs.dispose();
  assert.equal(rs.track('during_dispose'), false, 'track is refused as soon as dispose starts');
  assert.equal(rs.isActive, false);

  const result = await pending;
  assert.deepEqual(result, { sent: 3, dropped: 0 });
  assert.deepEqual(
    server.state.events.map((e) => e.event),
    ['a', 'b', 'c'],
  );
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.sessionToken, null, 'the token is dropped');
  assert.equal(rs.track('after_dispose'), false);
  assert.deepEqual(await rs.dispose(), { sent: 0, dropped: 0 }, 'a second dispose is a no op');
});

test('dispose({ flush: false }) sends nothing and counts the queue as dropped', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  rs.track('b');

  const result = await rs.dispose({ flush: false });
  assert.deepEqual(result, { sent: 0, dropped: 2 });
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 0);
  assert.equal(server.state.events.length, 0);
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.stats.dropped, 2);
});

test('dispose against a failing server reports the drop', async (t) => {
  const server = await startMockServer({ batchStatus: 503 });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  rs.track('b');

  const result = await rs.dispose();
  assert.deepEqual(result, { sent: 0, dropped: 2 });
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 1, 'one attempt, no retry loop');
  assert.equal(rs.stats.dropped, 2);
});

test('dispose against a hung server resolves within the timeout', async (t) => {
  const server = await startMockServer({ batchDelayMs: 5000 });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  rs.track('b');
  rs.track('c');

  const started = Date.now();
  const result = await rs.dispose({ timeoutMs: 150 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, 'resolved in ' + elapsed + 'ms, not after the server answered');
  assert.deepEqual(result, { sent: 0, dropped: 3 });
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.stats.dropped, 3);
});

test('dispose waits for a flush already in flight before giving up', async (t) => {
  const server = await startMockServer({ batchDelayMs: 100 });
  t.after(() => server.close());

  const rs = makeClient(server);
  await rs.init();
  rs.track('a');
  const inflight = rs.flush();
  rs.track('b');

  const result = await rs.dispose();
  await inflight;
  assert.equal(result.dropped, 0);
  assert.deepEqual(
    server.state.events.map((e) => e.event),
    ['a', 'b'],
  );
});

test('dispose in a browser never re sends the batch a timed out flush still has in flight', async (t) => {
  const server = await startMockServer({ batchDelayMs: 300 });
  t.after(() => server.close());

  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();
  // The 50th track starts a flush of the first 50, which hangs for 300ms.
  for (let i = 0; i < 70; i++) rs.track('e', { i });

  const result = await rs.dispose({ timeoutMs: 50 });
  assert.deepEqual(
    result,
    { sent: 20, dropped: 50 },
    'the unload request carried only the 20 beyond the in flight batch, whose outcome is unknown',
  );
  assert.equal(rs.stats.dropped, 50);

  // Both requests land late. Every event arrives exactly once.
  await waitFor(() => server.state.events.length >= 70);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const seen = server.state.events.map((e) => e.data.i).sort((x, y) => x - y);
  assert.deepEqual(seen, Array.from({ length: 70 }, (_, i) => i), 'no duplicates');
  const sizes = server.requestsTo('/api/v1/track/batch').map((r) => r.body.events.length).sort((x, y) => x - y);
  assert.deepEqual(sizes, [20, 50]);
});

test('dispose in a browser skips the unload request when the hung batch covers the queue', async (t) => {
  const server = await startMockServer({ batchDelayMs: 300 });
  t.after(() => server.close());

  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();
  rs.track('a');
  rs.track('b');

  const result = await rs.dispose({ timeoutMs: 50 });
  assert.deepEqual(result, { sent: 0, dropped: 2 }, 'a request that timed out counts as dropped');

  await waitFor(() => server.state.events.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(server.state.events.map((e) => e.event), ['a', 'b'], 'sent once, never twice');
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 1);
});

test('a session that opens after dispose timed out is never used', async (t) => {
  const server = await startMockServer({ sessionDelayMs: 200 });
  t.after(() => server.close());

  const rs = makeClient(server);
  rs.track('a');

  const result = await rs.dispose({ timeoutMs: 50 });
  assert.deepEqual(result, { sent: 0, dropped: 1 });

  await waitFor(() => server.state.tokens.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rs.sessionToken, null, 'the late session is not stored');
  assert.equal(rs.stats.sessions, 0);
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 0, 'no stray batch request');
});

// --- Device id ------------------------------------------------------------

test('setDeviceId flushes under the old session, then the next session carries the new id', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  const oldId = rs.deviceId;
  const oldToken = server.state.tokens[0];

  rs.track('before_switch_a');
  rs.track('before_switch_b');

  await rs.setDeviceId('player_42');

  const firstBatches = server.requestsTo('/api/v1/track/batch');
  assert.equal(firstBatches.length, 1);
  assert.equal(firstBatches[0].headers['x-session-token'], oldToken, 'earlier events used the old token');
  assert.deepEqual(
    firstBatches[0].body.events.map((e) => e.event),
    ['before_switch_a', 'before_switch_b'],
  );
  assert.equal(rs.deviceId, 'player_42');
  assert.equal(rs.sessionToken, null, 'the old session is invalidated');
  assert.equal(storage.getItem('ravensight_device_id'), 'player_42', 'the id is persisted');
  assert.equal(server.requestsTo('/api/v1/session').length, 1, 'the new session opens lazily');

  rs.track('after_switch');
  await rs.flush();

  const sessions = server.requestsTo('/api/v1/session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].body.deviceId, oldId);
  assert.equal(sessions[1].body.deviceId, 'player_42');
  const last = server.requestsTo('/api/v1/track/batch').at(-1);
  assert.equal(last.headers['x-session-token'], server.state.tokens[1]);
  assert.deepEqual(last.body.events.map((e) => e.event), ['after_switch']);

  const second = makeClient(server, { storage });
  assert.equal(second.deviceId, 'player_42', 'a second client on the same storage picks it up');

  await rs.dispose();
  await second.dispose();
});

test('setDeviceId validates, and an unchanged id is a no op', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const rs = makeClient(server, { deviceId: 'same' });
  await rs.init();

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    await assert.rejects(() => rs.setDeviceId(bad), TypeError, 'rejects ' + String(bad));
  }

  const token = rs.sessionToken;
  rs.track('x');
  await rs.setDeviceId('same');
  assert.equal(rs.sessionToken, token, 'the session is kept');
  assert.equal(rs.queue.length, 1, 'nothing was flushed');
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 0);
  await rs.dispose({ flush: false });
});

test('setDeviceId waits for a session already opening under the old id', async (t) => {
  const server = await startMockServer({ sessionDelayMs: 50 });
  t.after(() => server.close());

  const rs = makeClient(server, { deviceId: 'old' });
  const opening = rs._ensureSession();
  await rs.setDeviceId('new');
  await opening;

  rs.track('x');
  await rs.flush();

  const sessions = server.requestsTo('/api/v1/session').map((r) => r.body.deviceId);
  assert.deepEqual(sessions, ['old', 'new'], 'the event opened a session for the new id');
  const batch = server.requestsTo('/api/v1/track/batch').at(-1);
  assert.equal(batch.headers['x-session-token'], server.state.tokens[1]);
  assert.equal(rs.deviceId, 'new');
  await rs.dispose();
});

test('setDeviceId on a disposed client throws and stores nothing', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  const before = rs.deviceId;
  await rs.dispose();
  await assert.rejects(() => rs.setDeviceId('late'), (err) => err instanceof RavensightError && err.code === 'disposed');
  assert.equal(rs.deviceId, before);
  assert.equal(storage.getItem('ravensight_device_id'), before);
});

test('resetDeviceId switches to a fresh random id', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());

  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  const oldId = rs.deviceId;

  const next = await rs.resetDeviceId();
  assert.equal(next, rs.deviceId);
  assert.notEqual(next, oldId);
  assert.ok(next.startsWith('dev_'));
  assert.equal(storage.getItem('ravensight_device_id'), next);
  assert.equal(rs.sessionToken, null);
  await rs.dispose();
});
