// Ads and attribution
// (ADS_ATTRIBUTION_CONTRACT.md), experiment exposure (EXPOSURE_CONTRACT.md)
// and the device fields on POST /session.
import test from 'node:test';
import assert from 'node:assert/strict';

import Ravensight, {
  MemoryStorage,
  microsFromDecimalString,
  microsFromRevenue,
  adFormatFrom,
} from '../src/index.js';
import { startMockServer } from './helpers/mock-server.js';

const INGEST_KEY = 'gt_live_test_key';
const offline = async () => { throw new Error('offline'); };

function client(overrides = {}) {
  return new Ravensight(Object.assign({
    ingestKey: INGEST_KEY,
    storage: new MemoryStorage(),
    autoFlushMs: 0,
    deviceId: 'player-1',
    fetch: offline,
    random: () => 0.5,
  }, overrides));
}

/** A fake page: window listeners, a location and an optional WebGL canvas. */
function withPage(t, { search = '', gl = null } = {}) {
  const listeners = new Map();
  const win = {
    location: { search },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ getContext: () => gl }),
  };
  const saved = {};
  for (const [k, v] of [['window', win], ['document', doc]]) {
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
    emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    count: (type) => (listeners.get(type) || new Set()).size,
  };
}

const named = (rs, name) => rs.queue.filter((e) => e.event === name);

// --- Ads ----------------------------------------------------------------------------

test('conformance 1: trackAdRevenue sends exactly the seven keys', () => {
  const rs = client({});
  assert.equal(rs.trackAdRevenue('admob', 'rewarded', 'level_end', '1500', 'USD'), true);
  const [ad] = named(rs, 'rs_ad');
  const { rs_event_id: _id, ...data } = ad.data;
  assert.deepEqual(data, {
    rs_kind: 'ad',
    rs_ad_network: 'admob',
    rs_ad_format: 'rewarded',
    rs_ad_placement: 'level_end',
    rs_ad_result: 'shown',
    rs_revenue_micros: '1500',
    rs_currency: 'USD',
  });
  rs.dispose({ flush: false });
});

test('conformance 2: mediation doubles become micros on their digits, half up', () => {
  assert.equal(microsFromRevenue(0.0015), '1500');
  assert.equal(microsFromRevenue(1.23456789), '1234568');
  assert.equal(microsFromRevenue(0.1 + 0.2), '300000');
  assert.equal(microsFromRevenue(1e-7), '0');
  assert.equal(microsFromRevenue(5e-7), '1');
  assert.equal(microsFromRevenue(-1), null);
  assert.equal(microsFromRevenue(NaN), null);
  assert.equal(microsFromDecimalString('0.0015'), '1500');
  assert.equal(microsFromDecimalString('2'), '2000000');
  assert.equal(microsFromDecimalString('0.9999995'), '1000000');
  assert.equal(microsFromDecimalString('1.5e-3'), '1500');
  assert.equal(microsFromDecimalString('12E2'), '1200000000');
  assert.equal(microsFromDecimalString('.5'), '500000');
  assert.equal(microsFromDecimalString('abc'), null);
  assert.equal(microsFromDecimalString('-1'), null);
  assert.equal(microsFromDecimalString(''), null);
  assert.equal(microsFromDecimalString('1000000000000'), null, 'past 18 digits of micros');
});

test('conformance 3: revenue without a currency is never sent; other refusals', () => {
  const rs = client({});
  assert.equal(rs.trackAdRevenue('admob', 'rewarded', 'x', '1500'), false);
  assert.equal(rs.trackAd('admob', 'banner', 'clicked', { revenueMicros: '10', currency: 'USD' }), false, 'revenue only on shown');
  assert.equal(rs.trackAd('admob', 'banner', 'shown', { revenueMicros: '1.5', currency: 'USD' }), false);
  assert.equal(rs.trackAd('admob', 'banner', 'shown', { revenueMicros: '1', currency: 'US' }), false);
  assert.equal(rs.trackAd('admob', 'banner', 'shown', { currency: 'USD' }), false);
  assert.equal(rs.trackAd('', 'banner', 'shown'), false);
  assert.equal(rs.trackAd('admob', 'video', 'shown'), false);
  assert.equal(rs.trackAd('admob', 'banner', 'seen'), false);
  assert.equal(rs.trackAd('admob', 'banner', 'shown', { placement: '' }), false);
  assert.equal(named(rs, 'rs_ad').length, 0);
  assert.equal(rs.trackAd('admob', 'banner', 'failed'), true);
  assert.equal(rs.trackAd('admob', 'banner', 'shown', { revenueMicros: 2500, currency: 'eur' }), true);
  const [failed, shown] = named(rs, 'rs_ad');
  assert.equal(failed.data.rs_ad_placement, undefined, 'omitted, never empty');
  assert.equal(shown.data.rs_revenue_micros, '2500');
  assert.equal(shown.data.rs_currency, 'EUR');
  rs.dispose({ flush: false });
});

test('mediation format names map onto rs_ad_format', () => {
  const cases = { BANNER: 'banner', MREC: 'banner', LEADER: 'banner', INTER: 'interstitial', interstitial: 'interstitial', REWARDED: 'rewarded', rewarded_video: 'rewarded', REWARDED_INTER: 'rewarded', NATIVE: 'native', APP_OPEN: 'app_open', SPLASH: 'other', '': 'other' };
  for (const [name, format] of Object.entries(cases)) assert.equal(adFormatFrom(name), format, name);
});

// --- Attribution ---------------------------------------------------------------

test('conformance 4: setAttribution is sent once per device across restarts', () => {
  const storage = new MemoryStorage();
  const first = client({ storage });
  assert.equal(first.setAttribution({ source: 'store_referrer', network: 'google', campaign: 'spring', touchTime: 1767225600000 }), true);
  assert.equal(first.setAttribution({ source: 'organic' }), false, 'once');
  const [event] = named(first, 'rs_attribution');
  const { rs_event_id: _id, ...data } = event.data;
  assert.deepEqual(data, { rs_kind: 'attribution', rs_attr_source: 'store_referrer', rs_attr_network: 'google', rs_campaign: 'spring', rs_touch_time: 1767225600000 });
  first.dispose({ flush: false });
  const second = client({ storage });
  assert.equal(second.setAttribution({ source: 'organic' }), false, 'still once after a restart');
  second.dispose({ flush: false });
  const other = client({ storage, deviceId: 'player-2' });
  assert.equal(other.setAttribution({ source: 'organic' }), true, 'a new device id may send its own');
  assert.equal(other.setAttribution({ source: '' }), false);
  other.dispose({ flush: false });
});

test('conformance 5: UTM parameters on the first load of a new device', (t) => {
  withPage(t, { search: '?utm_campaign=spring&utm_source=newsletter&utm_medium=email&gclid=secret&ref=x' });
  const storage = new MemoryStorage();
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage, autoFlushMs: 0, fetch: offline, autoEvents: false });
  const [event] = named(rs, 'rs_attribution');
  const { rs_event_id: _id, rs_touch_time: touch, ...data } = event.data;
  assert.deepEqual(data, { rs_kind: 'attribution', rs_attr_source: 'utm', rs_campaign: 'spring', rs_attr_network: 'newsletter' });
  assert.ok(Number.isSafeInteger(touch) && touch > 1e12);
  rs.dispose({ flush: false });
  const again = new Ravensight({ ingestKey: INGEST_KEY, storage, autoFlushMs: 0, fetch: offline, autoEvents: false });
  assert.equal(again.stats.restored, 1, 'the first one is still stored, unsent');
  assert.equal(named(again, 'rs_attribution').length, 1, 'not a new device: no second one');
  again.dispose({ flush: false });
});

test('no UTM parameter, an opted-out player or an opt-in player before the yes: nothing', (t) => {
  withPage(t, { search: '?ref=friend' });
  const plain = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), autoFlushMs: 0, fetch: offline, autoEvents: false });
  assert.equal(named(plain, 'rs_attribution').length, 0);
  plain.dispose({ flush: false });
});

test('an opt-in player sends the landing UTM at the yes, never before', (t) => {
  withPage(t, { search: '?utm_source=ads' });
  const storage = new MemoryStorage();
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage, consent: 'opt_in', autoFlushMs: 0, fetch: offline, autoEvents: false });
  assert.equal(rs.queue.length, 0);
  rs.setEnabled(true);
  assert.equal(named(rs, 'rs_attribution')[0].data.rs_attr_network, 'ads');
  rs.dispose({ flush: false });
  const optedOut = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), enabled: false, autoFlushMs: 0, fetch: offline, autoEvents: false });
  assert.equal(optedOut.queue.length, 0);
  optedOut.dispose({ flush: false });
});

// --- Exposure ------------------------------------------------------------------

const etag = '"' + 'b'.repeat(64) + '"';
function configFetch(state) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status, body) => ({ status, headers: new Headers(), text: async () => JSON.stringify(body) });
    if (path.endsWith('/settings')) return reply(200, { trackingEnabled: true });
    if (path.endsWith('/session')) {
      state.sessions = (state.sessions || 0) + 1;
      return reply(201, { token: 'tok' + state.sessions, expiresIn: 3600, origin: { session: 'ses_' + state.sessions, build: '1', platform: 'web', stamp: 'o1.s' } });
    }
    if (path.endsWith('/ingest/config')) return reply(200, { values: { speed: 2 }, experiments: state.experiments, etag });
    if (path.endsWith('/track/batch')) {
      if (state.offline) throw new Error('offline');
      return reply(202, { accepted: 1 });
    }
    return reply(404, {});
  };
}

test('exposure: a fetch alone tags nothing; the first typed read tags later events and sends one rs_exposure', async () => {
  const state = { experiments: [{ key: 'difficulty', variant: 'easy' }, { key: 'shop', variant: 'b' }] };
  const rs = client({ fetch: configFetch(state), autoEvents: false });
  await rs.init();
  rs.track('before');
  assert.equal(rs.queue[0].data.rs_exp_difficulty, undefined, 'no tag without a read');
  assert.equal(named(rs, 'rs_exposure').length, 0);
  assert.equal(rs.getConfig('speed', 1), 2);
  rs.getConfig('speed', 1);
  rs.track('after');
  const exposures = named(rs, 'rs_exposure');
  assert.equal(exposures.length, 1, 'one per session');
  assert.equal(exposures[0].data.rs_exp_difficulty, 'easy');
  assert.equal(exposures[0].data.rs_exp_shop, 'b');
  assert.equal(named(rs, 'after')[0].data.rs_exp_difficulty, 'easy');
  assert.equal(named(rs, 'before')[0].data.rs_exp_difficulty, undefined, 'events queued before stay untagged');
  await rs.dispose({ flush: false });
});

test('exposure: a second session starts untagged; a stopped experiment is not tagged after the next fetch', async () => {
  const state = { experiments: [{ key: 'difficulty', variant: 'easy' }, { key: 'shop', variant: 'b' }] };
  const rs = client({ fetch: configFetch(state), autoEvents: false });
  await rs.init();
  rs.getConfig('speed', 1);
  state.experiments = [{ key: 'difficulty', variant: 'easy' }];
  await rs.fetchConfig();
  rs.track('stopped');
  assert.equal(named(rs, 'stopped')[0].data.rs_exp_shop, undefined, 'the stopped experiment drops out');
  assert.equal(named(rs, 'stopped')[0].data.rs_exp_difficulty, 'easy');
  rs._invalidateSession();
  await rs.session();
  rs.track('new_session');
  assert.equal(named(rs, 'new_session')[0].data.rs_exp_difficulty, undefined, 'untagged until its own read');
  rs.getConfig('speed', 1);
  assert.equal(named(rs, 'rs_exposure').length, 2);
  rs.track('read_again');
  assert.equal(named(rs, 'read_again')[0].data.rs_exp_difficulty, 'easy');
  await rs.dispose({ flush: false });
});

test('exposure: a queued offline event keeps its original tag', async () => {
  const state = { experiments: [{ key: 'difficulty', variant: 'easy' }], offline: true };
  const storage = new MemoryStorage();
  const rs = client({ storage, fetch: configFetch(state), autoEvents: false });
  await rs.init();
  rs.getConfig('speed', 1);
  rs.track('offline_event');
  await rs.flush();
  await rs.dispose({ flush: false });
  state.experiments = [{ key: 'difficulty', variant: 'hard' }];
  const next = client({ storage, fetch: configFetch(state), autoEvents: false });
  assert.equal(named(next, 'offline_event')[0].data.rs_exp_difficulty, 'easy');
  await next.dispose({ flush: false });
});

// --- Device fields ---------------------------------------------------------------

test('POST /session carries the device fields: the game\'s values cleaned, at most 128 printable characters', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({
    ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0,
    device: { model: '  Steam Deck\u0000 ', osVersion: '3.6', gpu: 'g'.repeat(200), serial: 'never sent' },
  });
  await rs.init();
  const { device } = server.requestsTo('/api/v1/session')[0].body;
  assert.deepEqual(device, { model: 'Steam Deck', osVersion: '3.6', gpu: 'g'.repeat(128) });
  await rs.dispose();
});

test('the browser sends the WebGL renderer where the extension answers, and never a model', async (t) => {
  const gl = {
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 7 } : null),
    getParameter: (p) => (p === 7 ? 'ANGLE (Apple M2)' : null),
  };
  withPage(t, { gl });
  const rs = client({ autoEvents: false });
  assert.deepEqual(rs._deviceFields(), { gpu: 'ANGLE (Apple M2)' });
  rs.dispose({ flush: false });
});

test('no device field known: no device object', (t) => {
  withPage(t, { gl: null });
  const rs = client({ autoEvents: false });
  assert.equal(rs._deviceFields(), null);
  rs.dispose({ flush: false });
});

// --- Campaign link -----------------------------------------------------------------

const LINK_ID = '64b0000000000000000000a1';

test('rs_link on the landing address goes once, as campaignLink on the first POST /session, and the address is left alone', async (t) => {
  withPage(t, { search: `?lang=en&rs_link=${LINK_ID.toUpperCase()}&utm_source=x` });
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false });
  await rs.init();
  assert.equal(server.requestsTo('/api/v1/session')[0].body.campaignLink, LINK_ID);
  // A later session of the same client (expiry, a new device id) carries none.
  await rs._createSession(rs.deviceId, rs._sessionEntry(rs.deviceId));
  assert.equal(server.requestsTo('/api/v1/session')[1].body.campaignLink, undefined);
  assert.equal(globalThis.window.location.search, `?lang=en&rs_link=${LINK_ID.toUpperCase()}&utm_source=x`);
  await rs.dispose();
});

test('no rs_link, or one that is not a link id: no campaignLink', async (t) => {
  for (const search of ['?ref=x', '?rs_link=abc', '?rs_link=' + 'g'.repeat(24), '']) {
    withPage(t, { search });
    const server = await startMockServer();
    const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false });
    await rs.init();
    assert.equal(server.requestsTo('/api/v1/session')[0].body.campaignLink, undefined, search);
    await rs.dispose();
    await server.close();
  }
});

test('an opt-in player sends the link only with the session after the yes, and an opted-out one never', async (t) => {
  withPage(t, { search: `?rs_link=${LINK_ID}` });
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), consent: 'opt_in', autoFlushMs: 0, autoEvents: false });
  await rs.init().catch(() => {});
  assert.equal(server.requestsTo('/api/v1/session').length, 0, 'no session before the yes');
  rs.setEnabled(true);
  await rs.init();
  assert.equal(server.requestsTo('/api/v1/session')[0].body.campaignLink, LINK_ID);
  await rs.dispose();
  const before = server.requestsTo('/api/v1/session').length;
  const optedOut = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), enabled: false, autoFlushMs: 0, autoEvents: false });
  await optedOut.init().catch(() => {});
  assert.equal(server.requestsTo('/api/v1/session').length, before);
  await optedOut.dispose();
});

test('setCampaignLink: a valid id goes lowercased with the next session, once, and returns true', async (t) => {
  withPage(t, { search: '' });
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false });
  assert.equal(rs.setCampaignLink(LINK_ID.toUpperCase()), true);
  await rs.init();
  assert.equal(server.requestsTo('/api/v1/session')[0].body.campaignLink, LINK_ID);
  // Once: the next session carries none until another call.
  await rs._createSession(rs.deviceId, rs._sessionEntry(rs.deviceId));
  assert.equal(server.requestsTo('/api/v1/session')[1].body.campaignLink, undefined);
  // A later call (a deep link while the game runs) goes with the next session opened.
  const OTHER = '64b0000000000000000000b2';
  assert.equal(rs.setCampaignLink(OTHER), true);
  await rs._createSession(rs.deviceId, rs._sessionEntry(rs.deviceId));
  assert.equal(server.requestsTo('/api/v1/session')[2].body.campaignLink, OTHER);
  await rs.dispose();
});

test('setCampaignLink refuses what is not a link id, returns false, and keeps an earlier link', async (t) => {
  withPage(t, { search: `?rs_link=${LINK_ID}` });
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false });
  for (const bad of ['', 'abc', LINK_ID + '0', LINK_ID.slice(1), 'g'.repeat(24), ` ${LINK_ID}`, `${LINK_ID} `, null, undefined, 42, {}]) {
    assert.equal(rs.setCampaignLink(bad), false, String(bad));
  }
  await rs.init();
  // The page's own link, untouched by the refused calls.
  assert.equal(server.requestsTo('/api/v1/session')[0].body.campaignLink, LINK_ID);
  await rs.dispose();
});

test('setCampaignLink replaces the page link, and never rides on a join token or a playtest session', async (t) => {
  withPage(t, { search: `?rs_link=${LINK_ID}` });
  const server = await startMockServer({ joinTokens: ['join_abc'] });
  t.after(() => server.close());
  const OTHER = '64b0000000000000000000b2';
  const rs = new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false, deviceId: 'host' });
  assert.equal(rs.setCampaignLink(OTHER), true);
  rs.joinSession('join_abc', { deviceId: 'p7' });
  rs.track('server_side', {}, { deviceId: 'p7' });
  await rs.flush();
  const joined = server.requestsTo('/api/v1/session').find((request) => request.body.deviceId === 'p7');
  assert.equal(joined.body.campaignLink, undefined, 'never on another device id or a join token');
  await rs.init();
  const own = server.requestsTo('/api/v1/session').find((request) => request.body.deviceId === 'host');
  assert.equal(own.body.campaignLink, OTHER);
  await rs.dispose();
});

test('setCampaignLink without a key or after dispose sends nothing and never throws', async (t) => {
  withPage(t, { search: '' });
  const keyless = new Ravensight({ storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false });
  assert.equal(keyless.setCampaignLink(LINK_ID), true);
  await keyless.dispose();
  assert.equal(keyless.setCampaignLink(LINK_ID), false);
});

test('a failed session keeps the link for the next attempt', async (t) => {
  withPage(t, { search: `?rs_link=${LINK_ID}` });
  const bodies = [];
  let fail = true;
  const fetchStub = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status, body) => ({ status, headers: new Headers(), text: async () => JSON.stringify(body) });
    if (path.endsWith('/session')) {
      bodies.push(JSON.parse(init.body));
      if (fail) return reply(500, { error: 'internal_error' });
      return reply(201, { token: 'tok', expiresIn: 3600 });
    }
    if (path.endsWith('/settings')) return reply(200, { trackingEnabled: true });
    return reply(200, {});
  };
  const rs = client({ deviceId: undefined, fetch: fetchStub, autoEvents: false });
  await rs._ensureSession().catch(() => {});
  fail = false;
  await rs._ensureSession();
  assert.deepEqual(bodies.map((body) => body.campaignLink), [LINK_ID, LINK_ID]);
  rs.dispose({ flush: false });
});
