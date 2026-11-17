import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteTracker, SiteTracker, MemoryStorage } from '../src/index.js';
const key = 'gt_site_abcdefghijklmnopqrstuvwx';
const trackers = [];
const previousWindow = globalThis.window;
function target(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, fn) { const rows = listeners.get(name) || []; rows.push(fn); listeners.set(name, rows); }, removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(value => value !== fn)); }, dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); } };
}
function browser({ privateMode = false, navigator = {}, href = 'https://studio.example/?email=secret%40example.com&utm_source=newsletter' } = {}) {
  const document = target({ referrer: 'https://search.example/find?secret=1', visibilityState: 'visible', documentElement: { scrollWidth: 1000, scrollHeight: 2000 } });
  const win = target({ location: { href }, document, navigator, innerWidth: 1000, innerHeight: 500, scrollY: 0, localStorage: new MemoryStorage() });
  win.history = { pushState(_state, _title, url) { win.location.href = new URL(url, win.location.href).href; }, replaceState(_state, _title, url) { win.location.href = new URL(url, win.location.href).href; } };
  if (privateMode) Object.defineProperty(win, 'localStorage', { get() { throw new Error('blocked'); } });
  globalThis.window = win; return win;
}
const ok = events => ({ ok: true, status: 200, json: async () => ({ accepted: events.length, duplicates: 0, dropped: 0, refused: 0, acceptedIds: events.map(event => event.eventId), droppedIds: [], refusedIds: [], paused: false }) });
function tracker(options = {}) { const value = createSiteTracker({ key, fetch: async (_url, request) => ok(JSON.parse(request.body).events), ...options }); trackers.push(value); return value; }
afterEach(() => { for (const tracker of trackers.splice(0)) { tracker.optOut(); tracker.destroy(); try { tracker._storage.removeItem(tracker._preferenceKey); } catch {} } globalThis.window = previousWindow; });

test('site mode validates options and leaves game identity separate', () => {
  browser(); assert.throws(() => new SiteTracker({ key: 'bad' }), TypeError);
  assert.throws(() => tracker({ consent: 'unknown' }), TypeError);
  const site = tracker(); assert.equal(site._queue.length, 1); assert.equal(site._queue[0].type, 'page_view');
  assert.equal(site._queue[0].url, 'https://studio.example/?utm_source=newsletter');
  assert.equal(site._queue[0].referrer, 'https://search.example');
  assert.equal(site._queue[0].timestamp > 1000000000000, true);
  assert.throws(() => site.track('typed text'), TypeError); assert.throws(() => site.track('click', { email: 'private' }), TypeError);
});
test('consent, GPC, DNT and reset avoid capture before consent or after withdrawal', () => {
  const win = browser(); const site = tracker({ consent: 'opt_in' });
  assert.equal(site._queue.length, 0); assert.equal(win.localStorage._map.size, 0);
  site.grantConsent(); const id = site._queue[0].visitorId; site.reset(); assert.notEqual(site._queue[0].visitorId, id);
  site.optOut(); assert.equal(site.track('click'), false); assert.equal(win.localStorage._map.size, 1); assert.equal(win.localStorage.getItem(site._storageKey), null);
  win.navigator.globalPrivacyControl = true; site.grantConsent(); assert.equal(site._queue.length, 0);
  win.navigator.globalPrivacyControl = false; win.navigator.doNotTrack = '1'; assert.equal(site.pageView(), false);
});
test('explicit opt-out persists across tracker recreation and repeated consent is idempotent', () => {
  const win = browser(); const first = tracker(); first.optOut(); first.destroy();
  const next = tracker(); assert.equal(next._queue.length, 0); assert.equal(win.localStorage.getItem(next._storageKey), null);
  next.grantConsent(); assert.equal(next._queue.length, 1); next.grantConsent(); assert.equal(next._queue.length, 1);
  assert.equal(win.localStorage.getItem(next._preferenceKey), null);
});
test('SPA history and hash transitions de-duplicate and restore history on destroy', () => {
  const win = browser(), original = win.history.pushState, site = tracker();
  win.history.pushState({}, '', '/pricing'); win.dispatch('popstate');
  win.location.href += '#details'; win.dispatch('hashchange'); win.dispatch('popstate');
  assert.equal(site._queue.length, 3); assert.equal(site._queue[2].url, 'https://studio.example/pricing');
  site.destroy(); assert.equal(win.history.pushState, original);
});
test('sessions roll after inactivity and memory fallback survives storage failures', () => {
  browser({ privateMode: true }); const site = tracker(); const before = site._identity.sessionId;
  site._identity.last -= 1800001; site.track('next'); assert.notEqual(site._identity.sessionId, before);
  const same = site._identity.sessionId; site.track('again'); assert.equal(site._identity.sessionId, same);
});
test('receipt and auth paths are excluded; encoded email and long capability segments are redacted', () => {
  const win = browser({ href: 'https://studio.example/r/secret' }); const site = tracker(); assert.equal(site._queue.length, 0);
  win.history.pushState({}, '', '/profile/person%40example.com'); assert.equal(site._queue[0].url.includes('example.com'), false);
  win.history.pushState({}, '', '/' + 'x'.repeat(64)); assert.equal(site._queue[1].url, 'https://studio.example/:private');
});
test('partial acknowledgements preserve retry IDs and malformed acknowledgements are ignored', async () => {
  browser(); let sent; const site = tracker({ fetch: async (_url, request) => { sent = JSON.parse(request.body).events; return { ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, dropped: 1, refused: 1, acceptedIds: [sent[0].eventId], droppedIds: [sent[1].eventId], refusedIds: [sent[2].eventId], paused: false }) }; } });
  site.track('one'); site.track('two'); assert.equal(await site.flush(), true);
  assert.equal(site._queue.length, 1); assert.equal(site._queue[0].eventId, sent[2].eventId);
  site._retryAt = 0; site._fetch = async () => ({ ok: true, status: 200, json: async () => ({ accepted: 1, acceptedIds: ['foreign_id'] }) });
  assert.equal(await site.flush(), false); assert.equal(site._queue.length, 1);
  site._retryAt = 0; site._fetch = async (_url, request) => { assert.equal(JSON.parse(request.body).events[0].eventId, sent[2].eventId); return ok(JSON.parse(request.body).events); };
  assert.equal(await site.flush(), true); assert.equal(site._queue.length, 0);
});
test('funding pause discards refused and later queued events without catch-up', async () => {
  browser(); const site = tracker({ fetch: async (_url, request) => { const events = JSON.parse(request.body).events; return { ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, dropped: 0, refused: 1, acceptedIds: [events[0].eventId], droppedIds: [], refusedIds: [events[1].eventId], paused: true, reason: 'needs_funds' }) }; } });
  site.track('next'); await site.flush(); assert.equal(site.paused, true); assert.equal(site._queue.length, 0); assert.equal(site.track('later'), false);
  site.resume(); assert.equal(site._queue.length, 1); assert.equal(site._queue[0].type, 'page_view');
});
test('network retry keeps IDs; authorization rejection drops permanently invalid events', async () => {
  browser(); const site = tracker({ fetch: async () => { throw new Error('offline'); } }); const id = site._queue[0].eventId;
  await site.flush(); assert.equal(site._queue[0].eventId, id); site._retryAt = 0;
  site._fetch = async () => ({ status: 401, ok: false, json: async () => ({ error: 'invalid_site_key' }) }); await site.flush(); assert.equal(site._queue.length, 0);
});
test('heatmaps capture structural selectors only, exclude form regions, combine scroll and stay bounded', () => {
  const win = browser(); const site = tracker({ heatmaps: true });
  assert.equal(site._summarize(), false);
  const form = { tagName: 'INPUT', closest: () => ({}) }; win.document.dispatch('click', { target: form, pageX: 100, pageY: 100 });
  const button = { tagName: 'BUTTON', id: 'email-private', textContent: 'Private answer', closest: () => null, parentElement: null };
  win.document.dispatch('click', { target: button, pageX: 100, pageY: 500 }); win.dispatch('scroll');
  site._summarize(); const summary = site._queue.at(-1); assert.equal(summary.type, 'heatmap'); assert.equal(summary.heatmap.clicks.length, 1);
  assert.equal(summary.heatmap.clicks[0].selector, 'button:nth-of-type(1)'); assert.equal(JSON.stringify(summary).includes('Private answer'), false); assert.equal(summary.heatmap.scroll[0], 1);
  for (let n = 0; n < 20; n++) { win.dispatch('scroll'); site._summarize(); }
  assert.equal(site._queue.filter(event => event.type === 'heatmap').length, 6);
});
