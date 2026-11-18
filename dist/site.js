// Generated from src/index.js. No external imports or automatic initialization.

export const DEFAULT_API_URL = 'https://api.ravensight.io/api/v1';

function utf8Bytes(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

function utf8Length(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function queueKeyHash(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of utf8Bytes(String(text))) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    }
  } catch (_err) {
    // Fall through to Math.random.
  }
  return 'x' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export class MemoryStorage {
  constructor() {
    this._map = new Map();
  }

  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }

  setItem(key, value) {
    this._map.set(key, String(value));
  }

  removeItem(key) {
    this._map.delete(key);
  }
}

export function normalizeApiUrl(url) {
  const raw = String(url == null || url === '' ? DEFAULT_API_URL : url).trim();
  const trimmed = raw.replace(/\/+$/, '');
  return /\/api\/v1$/.test(trimmed) ? trimmed : trimmed + '/api/v1';
}

export function parseRetryAfterMs(value) {
  if (value == null) return 0;
  const seconds = Number(String(value).trim());
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

// Website mode deliberately has no player authentication or free-form data.
const SITE_ATTRIBUTION = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'utm_source_platform', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'rs_link'];
// Mirrored from the platform public-events.json contract, version 3.
const SITE_PUBLIC_EVENTS = {"version":3,"limits":{"properties":24,"propertyBytes":4096,"batch":50,"engagementSummariesPerPage":6,"periodicSummaryMs":300000},"types":{"token":{"type":"string","max":80,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"},"slug":{"type":"string","max":120,"pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"},"catalog":{"type":"string","max":24,"pattern":"^[0-9]+$"},"path":{"type":"string","max":500,"pattern":"^/[^?#@\\\\]*$"},"count":{"type":"number","integer":true,"min":0,"max":1000000},"position":{"type":"number","integer":true,"min":1,"max":100},"flag":{"type":"boolean"},"campaign_tag":{"type":"string","max":60,"pattern":"^[a-z0-9_.-]{1,60}$"},"location":{"type":"enum","values":["header","footer","body","hero","sidebar","inline","bottom","nav"]},"form":{"type":"enum","values":["newsletter","contact","careers","support"]},"failure":{"type":"enum","values":["rejected","network","validation","unavailable"]},"error":{"type":"enum","values":["type_error","range_error","syntax_error","reference_error","network","unknown"]},"component":{"type":"enum","values":["runtime","promise","auth","play_catalog","play_transport","form"]},"product":{"type":"enum","values":["realityse","ravensight"]},"surface":{"type":"enum","values":["marketing","website","docs","blog"]}},"common":{"product":"product","surface":"surface","landing_page":"token","landing_version":"token"},"contextEvents":{"signup_form_viewed":"signup","signup_failed":"signup","checkout_failed":"checkout"},"events":{"signup_form_viewed":{},"signup_failed":{"code":{"type":"enum","values":["email_unconfirmed","invalid_input","email_in_use","rate_limited","network","unavailable","unknown"]}},"checkout_failed":{"plan":{"type":"enum","values":["monthly","annual"]},"code":{"type":"enum","values":["billing_disabled","billing_misconfigured","already_subscribed","invalid_plan","rate_limited","network","unavailable","unknown"]}},"navigation_click":{"location":"location","route":"token"},"game_link_click":{"catalog_id":"catalog","action":{"type":"enum","values":["play","learn_more","catalog","store","website"]},"destination":{"type":"enum","values":["apple","google_play","steam","game_site"]}},"external_link_click":{"destination":"token","location":"location"},"promotion_action":{"action":{"type":"enum","values":["dismiss","open"]}},"content_filter_change":{"section":{"type":"enum","values":["games","shop","play","accordion"]},"value":"slug"},"content_link_click":{"content_id":"slug","section":{"type":"enum","values":["blog","news","press","play"]},"action":{"type":"enum","values":["open","cta"]}},"form_submit_attempt":{"form":"form"},"form_submit_success":{"form":"form"},"form_submit_failure":{"form":"form","error_code":"failure"},"page_not_found":{"route":{"type":"enum","values":["not_found"]},"referrer":{"type":"enum","values":["internal","external","none"]}},"diagnostic":{"error_code":"error","component":"component"},"website_error":{"fingerprint":"token","error_code":"error","component":"component"},"cta_dashboard_clicked":{"section":"token","cta_location":"token"},"cta_docs_clicked":{"section":"token"},"sdk_repo_clicked":{"repo":"slug"},"pricing_viewed":{},"landing_page_viewed":{},"landing_cta_clicked":{"cta_location":"token","destination":"path"},"landing_stage_selected":{"stage":"token","stage_number":"position"},"landing_faq_opened":{"question_number":"position"},"landing_section_viewed":{"section":"token"},"ad_school_searched":{"found":"flag"},"ad_school_picked":{"classification":{"type":"enum","values":["1A","2A","3A","4A","5A","6A"]},"locked":"flag"},"ad_cta_clicked":{"placement":{"type":"enum","values":["hero","job_card_free","job_card","job_card_subscribe","finish","sticky"]},"picked":"flag","locked":"flag"},"ad_landing_viewed":{"source":"campaign_tag","medium":"campaign_tag","campaign":"campaign_tag","content":"campaign_tag"},"download":{"catalog_id":"catalog","destination":"token"},"outbound_click":{"destination":"token","location":"location"}}};
const SITE_SESSION_MS = 30 * 60 * 1000;
const SITE_MEMORY_STORAGE = new MemoryStorage();
// Advertising click IDs are often long opaque strings. Length alone is not a
// secret detector for these explicitly permitted attribution fields.
function siteCampaignValue(value) {
  return typeof value === 'string' && /^[A-Za-z0-9 _.:~+-]{1,256}$/.test(value)
    && !/(?:bearer|password|secret|token|authorization)[=:]|^Bearer\s|^(?:gt_(?:ingest|site)_|ph[ctx]_|sk-(?:live|test)-)|^eyJ[A-Za-z0-9_-]+\./i.test(value);
}
function siteAddress(value, excludedPaths = []) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /^\/(?:auth|oauth|account|r|c|u)(?:\/|$)/i.test(url.pathname)) return null;
    const redirect = url.searchParams.get('redirect');
    if (redirect && /^\/?oauth(?:\/|$)/i.test(redirect)) return null;
    if (excludedPaths.some(path => url.pathname === path || url.pathname.startsWith(path.replace(/\/$/, '') + '/'))) return null;
    url.pathname = url.pathname.replace(/\/[^/]*(?:@|%40)[^/]*(?=\/|$)/gi, '/:private').replace(/\/[A-Za-z0-9_-]{48,}(?=\/|$)/g, '/:private');
    const safe = new URL(url.origin + url.pathname);
    for (const key of SITE_ATTRIBUTION) { const value_ = url.searchParams.get(key); if (siteCampaignValue(value_)) safe.searchParams.set(key, value_); }
    return safe.href;
  } catch { return null; }
}
function siteSelector(target) {
  if (!target || typeof target.closest !== 'function' || target.closest('form,input,textarea,select,option,[contenteditable],[data-ravensight-private],[data-ravensight-ignore]')) return null;
  const parts = [];
  let node = target;
  while (node && parts.length < 6) {
    const tag = String(node.tagName || '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(tag)) break;
    const siblings = node.parentElement ? Array.from(node.parentElement.children || []).filter(value => value.tagName === node.tagName) : [node];
    parts.unshift(`${tag}:nth-of-type(${Math.max(1, siblings.indexOf(node) + 1)})`);
    node = node.parentElement;
  }
  const selector = parts.join(' > ');
  return selector && selector.length <= 240 ? selector : null;
}
function siteCampaign(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of SITE_ATTRIBUTION) if (siteCampaignValue(value[key])) result[key] = value[key];
  return result;
}
function siteTouch(value) {
  if (!value || typeof value !== 'object') return null;
  const address = siteAddress(value.landingPage);
  if (!address || address.length > 2048) return null;
  const url = new URL(address);
  let referrer = '';
  try { if (value.referrer) referrer = new URL(value.referrer.includes('://') ? value.referrer : 'https://' + value.referrer).hostname; } catch {}
  return { landingPage: url.origin + url.pathname, referrer, campaign: siteCampaign(value.campaign) };
}
function siteProperties(name, input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Website properties must be a registered scalar map.');
  const keys = Object.keys(input);
  const event = SITE_PUBLIC_EVENTS.events[name];
  if (keys.length > SITE_PUBLIC_EVENTS.limits.properties || (keys.length && !event)) throw new TypeError('Website event properties are not registered.');
  const schema = { ...SITE_PUBLIC_EVENTS.common, ...event }, result = {};
  for (const key of keys) {
    if (!Object.hasOwn(schema, key)) throw new TypeError('Website event property is not registered: ' + key);
    const definition = typeof schema[key] === 'string' ? SITE_PUBLIC_EVENTS.types[schema[key]] : schema[key];
    const value = input[key];
    let valid = definition.type === 'enum' ? definition.values.includes(value) : typeof value === definition.type;
    if (valid && definition.type === 'string') {
      valid = value.length <= definition.max && new RegExp(definition.pattern).test(value) && !/^(?:gt_(?:ingest|site)_|ph[ctx]_)/i.test(value);
      if (valid && schema[key] === 'path') {
        const safe = siteAddress('https://analytics.invalid' + value);
        valid = !!safe && new URL(safe).pathname === value;
      }
    }
    if (valid && definition.type === 'number') valid = Number.isFinite(value) && (!definition.integer || Number.isInteger(value)) && value >= definition.min && value <= definition.max;
    if (!valid) throw new TypeError('Invalid website event property: ' + key);
    result[key] = value;
  }
  if (utf8Length(JSON.stringify(result)) > SITE_PUBLIC_EVENTS.limits.propertyBytes) throw new TypeError('Website event properties are too large.');
  return result;
}

/** Privacy-limited browser analytics. No cookies, text capture or player IDs. */
export class SiteTracker {
  constructor(options = {}) {
    if (!/^gt_site_[A-Za-z0-9_-]{16,128}$/.test(options.key || '')) throw new TypeError('A website key is required.');
    if (options.consent !== undefined && !['opt_in', 'opt_out'].includes(options.consent)) throw new TypeError('Consent must be opt_in or opt_out.');
    if (options.excludedPaths !== undefined && (!Array.isArray(options.excludedPaths) || options.excludedPaths.length > 40 || options.excludedPaths.some(path => typeof path !== 'string' || !/^\/[A-Za-z0-9_/-]{0,180}$/.test(path)))) throw new TypeError('Excluded paths must be bounded absolute paths.');
    if (options.outcomesOnly !== undefined && typeof options.outcomesOnly !== 'boolean') throw new TypeError('outcomesOnly must be a boolean.');
    if (options.outcomesOnly && (options.heatmaps || options.engagement || options.autoPageviews === true)) throw new TypeError('Outcome-only mode cannot capture pages, engagement or heatmaps.');
    this._outcomesOnly = options.outcomesOnly === true;
    this.key = options.key;
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this._window = typeof window !== 'undefined' ? window : null;
    this._document = this._window?.document || (typeof document !== 'undefined' ? document : null);
    this._navigator = this._window?.navigator || (typeof navigator !== 'undefined' ? navigator : {});
    this._fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this._storage = options.storage || SITE_MEMORY_STORAGE;
    if (!options.storage) { try { this._storage = this._window?.localStorage || this._storage; } catch {} }
    this._storageKey = `ravensight_site_${queueKeyHash(this.key)}`;
    this._preferenceKey = `${this._storageKey}_opt_out`;
    this._allowed = options.consent !== 'opt_in';
    try { if (this._storage.getItem(this._preferenceKey) === 'true') this._allowed = false; } catch {}
    if (SITE_MEMORY_STORAGE.getItem(this._preferenceKey) === 'true') this._allowed = false;
    this._heatmaps = options.heatmaps === true;
    this._engagement = options.engagement === true;
    this._excludedPaths = options.excludedPaths || [];
    this._autoPageviews = !this._outcomesOnly && options.autoPageviews !== false;
    this._queue = []; this._listeners = []; this._identity = null; this._inFlight = null; this._exitFlight = null; this._exitRequests = new Set();
    this._paused = false; this._pauseUntil = 0; this._destroyed = false; this._retryAt = 0; this._attempts = 0;
    this._lastLocation = null; this._page = null; this._clicks = new Map(); this._scroll = Array(10).fill(0);
    this._summaryCount = 0; this._summaryStart = Date.now(); this._pageActive = false;
    this._pageViewId = null; this._pageSessionId = null; this._activeMs = 0; this._engagementTick = Date.now(); this._lastActivity = Date.now();
    this._visible = this._document?.visibilityState !== 'hidden'; this._focused = true;
    this._firstNavigation = true;
    if (this._outcomesOnly) {
      // Lifecycle delivery only: no navigation, clicks, scroll, key activity or
      // attribution observation. Applications explicitly name each safe outcome.
      this._on(this._window, 'pagehide', () => this.flush({ keepalive: true }));
      this._on(this._document, 'visibilitychange', () => { if (this._document?.visibilityState === 'hidden') this.flush({ keepalive: true }); });
      this._timer = setInterval(() => this.flush(), 5000);
      this._timer?.unref?.();
      return;
    }
    this._on(this._window, 'popstate', () => { if (this._autoPageviews) this._navigation(); });
    this._on(this._window, 'hashchange', () => { if (this._autoPageviews) this._navigation(); });
    this._on(this._window, 'pagehide', () => { this._summarize('pagehide'); this._visible = false; this.flush({ keepalive: true }); });
    this._on(this._window, 'pageshow', () => { this._visible = this._document?.visibilityState !== 'hidden'; this._activity(); });
    this._on(this._document, 'visibilitychange', () => {
      this._accrue(); this._visible = this._document.visibilityState !== 'hidden';
      if (!this._visible) { this._summarize('hidden'); this.flush({ keepalive: true }); }
      else this._activity();
    });
    this._on(this._window, 'focus', () => { this._focused = true; this._activity(); });
    this._on(this._window, 'blur', () => { this._accrue(); this._focused = false; });
    // Only activity time is observed. Keyboard values/text are never read.
    this._on(this._document, 'keydown', () => this._activity());
    // Record the public click before an application handler changes route or
    // destroys the tracker. Navigation then flushes it with the old page.
    this._on(this._document, 'click', event => this._click(event), { capture: true });
    this._on(this._window, 'scroll', () => this._scrolled(), { passive: true });
    const history = this._window?.history;
    if (history) for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      const tracker = this;
      const wrapped = function (...args) { const result = original.apply(this, args); if (tracker._autoPageviews) tracker._navigation(); return result; };
      history[method] = wrapped;
      this._listeners.push(() => { if (history[method] === wrapped) history[method] = original; });
    }
    this._timer = setInterval(() => {
      this._accrue();
      if (Date.now() - this._summaryStart >= 300000) this._summarize('interval');
      this.flush();
    }, 5000);
    this._timer?.unref?.();
    if (this._autoPageviews) this._navigation();
  }
  _on(target, name, listener, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, listener, options);
    this._listeners.push(() => target.removeEventListener(name, listener, options));
  }
  _privacyBlocked() { return this._navigator.globalPrivacyControl === true || [this._navigator.doNotTrack, this._navigator.msDoNotTrack, this._window?.doNotTrack].some(value => ['1', 'yes'].includes(String(value).toLowerCase())); }
  _enabled() {
    // Cooldown never creates an event. Only fresh activity can collect again;
    // the refused queue was discarded at the pause and is never replayed.
    if (this._paused && Date.now() >= this._pauseUntil) this._paused = false;
    return this._allowed && !this._privacyBlocked() && !this._paused && !this._destroyed;
  }
  _read() { try { return JSON.parse(this._storage.getItem(this._storageKey) || SITE_MEMORY_STORAGE.getItem(this._storageKey) || 'null'); } catch { try { return JSON.parse(SITE_MEMORY_STORAGE.getItem(this._storageKey) || 'null'); } catch { return null; } } }
  _write(value) {
    try { value ? this._storage.setItem(this._storageKey, JSON.stringify(value)) : this._storage.removeItem(this._storageKey); }
    catch { if (value) SITE_MEMORY_STORAGE.setItem(this._storageKey, JSON.stringify(value)); }
    if (!value) SITE_MEMORY_STORAGE.removeItem(this._storageKey);
  }
  _session() {
    const now = Date.now();
    if (!this._identity) this._identity = this._read();
    if (!this._identity || !/^[A-Za-z0-9_.:-]{8,128}$/.test(this._identity.visitorId || '')) this._identity = { visitorId: randomId(), sessionId: randomId(), last: now, firstSeenAt: now };
    if (!Number.isSafeInteger(this._identity.firstSeenAt) || this._identity.firstSeenAt <= 0 || this._identity.firstSeenAt > now) this._identity.firstSeenAt = now;
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(this._identity.sessionId || '') || !Number.isFinite(this._identity.last) || now - this._identity.last >= SITE_SESSION_MS || this._identity.last > now) this._identity.sessionId = randomId();
    this._identity.last = now; this._write(this._identity);
    return this._identity;
  }
  _rememberAttribution(address) {
    if (!address || !this._enabled()) return;
    const identity = this._session(), url = new URL(address);
    let referrer = '';
    try { referrer = this._document?.referrer ? new URL(this._document.referrer).hostname : ''; } catch {}
    const current = { landingPage: url.origin + url.pathname, referrer, campaign: siteCampaign(Object.fromEntries(url.searchParams)) };
    const first = siteTouch(identity.attribution?.first) || current;
    let last = siteTouch(identity.attribution?.last) || first;
    // A new tagged landing replaces the whole snapshot. Direct revisits and
    // internal route changes never erase an earlier acquired campaign.
    if (Object.keys(current.campaign).length || (this._firstNavigation && referrer && referrer !== url.hostname)) last = current;
    identity.attribution = { first, last }; this._write(identity); this._firstNavigation = false;
  }
  /** Sanitized attribution for a separate authenticated acquisition handoff. */
  getAttribution() {
    if (this._outcomesOnly || !this._enabled() || !this._identity) return null;
    const first = siteTouch(this._identity.attribution?.first), last = siteTouch(this._identity.attribution?.last);
    return first && last ? { first, last } : null;
  }
  _enqueue(type, extra = {}, address = this._page) {
    if (!this._enabled() || !address) return false;
    const summary = type === 'engagement' || type === 'heatmap';
    const identity = summary && this._identity ? this._identity : this._session();
    let referrer = '';
    if (!extra.context) { try { referrer = this._document?.referrer ? new URL(this._document.referrer).origin : ''; } catch {} }
    const attribution = extra.context ? null : this.getAttribution();
    const event = { eventId: randomId(), visitorId: identity.visitorId, sessionId: summary && this._pageSessionId ? this._pageSessionId : identity.sessionId, type, timestamp: Date.now(), url: address, ...(extra.context ? {} : { referrer }), webdriver: this._navigator.webdriver === true, firstSeenAt: identity.firstSeenAt, ...(attribution ? { attribution } : {}), ...extra };
    if (this._queue.length >= 100) this._queue.shift();
    this._queue.push(event); return true;
  }
  _navigation() {
    if (this._outcomesOnly) return false;
    const href = this._window?.location?.href;
    if (!href || href === this._lastLocation || !this._enabled()) return false;
    this._summarize('navigation'); this._lastLocation = href; this._page = siteAddress(href, this._excludedPaths);
    this._summaryCount = 0; this._summaryStart = Date.now(); this._pageActive = false;
    this._activeMs = 0; this._engagementTick = Date.now(); this._lastActivity = Date.now();
    this._clicks.clear(); this._scroll.fill(0); this._pageViewId = randomId();
    this._rememberAttribution(this._page);
    this._pageSessionId = this._identity?.sessionId || null;
    return this._enqueue('page_view', { pageViewId: this._pageViewId });
  }
  /** Track a machine-named action with its registered, bounded scalar fields. */
  track(name, properties) {
    if (this._outcomesOnly) throw new TypeError('Use trackOutcome in outcome-only mode.');
    if (SITE_PUBLIC_EVENTS.contextEvents?.[name]) throw new TypeError('This outcome needs a dedicated outcome-only tracker.');
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)) throw new TypeError('Use a machine event name without personal text.');
    const fields = siteProperties(name, properties);
    if (!siteAddress(this._window?.location?.href, this._excludedPaths)) return false;
    this._activity();
    return this._enqueue('custom', { name, ...(fields === undefined ? {} : { properties: fields }) });
  }
  /** Explicit registered outcome, without recording an authentication page. */
  trackOutcome(name, properties) {
    if (!this._outcomesOnly) throw new TypeError('Create a dedicated tracker with outcomesOnly: true.');
    const context = SITE_PUBLIC_EVENTS.contextEvents?.[name];
    if (!['signup', 'checkout'].includes(context)) throw new TypeError('Use a registered website outcome.');
    const fields = siteProperties(name, properties);
    // Context events cannot inherit common page/marketing tags.
    if (Object.keys(fields || {}).some(key => !Object.hasOwn(SITE_PUBLIC_EVENTS.events[name], key))) throw new TypeError('Unexpected outcome property.');
    if (!this._enabled()) return false;
    let origin;
    try {
      // Read only the origin. Never read or serialize the path, query, fragment,
      // form contents, referrer, or authenticated game/account identity.
      origin = this._window?.location?.origin;
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    } catch { return false; }
    return this._enqueue('custom', { name, context, ...(fields === undefined ? {} : { properties: fields }) }, origin);
  }
  pageView() { this._lastLocation = null; return this._navigation(); }
  grantConsent() {
    if (this._allowed) return false;
    try { this._storage.removeItem(this._preferenceKey); } catch {}
    SITE_MEMORY_STORAGE.removeItem(this._preferenceKey);
    this._allowed = true; this._lastLocation = null; return this._navigation();
  }
  optOut() {
    this._allowed = false; this._queue = []; this._identity = null; this._page = null;
    this._clicks.clear(); this._scroll.fill(0); this._write(null);
    this._activeMs = 0; this._pageActive = false; this._firstNavigation = true;
    try { this._storage.setItem(this._preferenceKey, 'true'); } catch { SITE_MEMORY_STORAGE.setItem(this._preferenceKey, 'true'); }
  }
  reset() {
    this._queue = []; this._identity = null; this._write(null); this._lastLocation = null;
    this._page = null; this._activeMs = 0; this._pageActive = false; this._firstNavigation = true;
    this._clicks.clear(); this._scroll.fill(0); return this._navigation();
  }
  /** Explicitly resume after the website owner restores collection capacity. */
  resume() { this._paused = false; this._retryAt = 0; this._lastLocation = null; return this._navigation(); }
  get paused() { return this._paused; }
  _viewport() { const width = this._window?.innerWidth || 1024; return width < 768 ? 'small' : width < 1200 ? 'medium' : 'large'; }
  _accrue() {
    const now = Date.now();
    if (this._engagement && this._enabled() && this._page && this._visible && this._focused) {
      const until = Math.min(now, this._lastActivity + 30000);
      this._activeMs = Math.min(300000, this._activeMs + Math.max(0, until - this._engagementTick));
    }
    this._engagementTick = now;
  }
  _activity() {
    this._accrue();
    if (!this._enabled() || !this._page) return;
    const now = Date.now();
    if (this._identity && now - this._identity.last >= SITE_SESSION_MS) { this._lastLocation = null; this._navigation(); }
    this._session(); this._lastActivity = now;
  }
  _click(event) {
    if (!this._enabled() || !this._page || event.isTrusted === false) return;
    this._activity();
    if (!this._heatmaps || this._summaryCount >= 6) return;
    const selector = siteSelector(event.target);
    if (!selector) return;
    const width = Math.max(1, this._document?.documentElement?.scrollWidth || this._window?.innerWidth || 1);
    const height = Math.max(1, this._document?.documentElement?.scrollHeight || this._window?.innerHeight || 1);
    const x = Math.max(0, Math.min(99, Math.floor((event.pageX || 0) / width * 100)));
    const y = Math.max(0, Math.min(99, Math.floor((event.pageY || 0) / height * 100)));
    const key = `${x}/${y}/${selector}`;
    if (!this._clicks.has(key) && this._clicks.size >= 200) return;
    const previous = this._clicks.get(key);
    this._clicks.set(key, { x, y, selector, count: Math.min(10000, (previous?.count || 0) + 1) }); this._pageActive = true;
  }
  _scrolled() {
    if (!this._enabled() || !this._page) return;
    this._activity();
    if (!this._heatmaps || this._summaryCount >= 6) return;
    const height = Math.max(1, this._document?.documentElement?.scrollHeight || 1);
    const depth = Math.min(10, Math.ceil(((this._window?.scrollY || 0) + (this._window?.innerHeight || 0)) / height * 10));
    for (let index = 0; index < depth; index++) this._scroll[index] = 1;
    this._pageActive = true;
  }
  _summarize(reason = 'hidden') {
    this._accrue();
    if (!this._enabled() || !this._page || this._summaryCount >= 6 || (reason === 'interval' && this._summaryCount >= 5)) return false;
    const heatmap = this._heatmaps && this._pageActive ? { viewport: this._viewport(), clicks: [...this._clicks.values()], scroll: [...this._scroll] } : null;
    const engagement = this._engagement && this._activeMs > 0 ? { activeMs: Math.round(this._activeMs), durationMs: Math.min(3600000, Math.max(Math.round(this._activeMs), Date.now() - this._summaryStart)), pageViewId: this._pageViewId, reason } : null;
    if (!heatmap && !engagement) return false;
    const accepted = this._enqueue(engagement ? 'engagement' : 'heatmap', { ...(engagement ? { engagement } : {}), ...(heatmap ? { heatmap } : {}) });
    this._clicks.clear(); this._scroll.fill(0); this._pageActive = false; this._summaryStart = Date.now();
    this._activeMs = 0;
    if (accepted) this._summaryCount++;
    return accepted;
  }
  async flush({ keepalive = false } = {}) {
    // An ordinary fetch can be cancelled by navigation. A separate bounded
    // keepalive sends pending work immediately, including any active IDs;
    // collector receipts make that replay idempotent. Waiting for the first
    // fetch would lose actions queued just before the page closes.
    const lane = keepalive ? '_exitFlight' : '_inFlight';
    if (!keepalive && this._inFlight) return this._inFlight;
    if (!this._enabled() || !this._queue.length || !this._fetch || Date.now() < this._retryAt) return false;
    const activeExitIds = new Set([...this._exitRequests].flatMap(request => [...request.ids]));
    const candidates = this._queue.filter(event => !keepalive || !activeExitIds.has(event.eventId));
    const batch = candidates.slice(0, 50);
    if (!batch.length) return this._exitFlight || false;
    while (batch.length > 1 && JSON.stringify(batch).length > 400000) batch.pop();
    // Keepalive has a browser-wide 64 KB budget. Reduce without changing IDs.
    if (keepalive) {
      const available = Math.max(0, 45000 - [...this._exitRequests].reduce((total, request) => total + request.bytes, 0));
      batch.length = 0;
      // A large optional summary must not block a small conversion behind it.
      // Leave anything that cannot fit queued for an ordinary foreground flush.
      for (const event of candidates) {
        if (batch.length >= 50) break;
        if (utf8Length(JSON.stringify({ key: this.key, events: [...batch, event] })) <= available) batch.push(event);
      }
      if (!batch.length) return false;
    }
    const exitRequest = keepalive ? { ids: new Set(batch.map(event => event.eventId)), bytes: utf8Length(JSON.stringify({ key: this.key, events: batch })) } : null;
    if (exitRequest) this._exitRequests.add(exitRequest);
    // Assign the latch before invoking an injected transport, which may throw
    // synchronously. Bound the body read too; abort alone is not enough for
    // custom transports that ignore its signal.
    const pending = Promise.resolve().then(async () => {
      let timer;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      try {
        // Consent/reset may change before this scheduled transport starts.
        // A destroy keepalive still owns its queued batch and may finish.
        if (!this._allowed || this._privacyBlocked() || !batch.some(event => this._queue.includes(event))) return false;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller?.abort(); reject(new Error('Website collection timed out.')); }, 10000);
          timer?.unref?.();
        });
        const { response, body } = await Promise.race([
          (async () => {
            const response = await this._fetch(`${this.apiUrl}/site/collect`, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: this.key, events: batch }), keepalive, ...(controller ? { signal: controller.signal } : {}) });
            const body = await response.json().catch(() => null);
            return { response, body };
          })(), timeout,
        ]);
        const ids = new Set(batch.map(event => event.eventId));
        const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && ids.has(id)) && new Set(value).size === value.length;
        const valid = body && ['accepted', 'duplicates', 'dropped', 'refused'].every(key => Number.isInteger(body[key]) && body[key] >= 0) && validIds(body.acceptedIds) && validIds(body.droppedIds) && validIds(body.refusedIds) && body.acceptedIds.length === body.accepted + body.duplicates && body.droppedIds.length === body.dropped && body.refusedIds.length === body.refused && new Set([...body.acceptedIds, ...body.droppedIds, ...body.refusedIds]).size === batch.length && body.accepted + body.duplicates + body.dropped + body.refused === batch.length;
        if ((response.ok || response.status === 429) && valid) {
          const acknowledged = new Set([...body.acceptedIds, ...body.droppedIds]);
          this._queue = this._queue.filter(event => !acknowledged.has(event.eventId));
          if (body.paused === true && ['needs_funds', 'backstop', 'internal_capacity'].includes(body.reason)) {
            this._paused = true; this._pauseUntil = Date.now() + 60000; this._queue = []; this._clicks.clear(); this._scroll.fill(0); this._pageActive = false;
          }
          this._attempts = 0; this._retryAt = body.refused && !this._paused ? Date.now() + 5000 : 0;
          return true;
        }
        // Permanent invalid-key/schema responses cannot be repaired by replay.
        if ([400, 401, 403, 413].includes(response.status)) this._queue = this._queue.filter(event => !ids.has(event.eventId));
        this._attempts++; this._retryAt = Date.now() + Math.max(parseRetryAfterMs(response.headers?.get?.('Retry-After')) || 0, Math.min(60000, 1000 * 2 ** Math.min(this._attempts, 6)));
        return false;
      } catch { this._attempts++; this._retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(this._attempts, 6)); return false; }
      finally {
        clearTimeout(timer);
        if (exitRequest) this._exitRequests.delete(exitRequest);
        if (this[lane] === pending) this[lane] = null;
      }
    });
    this[lane] = pending;
    return pending;
  }
  destroy() {
    if (this._destroyed) return;
    this._summarize('destroy'); this.flush({ keepalive: true }); this._destroyed = true;
    clearInterval(this._timer); for (const remove of this._listeners.splice(0)) remove();
  }
}
export function createSiteTracker(options) { return new SiteTracker(options); }
