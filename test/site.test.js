import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const { createSiteTracker, SiteTracker, MemoryStorage } = await import(process.env.SITE_TEST_BUNDLE === '1' ? '../dist/site.js' : '../src/index.js');
const key = 'gt_site_abcdefghijklmnopqrstuvwx';
const trackers = [];
const previousWindow = globalThis.window;
function target(extra = {}) {
  const listeners = new Map();
  const capture = options => options === true || options?.capture === true;
  return { ...extra,
    addEventListener(name, fn, options) { const rows = listeners.get(name) || []; rows.push({ fn, capture: capture(options) }); listeners.set(name, rows); },
    removeEventListener(name, fn, options) { listeners.set(name, (listeners.get(name) || []).filter(value => value.fn !== fn || value.capture !== capture(options))); },
    dispatch(name, event = {}, phase) { for (const listener of listeners.get(name) || []) if (!phase || listener.capture === (phase === 'capture')) listener.fn(event); }
  };
}
function browser({ privateMode = false, navigator = {}, href = 'https://studio.example/?email=secret%40example.com&utm_source=newsletter' } = {}) {
  const document = target({ referrer: 'https://search.example/find?secret=1', visibilityState: 'visible', documentElement: { scrollWidth: 1000, scrollHeight: 2000 } });
  const win = target({ location: { href }, document, navigator, innerWidth: 1000, innerHeight: 500, scrollY: 0, localStorage: new MemoryStorage() });
  win.history = { pushState(_state, _title, url) { win.location.href = new URL(url, win.location.href).href; }, replaceState(_state, _title, url) { win.location.href = new URL(url, win.location.href).href; } };
  if (privateMode) Object.defineProperty(win, 'localStorage', { get() { throw new Error('blocked'); } });
  globalThis.window = win; return win;
}
const ok = events => ({ ok: true, status: 200, json: async () => ({ accepted: events.length, duplicates: 0, dropped: 0, refused: 0, acceptedIds: events.map(event => event.eventId), droppedIds: [], refusedIds: [], paused: false }) });
function tracker(options = {}) { const value = createSiteTracker({ key, fetch: async (_url, request) => ok(JSON.parse(request.body).events), pageToken: false, ...options }); trackers.push(value); return value; }
afterEach(() => { for (const tracker of trackers.splice(0)) { tracker.optOut(); tracker.destroy(); tracker.grantConsent(); } globalThis.window = previousWindow; });

test('site mode validates options and leaves game identity separate', () => {
  browser(); assert.throws(() => new SiteTracker({ key: 'bad' }), TypeError);
  assert.throws(() => tracker({ consent: 'unknown' }), TypeError);
  const site = tracker(); assert.equal(site._queue.length, 1); assert.equal(site._queue[0].type, 'page_view');
  assert.equal(site._queue[0].url, 'https://studio.example/?utm_source=newsletter');
  assert.equal(site._queue[0].referrer, 'https://search.example');
  assert.equal(site._queue[0].timestamp > 1000000000000, true);
  assert.throws(() => site.track('typed text'), TypeError); assert.throws(() => site.track('click', { email: 'private' }), TypeError);
});
test('public marketing events preserve bounded campaign and decision dimensions without accepting personal fields', () => {
  browser(); const site = tracker();
  const cases = [
    ['ad_school_searched', { found: true }],
    ['ad_school_picked', { classification: '6A', locked: false }],
    ['ad_cta_clicked', { placement: 'job_card_subscribe', picked: true, locked: true }],
    ['ad_landing_viewed', { source: 'direct', medium: 'cpc', campaign: 'launch-2026', content: 'coach_ad.2' }],
  ];
  for (const [name, properties] of cases) {
    assert.equal(site.track(name, properties), true);
    assert.deepEqual(site._queue.at(-1).properties, properties);
  }
  for (const [name, properties] of [
    ['ad_school_searched', { query: 'private search' }],
    ['ad_school_picked', { classification: '7A', locked: false }],
    ['ad_cta_clicked', { placement: 'unregistered' }],
    ['ad_landing_viewed', { campaign: 'person@example.test' }],
    ['ad_landing_viewed', { source: 'phc_private' }],
    ['ad_landing_viewed', { content: 'x'.repeat(61) }],
  ]) assert.throws(() => site.track(name, properties), TypeError);
});
test('a navigation click belongs to the departing page even when its handler changes route before bubbling', () => {
  const win = browser(), site = tracker({ heatmaps: true });
  const button = { tagName: 'BUTTON', closest: () => null, parentElement: null };
  const event = { target: button, pageX: 250, pageY: 400, isTrusted: true };
  win.document.dispatch('click', event, 'capture');
  win.history.pushState({}, '', '/pricing');
  win.document.dispatch('click', event, 'bubble');
  assert.deepEqual(site._queue.map(value => value.type), ['page_view', 'heatmap', 'page_view']);
  const heatmap = site._queue[1];
  assert.equal(new URL(heatmap.url).pathname, '/');
  assert.deepEqual(heatmap.heatmap.clicks, [{ x: 25, y: 20, selector: 'button:nth-of-type(1)', count: 1 }]);
  assert.equal(site._clicks.size, 0, 'the old click must not be attached to the new page');
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
test('storage methods that throw retain opt-out in memory for subsequent trackers', () => {
  browser(); const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const first = tracker({ storage }); first.optOut(); first.destroy();
  const next = tracker({ storage }); assert.equal(next._queue.length, 0); next.grantConsent(); assert.equal(next._queue.length, 1);
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
test('a synchronous custom transport failure releases the latch and retries the same event', async () => {
  browser(); let calls = 0, first;
  const site = tracker({ fetch(_url, request) {
    const events = JSON.parse(request.body).events; calls++;
    if (calls === 1) { first = events[0].eventId; throw new Error('synchronous network adapter failure'); }
    assert.equal(events[0].eventId, first); return Promise.resolve(ok(events));
  } });
  assert.equal(await site.flush(), false); site._retryAt = 0;
  assert.equal(await site.flush(), true); assert.equal(calls, 2); assert.equal(site._queue.length, 0);
});
test('scheduled collection honors withdrawal or identity reset before transport starts', async () => {
  const win = browser(); let calls = 0, sent;
  const site = tracker({ fetch: async (_url, request) => { calls++; sent = JSON.parse(request.body).events; return ok(sent); } });
  const withdrawn = site.flush(); site.optOut(); assert.equal(await withdrawn, false); assert.equal(calls, 0);
  site.grantConsent(); const beforeReset = site._queue[0].visitorId;
  const reset = site.flush(); site.reset(); assert.equal(await reset, false); assert.equal(calls, 0);
  const denied = site.flush(); win.navigator.globalPrivacyControl = true; assert.equal(await denied, false); assert.equal(calls, 0);
  win.navigator.globalPrivacyControl = false;
  assert.equal(await site.flush(), true); assert.equal(calls, 1); assert.notEqual(sent[0].visitorId, beforeReset);
});
test('a stalled transport times out even when it ignores abort, and late acceptance cannot discard new activity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browser(); let resolveFirst, firstEvents, signal;
  const site = tracker({ fetch(_url, request) {
    firstEvents = JSON.parse(request.body).events; signal = request.signal;
    return new Promise(resolve => { resolveFirst = resolve; });
  } });
  const pending = site.flush(); await Promise.resolve();
  t.mock.timers.tick(10000); assert.equal(await pending, false); assert.equal(signal.aborted, true);
  site.track('fresh_activity'); const queued = site._queue.map(event => event.eventId);
  resolveFirst(ok(firstEvents)); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(site._queue.map(event => event.eventId), queued);
  site._retryAt = 0;
  site._fetch = async (_url, request) => { const events = JSON.parse(request.body).events; assert.deepEqual(events.map(event => event.eventId), queued); return ok(events); };
  assert.equal(await site.flush(), true); assert.equal(site._queue.length, 0);
});
test('a stalled response body has the same deadline and cannot change the queue after a successful retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browser(); let resolveBody, firstEvents, signal;
  const site = tracker({ fetch: async (_url, request) => {
    firstEvents = JSON.parse(request.body).events; signal = request.signal;
    return { status: 200, ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) };
  } });
  const pending = site.flush(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10000); assert.equal(await pending, false); assert.equal(signal.aborted, true);
  site._retryAt = 0; site._fetch = async (_url, request) => {
    const events = JSON.parse(request.body).events; assert.deepEqual(events, firstEvents); return ok(events);
  };
  assert.equal(await site.flush(), true); site.track('after_retry'); const queued = site._queue.map(event => event.eventId);
  resolveBody(await ok(firstEvents).json()); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(site._queue.map(event => event.eventId), queued);
});
test('fresh activity resumes after pause cooldown without billable probes or catch-up', async () => {
  const win = browser(); let requests = 0;
  const site = tracker({ fetch: async (_url, request) => { requests++; const events = JSON.parse(request.body).events; return { ok: false, status: 429, json: async () => ({ accepted: 0, duplicates: 0, dropped: 0, refused: events.length, acceptedIds: [], droppedIds: [], refusedIds: events.map(event => event.eventId), paused: true, reason: 'needs_funds' }) }; } });
  await site.flush(); assert.equal(site._queue.length, 0); assert.equal(site.track('before_refill'), false);
  site._pauseUntil = Date.now() - 1; await site.flush(); assert.equal(requests, 1); // no synthetic probe
  site._fetch = async (_url, request) => { const events = JSON.parse(request.body).events; assert.equal(events.length, 1); assert.equal(events[0].name, 'after_refill'); return ok(events); };
  assert.equal(site.track('after_refill'), true); await site.flush(); assert.equal(site._queue.length, 0);
  win.navigator.globalPrivacyControl = true; assert.equal(site.track('private'), false); site.optOut(); win.navigator.globalPrivacyControl = false; assert.equal(site.track('denied'), false);
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
test('large summaries split under the collector body bound and rate limits respect Retry-After', async () => {
  browser(); const site = tracker();
  const selector = Array(6).fill('custom-element:nth-of-type(123)').join(' > ');
  for (let n = 0; n < 25; n++) site._enqueue('heatmap', { heatmap: { viewport: 'small', clicks: Array.from({ length: 200 }, (_, x) => ({ x: x % 100, y: 2, selector, count: 1 })), scroll: Array(10).fill(1) } });
  let size = 0; site._fetch = async (_url, request) => { size = request.body.length; return { status: 429, ok: false, headers: { get: () => '90' }, json: async () => ({ error: 'rate_limited' }) }; };
  await site.flush(); assert.ok(size < 512 * 1024); assert.ok(site._retryAt - Date.now() > 85000); assert.equal(site._queue.length, 26);
});

test('registered public properties retain dimensions without accepting identity or free text', () => {
  browser(); const site = tracker();
  assert.equal(site.track('cta_dashboard_clicked', { section: 'hero', product: 'ravensight', surface: 'marketing' }), true);
  assert.deepEqual(site._queue.at(-1).properties, { section: 'hero', product: 'ravensight', surface: 'marketing' });
  assert.equal(site.track('custom_named_action'), true);
  for (const [name, properties] of [
    ['custom_named_action', { section: 'hero' }], ['cta_dashboard_clicked', { email: 'private@example.test' }],
    ['cta_dashboard_clicked', { section: 'typed personal text' }], ['cta_dashboard_clicked', { section: { text: 'secret' } }],
    ['landing_stage_selected', { stage_number: NaN }], ['landing_stage_selected', { stage_number: 0 }],
    ['landing_cta_clicked', { destination: '/auth/reset/secret' }], ['landing_cta_clicked', { destination: '/profile/person%40mail.test' }],
    ['landing_cta_clicked', { destination: '/signup?token=private' }], ['cta_dashboard_clicked', { section: 'gt_ingest_secret' }],
  ]) assert.throws(() => site.track(name, properties), TypeError);
  assert.throws(() => site.track('cta_dashboard_clicked', JSON.parse('{"__proto__":"bad"}')), TypeError);
  const fields = { repo: 'ravensight-js' }; site.track('sdk_repo_clicked', fields); fields.repo = 'mutated';
  assert.equal(site._queue.at(-1).properties.repo, 'ravensight-js');
});

test('attribution keeps all approved campaign fields, first touch, and latest tagged snapshot', () => {
  const win = browser({ href: 'https://studio.example/?utm_source=first&utm_id=campaign1&utm_source_platform=ads&gbraid=gb&wbraid=wb&ttclid=tt&email=private' });
  const site = tracker(), first = site.getAttribution();
  assert.deepEqual(first.first.campaign, { utm_source: 'first', utm_id: 'campaign1', utm_source_platform: 'ads', gbraid: 'gb', wbraid: 'wb', ttclid: 'tt' });
  assert.equal(first.first.landingPage, 'https://studio.example/');
  assert.equal(first.first.referrer, 'search.example');
  win.history.pushState({}, '', '/pricing?utm_source=second&utm_medium=email');
  assert.deepEqual(site.getAttribution().first, first.first);
  assert.deepEqual(site.getAttribution().last.campaign, { utm_source: 'second', utm_medium: 'email' });
  win.history.pushState({}, '', '/direct'); assert.equal(site.getAttribution().last.campaign.utm_source, 'second');
  const copy = site.getAttribution(); copy.first.campaign.utm_source = 'changed';
  assert.equal(site.getAttribution().first.campaign.utm_source, 'first');
  assert.equal(JSON.stringify(first).includes('visitorId'), false);
  site.optOut(); assert.equal(site.getAttribution(), null);
});

test('campaign values retain the existing 256 character bound and reject email/query payloads', () => {
  browser({ href: 'https://studio.example/?utm_campaign=' + 'a'.repeat(256) + '&utm_source=x%40example.test&utm_medium=' + 'z'.repeat(257) });
  const site = tracker(); assert.deepEqual(site.getAttribution().first.campaign, { utm_campaign: 'a'.repeat(256) });
  assert.equal(new URL(site._queue[0].url).searchParams.get('utm_campaign').length, 256);
});

test('returning browser retains first touch and first seen without inventing an account identity', () => {
  const win = browser({ href: 'https://studio.example/?utm_source=campaign' }); const site = tracker();
  const storage = win.localStorage, id = site._identity.visitorId, firstSeen = site._identity.firstSeenAt;
  site.destroy(); browser({ href: 'https://studio.example/' }).document.referrer = '';
  const returning = tracker({ storage });
  assert.equal(returning._identity.visitorId, id); assert.equal(returning._identity.firstSeenAt, firstSeen);
  assert.equal(returning.getAttribution().first.campaign.utm_source, 'campaign');
  assert.equal(returning.getAttribution().last.campaign.utm_source, 'campaign');
  assert.equal('userId' in returning._queue[0], false);
});

test('all protected auth and account paths and OAuth consent redirects suppress public capture', () => {
  for (const path of ['/auth', '/auth/reset?token=abc', '/oauth/authorize', '/oauth/consent', '/account/dashboard', '/login?redirect=%2Foauth%2Fconsent']) {
    const win = browser({ href: 'https://studio.example' + path }); const site = tracker({ autoPageviews: false, heatmaps: true });
    site.pageView(); assert.equal(site._queue.length, 0, path); assert.equal(site.track('click'), false);
    win.document.dispatch('click', { target: { closest: () => null, tagName: 'BUTTON' }, pageX: 1, pageY: 1 });
    assert.equal(site._clicks.size, 0);
  }
});

test('manual router mode counts only explicit completed routes and extra excluded paths', () => {
  const win = browser(); const site = tracker({ autoPageviews: false, excludedPaths: ['/settings'] });
  assert.equal(site._queue.length, 0); win.history.pushState({}, '', '/pricing'); assert.equal(site._queue.length, 0);
  site.pageView(); assert.equal(site._queue.length, 1);
  win.history.pushState({}, '', '/settings/team'); site.pageView(); assert.equal(site._queue.length, 1);
  assert.throws(() => tracker({ excludedPaths: ['not/absolute'] }), TypeError);
});

test('legacy DNT values and global privacy control block collection before storage', () => {
  for (const navigator of [{ doNotTrack: 'yes' }, { msDoNotTrack: '1' }, { msDoNotTrack: 'yes' }, { globalPrivacyControl: true }]) {
    const win = browser({ navigator }); const site = tracker({ engagement: true });
    assert.equal(site._queue.length, 0); assert.equal(win.localStorage._map.size, 0);
  }
});

test('engagement and heatmap activity share one bounded event joined to its pageview', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const win = browser(); const site = tracker({ engagement: true, heatmaps: true });
  const view = site._queue[0]; t.mock.timers.tick(12000);
  win.document.dispatch('click', { target: { closest: () => null, tagName: 'BUTTON' }, pageX: 100, pageY: 100 });
  site._summarize('hidden'); const summary = site._queue.at(-1);
  assert.equal(site._queue.length, 2); assert.equal(summary.type, 'engagement');
  assert.deepEqual(summary.engagement, { activeMs: 12000, durationMs: 12000, pageViewId: view.pageViewId, reason: 'hidden' });
  assert.equal(summary.heatmap.clicks.length, 1); assert.equal(summary.sessionId, view.sessionId);
  assert.equal(site._summarize('hidden'), false);
});

test('engagement stops in background and after inactivity; each delta is disjoint', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const win = browser(); const site = tracker({ engagement: true });
  t.mock.timers.tick(10000); win.document.visibilityState = 'hidden'; win.document.dispatch('visibilitychange');
  assert.equal(site._queue.at(-1).engagement.activeMs, 10000);
  t.mock.timers.tick(120000); site._accrue(); assert.equal(site._activeMs, 0);
  win.document.visibilityState = 'visible'; win.document.dispatch('visibilitychange');
  t.mock.timers.tick(60000); site._summarize('interval');
  assert.equal(site._queue.at(-1).engagement.activeMs, 30000);
  assert.equal(site._summarize('interval'), false);
});

test('periodic summaries reserve a final slot and never exceed six per page', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  browser(); const site = tracker({ engagement: true });
  for (let n = 0; n < 8; n++) { site._activity(); t.mock.timers.tick(300000); site._summarize('interval'); }
  assert.equal(site._queue.filter(x => x.type === 'engagement').length, 5);
  site._summarize('pagehide'); assert.equal(site._queue.filter(x => x.type === 'engagement').length, 6);
  site._activity(); t.mock.timers.tick(10000); site._summarize('hidden');
  assert.equal(site._queue.filter(x => x.type === 'engagement').length, 6);
});

test('a delayed old-page summary cannot move into the next session', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const win = browser(); const site = tracker({ engagement: true }); const view = site._queue[0];
  t.mock.timers.tick(31 * 60000); win.history.pushState({}, '', '/next');
  const summary = site._queue.find(x => x.type === 'engagement'), next = site._queue.at(-1);
  assert.equal(summary.sessionId, view.sessionId); assert.equal(summary.engagement.pageViewId, view.pageViewId);
  assert.notEqual(next.sessionId, view.sessionId);
});
test('a platform internal-budget pause discards refused work with the same no-catch-up contract', async () => {
  browser(); const site = tracker({ fetch: async (_url, request) => {
    const events = JSON.parse(request.body).events;
    return { ok: false, status: 429, json: async () => ({ accepted: 0, duplicates: 0, dropped: 0, refused: events.length, acceptedIds: [], droppedIds: [], refusedIds: events.map(event => event.eventId), paused: true, reason: 'internal_capacity' }) };
  } });
  assert.equal(await site.flush(), true); assert.equal(site.paused, true); assert.equal(site._queue.length, 0);
  assert.equal(site.track('more_activity'), false); site.resume(); assert.equal(site._queue.length, 1);
});


test('pagehide sends new actions immediately while an ordinary request is still in flight', async () => {
  const win = browser(); let finishFirst; const calls = [];
  const site = tracker({ fetch(_url, request) {
    const events = JSON.parse(request.body).events; calls.push({ request, events });
    if (calls.length === 1) return new Promise(resolve => { finishFirst = () => resolve(ok(events)); });
    return Promise.resolve(ok(events));
  } });
  const first = site.flush(); await Promise.resolve();
  site.track('form_submit_success', { form: 'contact' }); const successId = site._queue.at(-1).eventId;
  win.dispatch('pagehide'); await site._exitFlight;
  assert.equal(calls.length, 2); assert.equal(calls[0].request.keepalive, false); assert.equal(calls[1].request.keepalive, true);
  assert.equal(calls[1].events[0].eventId, calls[0].events[0].eventId);
  assert.ok(calls[1].events.some(event => event.eventId === successId));
  assert.equal(site._queue.length, 0);
  site.track('after_unload_ack'); const remainingId = site._queue[0].eventId;
  finishFirst(); await first;
  assert.deepEqual(site._queue.map(event => event.eventId), [remainingId]);
});

test('concurrent keepalive requests share a bounded lane and honor consent withdrawal', async () => {
  browser(); const calls = []; let finish;
  const site = tracker({ fetch(_url, request) {
    calls.push(request); const events = JSON.parse(request.body).events;
    return new Promise(resolve => { finish = () => resolve(ok(events)); });
  } });
  const first = site.flush({ keepalive: true }); const next = site.flush({ keepalive: true });
  await Promise.resolve(); assert.equal(calls.length, 1);
  finish(); await Promise.all([first, next]);
  site.track('pending'); const withdrawn = site.flush({ keepalive: true }); site.optOut();
  assert.equal(await withdrawn, false); assert.equal(calls.length, 1);
});


test('a new outcome after visibilityhide is sent on pagehide without waiting for the earlier keepalive', async () => {
  const win = browser(); const calls = []; const complete = [];
  const site = tracker({ fetch(_url, request) {
    const events = JSON.parse(request.body).events; calls.push({ request, events });
    return new Promise(resolve => complete.push(() => resolve(ok(events))));
  } });
  win.document.visibilityState = 'hidden'; win.document.dispatch('visibilitychange'); await Promise.resolve();
  const first = site._exitFlight;
  site.track('form_submit_success', { form: 'contact' }); const successId = site._queue.at(-1).eventId;
  win.dispatch('pagehide'); await Promise.resolve(); const last = site._exitFlight;
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.request.keepalive));
  assert.deepEqual(calls[1].events.map(event => event.eventId), [successId]);
  assert.ok(calls.reduce((sum, call) => sum + Buffer.byteLength(call.request.body), 0) <= 45000);
  complete[1](); await last; complete[0](); await first;
  assert.equal(site._queue.length, 0); assert.equal(site._exitRequests.size, 0);
});


test('an oversized optional summary cannot block a small accepted conversion during exit', async () => {
  browser(); const requests = []; const site = tracker({ fetch: async (_url, request) => { requests.push(request); return ok(JSON.parse(request.body).events); } });
  await site.flush(); requests.length = 0;
  const selector = Array(6).fill('custom-long-element:nth-of-type(123)').join(' > ');
  site._enqueue('heatmap', { heatmap: { viewport: 'large', clicks: Array.from({ length: 200 }, (_, x) => ({ x: x % 100, y: 2, selector, count: 1 })), scroll: Array(10).fill(1) } });
  site.track('form_submit_success', { form: 'contact' });
  await site.flush({ keepalive: true });
  assert.equal(requests.length, 1); assert.ok(Buffer.byteLength(requests[0].body) <= 45000);
  assert.deepEqual(JSON.parse(requests[0].body).events.map(event => event.name), ['form_submit_success']);
  assert.equal(site._queue.length, 1); assert.equal(site._queue[0].type, 'heatmap');
});


test('long legitimate advertising IDs survive while recognizable credentials are omitted', () => {
  const clickId = 'testAdClick' + 'aZ09_-'.repeat(30);
  browser({ href: 'https://studio.example/?gclid=' + clickId + '&utm_source=paid_search&utm_content=gt_ingest_private&fbclid=eyJhbGciOiJIUzI1NiJ9.secret.payload' });
  const site = tracker();
  assert.equal(new URL(site._queue[0].url).searchParams.get('gclid'), clickId);
  assert.deepEqual(site.getAttribution().first.campaign, { utm_source: 'paid_search', gclid: clickId });
});

test('website transport suppresses automatic HTTP referrers in ordinary and outcome modes', async () => {
  const win = browser(); win.location.origin = 'https://studio.example';
  for (const outcomesOnly of [false, true]) {
    let request;
    const site = tracker({ outcomesOnly, fetch: async (_url, value) => { request = value; return ok(JSON.parse(value.body).events); } });
    if (outcomesOnly) site.trackOutcome('signup_form_viewed');
    await site.flush({ keepalive: true });
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.keepalive, true);
  }
});

test('explicit outcome-only mode never observes auth URLs, referrers, fields or navigation', async () => {
  const win = browser({ href: 'https://studio.example/register?token=private&email=private' });
  win.location = { origin: 'https://studio.example', get href() { throw Error('must not read auth address'); } };
  Object.defineProperty(win.document, 'referrer', { get() { throw Error('must not read auth referrer'); } });
  const push = win.history.pushState, replace = win.history.replaceState;
  const site = tracker({ outcomesOnly: true });
  assert.equal(site._queue.length, 0);
  assert.equal(win.localStorage._map.size, 0);
  assert.equal(win.history.pushState, push); assert.equal(win.history.replaceState, replace);
  assert.equal(site.pageView(), false); assert.equal(site.getAttribution(), null);
  assert.equal(site.trackOutcome('signup_form_viewed'), true);
  assert.equal(site.trackOutcome('signup_failed', { code: 'network' }), true);
  assert.equal(site.trackOutcome('checkout_failed', { plan: 'annual', code: 'billing_disabled' }), true);
  for (const event of site._queue) {
    assert.equal(event.type, 'custom'); assert.equal(event.url, 'https://studio.example');
    assert.ok(['signup', 'checkout'].includes(event.context));
    for (const key of ['referrer', 'attribution', 'pageViewId', 'engagement', 'heatmap']) assert.equal(Object.hasOwn(event, key), false);
  }
  assert.equal(new Set(site._queue.map(event => event.sessionId)).size, 1);
  for (const name of ['click', 'scroll', 'keydown']) win.document.dispatch(name, { isTrusted: true });
  assert.equal(site._queue.length, 3);
  assert.throws(() => site.track('cta_docs_clicked'), TypeError);
  assert.throws(() => site.trackOutcome('cta_docs_clicked'), TypeError);
  assert.throws(() => site.trackOutcome('signup_failed', { code: 'private email' }), TypeError);
  assert.throws(() => site.trackOutcome('signup_failed', { code: 'network', product: 'realityse' }), TypeError);
  assert.throws(() => tracker({ outcomesOnly: true, heatmaps: true }), TypeError);
  assert.throws(() => tracker({ outcomesOnly: 'true' }), TypeError);
  win.document.visibilityState = 'hidden'; win.document.dispatch('visibilitychange');
  await site.flush(); assert.equal(site._queue.length, 0);
});

test('outcomes honor opt-in, privacy signals, withdrawal and funding without capturing pages', async () => {
  const win = browser(); win.location.origin = 'https://studio.example';
  const site = tracker({ outcomesOnly: true, consent: 'opt_in' });
  assert.equal(site.trackOutcome('signup_form_viewed'), false);
  assert.equal(win.localStorage._map.size, 0);
  site.grantConsent(); assert.equal(site._queue.length, 0);
  win.navigator.globalPrivacyControl = true;
  assert.equal(site.trackOutcome('signup_form_viewed'), false);
  win.navigator.globalPrivacyControl = false; win.navigator.doNotTrack = '1';
  assert.equal(site.trackOutcome('signup_form_viewed'), false);
  win.navigator.doNotTrack = '0';
  assert.equal(site.trackOutcome('signup_form_viewed'), true);
  site._paused = true; site._pauseUntil = Date.now() + 60000;
  assert.equal(site.trackOutcome('signup_failed', { code: 'network' }), false);
  site.optOut(); assert.equal(site._queue.length, 0);
  assert.equal(site.trackOutcome('signup_form_viewed'), false);
  site.resume(); assert.equal(site._queue.length, 0);
  const ordinary = tracker();
  assert.throws(() => ordinary.trackOutcome('signup_form_viewed'), TypeError);
  assert.throws(() => ordinary.track('signup_form_viewed'), TypeError);
});

test('page views carry a signed page token fetched at page load and held at least the server minimum before sending', async () => {
  browser();
  const calls = [];
  const fetch = async (url, request) => {
    calls.push({ url, request });
    if (String(url).includes('/site/collect/token')) return { ok: true, status: 200, json: async () => ({ token: 'eyJ2IjoxfQ.c2lnbmF0dXJl', minDelayMs: 50 }) };
    return ok(JSON.parse(request.body).events);
  };
  const site = tracker({ fetch, pageToken: true });
  const tokenCall = calls.find(call => String(call.url).includes('/site/collect/token'));
  assert.ok(tokenCall, 'a token is requested when the page loads');
  assert.equal(tokenCall.request.method, 'GET'); assert.equal(tokenCall.request.credentials, 'omit');
  assert.ok(String(tokenCall.url).includes(`key=${key}`));
  const started = Date.now();
  await site.flush();
  const sent = calls.filter(call => String(call.url).endsWith('/site/collect'));
  assert.equal(sent.length, 1);
  const views = JSON.parse(sent[0].request.body).events.filter(event => event.type === 'page_view');
  assert.ok(views.length >= 1);
  assert.ok(views.every(event => event.pageToken === 'eyJ2IjoxfQ.c2lnbmF0dXJl'));
  assert.ok(Date.now() - started >= 40, 'waits until the token has been held for the minimum time');
  // Only page views carry it.
  site.track('cta_clicked'); await site.flush();
  const custom = JSON.parse(calls.filter(call => String(call.url).endsWith('/site/collect')).at(-1).request.body).events.find(event => event.type === 'custom');
  assert.equal(custom.pageToken, undefined);
});
test('a failed token request never blocks collection', async () => {
  browser();
  const site = tracker({ pageToken: true, fetch: async (url, request) => String(url).includes('/site/collect/token') ? { ok: false, status: 503, json: async () => ({}) } : ok(JSON.parse(request.body).events) });
  assert.equal(await site.flush(), true);
});
// Timers that keep the process alive (unref'd ones are not counted).
const liveTimers = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function heldTracker({ minDelayMs = 1000, token = true } = {}) {
  const calls = [];
  const fetch = async (url, request) => {
    calls.push({ url: String(url), request });
    if (String(url).includes('/site/collect/token')) return token ? { ok: true, status: 200, json: async () => ({ token: 'eyJ2IjoxfQ.c2lnbmF0dXJl', minDelayMs }) } : new Promise(() => {});
    return ok(JSON.parse(request.body).events);
  };
  return { site: tracker({ fetch, pageToken: true }), collects: () => calls.filter(call => call.url.endsWith('/site/collect')) };
}
test('opting out while a page view is held for its token sends nothing and ends the wait at once', async () => {
  browser(); const { site, collects } = heldTracker();
  const held = site.flush(); await sleep(20);
  assert.equal(collects().length, 0, 'the page view is still held');
  const before = liveTimers(), started = Date.now();
  site.optOut();
  assert.equal(before - liveTimers(), 1, 'the hold timer is cleared');
  assert.equal(await held, false);
  assert.ok(Date.now() - started < 500, 'the wait ends early instead of running out');
  await sleep(1100);
  assert.equal(collects().length, 0, 'nothing is sent when the hold would have ended');
});
test('destroying the tracker while a page view is held sends nothing after teardown and leaves no timer', async () => {
  browser(); const { site, collects } = heldTracker();
  const held = site.flush(); await sleep(20);
  assert.equal(collects().length, 0, 'the page view is still held');
  const before = liveTimers(), started = Date.now();
  site.destroy();
  assert.equal(before - liveTimers(), 1, 'the hold timer is cleared');
  assert.equal(await held, false, 'the held send is dropped');
  assert.ok(Date.now() - started < 500, 'the wait ends early instead of running out');
  // destroy() keeps its documented final keepalive flush, scheduled at teardown; a closing page sends without the token.
  const final = collects();
  assert.equal(final.length, 1); assert.equal(final[0].request.keepalive, true);
  assert.ok(JSON.parse(final[0].request.body).events.every(event => event.pageToken === undefined));
  await sleep(1100);
  assert.equal(collects().length, 1, 'nothing is sent when the hold would have ended');
});
test('opting out while the token request is pending sends nothing and clears the two second limit', async () => {
  browser(); const { site, collects } = heldTracker({ token: false });
  const held = site.flush(); await sleep(20);
  const before = liveTimers(), started = Date.now();
  site.optOut();
  assert.equal(before - liveTimers(), 1, 'the limit timer is cleared');
  assert.equal(await held, false);
  assert.ok(Date.now() - started < 500);
  assert.equal(collects().length, 0);
});
test('a privacy signal or a reset that arrives during the hold stops the held send', async () => {
  const win = browser(); const signalled = heldTracker({ minDelayMs: 100 });
  const blocked = signalled.site.flush(); await sleep(20);
  win.navigator.globalPrivacyControl = true;
  assert.equal(await blocked, false); assert.equal(signalled.collects().length, 0);
  browser(); const resetting = heldTracker({ minDelayMs: 100 });
  const reset = resetting.site.flush(); await sleep(20);
  resetting.site.reset();
  assert.equal(await reset, false); assert.equal(resetting.collects().length, 0, 'the events from before the reset are never sent');
});
