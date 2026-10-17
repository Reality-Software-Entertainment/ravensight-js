// Public builds: inert without a key, consent modes, distribution, a refused
// key ending the run, jitter, rs_event_id and the 8 KB event cap, plus the
// exact key set of every body the SDK sends.
import test from 'node:test';
import assert from 'node:assert/strict';

import Ravensight, { MemoryStorage, MAX_EVENT_BYTES } from '../src/index.js';
import { startMockServer, fakeClock } from './helpers/mock-server.js';

const INGEST_KEY = 'gt_live_test_key';
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
        random: () => 0.5,
      },
      overrides,
    ),
  );
}

/** Storage that records every write. */
function spyStorage(initial = {}, { removable = true } = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  const store = {
    writes,
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes.push(['set', k, String(v)]);
      map.set(k, String(v));
    },
  };
  if (removable) {
    store.removeItem = (k) => {
      writes.push(['remove', k]);
      map.delete(k);
    };
  }
  return store;
}

function spyFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    throw new Error('no network in this test');
  };
  fn.calls = calls;
  return fn;
}

function captureConsole(t, method) {
  const calls = [];
  const original = console[method];
  console[method] = (...args) => calls.push(args.join(' '));
  t.after(() => {
    console[method] = original;
  });
  return calls;
}

/** A fake window, document and localStorage that count listeners and writes. */
function withBrowser(t) {
  const listeners = new Map();
  const target = (name) => ({
    addEventListener(type, fn) {
      const key = name + ':' + type;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn) {
      const key = name + ':' + type;
      if (listeners.has(key)) listeners.get(key).delete(fn);
    },
  });
  const win = target('window');
  const doc = Object.assign(target('document'), { visibilityState: 'visible' });
  const local = spyStorage();
  const saved = {};
  for (const [k, v] of [['window', win], ['document', doc], ['localStorage', local]]) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  });
  return {
    local,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

const keys = (obj) => Object.keys(obj).sort();

// --- Inert without a key ----------------------------------------------------

test('no key: inert, no storage writes, no fetch, no timer, no listeners, one warning', async (t) => {
  const browser = withBrowser(t);
  const warnings = captureConsole(t, 'warn');
  const fetchSpy = spyFetch();
  const storage = spyStorage();

  for (const ingestKey of [undefined, null, '', '   ']) {
    const rs = new Ravensight({ ingestKey, fetch: fetchSpy, storage });
    assert.equal(rs.isEnabled(), false);
    assert.equal(rs.isActive, false);
    assert.equal(rs.deviceId, null, 'no device id is made');
    assert.deepEqual(rs.queue, [], 'no game_started');
    assert.deepEqual(await rs.init(), { trackingEnabled: false, sessionReady: false, reason: 'no_key' });
    assert.equal(rs._timer, null, 'no timer');
    assert.equal(rs.track('anything', { a: 1 }), false);
    assert.equal((await rs.flush()).skipped, 'inactive');
    await assert.rejects(rs.session(), (e) => e.code === 'no_key');
    await assert.rejects(rs.submitFeedback('hi'), (e) => e.code === 'no_key');
    await assert.rejects(rs.fetchSuggestions(), (e) => e.code === 'no_key');
    assert.deepEqual(await rs.joinSession('tok'), { joined: false, reason: 'no_key' });
    rs.setEnabled(false);
    rs.setEnabled(true);
    await rs.setDeviceId('player-1');
    await rs.resetDeviceId();
    assert.equal(rs.flushOnHidden(), false);
    assert.equal(rs.isEnabled(), false, 'setEnabled(true) does not start an inert client');
    assert.deepEqual(await rs.dispose(), { sent: 0, dropped: 0 });
  }

  assert.deepEqual(storage.writes, [], 'nothing written to the injected storage');
  assert.deepEqual(browser.local.writes, [], 'nothing written to localStorage, not even the probe');
  assert.equal(fetchSpy.calls.length, 0, 'no request');
  assert.equal(browser.listenerCount(), 0, 'no listener on window or document');
  assert.equal(warnings.length, 4, 'one warning per client');
  assert.ok(warnings[0].includes('no ingestKey') && warnings[0].includes('optional'));
});

test('no key with optional: true prints nothing; a missing fetch is fine while inert', (t) => {
  const warnings = captureConsole(t, 'warn');
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'fetch', savedFetch));
  const rs = new Ravensight({ optional: true });
  assert.equal(rs.isEnabled(), false);
  assert.equal(warnings.length, 0);
  assert.throws(() => new Ravensight({ ingestKey: INGEST_KEY }), TypeError, 'a keyed client still needs fetch');
});

test('a key and nothing else behaves as before: opt_out, no ravensight_optin, device id stored', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage();
  const rs = makeClient(server, { storage });
  assert.equal(rs.consent, 'opt_out');
  assert.equal(rs.distribution, null);
  assert.deepEqual(storage.writes, [['set', 'ravensight_device_id', rs.deviceId]]);
  const result = await rs.init();
  assert.deepEqual(result, { trackingEnabled: true, sessionReady: true, reason: null });
  assert.equal(rs.isEnabled(), true);
  rs.setEnabled(false);
  rs.setEnabled(true);
  assert.deepEqual(storage.writes, [['set', 'ravensight_device_id', rs.deviceId]], 'opt-out is not stored');
  await rs.dispose();
});

// --- Consent: opt_in ------------------------------------------------------------

test('opt_in before the yes: no device id, no storage writes, no request, events dropped', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const browser = withBrowser(t);
  const storage = spyStorage();
  const rs = makeClient(server, { consent: 'opt_in', storage, autoFlushMs: 60000 });

  assert.equal(rs.deviceId, null);
  assert.equal(rs.enabled, false);
  assert.equal(rs.isEnabled(), false);
  assert.deepEqual(rs.queue, [], 'no game_started before the yes');
  assert.equal(browser.listenerCount(), 0, 'no listeners before the yes');
  assert.deepEqual(await rs.init(), { trackingEnabled: false, sessionReady: false, reason: 'no_consent' });
  assert.equal(rs.track('dropped', { a: 1 }), false);
  assert.deepEqual(rs.queue, []);
  await assert.rejects(rs.session(), (e) => e.code === 'no_consent');
  await rs.setDeviceId('chosen-before-yes');
  rs.setEnabled(false);
  assert.equal(rs._timer, null);
  assert.deepEqual(storage.writes, [], 'nothing stored');
  assert.deepEqual(browser.local.writes, [], 'no probe write to localStorage either');
  assert.equal(server.state.requests.length, 0, 'nothing on the network');
  await rs.dispose();
});

test('opt_in: setEnabled(true) stores the yes, makes the device id and runs the earlier init()', async (t) => {
  const server = await startMockServer({ sessionDelayMs: 40 });
  t.after(() => server.close());
  const storage = spyStorage();
  const rs = makeClient(server, { consent: 'opt_in', storage });
  await rs.init();
  assert.equal(server.state.requests.length, 0);

  rs.setEnabled(true);
  assert.equal(storage.map.get('ravensight_optin'), '1');
  assert.ok(rs.deviceId && rs.deviceId.startsWith('dev_'));
  assert.equal(storage.map.get('ravensight_device_id'), rs.deviceId);
  // Tracked right after the yes, while the settings check and session run.
  assert.equal(rs.track('right_after_yes', { n: 1 }), true);
  assert.equal(rs.queue.length, 1);

  // A bridge calling init() too shares the run already going.
  const shared = rs.init();
  await shared;
  await waitFor(() => server.state.events.length === 1);
  assert.equal(server.requestsTo('/api/v1/settings').length, 1, 'one settings check');
  assert.equal(server.requestsTo('/api/v1/session').length, 1, 'one session');
  assert.equal(server.state.events[0].event, 'right_after_yes');
  assert.equal(rs.isEnabled(), true);
  await rs.dispose();
});

test('opt_in: the yes survives a reload; revoking keeps the device id; a new yes reuses it', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage();

  const first = makeClient(server, { consent: 'opt_in', storage });
  first.setTrackingEnabled(true);
  const id = first.deviceId;
  await first.dispose();

  const reloaded = makeClient(server, { consent: 'opt_in', storage });
  assert.equal(reloaded.enabled, true, 'the stored yes starts the next launch');
  assert.equal(reloaded.deviceId, id);
  assert.equal((await reloaded.init()).sessionReady, true);
  reloaded.track('kept');
  reloaded.setEnabled(false);
  assert.equal(reloaded.queue.length, 0, 'revoking drops the queue');
  assert.equal(storage.map.has('ravensight_optin'), false, 'the yes is removed');
  assert.equal(storage.map.get('ravensight_device_id'), id, 'the device id is kept');
  await reloaded.dispose();

  const afterNo = makeClient(server, { consent: 'opt_in', storage });
  assert.equal(afterNo.enabled, false);
  assert.equal(afterNo.deviceId, null);
  afterNo.setEnabled(true);
  assert.equal(afterNo.deviceId, id, 'the same install id comes back');
  await afterNo.dispose();
});

test('opt_in: a storage without removeItem records the no as 0, read as no', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage({}, { removable: false });
  const rs = makeClient(server, { consent: 'opt_in', storage });
  rs.setEnabled(true);
  rs.setEnabled(false);
  assert.equal(storage.map.get('ravensight_optin'), '0');
  const next = makeClient(server, { consent: 'opt_in', storage });
  assert.equal(next.enabled, false);
  await rs.dispose();
  await next.dispose();
});

test('opt_in: a device id set before the yes is stored at the yes', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage();
  const rs = makeClient(server, { consent: 'opt_in', storage });
  await rs.setDeviceId('player-7');
  assert.deepEqual(storage.writes, []);
  rs.setEnabled(true);
  assert.equal(rs.deviceId, 'player-7');
  assert.equal(storage.map.get('ravensight_device_id'), 'player-7');
  await rs.dispose();
});

test('opt_in with enabled: false stays off for the run even with a stored yes', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage({ ravensight_optin: '1', ravensight_device_id: 'dev_saved' });
  const rs = makeClient(server, { consent: 'opt_in', storage, enabled: false });
  assert.equal(rs.deviceId, 'dev_saved');
  assert.equal((await rs.init()).reason, 'disabled');
  assert.equal(server.state.requests.length, 0);
  await rs.dispose();
});

test('consent rejects an unknown mode', () => {
  assert.throws(() => new Ravensight({ ingestKey: INGEST_KEY, consent: 'optin', storage: new MemoryStorage() }), TypeError);
  assert.throws(() => new Ravensight({ ingestKey: INGEST_KEY, consent: true, storage: new MemoryStorage() }), TypeError);
});

test('opt_in under a playtest needs no yes and stores nothing', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const storage = spyStorage({ 'ravensight.playtest': 'pt_token' });
  const rs = makeClient(server, { consent: 'opt_in', storage });
  assert.equal(rs.isPlaytest, true);
  assert.equal(rs.enabled, true);
  assert.equal((await rs.init()).sessionReady, true);
  assert.deepEqual(storage.writes, []);
  await rs.dispose();
});

// --- distribution ----------------------------------------------------------------

test('distribution is sent on POST /session, and validated', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { distribution: 'web-itch' });
  await rs.init();
  assert.equal(server.requestsTo('/api/v1/session')[0].body.distribution, 'web-itch');
  await rs.dispose();

  const blank = makeClient(server, { distribution: '' });
  assert.equal(blank.distribution, null, 'an empty label is no label');
  assert.equal(makeClient(server, { distribution: 'x'.repeat(40) }).distribution.length, 40);
  for (const bad of ['x'.repeat(41), 'line\nbreak', 'tab\there', 'nul\u0000', 'del\u007f', 42, {}]) {
    assert.throws(() => makeClient(server, { distribution: bad }), TypeError, 'rejects ' + JSON.stringify(bad));
  }
});

// --- Jitter --------------------------------------------------------------------

test('backoff carries plus or minus 20 percent jitter; Retry-After stays exact', async (t) => {
  const cases = [
    [0, 8000],
    [0.5, 10000],
    [0.999999, 12000],
  ];
  for (const [r, expected] of cases) {
    const server = await startMockServer({ batchStatus: 503 });
    t.after(() => server.close());
    const clock = fakeClock();
    const rs = makeClient(server, { now: clock, random: () => r });
    await rs.init();
    rs.track('a');
    await rs.flush();
    assert.equal(rs.retryInMs, expected, 'random ' + r);
    await rs.dispose({ flush: false });
  }

  const server = await startMockServer({
    batchOverrides: [{ status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '2' } }],
  });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock, random: () => 0 });
  await rs.init();
  rs.track('a');
  await rs.flush();
  assert.equal(rs.retryInMs, 2000, 'Retry-After is honored as given');
  await rs.dispose({ flush: false });
});

test('a jittered wait never passes the 5 minute ceiling', async (t) => {
  const server = await startMockServer({ batchStatus: 503 });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock, random: () => 0.99 });
  await rs.init();
  rs.track('a');
  for (let i = 0; i < 8; i++) {
    clock.advance(rs.retryInMs + 1);
    await rs.flush();
    assert.ok(rs.retryInMs <= 300000, 'wait ' + rs.retryInMs);
  }
  assert.equal(rs.retryInMs, 300000);
  await rs.dispose({ flush: false });
});

// --- rs_event_id ----------------------------------------------------------------

test('every event carries a well formed rs_event_id in a copy of its data', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { deviceId: 'player:ünïcode@example' });
  const mine = { level: 3, rs_event_id: 'caller-value' };
  rs.track('a', mine);
  rs.track('b');
  rs.track('c', null);
  assert.deepEqual(mine, { level: 3, rs_event_id: 'caller-value' }, "the caller's object is untouched");

  const ids = rs.queue.map((e) => e.data.rs_event_id);
  assert.equal(new Set(ids).size, 3, 'unique');
  for (const id of ids) {
    assert.match(id, EVENT_ID);
    assert.ok(id.startsWith('player__n_code_e-'), 'device id prefix, unsafe characters replaced: ' + id);
  }
  const [prefix, start, nonce, counter] = ids[0].split('-');
  assert.equal(prefix.length, 16);
  assert.match(start, /^[0-9a-f]+$/);
  assert.match(nonce, /^[0-9a-f]{8}$/);
  assert.equal(counter, '1');
  assert.ok(ids.every((id) => id.split('-')[2] === nonce), 'one nonce per launch');
  assert.notEqual(ids[0], 'caller-value', 'the SDK owns rs_event_id');

  const other = makeClient(server, { deviceId: 'player:ünïcode@example' });
  other.track('a');
  assert.notEqual(other.queue[0].data.rs_event_id.split('-')[2], nonce, 'a new launch gets a new nonce');

  const dev = makeClient(server);
  dev.track('x');
  assert.ok(dev.queue[0].data.rs_event_id.startsWith(dev.deviceId.slice(0, 16) + '-'));
  await rs.dispose({ flush: false });
  await other.dispose({ flush: false });
  await dev.dispose({ flush: false });
});

test('a resend after a 5xx, a 401 and a 400 split carries the same ids', async (t) => {
  const server = await startMockServer({
    batchOverrides: [{ status: 503, body: { error: 'unavailable' } }],
  });
  t.after(() => server.close());
  const clock = fakeClock();
  const rs = makeClient(server, { now: clock });
  await rs.init();
  for (let i = 0; i < 4; i++) rs.track('e', { i });
  const queuedIds = rs.queue.map((e) => e.data.rs_event_id);

  await rs.flush();
  assert.equal(server.state.events.length, 0);
  server.expireSession();
  server.state.maxBatchAccept = 2;
  clock.advance(60000);
  await rs.flush();

  const batches = server.requestsTo('/api/v1/track/batch').map((r) => r.body.events.map((e) => e.data.rs_event_id));
  assert.ok(batches.length >= 4, 'failed, expired, split and accepted attempts: ' + batches.length);
  assert.deepEqual(batches[0], queuedIds, 'the failed attempt');
  for (const ids of batches) for (const id of ids) assert.ok(queuedIds.includes(id), 'never a new id on a resend');
  assert.deepEqual(server.state.events.map((e) => e.data.rs_event_id), queuedIds, 'delivered once each, same ids');
  await rs.dispose();
});

test("a joined session's events and the page hide flush carry rs_event_id too", async (t) => {
  const server = await startMockServer({ joinTokens: ['browser_tok'], joinSynthetic: false });
  t.after(() => server.close());
  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();
  const join = await rs.joinSession('browser_tok', { deviceId: 'p1' });
  assert.equal(join.joined, true);
  rs.track('server_side', { sku: 'gold' }, { deviceId: 'p1' });
  await rs.flush();
  assert.match(server.state.events[0].data.rs_event_id, EVENT_ID);
  assert.ok(server.state.events[0].data.rs_event_id.startsWith('p1-'));

  rs.track('near_exit');
  const queuedId = rs.queue[0].data.rs_event_id;
  assert.equal(rs.flushOnHidden(), true);
  await waitFor(() => server.state.events.length === 2);
  assert.equal(server.state.events[1].data.rs_event_id, queuedId);
  await rs.dispose();
});

// --- The 8 KB cap --------------------------------------------------------------

/** Data whose JSON, including rs_event_id, is exactly `bytes` long for this client. */
function dataOfSize(rs, bytes, fill = 'x') {
  const probe = { pad: '', rs_event_id: rs._nextEventId(rs.deviceId) };
  rs._eventCounter -= 1;
  const base = Buffer.byteLength(JSON.stringify(probe));
  const unit = Buffer.byteLength(fill);
  return { pad: fill.repeat(Math.floor((bytes - base) / unit)) };
}

test('event data over 8,192 bytes is dropped at track(), warned once, never sent', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const warnings = captureConsole(t, 'warn');
  const rs = makeClient(server, { deviceId: 'size-test-device' });
  assert.equal(MAX_EVENT_BYTES, 8192);
  await rs.init();

  const exact = dataOfSize(rs, MAX_EVENT_BYTES);
  assert.equal(rs.track('exact', exact), true, 'exactly 8,192 bytes is accepted');
  assert.equal(Buffer.byteLength(JSON.stringify(rs.queue[0].data)), MAX_EVENT_BYTES);

  const over = { pad: exact.pad + 'x' };
  assert.equal(rs.track('over', over), false);
  // Two-byte characters: under 8,192 characters but over 8,192 bytes.
  const wide = { pad: 'é'.repeat(4500) };
  assert.equal(rs.track('wide', wide), false);

  assert.equal(rs.stats.dropped, 2);
  assert.equal(rs.stats.lastError.code, 'event_too_large');
  assert.equal(warnings.length, 1, 'one warning for the run');
  assert.ok(warnings[0].includes('8192'));

  await rs.flush();
  assert.deepEqual(server.state.events.map((e) => e.event), ['exact']);
  await rs.dispose();
});

// --- Exact key sets of every outgoing body -------------------------------------

test('exact key sets: settings, session, batch, feedback, keepalive and beacon bodies', async (t) => {
  const server = await startMockServer({ joinTokens: ['jt'] });
  t.after(() => server.close());
  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();

  const settings = server.requestsTo('/api/v1/settings')[0];
  assert.equal(settings.method, 'GET');
  assert.equal(settings.body, null, 'GET /settings has no body');
  assert.equal(settings.headers['content-type'], undefined);

  const session = server.requestsTo('/api/v1/session')[0].body;
  assert.deepEqual(keys(session), ['deviceId', 'gameVersion', 'platform']);

  rs.track('a', { level: 1 });
  rs.track('b');
  await rs.flush();
  const batch = server.requestsTo('/api/v1/track/batch')[0].body;
  assert.deepEqual(keys(batch), ['events']);
  for (const event of batch.events) {
    assert.deepEqual(keys(event), ['data', 'event', 'timestamp']);
  }
  assert.deepEqual(keys(batch.events[0].data), ['level', 'rs_event_id']);
  assert.deepEqual(keys(batch.events[1].data), ['rs_event_id']);

  await rs.submitFeedback('plain');
  await rs.submitFeedback('full', 'bug', 3);
  const feedback = server.requestsTo('/api/v1/feedback').map((r) => keys(r.body));
  assert.deepEqual(feedback, [['message'], ['category', 'message', 'rating']]);

  rs.track('hidden');
  rs.flushOnHidden();
  await waitFor(() => server.requestsTo('/api/v1/track/batch').length === 2);
  const keepalive = server.requestsTo('/api/v1/track/batch')[1];
  assert.deepEqual(keys(keepalive.body), ['events']);
  assert.deepEqual(keys(keepalive.body.events[0]), ['data', 'event', 'timestamp']);

  const beacon = rs._buildUnloadRequest(rs.queue.concat([{ event: 'x', data: { rs_event_id: 'i' }, timestamp: 1, deviceId: 'd' }]), 'tok', {
    hasFetchKeepalive: false,
    hasBeacon: true,
  });
  assert.deepEqual(keys(JSON.parse(beacon.body)), ['events', 'sessionToken']);
  assert.deepEqual(keys(JSON.parse(beacon.body).events[0]), ['data', 'event', 'timestamp']);
  await rs.dispose();

  const full = makeClient(server, { distribution: 'native-release', deviceId: 'joined' });
  await full.joinSession('jt');
  const joinedSession = server.requestsTo('/api/v1/session').at(-1).body;
  assert.deepEqual(keys(joinedSession), ['deviceId', 'distribution', 'gameVersion', 'joinToken', 'platform']);
  await full.dispose();
});

// --- flushOnHidden ------------------------------------------------------------------

test('flushOnHidden() skips the batch in flight, with or without an offset', async (t) => {
  const server = await startMockServer({ batchDelayMs: 80 });
  t.after(() => server.close());
  const rs = makeClient(server, { env: { hasFetchKeepalive: true, hasBeacon: false } });
  await rs.init();
  rs.track('a');
  rs.track('b');
  const flushing = rs.flush();
  await waitFor(() => rs._inflightSize === 2);
  rs.track('c');
  // The bridge passes the in-flight count; 0 must not resend the in-flight batch.
  assert.equal(rs.flushOnHidden(0), true);
  assert.deepEqual(rs.queue.map((e) => e.event), ['a', 'b']);
  await flushing;
  await waitFor(() => server.state.events.length === 3);
  assert.deepEqual(server.state.events.map((e) => e.event).sort(), ['a', 'b', 'c'], 'each event once');

  rs.track('d');
  rs.track('e');
  assert.equal(rs.flushOnHidden(1), true, 'an explicit offset is honored');
  assert.deepEqual(rs.queue.map((e) => e.event), ['d']);
  await rs.dispose({ flush: false });

  const node = makeClient(server);
  await node.init();
  node.track('x');
  assert.equal(node.flushOnHidden(), false, 'there is no page to hide in Node');
  await node.dispose({ flush: false });
});
