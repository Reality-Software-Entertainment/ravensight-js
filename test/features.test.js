// Crash capture (CRASH_CONTRACT.md), ads and attribution
// (ADS_ATTRIBUTION_CONTRACT.md), experiment exposure (EXPOSURE_CONTRACT.md)
// and the device fields on POST /session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Ravensight, {
  MemoryStorage,
  microsFromDecimalString,
  microsFromRevenue,
  adFormatFrom,
  stackFrames,
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

// --- Crash capture --------------------------------------------------------------

test('browser: window error is game_crashed (critical), unhandledrejection is game_error, stack is frames only', (t) => {
  const page = withPage(t);
  const rs = client();
  assert.equal(page.count('error'), 1);
  assert.equal(page.count('unhandledrejection'), 1);
  const error = new TypeError('cannot read x');
  error.stack = 'TypeError: cannot read x\n    at update (https://cdn.example.com/game/main.js:10:5)\n    at loop (https://cdn.example.com/game/engine.js:2:1)';
  page.emit('error', { error, message: 'Uncaught TypeError: cannot read x' });
  page.emit('unhandledrejection', { reason: new Error('load failed') });
  const [crash] = named(rs, 'game_crashed');
  assert.deepEqual(
    { kind: crash.data.rs_kind, severity: crash.data.rs_severity, message: crash.data.rs_message },
    { kind: 'error', severity: 'critical', message: 'TypeError: cannot read x' },
  );
  assert.equal(crash.data.rs_stack, 'at update (game/main.js:10:5)\nat loop (game/engine.js:2:1)', 'no message line, no host');
  assert.match(crash.data.rs_event_id, /^[A-Za-z0-9_-]{1,64}$/);
  const [rejection] = named(rs, 'game_error');
  assert.equal(rejection.data.rs_severity, 'error');
  assert.equal(rejection.data.rs_message, 'Error: load failed');
  rs.dispose({ flush: false });
  assert.equal(page.count('error'), 0, 'dispose removes the listeners');
});

test('a cross-origin script error with no error object still sends a message', (t) => {
  const page = withPage(t);
  const rs = client();
  page.emit('error', { message: 'Script error.' });
  assert.equal(named(rs, 'game_crashed')[0].data.rs_message, 'Error: Script error.');
  assert.equal(named(rs, 'game_crashed')[0].data.rs_stack, undefined);
  rs.dispose({ flush: false });
});

test('at most 10 per message and 50 per session', (t) => {
  const page = withPage(t);
  const rs = client({ maxQueueSize: 500 });
  for (let i = 0; i < 15; i++) page.emit('unhandledrejection', { reason: new Error('same') });
  assert.equal(named(rs, 'game_error').length, 10);
  for (let i = 0; i < 60; i++) page.emit('unhandledrejection', { reason: new Error('m' + i) });
  assert.equal(named(rs, 'game_error').length, 50);
  rs.dispose({ flush: false });
});

test('captureErrors: false never listens; setCaptureErrors(false) stops capture and keeps what is queued', (t) => {
  const page = withPage(t);
  const off = client({ captureErrors: false });
  assert.equal(page.count('error'), 0);
  off.dispose({ flush: false });
  const rs = client();
  page.emit('unhandledrejection', { reason: 'x' });
  rs.setCaptureErrors(false);
  page.emit('unhandledrejection', { reason: 'y' });
  assert.equal(named(rs, 'game_error').length, 1);
  assert.equal(page.count('unhandledrejection'), 0);
  rs.dispose({ flush: false });
});

test('no capture while inert, before an opt-in yes, or after an opt-out', (t) => {
  const page = withPage(t);
  const inert = new Ravensight({ optional: true });
  const waiting = client({ consent: 'opt_in' });
  assert.equal(page.count('error'), 0);
  waiting.setEnabled(true);
  assert.equal(page.count('error'), 1, 'the yes starts capture');
  waiting.setEnabled(false);
  page.emit('error', { error: new Error('after opt-out') });
  assert.equal(named(waiting, 'game_crashed').length, 0);
  inert.dispose();
  waiting.dispose({ flush: false });
});

test('Node: one uncaughtExceptionMonitor for every client, no uncaughtException listener, written to the file at once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uncaughtBefore = process.listenerCount('uncaughtException');
  const monitorBefore = process.listenerCount('uncaughtExceptionMonitor');
  const server = await startMockServer({ origins: true });
  t.after(() => server.close());
  const make = () => new Ravensight({ ingestKey: INGEST_KEY, apiUrl: server.url, queueDir: dir, deviceId: 'p', autoFlushMs: 0, gameVersion: '1.0.0', platform: 'test' });
  const a = make();
  await a.init();
  const b = new Ravensight({ ingestKey: 'gt_live_other', apiUrl: server.url, queueDir: dir, deviceId: 'q', autoFlushMs: 0 });
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorBefore + 1, 'one listener shared');
  assert.equal(process.listenerCount('uncaughtException'), uncaughtBefore, 'exit behaviour unchanged');

  const boom = new Error('boom');
  boom.stack = 'Error: boom\n    at run (' + process.cwd() + '/src/game.js:3:9)\n    at /home/alex/tools/x.js:1:1';
  process.emit('uncaughtExceptionMonitor', boom, 'uncaughtException');
  // The process would end here. A new launch reads the file and sends the crash.
  const next = make();
  const [crash] = named(next, 'game_crashed');
  assert.equal(crash.data.rs_message, 'Error: boom');
  assert.equal(crash.data.rs_stack, 'at run (src/game.js:3:9)\nat ~/tools/x.js:1:1');
  assert.equal(crash.origin.session, 'ses_1', 'stamped with the run that crashed');
  await next.init();
  while (next._flushPromise) await next._flushPromise;
  const sent = server.state.events.find((e) => e.event === 'game_crashed');
  assert.equal(sent.origin.session, 'ses_1');
  await a.dispose({ flush: false });
  await b.dispose({ flush: false });
  await next.dispose();
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorBefore, 'removed with the last client');
});

test('stackFrames keeps 30 frames, drops non-frame lines and strips home directories and file URLs', () => {
  const lines = ['Error: x'];
  for (let i = 0; i < 40; i++) lines.push('    at f' + i + ' (file:///Users/sam/proj/a.js:' + i + ':1)');
  const frames = stackFrames(lines.join('\n')).split('\n');
  assert.equal(frames.length, 30);
  assert.equal(frames[0], 'at f0 (~/proj/a.js:0:1)');
  assert.equal(stackFrames('update@https://example.com/js/app.js:4:2\nC:\\Users\\Ann\\game\\a.js:1:1'), 'update@js/app.js:4:2');
  assert.equal(stackFrames('fn@C:\\Users\\Ann\\game\\a.js:1:1'), 'fn@~/game\\a.js:1:1');
  assert.equal(stackFrames(''), '');
});

// --- Ads ----------------------------------------------------------------------------

test('conformance 1: trackAdRevenue sends exactly the seven keys', () => {
  const rs = client({ captureErrors: false });
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
  const rs = client({ captureErrors: false });
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
  const first = client({ storage, captureErrors: false });
  assert.equal(first.setAttribution({ source: 'store_referrer', network: 'google', campaign: 'spring', touchTime: 1767225600000 }), true);
  assert.equal(first.setAttribution({ source: 'organic' }), false, 'once');
  const [event] = named(first, 'rs_attribution');
  const { rs_event_id: _id, ...data } = event.data;
  assert.deepEqual(data, { rs_kind: 'attribution', rs_attr_source: 'store_referrer', rs_attr_network: 'google', rs_campaign: 'spring', rs_touch_time: 1767225600000 });
  first.dispose({ flush: false });
  const second = client({ storage, captureErrors: false });
  assert.equal(second.setAttribution({ source: 'organic' }), false, 'still once after a restart');
  second.dispose({ flush: false });
  const other = client({ storage, deviceId: 'player-2', captureErrors: false });
  assert.equal(other.setAttribution({ source: 'organic' }), true, 'a new device id may send its own');
  assert.equal(other.setAttribution({ source: '' }), false);
  other.dispose({ flush: false });
});

test('conformance 5: UTM parameters on the first load of a new device', (t) => {
  withPage(t, { search: '?utm_campaign=spring&utm_source=newsletter&utm_medium=email&gclid=secret&ref=x' });
  const storage = new MemoryStorage();
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage, autoFlushMs: 0, fetch: offline, autoEvents: false, captureErrors: false });
  const [event] = named(rs, 'rs_attribution');
  const { rs_event_id: _id, rs_touch_time: touch, ...data } = event.data;
  assert.deepEqual(data, { rs_kind: 'attribution', rs_attr_source: 'utm', rs_campaign: 'spring', rs_attr_network: 'newsletter' });
  assert.ok(Number.isSafeInteger(touch) && touch > 1e12);
  rs.dispose({ flush: false });
  const again = new Ravensight({ ingestKey: INGEST_KEY, storage, autoFlushMs: 0, fetch: offline, autoEvents: false, captureErrors: false });
  assert.equal(again.stats.restored, 1, 'the first one is still stored, unsent');
  assert.equal(named(again, 'rs_attribution').length, 1, 'not a new device: no second one');
  again.dispose({ flush: false });
});

test('no UTM parameter, an opted-out player or an opt-in player before the yes: nothing', (t) => {
  withPage(t, { search: '?ref=friend' });
  const plain = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), autoFlushMs: 0, fetch: offline, autoEvents: false, captureErrors: false });
  assert.equal(named(plain, 'rs_attribution').length, 0);
  plain.dispose({ flush: false });
});

test('an opt-in player sends the landing UTM at the yes, never before', (t) => {
  withPage(t, { search: '?utm_source=ads' });
  const storage = new MemoryStorage();
  const rs = new Ravensight({ ingestKey: INGEST_KEY, storage, consent: 'opt_in', autoFlushMs: 0, fetch: offline, autoEvents: false, captureErrors: false });
  assert.equal(rs.queue.length, 0);
  rs.setEnabled(true);
  assert.equal(named(rs, 'rs_attribution')[0].data.rs_attr_network, 'ads');
  rs.dispose({ flush: false });
  const optedOut = new Ravensight({ ingestKey: INGEST_KEY, storage: new MemoryStorage(), enabled: false, autoFlushMs: 0, fetch: offline, autoEvents: false, captureErrors: false });
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
  const rs = client({ fetch: configFetch(state), autoEvents: false, captureErrors: false });
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
  const rs = client({ fetch: configFetch(state), autoEvents: false, captureErrors: false });
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
  const rs = client({ storage, fetch: configFetch(state), autoEvents: false, captureErrors: false });
  await rs.init();
  rs.getConfig('speed', 1);
  rs.track('offline_event');
  await rs.flush();
  await rs.dispose({ flush: false });
  state.experiments = [{ key: 'difficulty', variant: 'hard' }];
  const next = client({ storage, fetch: configFetch(state), autoEvents: false, captureErrors: false });
  assert.equal(named(next, 'offline_event')[0].data.rs_exp_difficulty, 'easy');
  await next.dispose({ flush: false });
});

// --- Device fields ---------------------------------------------------------------

test('POST /session carries the device fields: the game\'s values cleaned, at most 128 printable characters', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = new Ravensight({
    ingestKey: INGEST_KEY, apiUrl: server.url, storage: new MemoryStorage(), autoFlushMs: 0, captureErrors: false,
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
  const rs = client({ captureErrors: false, autoEvents: false });
  assert.deepEqual(rs._deviceFields(), { gpu: 'ANGLE (Apple M2)' });
  rs.dispose({ flush: false });
});

test('no device field known: no device object', (t) => {
  withPage(t, { gl: null });
  const rs = client({ captureErrors: false, autoEvents: false });
  assert.equal(rs._deviceFields(), null);
  rs.dispose({ flush: false });
});
