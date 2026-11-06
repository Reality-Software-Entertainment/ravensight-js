// The delivery contract (DELIVERY_CONTRACT.md in the platform repo): the
// shared vectors, the persisted queue, origin replay, the response table,
// backoff, gzip and request signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ravensight, {
  MemoryStorage,
  MAX_PERSISTED_EVENTS,
  GZIP_MIN_BYTES,
  queueKeyHash,
  signRequest,
  signedBeaconBody,
  eventDataBytes,
} from '../src/index.js';
import { startMockServer, fakeClock } from './helpers/mock-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'delivery-vectors.json'), 'utf8'));
const INGEST_KEY = 'gt_live_test_key';
const DAY = 86400 * 1000;

function makeClient(server, overrides = {}) {
  return new Ravensight(Object.assign({
    ingestKey: INGEST_KEY,
    apiUrl: server.url,
    gameVersion: '1.2.3',
    platform: 'test',
    autoFlushMs: 0,
    storage: new MemoryStorage(),
    random: () => 0.5,
  }, overrides));
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Expands the vectors' {repeat, count} values. */
function expand(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.repeat === 'string' && Number.isInteger(value.count)) return value.repeat.repeat(value.count);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

/** Waits out the flush init() starts when restored events are waiting. */
async function settle(rs) {
  while (rs._flushPromise) await rs._flushPromise;
}

const queueKey = 'ravensight_queue_' + queueKeyHash(INGEST_KEY);
const stored = (storage) => JSON.parse(storage.getItem(queueKey));

// --- Shared vectors -------------------------------------------------------------

test('every header signing vector', () => {
  const secret = VECTORS.signing.secret;
  for (const vector of VECTORS.signing.header) {
    assert.equal(signRequest(secret, vector.timestamp, vector.body), vector.header, vector.name);
  }
});

test('every beacon envelope vector', () => {
  const secret = VECTORS.signing.secret;
  for (const vector of VECTORS.signing.beacon) {
    const envelope = signedBeaconBody(vector.envelope.sessionToken, secret, vector.t, vector.inner);
    assert.deepEqual(envelope, vector.envelope, vector.name);
  }
});

test('every 8 KB event size vector, measured as the server measures it', () => {
  for (const vector of VECTORS.anyKeyEventSize.cases) {
    const data = expand(vector.data);
    const fits = eventDataBytes(data) <= 8192;
    assert.equal(fits, vector.expect === null, vector.name);
  }
});

test('the 8 KB vectors through track(): a 2,000 character stack of control characters is queued, not dropped', () => {
  for (const vector of VECTORS.anyKeyEventSize.cases) {
    const rs = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), autoFlushMs: 0, deviceId: 'd', fetch: async () => { throw new Error('offline'); } });
    const savedWarn = console.warn;
    console.warn = () => {};
    let queued;
    try {
      queued = rs.track('e', expand(vector.data));
    } finally {
      console.warn = savedWarn;
    }
    assert.equal(queued, vector.expect === null, vector.name);
  }
});

test('typed text vectors: the SDK cuts message to 200 and stack to 2,000, so an over-cap case conforms', () => {
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), autoFlushMs: 0, deviceId: 'd', fetch: async () => { throw new Error('offline'); } });
  for (const vector of VECTORS.publicKeyTypedText.cases) {
    const data = expand(vector.data);
    if (data.rs_kind !== 'error') continue;
    assert.equal(rs.trackError({ severity: data.rs_severity, message: data.rs_message, stack: data.rs_stack }), true, vector.name);
    const sent = rs.queue.at(-1).data;
    assert.ok(sent.rs_message.length <= 200, vector.name);
    if (sent.rs_stack !== undefined) assert.ok(sent.rs_stack.length <= 2000, vector.name);
  }
  const overCap = rs.queue.find((e) => e.data.rs_message === 'boom' && e.data.rs_stack && e.data.rs_stack.length === 2000);
  assert.ok(overCap, 'the 2,001 character stack was cut to 2,000');
});

test('queue file names are 64-bit FNV-1a of the key', () => {
  assert.equal(queueKeyHash(''), 'cbf29ce484222325');
  assert.equal(queueKeyHash('a'), 'af63dc4c8601ec8c');
  assert.equal(queueKeyHash('foobar'), '85944171f73967e8');
  assert.match(queueKeyHash(INGEST_KEY), /^[0-9a-f]{16}$/);
});

// --- The persisted queue ----------------------------------------------------------

test('Node: a file per key, written atomically, read back by the next launch and sent under the original origin', async (t) => {
  const dir = tempDir(t);
  const server = await startMockServer({ origins: true, batchStatus: 503 });
  t.after(() => server.close());

  const first = makeClient(server, { storage: undefined, queueDir: dir, deviceId: 'player-1', autoEvents: false });
  await first.init();
  first.track('pickup', { coin: 1 });
  first.track('pickup', { coin: 2 });
  await first.flush();
  await new Promise((r) => setImmediate(r));
  const file = join(dir, 'queue-' + queueKeyHash(INGEST_KEY) + '.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.version, 2);
  assert.equal(doc.groups.length, 1);
  assert.deepEqual(doc.groups[0].origin, { session: 'ses_1', build: '1.2.3', platform: 'test', stamp: 'o1.stamp1' });
  assert.equal(doc.groups[0].sessionToken, undefined, 'no session token at rest');
  assert.deepEqual(readdirSync(dir), ['queue-' + queueKeyHash(INGEST_KEY) + '.json'], 'no temporary file left behind');
  const ids = doc.groups[0].events.map((e) => e.data.rs_event_id);
  const times = doc.groups[0].events.map((e) => e.timestamp);
  // The process ends without dispose: a crash, a kill or a closed tab.

  server.state.batchStatus = null;
  const second = makeClient(server, { storage: undefined, queueDir: dir, deviceId: 'player-1', autoEvents: false });
  assert.equal(second.queue.length, 2, 'read back at start');
  assert.equal(second.stats.restored, 2);
  await second.init();
  await settle(second);
  const sent = server.state.batches.at(-1).events;
  assert.deepEqual(sent.map((e) => e.data.rs_event_id), ids, 'same ids');
  assert.deepEqual(sent.map((e) => e.timestamp), times, 'original times');
  for (const event of sent) {
    assert.deepEqual(event.origin, { session: 'ses_1', build: '1.2.3', platform: 'test', stamp: 'o1.stamp1' }, 'origin copied verbatim');
    assert.deepEqual(Object.keys(event).sort(), ['data', 'event', 'origin', 'timestamp']);
  }
  assert.equal(existsSync(file), false, 'an empty queue deletes the file');
  second.track('fresh');
  await second.flush();
  assert.equal(server.state.batches.at(-1).events[0].origin, undefined, "the current session's own events carry no origin");
  await second.dispose();
});

test('removal is stored on a 2xx, and only then', async (t) => {
  const server = await startMockServer({ batchOverrides: [{ status: 500 }] });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, autoEvents: false });
  await rs.init();
  rs.track('a');
  await new Promise((r) => setImmediate(r));
  assert.equal(stored(storage).groups[0].events.length, 1);
  await rs.flush();
  assert.equal(stored(storage).groups[0].events.length, 1, 'a 500 keeps it stored');
  await rs.flush();
  assert.equal(storage.getItem(queueKey), null, 'a 202 removes it');
  await rs.dispose();
});

test('a version 1 file, a malformed file and an unknown version', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const now = Date.now();
  const v1 = { version: 1, groups: [{ sessionToken: 'old', expiresAtMs: 1, events: [{ event: 'old', timestamp: Math.floor(now / 1000) - 60, data: { rs_event_id: 'x-1' } }] }] };
  for (const [text, expected] of [[JSON.stringify(v1), 1], ['{not json', 0], [JSON.stringify({ version: 3, groups: [] }), 0], ['[]', 0]]) {
    const storage = new MemoryStorage();
    storage.setItem(queueKey, text);
    const rs = makeClient(server, { storage, autoEvents: false });
    assert.equal(rs.queue.length, expected, text.slice(0, 20));
    if (expected) {
      assert.equal(rs.queue[0].origin, null, 'version 1 groups have no origin');
      assert.equal(rs.queue[0].timestamp, (Math.floor(now / 1000) - 60) * 1000, 'seconds read as milliseconds');
    }
    await rs.dispose({ flush: false });
  }
});

test('89 days and 500 events: older and oldest are dropped and counted', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const now = Date.now();
  const events = [];
  events.push({ event: 'ancient', timestamp: now - 90 * DAY, data: { rs_event_id: 'old' } });
  for (let i = 0; i < 510; i++) events.push({ event: 'e' + i, timestamp: now - 1000 + i, data: { rs_event_id: 'id-' + i } });
  const storage = new MemoryStorage();
  storage.setItem(queueKey, JSON.stringify({ version: 2, groups: [{ events }] }));
  const rs = makeClient(server, { storage, autoEvents: false, maxQueueSize: 1000 });
  assert.equal(rs.stats.expired, 1);
  assert.equal(rs.queue.length, MAX_PERSISTED_EVENTS);
  assert.equal(rs.queue[0].event, 'e10', 'the oldest went first');
  assert.equal(rs.stats.dropped, 10);
  await rs.dispose({ flush: false });
});

test('the queue is never written for an opt-in player before the yes, nor under persistQueue: false', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const optIn = makeClient(server, { storage, consent: 'opt_in' });
  optIn.track('nothing');
  await new Promise((r) => setImmediate(r));
  assert.equal(storage.getItem(queueKey), null);
  const off = makeClient(server, { storage, persistQueue: false });
  off.track('memory only');
  await new Promise((r) => setImmediate(r));
  assert.equal(storage.getItem(queueKey), null);
  await optIn.dispose({ flush: false });
  await off.dispose({ flush: false });
});

test('opting out removes the stored queue', async (t) => {
  const server = await startMockServer({ batchStatus: 503 });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  rs.track('a');
  await new Promise((r) => setImmediate(r));
  assert.ok(storage.getItem(queueKey));
  rs.setEnabled(false);
  assert.equal(storage.getItem(queueKey), null);
  await rs.dispose({ flush: false });
});

test('the origin stamp and the signing secret are never logged; the secret is never stored', async (t) => {
  const server = await startMockServer({ origins: true, signing: true, batchStatus: 503 });
  t.after(() => server.close());
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = original; });
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, debug: true });
  await rs.init();
  rs.track('a');
  await rs.flush();
  await new Promise((r) => setImmediate(r));
  assert.ok(storage.getItem(queueKey).includes('o1.stamp1'), 'the stamp is kept with the queue');
  assert.ok(!storage.getItem(queueKey).includes('secret_1'), 'the secret is memory only');
  assert.ok(!logs.some((line) => line.includes('o1.stamp') || line.includes('secret_')));
  await rs.dispose({ flush: false });
});

// --- Response table -----------------------------------------------------------

test('400 with an index drops that event only; any other 400 drops the request', async (t) => {
  const server = await startMockServer({
    batchOverrides: [
      { status: 400, body: { error: 'event_not_allowed', index: 1 } },
      { status: 202, body: { accepted: 2 } },
      { status: 400, body: { error: 'invalid_payload' } },
    ],
  });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('a');
  rs.track('b');
  rs.track('c');
  await rs.flush();
  const first = server.requestsTo('/api/v1/track/batch');
  assert.deepEqual(first[1].body.events.map((e) => e.event), ['a', 'c'], 'resent without the named event');
  assert.equal(rs.stats.dropped, 1);
  rs.track('d');
  rs.track('e');
  await rs.flush();
  assert.equal(rs.queue.length, 0);
  assert.equal(rs.stats.dropped, 3);
  await rs.dispose();
});

test('400 batch_too_large halves; a single event still too large is dropped', async (t) => {
  const server = await startMockServer({ maxBatchAccept: 0 });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('a');
  rs.track('b');
  await rs.flush();
  assert.deepEqual(server.requestsTo('/api/v1/track/batch').map((r) => r.body.events.length), [2, 1, 1]);
  assert.equal(rs.stats.dropped, 2);
  await rs.dispose();
});

test('401: a new session once, resent with the same ids; a second 401 in a row waits for the backoff', async (t) => {
  const unauthorized = { status: 401, body: { error: 'signature_invalid' } };
  const server = await startMockServer({ batchOverrides: [unauthorized, unauthorized] });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock, autoEvents: false });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(server.requestsTo('/api/v1/session').length, 2, 'one new session');
  assert.equal(rs.queue.length, 1, 'kept');
  assert.equal(rs.retryInMs, 7500, 'then the backoff');
  clock.advance(7501);
  await rs.flush();
  const batches = server.requestsTo('/api/v1/track/batch');
  assert.equal(batches.length, 3);
  assert.equal(new Set(batches.map((r) => r.body.events[0].data.rs_event_id)).size, 1, 'same id every time');
  assert.equal(rs.queue.length, 0);
  await rs.dispose();
});

test('403 keeps the events and stops sending until the next launch', async (t) => {
  const server = await startMockServer({ batchOverrides: [{ status: 403, body: { error: 'origin_refused' } }] });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, autoEvents: false });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(rs.queue.length, 1);
  assert.equal((await rs.flush()).skipped, 'refused');
  assert.equal(server.requestsTo('/api/v1/track/batch').length, 1);
  assert.ok(storage.getItem(queueKey), 'still stored');
  await rs.dispose({ flush: false });
  const next = makeClient(server, { storage, autoEvents: false });
  await next.init();
  await settle(next);
  assert.equal(server.state.events.length, 1, 'the next launch sends it');
  await next.dispose();
});

test('429 and 503 with Retry-After wait exactly that long; flush() never cuts it short, but cuts a backoff short', async (t) => {
  const server = await startMockServer({
    batchOverrides: [
      { status: 503, body: { error: 'busy' }, headers: { 'Retry-After': '7' } },
      { status: 500, body: { error: 'boom' } },
    ],
  });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock, random: () => 0, autoEvents: false });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(rs.retryInMs, 7000, 'exact, no jitter');
  assert.equal((await rs.flush()).skipped, 'retry_after');
  clock.advance(7000);
  await rs.flush();
  assert.equal(rs.retryInMs, 5000, 'a 500 backs off');
  const result = await rs.flush();
  assert.equal(result.sent, 1, 'an explicit flush cuts the backoff short');
  await rs.dispose();
});

test('a 503 without Retry-After is an ordinary backoff', async (t) => {
  const server = await startMockServer({ batchOverrides: [{ status: 503, body: { error: 'busy' } }] });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock, autoEvents: false });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(rs.retryInMs, 7500);
  await rs.dispose({ flush: false });
});

// --- gzip and signing -----------------------------------------------------------

test('a body of 1,024 bytes or more is gzip compressed; a smaller one is plain', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('small');
  await rs.flush();
  rs.track('big', { pad: 'x'.repeat(GZIP_MIN_BYTES) });
  await rs.flush();
  const [small, big] = server.requestsTo('/api/v1/track/batch');
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(big.headers['content-encoding'], 'gzip');
  assert.equal(big.body.events[0].event, 'big', 'the server decodes it');
  await rs.dispose();
});

test('415 resends uncompressed once', async (t) => {
  const server = await startMockServer({ batchOverrides: [{ status: 415, body: { error: 'unsupported_encoding' } }] });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('big', { pad: 'x'.repeat(2000) });
  await rs.flush();
  const [zipped, plain] = server.requestsTo('/api/v1/track/batch');
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(server.state.events.length, 1);
  await rs.dispose();
});

test('413 splits; a single event still refused is dropped', async (t) => {
  const tooLarge = { status: 413, body: { error: 'payload_too_large' } };
  const server = await startMockServer({ batchOverrides: [tooLarge, tooLarge] });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('a');
  rs.track('b');
  await rs.flush();
  assert.deepEqual(server.requestsTo('/api/v1/track/batch').map((r) => r.body.events.length), [2, 1, 1]);
  assert.equal(rs.stats.dropped, 1);
  assert.equal(server.state.events.length, 1);
  await rs.dispose();
});

test('a signing session signs every batch over the plain bytes, with the server clock offset', async (t) => {
  const server = await startMockServer({ signing: true });
  t.after(() => server.close());
  const skewMs = 1000 * 1000;
  const rs = makeClient(server, { now: () => Date.now() - skewMs, autoEvents: false });
  await rs.init();
  rs.track('small');
  await rs.flush();
  rs.track('big', { pad: 'y'.repeat(3000) });
  await rs.flush();
  for (const request of server.requestsTo('/api/v1/track/batch')) {
    const ts = Number(request.headers['x-ravensight-timestamp']);
    assert.ok(Math.abs(ts - Date.now() / 1000) < 5, 'device clock corrected to the server');
    assert.equal(request.headers['x-ravensight-signature'], signRequest('secret_1', ts, request.text));
  }
  assert.equal(server.requestsTo('/api/v1/track/batch')[1].headers['content-encoding'], 'gzip', 'signed text, then gzip');
  await rs.dispose();
});

test('an unsigned session sends no signature headers', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(server.requestsTo('/api/v1/track/batch')[0].headers['x-ravensight-signature'], undefined);
  await rs.dispose();
});

test('unload sends: keepalive signs in headers, a beacon carries the signed envelope, neither is compressed', async (t) => {
  const server = await startMockServer({ signing: true, origins: true });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('x', { pad: 'z'.repeat(2000) });
  const entry = rs._sessions.get(rs.deviceId);
  const keepalive = rs._buildUnloadRequest(rs.queue, entry.token, { hasFetchKeepalive: true }, entry);
  assert.equal(typeof keepalive.body, 'string', 'plain');
  const ts = Number(keepalive.headers['X-Ravensight-Timestamp']);
  assert.equal(keepalive.headers['X-Ravensight-Signature'], signRequest('secret_1', ts, keepalive.body));
  const beacon = rs._buildUnloadRequest(rs.queue, entry.token, { hasBeacon: true }, entry);
  const envelope = JSON.parse(beacon.body);
  assert.deepEqual(Object.keys(envelope).sort(), ['sessionToken', 'signed']);
  assert.equal(envelope.sessionToken, entry.token);
  assert.equal(envelope.signed.v, 1);
  assert.equal(signedBeaconBody(entry.token, 'secret_1', envelope.signed.t, envelope.signed.body).signed.sig, envelope.signed.sig);
  assert.equal(JSON.parse(envelope.signed.body).events[0].event, 'x');
  await rs.dispose({ flush: false });
});

test('an unload batch stays stored unconfirmed: a keepalive 2xx clears it, otherwise the next launch resends it within 23 hours', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, autoEvents: false, env: { hasFetchKeepalive: true } });
  await rs.init();
  rs.track('confirmed');
  assert.equal(rs.flushOnHidden(), true);
  assert.equal(rs.queue.length, 0, 'never resent by this page');
  assert.equal(stored(storage).groups[0].events[0].event, 'confirmed');
  assert.ok(stored(storage).groups[0].events[0].unconfirmedAt > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(storage.getItem(queueKey), null, 'the 2xx cleared it');
  await rs.dispose({ flush: false });

  const beaconStorage = new MemoryStorage();
  const sent = [];
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: (url, body) => sent.push(body) }, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true }));
  const clock = fakeClock();
  const page = makeClient(server, { storage: beaconStorage, autoEvents: false, env: { hasBeacon: true }, now: clock });
  await page.init();
  page.track('beaconed');
  assert.equal(page.flushOnHidden(), true);
  assert.equal(sent.length, 1);
  await page.dispose({ flush: false });

  const soon = makeClient(server, { storage: beaconStorage, autoEvents: false, now: () => clock() + 3600 * 1000 });
  assert.deepEqual(soon.queue.map((e) => e.event), ['beaconed'], 'resent within the duplicate window');
  await soon.dispose({ flush: false });
  const late = makeClient(server, { storage: beaconStorage, autoEvents: false, now: () => clock() + 24 * 3600 * 1000 });
  assert.deepEqual(late.queue, [], 'past 23 hours it is presumed delivered');
  await late.dispose({ flush: false });
});

// --- Error events queue behind gameplay ------------------------------------------

test('gameplay events queue ahead of error events, never inside a batch in flight', async (t) => {
  const server = await startMockServer({ batchDelayMs: 60 });
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false });
  await rs.init();
  rs.track('ev_0');
  rs.trackError({ severity: 'error', message: 'one' });
  rs.trackError({ severity: 'error', message: 'two' });
  rs.track('ev_1');
  assert.deepEqual(rs.queue.map((e) => e.event), ['ev_0', 'ev_1', 'error', 'error']);

  const flushing = rs.flush();
  await new Promise((r) => setTimeout(r, 20));
  rs.track('ev_2');
  assert.deepEqual(rs.queue.map((e) => e.event), ['ev_0', 'ev_1', 'error', 'error', 'ev_2'], 'the batch in flight is never reordered');
  await flushing;
  rs.trackError({ severity: 'error', message: 'three' });
  rs.track('ev_3');
  assert.deepEqual(rs.queue.map((e) => e.event), ['ev_3', 'error'], 'the flush sent ev_2 in its next batch');
  await rs.dispose({ flush: false });
});

test('a full queue evicts the oldest error first; an incoming error with none to evict is dropped', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { autoEvents: false, maxQueueSize: 3 });
  rs.track('a');
  rs.trackError({ severity: 'error', message: 'old' });
  rs.track('b');
  rs.track('c');
  assert.deepEqual(rs.queue.map((e) => e.data.rs_message || e.event), ['a', 'b', 'c'], 'the error went first');
  assert.equal(rs.trackError({ severity: 'error', message: 'new' }), false, 'no error to evict: the incoming one is dropped');
  rs.track('d');
  assert.deepEqual(rs.queue.map((e) => e.event), ['b', 'c', 'd'], 'with no error queued the oldest goes');
  assert.equal(rs.stats.dropped, 3);
  await rs.dispose({ flush: false });
});

test('restored error events still queue behind gameplay', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const first = makeClient(server, { storage, autoEvents: false });
  first.trackError({ severity: 'error', message: 'boom' });
  await first.dispose({ flush: false });
  const next = makeClient(server, { storage, autoEvents: false });
  next.track('play');
  assert.deepEqual(next.queue.map((e) => e.event), ['play', 'error']);
  await next.dispose({ flush: false });
});
