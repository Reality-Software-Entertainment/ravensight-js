import test from 'node:test';
import assert from 'node:assert/strict';
import { Ravensight, MemoryStorage } from '../src/index.js';
const etag = '"' + 'a'.repeat(64) + '"';
const doc = (values = { speed: 3, enabled: false, label: 'test', rules: { bonus: 2 } }, experiments = [{ key: 'difficulty', variant: 'easy' }]) => ({ values, experiments, etag });
const response = (body, status = 200) => ({ status, headers: new Headers(), text: async () => body == null ? '' : JSON.stringify(body) });
function make(overrides = {}) {
  const calls = [];
  const rs = new Ravensight({ ingestKey: 'test-key', deviceId: 'player-a', platform: 'web', gameVersion: '1', autoFlushMs: 0, autoEvents: false,
    storage: new MemoryStorage(), fetch: async (url, options) => { calls.push({ url, ...options }); return response(doc()); }, ...overrides });
  return { rs, calls };
}
test('fetch uses existing ingest endpoint, typed values, clone isolation and assignment labels', async () => {
  const { rs, calls } = make();
  const result = await rs.fetchConfig();
  assert.equal(result.source, 'network');
  assert.match(calls[0].url, /\/api\/v1\/ingest\/config\?deviceId=player-a&platform=web&gameVersion=1$/);
  assert.equal(calls[0].headers['X-API-Key'], 'test-key');
  assert.equal(rs.getConfig('speed', 1), 3);
  assert.equal(rs.getConfig('enabled', true), false);
  assert.equal(rs.getConfig('speed', 'fallback'), 'fallback');
  assert.equal(rs.getConfig('missing', 9), 9);
  result.values.rules.bonus = 99;
  rs.getConfig('rules', {}).bonus = 100;
  assert.deepEqual(rs.getConfig('rules', {}), { bonus: 2 });
  rs.track('start', { rs_exp_difficulty: 'forged' });
  assert.equal(rs.queue[0].data.rs_exp_difficulty, 'easy');
  rs.trackPurchase({ amount: 20, currency: 'usd', itemType: 'boost', itemId: 'one' });
  assert.equal(rs.queue[1].data.rs_exp_difficulty, 'easy');
  await rs.dispose({ flush: false });
});
test('matching ETag, network failure and malformed document retain last known values', async () => {
  let next = response(doc()); const requests = [];
  const { rs } = make({ fetch: async (_, init) => { requests.push(init); if (next instanceof Error) throw next; return next; } });
  await rs.fetchConfig(); next = response(null, 304);
  assert.equal((await rs.fetchConfig()).source, 'cache');
  assert.equal(requests[1].headers['If-None-Match'], etag);
  next = new Error('offline'); assert.equal((await rs.fetchConfig()).source, 'cache');
  next = response(doc({ speed: 'bad' }, [{ key: 'x', variant: 'invalid value' }]));
  await rs.fetchConfig(); assert.equal(rs.getConfig('speed', 0), 3);
  next = response(doc({}, [])); await rs.fetchConfig(); rs.track('after');
  assert.equal(rs.queue[0].data.rs_exp_difficulty, undefined);
  assert.equal(rs.getConfig('speed', 0), 0);
  await rs.dispose({ flush: false });
});
test('persistent fallback is scoped to endpoint, ingest key, player, platform and build', async () => {
  const storage = new MemoryStorage(); const { rs } = make({ storage });
  await rs.fetchConfig(); await rs.dispose({ flush: false });
  const offline = async () => { throw new Error('offline'); };
  const restored = make({ storage, fetch: offline }).rs;
  assert.equal(restored.getConfig('speed', 0), 3);
  assert.equal((await restored.fetchConfig()).source, 'cache');
  for (const override of [{ deviceId: 'other' }, { platform: 'other' }, { gameVersion: '2' }, { ingestKey: 'other' }, { apiUrl: 'https://other.invalid' }]) {
    const other = make({ storage, fetch: offline, ...override }).rs;
    assert.equal(other.getConfig('speed', 0), 0);
    await other.dispose({ flush: false });
  }
  await restored.dispose({ flush: false });
});
test('concurrent requests deduplicate; opt out discards in-flight values and callbacks', async () => {
  let finish; let count = 0; let callbacks = 0;
  const { rs } = make({ fetch: () => { count++; return new Promise(resolve => { finish = resolve; }); }, onConfigReady: () => callbacks++ });
  const first = rs.fetchConfig(); assert.equal(first, rs.fetchConfig()); assert.equal(count, 1);
  rs.setEnabled(false); finish(response(doc()));
  assert.deepEqual(await first, { source: 'default', values: {} });
  assert.equal(callbacks, 0); assert.equal(rs.getConfig('speed', 0), 0);
  assert.deepEqual(await rs.fetchConfig(), { source: 'default', values: {} });
  await rs.dispose({ flush: false });
});
test('multi-player events use only their own cached assignment and build changes invalidate it', async () => {
  const { rs } = make({ fetch: async url => response(doc({}, [{ key: 'difficulty', variant: new URL(url).searchParams.get('deviceId') === 'player-a' ? 'easy' : 'hard' }])) });
  await rs.fetchConfig(); await rs.fetchConfig('player-b');
  rs.track('a'); rs.track('b', {}, { deviceId: 'player-b' }); rs.track('c', {}, { deviceId: 'player-c' });
  assert.deepEqual(rs.queue.map(row => row.data.rs_exp_difficulty), ['easy', 'hard', undefined]);
  await rs.setDeviceId('player-b'); rs.track('b2'); assert.equal(rs.queue[3].data.rs_exp_difficulty, 'hard');
  rs.gameVersion = '2'; rs.track('new_build'); assert.equal(rs.queue[4].data.rs_exp_difficulty, undefined);
  await rs.dispose({ flush: false });
});
test('consent and inert clients make no config requests or storage writes', async () => {
  let calls = 0; const storage = { getItem: () => null, setItem: () => { calls++; }, removeItem: () => {} };
  for (const overrides of [{ ingestKey: '', optional: true }, { consent: 'opt_in' }]) {
    const { rs } = make({ ...overrides, storage, fetch: async () => { calls++; throw new Error('must not fetch'); } });
    const before = calls; await rs.fetchConfig(); assert.equal(rs.getConfig('speed', 0), 0); assert.equal(calls, before);
    await rs.dispose({ flush: false });
  }
});
test('session startup fetches config and signals readiness without a callback failure breaking init', async () => {
  const paths = []; let ready = 0;
  const { rs } = make({ onConfigReady: () => { ready++; throw new Error('game callback'); }, fetch: async url => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/settings')) return response({ trackingEnabled: true });
    if (url.endsWith('/session')) return response({ token: 'session', expiresIn: 3600 }, 201);
    return response(doc());
  } });
  assert.equal((await rs.init()).sessionReady, true);
  assert.deepEqual(paths, ['/api/v1/settings', '/api/v1/session', '/api/v1/ingest/config']);
  assert.equal(ready, 1); assert.equal(rs.getConfig('speed', 0), 3);
  await rs.dispose({ flush: false });
});
test('corrupt cache and reserved nested object properties are ignored', async () => {
  const storage = new MemoryStorage(); storage.setItem('ravensight_config_v1', '{');
  const unsafe = JSON.parse('{"values":{"settings":{"__proto__":{"polluted":true}}},"experiments":[]}'); unsafe.etag = etag;
  const { rs } = make({ storage, fetch: async () => response(unsafe) });
  assert.equal((await rs.fetchConfig()).source, 'default');
  assert.equal(rs.getConfig('settings', null), null); assert.equal({}.polluted, undefined);
  await rs.dispose({ flush: false });
});
