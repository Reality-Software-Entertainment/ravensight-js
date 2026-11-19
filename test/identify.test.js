import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import Ravensight, { MemoryStorage } from '../src/index.js';
import { startMockServer } from './helpers/mock-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'identify-vectors.json'), 'utf8'));
const SALT = VECTORS.salt;
const SEQ = VECTORS.sequence;
const U1 = SEQ[1].expect.stored.accountHash;
const INGEST_KEY = 'gt_live_test_key';
const IDENTITY_KEY = 'ravensight_identity';

function makeClient(server, overrides = {}) {
  return new Ravensight(
    Object.assign(
      {
        ingestKey: INGEST_KEY,
        apiUrl: server.url,
        gameVersion: '1.2.3',
        platform: 'test',
        autoFlushMs: 0,
        autoEvents: false,
        captureErrors: false,
        storage: new MemoryStorage(),
        random: () => 0.5,
      },
      overrides,
    ),
  );
}

function saltedServer(config = {}) {
  return startMockServer(Object.assign({ identifySalt: SALT }, config));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

/** Lets any request the SDK started settle, so "nothing was sent" is a real check. */
async function settle(ms = 60) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stored(storage) {
  const raw = storage.getItem(IDENTITY_KEY);
  return raw == null ? null : JSON.parse(raw);
}

/** The session label (S1, S2, ...) the mock server gave a token, in the order it issued them. */
function label(server, token) {
  const index = server.state.tokens.indexOf(token);
  return index < 0 ? null : 'S' + (index + 1);
}

function sends(server, from = 0) {
  return server.state.identifies
    .slice(from)
    .map((r) => ({ session: label(server, r.token), accountHash: r.body && r.body.accountHash }));
}

const refusedAs = (reason) => (err) => err instanceof TypeError && err.code === reason;

/** Forces the next session: the server forgets the token, the next batch 401s and the SDK opens a new one. */
async function nextSession(server, rs) {
  server.expireSession();
  rs.track('tick');
  await rs.flush();
}

// --- Conformance 1: every accept vector hashes to its wire -----------------

test('every accept vector, with the file salt, is sent as its wire and stored with the salt', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  for (const vector of VECTORS.accept) {
    const storage = new MemoryStorage();
    const rs = makeClient(server, { storage });
    await rs.init();
    const before = server.state.identifies.length;
    await rs.identify(vector.accountId);
    await waitFor(() => server.state.identifies.length === before + 1);
    assert.equal(server.state.identifies[before].body.accountHash, vector.wire, vector.note);
    assert.deepEqual(stored(storage), { salt: SALT, accountHash: vector.wire }, vector.note);
    assert.equal(rs.isIdentified, true);
    await rs.dispose();
  }
});

test('salts_differ: one account under two salts gives the two wires', async (t) => {
  const vector = VECTORS.salts_differ;
  for (const [salt, wire] of [[vector.salt_a, vector.wire_a], [vector.salt_b, vector.wire_b]]) {
    const server = await startMockServer({ identifySalt: salt });
    const rs = makeClient(server);
    await rs.init();
    await rs.identify(vector.accountId);
    await waitFor(() => server.state.identifies.length === 1);
    assert.equal(server.state.identifies[0].body.accountHash, wire);
    await rs.dispose();
    await server.close();
  }
  assert.notEqual(vector.wire_a, vector.wire_b);
});

// --- Conformance 2: every refuse vector ------------------------------------

test('every refuse vector is refused with nothing sent, nothing stored and the device id kept', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  for (const vector of VECTORS.refuse) {
    for (const initFirst of [true, false]) {
      const storage = new MemoryStorage();
      const rs = makeClient(server, { storage });
      if (initFirst) await rs.init();
      const device = rs.deviceId;
      await assert.rejects(() => rs.identify(vector.accountId), refusedAs(vector.reason), vector.note);
      if (!initFirst) await rs.init();
      await settle(20);
      assert.equal(server.state.identifies.length, 0, vector.note);
      assert.equal(storage.getItem(IDENTITY_KEY), null, vector.note);
      assert.equal(rs.deviceId, device, vector.note);
      assert.equal(rs.isIdentified, false);
      await rs.dispose();
    }
  }
});

test('a refusal while identified keeps the stored identity and the device and sends nothing', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  const device = rs.deviceId;
  const before = storage.getItem(IDENTITY_KEY);
  for (const vector of VECTORS.refuse) {
    await assert.rejects(() => rs.identify(vector.accountId), refusedAs(vector.reason), vector.note);
  }
  await settle();
  assert.equal(server.state.identifies.length, 1);
  assert.equal(storage.getItem(IDENTITY_KEY), before);
  assert.equal(rs.deviceId, device);
  await rs.dispose();
});

test('other values that are not text or a whole number are refused not_text', async () => {
  const rs = new Ravensight({ ingestKey: '', optional: true });
  for (const value of [undefined, {}, [], true, NaN, Infinity, -Infinity, 1e21, () => 'x', Symbol('s')]) {
    await assert.rejects(() => rs.identify(value), refusedAs('not_text'), String(typeof value));
  }
  assert.equal(rs.isIdentified, false);
});

// --- Conformance 3: the sequence -------------------------------------------

test('the contract sequence holds: salt present, salt changed, salt missing', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  let rs;
  let from;
  let device;
  const begin = () => {
    from = server.state.identifies.length;
    device = rs.deviceId;
  };
  const check = (index) => {
    const { step, expect } = SEQ[index];
    assert.deepEqual(sends(server, from), expect.sends, step);
    if ('stored' in expect) assert.deepEqual(stored(storage), expect.stored, step);
    if (expect.device_changed !== undefined) assert.equal(rs.deviceId !== device, expect.device_changed, step);
  };

  // 0: init with a key and consent; identify("u1") before any session opens.
  rs = makeClient(server, { storage });
  begin();
  await rs.identify('u1');
  await settle(20);
  check(0);
  assert.equal(rs.isIdentified, SEQ[0].expect.held_in_memory);
  for (const [, value] of storage._map) assert.ok(!String(value).includes('u1'), 'the raw id is never stored');

  // 1: S1 opens with the salt: the held id is hashed, stored and sent.
  await rs.init();
  await waitFor(() => server.state.identifies.length === from + 1);
  await settle(20);
  check(1);
  assert.equal(label(server, rs.sessionToken), 'S1');

  // 2: the same account again in S1.
  begin();
  await rs.identify('u1');
  await settle();
  check(2);
  await rs.dispose();

  // 3: relaunch, S2 opens with the same salt, no call.
  rs = makeClient(server, { storage });
  begin();
  assert.equal(rs.isIdentified, true);
  await rs.init();
  await waitFor(() => server.state.identifies.length === from + 1);
  await settle(20);
  check(3);

  // 4: an email is refused.
  begin();
  await assert.rejects(() => rs.identify('player@example.com'), refusedAs(SEQ[4].expect.refused));
  await settle();
  check(4);

  // 5: another account on this device: a fresh device, session S3.
  begin();
  await rs.identify('u2');
  await waitFor(() => server.state.identifies.length === from + 1);
  await settle(20);
  check(5);
  assert.equal(label(server, rs.sessionToken), SEQ[5].expect.new_session);
  assert.equal(server.state.tokenDevices.get(rs.sessionToken), rs.deviceId);

  // 6: resetIdentity(): a fresh device, nothing sent, nothing stored. Its session is S4.
  begin();
  await rs.resetIdentity();
  await nextSession(server, rs);
  await settle();
  check(6);
  assert.equal(label(server, rs.sessionToken), SEQ[6].expect.new_session);
  assert.equal(rs.isIdentified, false);
  assert.equal(storage.getItem('ravensight_device_id'), rs.deviceId);

  // 7: resetIdentity() again with nothing stored: nothing changes.
  begin();
  await rs.resetIdentity();
  await settle();
  check(7);

  // 8: identify("u3"), the answer is needs_funds: the identity is kept, no loop.
  begin();
  server.state.identifyOverrides.push({ status: 429, body: { error: 'quota_exceeded', reason: 'needs_funds' } });
  await rs.identify('u3');
  await waitFor(() => server.state.identifies.length === from + 1);
  await settle(20);
  check(8);
  await rs.identify('u3');
  await settle();
  assert.equal(server.state.identifies.length, from + 1, 'never in a loop');
  await rs.dispose();

  // 9: relaunch; S5 answers a different salt: the stored identity is deleted, never sent.
  server.state.identifySalt = VECTORS.salts_differ.salt_b;
  rs = makeClient(server, { storage });
  begin();
  await rs.init();
  await settle();
  check(9);
  assert.equal(label(server, rs.sessionToken), 'S5');
  assert.equal(rs.isIdentified, false);
  await rs.dispose();

  // 10: identify("u4"); the session answer carries no identify.salt (an older server).
  server.state.identifySalt = null;
  rs = makeClient(server, { storage });
  begin();
  await rs.identify('u4');
  await rs.init();
  await settle();
  check(10);
  assert.equal(rs.isIdentified, false, 'the held id is dropped');
  // Unavailable for the rest of this launch, even in an open session.
  await rs.identify('u4');
  await settle();
  check(10);

  // 11: opt out.
  begin();
  rs.setEnabled(false);
  await settle();
  check(11);
  await rs.dispose();
});

test('opt-out deletes a stored identity and drops a held id', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
  rs.setEnabled(false);
  assert.equal(storage.getItem(IDENTITY_KEY), null);
  assert.equal(rs.isIdentified, false);
  await rs.dispose();

  const held = makeClient(server, { storage: new MemoryStorage() });
  await held.identify('u1');
  held.setEnabled(false);
  assert.equal(held.isIdentified, false);
  held.setEnabled(true);
  await held.init();
  await settle();
  assert.equal(server.state.identifies.length, 1, 'the dropped id is never sent');
  await held.dispose();
});

test('needs_funds, identify_limited and rate_limited keep the identity and retry at the next session only', async (t) => {
  const answers = [
    { status: 429, body: { error: 'quota_exceeded', reason: 'needs_funds' } },
    { status: 429, body: { error: 'identify_limited' }, headers: { 'Retry-After': '3600' } },
    { status: 429, body: { error: 'rate_limited' } },
    { status: 503 },
    { status: 500, body: { error: 'internal' } },
  ];
  for (const answer of answers) {
    const server = await saltedServer({ identifyOverrides: [answer] });
    const storage = new MemoryStorage();
    const rs = makeClient(server, { storage });
    await rs.init();
    await rs.identify('u1');
    await waitFor(() => server.state.identifies.length === 1);
    await settle();
    await rs.identify('u1');
    await settle();
    assert.equal(server.state.identifies.length, 1, 'no loop: ' + JSON.stringify(answer));
    assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
    await nextSession(server, rs);
    await waitFor(() => server.state.identifies.length === 2);
    assert.equal(server.state.identifies[1].token, rs.sessionToken);
    await settle();
    assert.equal(server.state.identifies.length, 2);
    await rs.dispose();
    await server.close();
  }
});

test('offline keeps the identity and retries at the next session', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  let offline = false;
  const fetchImpl = (url, init) =>
    offline && String(url).endsWith('/identify') ? Promise.reject(new Error('offline')) : fetch(url, init);
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, fetch: fetchImpl });
  await rs.init();
  offline = true;
  await rs.identify('u1');
  await settle();
  await rs.identify('u1');
  await settle();
  assert.equal(server.state.identifies.length, 0);
  assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
  offline = false;
  await nextSession(server, rs);
  await waitFor(() => server.state.identifies.length === 1);
  await rs.dispose();
});

test('a 404 keeps the stored identity and is not retried this launch', async (t) => {
  const server = await saltedServer({ identifyOverrides: [{ status: 404, body: { error: 'not_found' } }] });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await nextSession(server, rs);
  await rs.resetDeviceId();
  rs.track('b');
  await rs.flush();
  await settle();
  assert.equal(server.state.identifies.length, 1, 'no retry this launch');
  assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
  await rs.dispose();
  const next = makeClient(server, { storage });
  await next.init();
  await waitFor(() => server.state.identifies.length === 2);
  await next.dispose();
});

test('a 409 is not retried in that session but is at the next one', async () => {
  for (const error of ['session_taken', 'synthetic_session']) {
    const server = await saltedServer({ identifyOverrides: [{ status: 409, body: { error } }] });
    const rs = makeClient(server);
    await rs.init();
    await rs.identify('u1');
    await waitFor(() => server.state.identifies.length === 1);
    await settle();
    await rs.identify('u1');
    await settle();
    assert.equal(server.state.identifies.length, 1, error);
    await nextSession(server, rs);
    await waitFor(() => server.state.identifies.length === 2);
    await rs.dispose();
    await server.close();
  }
});

test('a 400 invalid_account_hash is logged once and never retried this launch', async (t) => {
  const server = await saltedServer({ identifyOverrides: [{ status: 400, body: { error: 'invalid_account_hash' } }] });
  t.after(() => server.close());
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = original;
  });
  const rs = makeClient(server);
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await settle();
  await nextSession(server, rs);
  await settle();
  assert.equal(server.state.identifies.length, 1);
  assert.equal(warnings.filter((w) => w.includes('invalid_account_hash')).length, 1);
  await rs.dispose();
});

test('a 400 no_session identifies again once the next session opens, once', async (t) => {
  const noSession = { status: 400, body: { error: 'no_session' } };
  const server = await saltedServer({ identifyOverrides: [noSession, noSession] });
  t.after(() => server.close());
  const rs = makeClient(server);
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await settle();
  assert.equal(server.state.identifies.length, 1);
  await nextSession(server, rs);
  await waitFor(() => server.state.identifies.length === 2);
  assert.equal(server.state.identifies[1].token, rs.sessionToken);
  await settle();
  // A second no_session in a row: no more tries this launch.
  await nextSession(server, rs);
  await settle();
  assert.equal(server.state.identifies.length, 2);
  await rs.dispose();
});

test('resetDeviceId alone keeps the identity and the next session identifies again', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await rs.resetDeviceId();
  assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
  assert.equal(rs.isIdentified, true);
  rs.track('a');
  await rs.flush();
  await waitFor(() => server.state.identifies.length === 2);
  assert.equal(server.state.tokenDevices.get(server.state.identifies[1].token), rs.deviceId);
  await rs.dispose();
});

test('a different account before the salt is known still switches the device first', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const first = makeClient(server, { storage });
  await first.init();
  await first.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await first.dispose();

  const rs = makeClient(server, { storage });
  const device = rs.deviceId;
  await rs.identify('u1');
  assert.equal(rs.deviceId, device, 'the same account keeps the device');
  await rs.identify('u2');
  assert.notEqual(rs.deviceId, device, 'another account switches the device');
  assert.equal(storage.getItem(IDENTITY_KEY), null);
  await rs.init();
  await waitFor(() => server.state.identifies.length === 2);
  assert.deepEqual(sends(server, 1), [{ session: 'S2', accountHash: SEQ[5].expect.stored.accountHash }]);
  assert.equal(server.state.tokenDevices.get(rs.sessionToken), rs.deviceId);
  await rs.dispose();
});

// --- Conformance 4: the request shape --------------------------------------

test('the request carries the key, the session token and exactly { accountHash }', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const rs = makeClient(server);
  await rs.init();
  await rs.identify('12345');
  await waitFor(() => server.state.identifies.length === 1);
  const request = server.requestsTo('/api/v1/identify')[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], INGEST_KEY);
  assert.equal(request.headers['x-session-token'], rs.sessionToken);
  assert.equal(request.text, JSON.stringify({ accountHash: VECTORS.accept[0].wire }));
  assert.ok(!request.text.includes(rs.deviceId));
  await rs.dispose();
});

test('identify never enters the event queue or the stored queue, and never holds back events', async (t) => {
  const server = await saltedServer({ identifyDelayMs: 300 });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  assert.equal(rs.queue.length, 0);
  rs.track('a');
  await rs.flush();
  assert.equal(server.state.events.length, 1, 'the event went out while identify was in flight');
  assert.equal(server.state.identifies.length, 1);
  for (const [key, value] of storage._map) {
    if (key === IDENTITY_KEY) continue;
    assert.ok(!String(value).includes(U1), key);
  }
  await rs.dispose();
});

// --- Conformance 5: nothing without a key or before consent ----------------

test('without a key identify is validated, held in memory and nothing is sent or stored', async () => {
  const calls = [];
  const storage = new MemoryStorage();
  const rs = new Ravensight({
    ingestKey: '',
    optional: true,
    storage,
    fetch: (...args) => {
      calls.push(args);
      return Promise.reject(new Error('no'));
    },
  });
  await rs.identify('u1');
  assert.equal(rs.isIdentified, true);
  await assert.rejects(() => rs.identify('a@b'), refusedAs('looks_like_email'));
  await rs.init();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(storage.getItem(IDENTITY_KEY), null);
  await rs.resetIdentity();
  assert.equal(rs.isIdentified, false);
  assert.equal(calls.length, 0);
});

test('before the opt-in yes identify is held in memory, then hashed, stored and sent on the yes', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage, consent: 'opt_in' });
  await rs.init();
  await rs.identify('u1');
  await settle();
  assert.equal(server.state.requests.length, 0);
  assert.equal(storage.getItem(IDENTITY_KEY), null);
  rs.setEnabled(true);
  await waitFor(() => server.state.identifies.length === 1);
  assert.equal(server.state.identifies[0].body.accountHash, U1);
  assert.deepEqual(stored(storage), { salt: SALT, accountHash: U1 });
  rs.setEnabled(false);
  assert.equal(storage.getItem(IDENTITY_KEY), null, 'consent withdrawn deletes it');
  assert.equal(rs.isIdentified, false);
  await rs.dispose();
});

test('a stored identity is not read or sent before the opt-in yes', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const storage = new MemoryStorage();
  storage.setItem(IDENTITY_KEY, JSON.stringify({ salt: SALT, accountHash: U1 }));
  const rs = makeClient(server, { storage, consent: 'opt_in' });
  await rs.init();
  await settle();
  assert.equal(server.state.requests.length, 0);
  assert.equal(rs.isIdentified, false);
  await rs.dispose();
});

test('a malformed stored identity is ignored', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  for (const bad of ['not json', '{"salt":"x","accountHash":"y"}', JSON.stringify({ accountHash: U1 })]) {
    const storage = new MemoryStorage();
    storage.setItem(IDENTITY_KEY, bad);
    const rs = makeClient(server, { storage });
    assert.equal(rs.isIdentified, false);
    await rs.init();
    await settle(20);
    await rs.dispose();
  }
  assert.equal(server.state.identifies.length, 0);
});

// --- Late answers -----------------------------------------------------------

test('a late 200 arriving after resetIdentity does not mark the new session identified', async (t) => {
  const server = await saltedServer({ identifyDelayMs: 200 });
  t.after(() => server.close());
  const storage = new MemoryStorage();
  const rs = makeClient(server, { storage });
  await rs.init();
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 1);
  await rs.resetIdentity();
  rs.track('a');
  await rs.flush();
  await settle(300);
  assert.equal(rs.isIdentified, false);
  assert.equal(storage.getItem(IDENTITY_KEY), null);
  server.state.identifyDelayMs = 0;
  await rs.identify('u1');
  await waitFor(() => server.state.identifies.length === 2);
  assert.equal(server.state.identifies[1].token, rs.sessionToken);
  await rs.dispose();
});

test('identify and resetIdentity after dispose are refused as disposed', async (t) => {
  const server = await saltedServer();
  t.after(() => server.close());
  const rs = makeClient(server);
  await rs.dispose();
  await assert.rejects(() => rs.identify('u1'), (err) => err.code === 'disposed');
  await assert.rejects(() => rs.resetIdentity(), (err) => err.code === 'disposed');
});
