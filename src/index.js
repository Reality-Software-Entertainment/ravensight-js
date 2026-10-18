/**
 * Ravensight JavaScript SDK
 *
 * Zero dependency client for the hosted Ravensight analytics API.
 * Works in browsers and in Node 18+ (built in global fetch).
 *
 * Docs: https://ravensight.io/docs/
 */

export const VERSION = '0.5.1';

export const DEFAULT_API_URL = 'https://api.ravensight.io/api/v1';

/** Server hard limit on POST /track/batch. */
export const MAX_BATCH_SIZE = 50;

/** Feedback categories the API accepts. Anything else is rejected locally. */
export const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);

/**
 * Values the reserved `rs_kind` property accepts: what an event means for the
 * level funnel. Property keys starting with `rs_` are reserved for Ravensight.
 */
export const RS_KINDS = Object.freeze([
  'level_start', 'level_complete', 'death', 'none',
  'purchase', 'resource', 'progression', 'error', 'health',
]);

/** The reserved keys Ravensight reads. Any other `rs_` key is a typo or a clash. */
// `rs_invalid` is deliberately absent: only the server writes it.
const KNOWN_RS_KEYS = Object.freeze([
  'rs_kind', 'rs_doctor', 'rs_event_id',
  'rs_status', 'rs_p1', 'rs_p2', 'rs_p3', 'rs_score',
  'rs_amount', 'rs_currency', 'rs_item_type', 'rs_item_id', 'rs_cart', 'rs_transaction_id',
  'rs_flow', 'rs_resource',
  'rs_severity', 'rs_message', 'rs_stack',
  'rs_fps_median', 'rs_fps_p10', 'rs_memory_mb', 'rs_boot_ms',
]);

const MAX_MESSAGE_CHARS = 200;
const MAX_STACK_CHARS = 2000;
const MAX_FPS_SAMPLES = 600;
const SAMPLE_INTERVAL_MS = 1000;

const cutText = (value, max) =>
  typeof value === 'string' && value.length > max ? Array.from(value).slice(0, max).join('') : value;

/** The value at fraction `q` of an ascending list, interpolated between neighbours. */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round2 = (n) => Math.round(n * 100) / 100;

const DEFAULT_QUEUE_CAP = 500;
const DEFAULT_RETRY_MS = 10000;
const MAX_BACKOFF_MS = 300000;
const DEFAULT_AUTO_FLUSH_MS = 15000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2000;
const DEFAULT_MAX_SESSIONS = 64;
const DEVICE_ID_KEY = 'ravensight_device_id';
/** Where the playtest runner leaves its token for the page. */
const PLAYTEST_STORAGE_KEY = 'ravensight.playtest';
const PLAYTEST_GLOBAL = '__RAVENSIGHT_PLAYTEST__';
/** Clock skew allowance so we refresh slightly before the server expires us. */
const EXPIRY_SKEW_MS = 5000;

/**
 * The largest event the API accepts, measured as the server measures it: the
 * UTF-8 bytes of the JSON of the event's data. Bigger events are dropped by
 * track() and never sent.
 */
export const MAX_EVENT_BYTES = 8192;
/** Written only with consent 'opt_in', once the player has said yes. */
const OPTIN_KEY = 'ravensight_optin';
const CONSENT_MODES = Object.freeze(['opt_out', 'opt_in']);
const MAX_DISTRIBUTION_LENGTH = 40;
/** Retry waits vary by plus or minus this fraction, so clients that failed together do not retry together. */
const BACKOFF_JITTER = 0.2;

/**
 * Error thrown by the explicit request helpers (submitFeedback,
 * fetchSuggestions). Carries a stable `code` for programmatic handling.
 * Event tracking never throws: it queues and retries instead.
 */
export class RavensightError extends Error {
  constructor(message, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'RavensightError';
    this.code = code;
    this.status = status;
  }
}

/** Storage shim used when localStorage is unavailable (Node, private mode). */
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

/**
 * Accepts either "https://api.ravensight.io" or the full
 * "https://api.ravensight.io/api/v1" and always returns the versioned base
 * with no trailing slash.
 */
export function normalizeApiUrl(url) {
  const raw = String(url == null || url === '' ? DEFAULT_API_URL : url).trim();
  const trimmed = raw.replace(/\/+$/, '');
  return /\/api\/v1$/.test(trimmed) ? trimmed : trimmed + '/api/v1';
}

/** Parses a delta seconds Retry-After header. Returns 0 when absent/invalid. */
export function parseRetryAfterMs(value) {
  if (value == null) return 0;
  const seconds = Number(String(value).trim());
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

/**
 * Picks the transport used for the final flush when a page is going away.
 *
 * fetch with keepalive is preferred over sendBeacon because sendBeacon cannot
 * set request headers, and the batch endpoint authenticates with the
 * X-Session-Token header. The beacon path therefore moves the token into the
 * JSON body as `sessionToken` (never the URL, where proxies and logs could
 * capture it). It is a best effort fallback for browsers where keepalive is
 * unavailable.
 */
export function chooseUnloadTransport(env) {
  if (env && env.hasFetchKeepalive) return 'fetch-keepalive';
  if (env && env.hasBeacon) return 'beacon';
  return 'none';
}

function detectStorage(injected, probe = true) {
  if (injected) return injected;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      // Read only detection where a write is not allowed yet (opt-in before
      // the player's yes). Every later write is wrapped in try/catch anyway.
      if (!probe) {
        localStorage.getItem(DEVICE_ID_KEY);
        return localStorage;
      }
      const probe = '__ravensight_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (_err) {
    // Safari private mode and hardened browsers throw on access. Fall through.
  }
  return new MemoryStorage();
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

/** `count` random bytes as hex, from a secure source where one exists. */
function randomHex(count) {
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(count));
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    }
  } catch (_err) {
    // Fall through to Math.random.
  }
  let out = '';
  for (let i = 0; i < count; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

/** UTF-8 byte length of a string, without TextEncoder where it is missing. */
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

/** The first 16 characters of a device id, limited to the characters an rs_event_id may hold. */
function eventIdPrefix(deviceId) {
  const prefix = String(deviceId == null ? '' : deviceId)
    .slice(0, 16)
    .replace(/[^A-Za-z0-9_-]/g, '_');
  return prefix || 'x';
}

/** Validates the `distribution` option: null when not set, else the label. */
function readDistribution(value) {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > MAX_DISTRIBUTION_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      'Ravensight: `distribution` must be a string of at most ' + MAX_DISTRIBUTION_LENGTH +
        ' characters with no control characters',
    );
  }
  return value;
}

function detectPlatform() {
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.userAgent) return 'web';
  } catch (_err) {
    // ignore
  }
  if (typeof process !== 'undefined' && process && process.platform) return 'node-' + process.platform;
  return 'unknown';
}

function noop() {}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Strips the local device id: the server stamps it from the session. */
function wireEvents(items) {
  return items.map((item) => ({ event: item.event, data: item.data, timestamp: item.timestamp }));
}

/** A token from a string, a JSON string or an object with `token`. */
function playtestTokenFrom(value) {
  if (value == null) return null;
  if (typeof value === 'object') return isNonEmptyString(value.token) ? value.token.trim() : null;
  const text = String(value).trim();
  if (!text) return null;
  if (text[0] === '{') {
    try {
      return playtestTokenFrom(JSON.parse(text));
    } catch (_err) {
      return null;
    }
  }
  return text;
}

/**
 * The Ravensight Playtest runner injects a token into the page, read in this
 * order: `window.__RAVENSIGHT_PLAYTEST__`, then
 * `localStorage['ravensight.playtest']`. Null outside a playtest.
 *
 * Never from the URL: a bearer token in a query string leaks through
 * referrers, history and server logs, and a crafted link could pin a
 * visitor's session to a playtest run.
 */
function readPlaytestToken(storage) {
  try {
    if (typeof window !== 'undefined' && window) {
      const fromGlobal = playtestTokenFrom(window[PLAYTEST_GLOBAL]);
      if (fromGlobal) return fromGlobal;
    }
  } catch (_err) {
    // A hostile or partial window object. Fall through to storage.
  }
  const stores = [storage];
  try {
    // Only in a browser: touching the global in Node 25+ prints a warning.
    if (isBrowser() && typeof localStorage !== 'undefined' && localStorage && localStorage !== storage) {
      stores.push(localStorage);
    }
  } catch (_err) {
    // Blocked storage.
  }
  for (const store of stores) {
    try {
      const fromStorage = playtestTokenFrom(store.getItem(PLAYTEST_STORAGE_KEY));
      if (fromStorage) return fromStorage;
    } catch (_err) {
      // Blocked storage.
    }
  }
  return null;
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Ravensight analytics client.
 *
 * @example
 * const rs = new Ravensight({ ingestKey: 'gt_live_...' });
 * await rs.init();
 * rs.track('level_started', { level: 3 });
 */
export class Ravensight {
  constructor(options = {}) {
    const opts = options || {};

    const rawKey = opts.ingestKey;
    if (rawKey != null && typeof rawKey !== 'string') {
      throw new TypeError('Ravensight: `ingestKey` must be a string (your publishable key)');
    }
    this.ingestKey = rawKey == null ? '' : rawKey.trim();
    /**
     * False with no key: the client is inert. It writes no storage, makes no
     * request, starts no timer and adds no listener, and every call is a no-op.
     */
    this._hasKey = this.ingestKey !== '';
    this.optional = Boolean(opts.optional);

    if (opts.consent != null && !CONSENT_MODES.includes(opts.consent)) {
      throw new TypeError("Ravensight: `consent` must be 'opt_out' or 'opt_in'");
    }
    /** 'opt_out' (default): on until the player opts out. 'opt_in': off until setEnabled(true). */
    this.consent = opts.consent == null ? 'opt_out' : opts.consent;
    /** A short label sent on POST /session, or null. */
    this.distribution = readDistribution(opts.distribution);

    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.gameVersion = opts.gameVersion == null ? '1.0.0' : String(opts.gameVersion);
    this.platform = opts.platform == null ? detectPlatform() : String(opts.platform);
    this.autoFlushMs = opts.autoFlushMs == null ? DEFAULT_AUTO_FLUSH_MS : Number(opts.autoFlushMs);
    this.maxQueueSize = opts.maxQueueSize == null ? DEFAULT_QUEUE_CAP : Number(opts.maxQueueSize);
    this.maxSessions =
      opts.maxSessions == null ? DEFAULT_MAX_SESSIONS : Math.max(1, Math.floor(Number(opts.maxSessions)) || 1);
    this.debug = Boolean(opts.debug);

    this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!this._fetch && this._hasKey) {
      throw new TypeError('Ravensight: no global fetch found. Use Node 18+ or pass `fetch`.');
    }

    this._clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._random = typeof opts.random === 'function' ? opts.random : Math.random;
    this._env = opts.env || null;
    this._startedAt = this._clock();
    /** rs_event_id parts: a per-launch nonce (made on the first event) and a counter. */
    this._eventNonce = null;
    this._eventCounter = 0;
    this._tooLargeWarned = false;

    if (this._hasKey) {
      // Opt-in before the yes: detect storage without the probe write.
      const optIn = this.consent === 'opt_in';
      this._storage = detectStorage(opts.storage, !optIn);
      // Under a playtest the server decides the device id from the token, so
      // nothing is read from or written to the player's own storage.
      this._playtestToken = readPlaytestToken(this._storage);
      /**
       * Whether the player has agreed. Always true with 'opt_out'. With
       * 'opt_in', true once `ravensight_optin` is stored (or under a
       * playtest, where the player is a persona and nothing is stored).
       */
      this._consented = !optIn || Boolean(this._playtestToken) || this._readOptIn(this._storage);
    } else {
      this._storage = opts.storage || new MemoryStorage();
      this._playtestToken = null;
      this._consented = false;
      if (!this.optional && typeof console !== 'undefined') {
        console.warn(
          '[ravensight] no ingestKey, so analytics is off for this client (pass optional: true to silence this line)',
        );
      }
    }
    /** Set by setDeviceId before the opt-in yes: stored once the player agrees. */
    this._deviceIdUnsaved = false;

    if (opts.deviceId) this.deviceId = String(opts.deviceId);
    else if (!this._hasKey || !this._consented) this.deviceId = null;
    else this.deviceId = this._playtestToken ? 'dev_' + randomId() : this._loadOrCreateDeviceId();

    /** Local opt out. Combined with the server kill switch by `isActive`. */
    this.enabled = this._consented && (opts.enabled === undefined ? true : Boolean(opts.enabled));
    /** Server kill switch from GET /settings. Assumed on until told otherwise. */
    this.trackingEnabled = true;
    this.initialized = false;
    /** init() was called while waiting for the opt-in yes: the yes runs it. */
    this._initRequested = false;
    this._initPromise = null;

    /**
     * One cached session per device id, least recently used first:
     * deviceId -> { token, expiresAt, promise, joinToken }.
     */
    this._sessions = new Map();
    this._configs = new Map();
    this._configRequests = new Map();
    this._configGeneration = 0;
    this.onConfigReady = typeof opts.onConfigReady === 'function' ? opts.onConfigReady : null;

    this.queue = [];
    this.stats = {
      queued: 0,
      sent: 0,
      dropped: 0,
      flushes: 0,
      sessions: 0,
      sessionsEvicted: 0,
      /** The last failed request: { code, status, at } with `at` in epoch ms, or null. */
      lastError: null,
    };

    this._disposed = false;
    this._disposing = false;
    this._disposePromise = null;
    this._flushing = false;
    this._flushPromise = null;
    /** Events in the batch request currently awaiting an answer. */
    this._inflightSize = 0;
    this._timer = null;
    this._nextAttemptAt = 0;
    this._backoffMs = DEFAULT_RETRY_MS;
    this._listenersBound = false;
    this._onVisibilityChange = null;
    this._onPageHide = null;
    this._pageHideBound = false;
    this._exitSent = false;
    this._startSent = false;
    /** Set when the settings check or POST /session refuses the key. Ends the run. */
    this._invalidKey = false;
    this._invalidKeyWarned = false;
    /** event + key pairs already warned about in debug mode. */
    this._reservedWarned = new Set();
    /** Set by a 403 playtest_job_closed. Permanent for this client. */
    this._playtestClosed = false;

    // Automatic lifecycle events, in a browser only: a Node client serves many
    // players and has no single game to start or exit. Never while inert or
    // before the opt-in yes.
    this.autoEvents = opts.autoEvents === undefined ? true : Boolean(opts.autoEvents);
    if (this.autoEvents && isBrowser() && this._hasKey && this._consented) {
      this._bindPageHide();
      if (this.enabled) this._startSent = this.track('game_started');
    }

    // Opt-in per-session performance sampling, browser only. One `health`
    // event goes out on the first `pagehide`, never from the frame hook.
    this.performance = Boolean(opts.performance);
    this._fpsSamples = [];
    this._healthSent = false;
    this._healthBound = false;
    this._onHealthHide = null;
    this._onHealthShow = null;
    this._frameHandle = null;
    this._lastFrameTs = null;
    this._nextSampleAt = 0;
    this._bootMs = null;
    if (this.performance && isBrowser()) this._startPerformance();
  }

  /** True only while the client is running and collecting: a key, consent, not opted out, not switched off by the server, the key not refused, not disposed. */
  isEnabled() {
    return this.isActive;
  }

  /** True when events may actually be sent. */
  get isActive() {
    return this._canSend && !this._disposing;
  }

  /** Like isActive, but still true while dispose() delivers the last events. */
  get _canSend() {
    return (
      this._hasKey &&
      this._consented &&
      this.enabled &&
      this.trackingEnabled &&
      !this._invalidKey &&
      !this._playtestClosed &&
      !this._disposed
    );
  }

  /** True when a Ravensight Playtest token was found at construction. */
  get isPlaytest() {
    return Boolean(this._playtestToken);
  }

  /** The current id's session token, or null. Read only. */
  get sessionToken() {
    const entry = this._sessions.get(this.deviceId);
    return entry && entry.token ? entry.token : null;
  }

  /** When the current id's session expires, in epoch ms, or 0. Read only. */
  get sessionExpiresAt() {
    const entry = this._sessions.get(this.deviceId);
    return entry && entry.token ? entry.expiresAt : 0;
  }

  /** Milliseconds until the next allowed network attempt (0 when clear). */
  get retryInMs() {
    return Math.max(0, this._nextAttemptAt - this._clock());
  }

  /**
   * Reads the server kill switch, opens a session, and starts the flush timer.
   * Never throws on network failure: the SDK degrades to queue and retry.
   *
   * `reason` says why the session is not ready: `no_key` (inert),
   * `no_consent` (opt-in, no yes yet), `disabled`, `invalid_key` (the run has
   * ended), `tracking_disabled`, `offline`, `rate_limited`, `session_failed`,
   * or null. Concurrent calls share one promise.
   *
   * @returns {Promise<{trackingEnabled: boolean, sessionReady: boolean, reason: string|null}>}
   */
  init() {
    if (this._disposed || this._disposing) {
      return Promise.reject(new RavensightError('client disposed', 'disposed'));
    }
    // Concurrent calls (a game and a bridge, or the opt-in yes) share one run.
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init().finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  async _init() {
    // No key: inert. Nothing on the network, nothing stored.
    if (!this._hasKey) {
      return { trackingEnabled: false, sessionReady: false, reason: 'no_key' };
    }

    // Opt-in and no yes yet: the yes (setEnabled(true)) runs init itself.
    if (!this._consented) {
      this._initRequested = true;
      this._log('waiting for the player to opt in, init() does nothing yet');
      return { trackingEnabled: false, sessionReady: false, reason: 'no_consent' };
    }

    // Opted out: no settings check, no session, nothing on the network.
    if (!this.enabled) {
      this._log('client is disabled, init() does nothing');
      return { trackingEnabled: false, sessionReady: false, reason: 'disabled' };
    }

    // The key was refused earlier in this run: the run has ended.
    if (this._invalidKey) {
      return { trackingEnabled: false, sessionReady: false, reason: 'invalid_key' };
    }

    await this._checkSettings();
    this.initialized = true;
    if (this._playtestClosed) this.trackingEnabled = false;

    if (this._invalidKey) {
      return { trackingEnabled: false, sessionReady: false, reason: 'invalid_key' };
    }

    if (!this.trackingEnabled) {
      this._log('tracking disabled by server kill switch');
      this.queue.length = 0;
      return { trackingEnabled: false, sessionReady: false, reason: 'tracking_disabled' };
    }

    let sessionReady = false;
    let reason = null;
    try {
      await this._ensureSession();
      sessionReady = true;
    } catch (err) {
      reason = (err && err.reason) || 'session_failed';
      this._log('session not ready yet: ' + (err && err.message));
    }

    if (this._invalidKey) {
      return { trackingEnabled: false, sessionReady: false, reason: 'invalid_key' };
    }

    if (!this.trackingEnabled) {
      return { trackingEnabled: false, sessionReady: false, reason: 'tracking_disabled' };
    }

    this._startTimer();
    this._bindLifecycle();

    if (sessionReady && this.queue.length > 0) {
      this.flush().catch(noop);
    }

    return { trackingEnabled: true, sessionReady, reason };
  }

  /**
   * Queues an event. Safe to call before init(): events are held and sent once
   * a session exists. Returns false when tracking is off, and when the event
   * is dropped for data over MAX_EVENT_BYTES (one console warning per client,
   * stats.dropped and stats.lastError `event_too_large`). The queued data is
   * a copy of `data` carrying `rs_event_id`.
   *
   * `options.deviceId` sends this one event as another device, so one Node
   * client can serve many players. Each device gets its own session.
   */
  track(event, data, options) {
    if (typeof event !== 'string' || event.trim() === '') {
      throw new TypeError('Ravensight: `event` must be a non-empty string');
    }
    let deviceId = this.deviceId;
    if (options && options.deviceId !== undefined) {
      if (!isNonEmptyString(options.deviceId)) {
        throw new TypeError('Ravensight: `deviceId` must be a non-empty string');
      }
      deviceId = options.deviceId;
    }
    if (!this.isActive) return false;
    if (this.debug && data && typeof data === 'object') this._checkReservedKeys(event, data);

    // A copy, never the caller's own object, carrying the id the server
    // dedupes on. It lives inside the data, so a resend carries the same id.
    // A throwing getter or a cycle cannot be sent either: dropped the same way.
    let payload = null;
    let bytes = Infinity;
    try {
      payload = Object.assign({}, data && typeof data === 'object' ? data : {});
      for (const assignment of this._cachedConfig(deviceId)?.experiments || []) {
        payload['rs_exp_' + assignment.key] = assignment.variant;
      }
      payload.rs_event_id = this._nextEventId(deviceId);
      bytes = utf8Length(JSON.stringify(payload));
    } catch (_err) {
      payload = null;
    }
    if (!payload || !(bytes <= MAX_EVENT_BYTES)) {
      const code = payload ? 'event_too_large' : 'event_not_serializable';
      this.stats.dropped += 1;
      this._recordError(code, 0);
      if (!this._tooLargeWarned && typeof console !== 'undefined') {
        this._tooLargeWarned = true;
        console.warn(
          '[ravensight] dropped event "' + event + '" (' + code + '): its data must serialize to at most ' +
            MAX_EVENT_BYTES + ' bytes of JSON (further drops are not logged)',
        );
      }
      return false;
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.stats.dropped += 1;
    }

    this.queue.push({
      event,
      data: payload,
      timestamp: Math.floor(this._clock() / 1000),
      deviceId,
    });
    this.stats.queued += 1;

    if (this.queue.length >= MAX_BATCH_SIZE) this.flush().catch(noop);
    return true;
  }

  // --- Typed events -------------------------------------------------------
  //
  // Thin builders over track(): they set the reserved rs_ properties and call
  // it, so queueing, batching, retries and opt out are unchanged. They return
  // what track returns and never throw on bad input; the server flags a wrong
  // value with rs_invalid. `data` is merged first, so reserved keys win, and
  // `event` overrides the default event name. The second argument is track's
  // own options ({ deviceId }).

  /** rs_amount is whole minor units (499 is 4.99), an integer or a digit string. */
  trackPurchase(options, trackOptions) {
    const o = options || {};
    const currency = typeof o.currency === 'string' ? o.currency.toUpperCase() : o.currency;
    const props = this._typed('purchase', {
      rs_amount: o.amount,
      rs_currency: currency,
      rs_item_type: o.itemType,
      rs_item_id: o.itemId,
      rs_cart: o.cart,
      rs_transaction_id: o.transactionId,
    }, o.data);
    return this.track(o.event || 'purchase', props, trackOptions);
  }

  /** flow is 'source' or 'sink'; rs_amount is a plain number, not money. */
  trackResource(options, trackOptions) {
    const o = options || {};
    const props = this._typed('resource', {
      rs_flow: o.flow,
      rs_resource: o.resource,
      rs_amount: o.amount,
      rs_item_type: o.itemType,
      rs_item_id: o.itemId,
    }, o.data);
    return this.track(o.event || 'resource_' + o.flow, props, trackOptions);
  }

  /** status is 'start', 'complete' or 'fail'. */
  trackProgression(options, trackOptions) {
    const o = options || {};
    const props = this._typed('progression', {
      rs_status: o.status,
      rs_p1: o.p1,
      rs_p2: o.p2,
      rs_p3: o.p3,
      rs_score: o.score,
    }, o.data);
    return this.track(o.event || 'progression_' + o.status, props, trackOptions);
  }

  /** severity is 'debug', 'info', 'warning', 'error' or 'critical'. Message is cut to 200 characters, stack to 2000. */
  trackError(options, trackOptions) {
    const o = options || {};
    const props = this._typed('error', {
      rs_severity: o.severity,
      rs_message: cutText(o.message, MAX_MESSAGE_CHARS),
      rs_stack: cutText(o.stack, MAX_STACK_CHARS),
    }, o.data);
    return this.track(o.event || 'error', props, trackOptions);
  }

  /** Extra data first, then the kind and every given typed key, so reserved keys win. */
  _typed(kind, fields, extra) {
    const props = extra && typeof extra === 'object' ? { ...extra } : {};
    props.rs_kind = kind;
    for (const key of Object.keys(fields)) {
      if (fields[key] !== undefined) props[key] = fields[key];
    }
    return props;
  }

  // --- Performance sampling (opt in) --------------------------------------

  _startPerformance() {
    if (!this.isActive || this._healthBound) return;
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        this._bootMs = Math.round(performance.now());
      }
    } catch (_err) {
      // Boot time is optional.
    }
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      this._onHealthHide = () => this._sendHealth();
      this._onHealthShow = (event) => {
        // A page restored from the back-forward cache is a new session.
        if (event && event.persisted) this._rearmHealth();
      };
      window.addEventListener('pagehide', this._onHealthHide);
      window.addEventListener('pageshow', this._onHealthShow);
      this._healthBound = true;
    }
    this._startFrameLoop();
  }

  /** Starts sampling frames, only while tracking is on and nothing was sent yet this session. */
  _startFrameLoop() {
    if (this._frameHandle !== null || this._healthSent || this._disposed) return;
    if (!this.isActive || typeof requestAnimationFrame !== 'function') return;
    this._lastFrameTs = null;
    this._frameHandle = requestAnimationFrame((ts) => this._onFrame(ts));
  }

  _stopFrameLoop() {
    if (this._frameHandle !== null && typeof cancelAnimationFrame === 'function') {
      try {
        cancelAnimationFrame(this._frameHandle);
      } catch (_err) {
        // ignore
      }
    }
    this._frameHandle = null;
  }

  /** A new session: forget the old samples and sample again. */
  _rearmHealth() {
    if (!this.performance || this._disposed) return;
    this._healthSent = false;
    this._fpsSamples = [];
    this._nextSampleAt = 0;
    this._startFrameLoop();
  }

  /** The frame hook: records one frame rate sample per second and schedules the next frame. Never sends. */
  _onFrame(ts) {
    this._frameHandle = null;
    if (this._healthSent || this._disposed) return;
    // Opted out: stop spending frames. setEnabled(true) starts the loop again.
    if (!this.isActive) return;
    if (this._lastFrameTs !== null) {
      const delta = ts - this._lastFrameTs;
      if (delta > 0 && ts >= this._nextSampleAt) {
        if (this._fpsSamples.length >= MAX_FPS_SAMPLES) this._fpsSamples.shift();
        this._fpsSamples.push(1000 / delta);
        this._nextSampleAt = ts + SAMPLE_INTERVAL_MS;
      }
    }
    this._lastFrameTs = ts;
    if (typeof requestAnimationFrame === 'function') {
      this._frameHandle = requestAnimationFrame((next) => this._onFrame(next));
    }
  }

  /** The rs_ health properties from the samples so far, or null when there are none. */
  _healthSummary() {
    if (this._fpsSamples.length === 0) return null;
    const sorted = this._fpsSamples.slice().sort((a, b) => a - b);
    const summary = {
      rs_kind: 'health',
      rs_fps_median: round2(quantile(sorted, 0.5)),
      rs_fps_p10: round2(quantile(sorted, 0.1)),
    };
    try {
      const mem = typeof performance !== 'undefined' && performance && performance.memory;
      if (mem && Number.isFinite(mem.usedJSHeapSize)) summary.rs_memory_mb = round2(mem.usedJSHeapSize / 1048576);
    } catch (_err) {
      // Memory is only exposed by some browsers.
    }
    if (this._bootMs !== null) summary.rs_boot_ms = this._bootMs;
    return summary;
  }

  /** Sends the one `health` event for this session, on the first pagehide. Nothing when no sample was taken. */
  _sendHealth() {
    if (this._healthSent || !this.isActive) return;
    this._healthSent = true;
    this._stopFrameLoop();
    const summary = this._healthSummary();
    if (!summary) return;
    if (!this.track('health', summary)) return;
    this._flushOnHidden(this._inflightSize);
  }

  _stopPerformance() {
    this._stopFrameLoop();
    if (this._healthBound) {
      try {
        window.removeEventListener('pagehide', this._onHealthHide);
        window.removeEventListener('pageshow', this._onHealthShow);
      } catch (_err) {
        // ignore
      }
      this._healthBound = false;
      this._onHealthHide = null;
      this._onHealthShow = null;
    }
  }

  /**
   * The next rs_event_id: the first 16 characters of the device id, the
   * client's start time in hex, an 8 hex character per-launch nonce and a
   * counter. Matches ^[A-Za-z0-9_-]{1,64}$.
   */
  _nextEventId(deviceId) {
    if (!this._eventNonce) this._eventNonce = randomHex(4);
    this._eventCounter += 1;
    return (
      eventIdPrefix(deviceId) + '-' +
      Math.max(0, Math.floor(this._startedAt / 1000)).toString(16) + '-' +
      this._eventNonce + '-' +
      this._eventCounter
    );
  }

  /**
   * Debug only: warns once per event and key about an `rs_kind` outside
   * RS_KINDS or an `rs_` key Ravensight does not read. Never throws.
   */
  _checkReservedKeys(event, data) {
    try {
      for (const key of Object.keys(data)) {
        if (!key.startsWith('rs_')) continue;
        let problem = null;
        if (key === 'rs_kind') {
          const value = data[key];
          if (!RS_KINDS.includes(value)) {
            problem =
              'rs_kind ' + JSON.stringify(value) + ' is not one of ' + RS_KINDS.join(', ') +
              '; the dashboard falls back to the event name';
          }
        } else if (!KNOWN_RS_KEYS.includes(key)) {
          problem = key + ' is not a key Ravensight reads; keys starting with rs_ are reserved';
        }
        if (!problem) continue;
        const seen = event + '\u0000' + key;
        if (this._reservedWarned.has(seen)) continue;
        this._reservedWarned.add(seen);
        if (typeof console !== 'undefined') console.warn('[ravensight] event "' + event + '": ' + problem);
      }
    } catch (_err) {
      // A diagnostic must never break tracking.
    }
  }

  /**
   * Sends queued events in batches of at most 50 until the queue drains or the
   * server asks us to back off. Events are only removed once accepted.
   *
   * @returns {Promise<{sent: number, queued: number, skipped?: string}>}
   */
  async flush(options = {}) {
    const force = Boolean(options && options.force);

    if (!this._canSend) return { sent: 0, queued: this.queue.length, skipped: 'inactive' };
    if (this.queue.length === 0) return { sent: 0, queued: 0 };
    if (this._flushing) return { sent: 0, queued: this.queue.length, skipped: 'in-progress' };
    if (!force && this._clock() < this._nextAttemptAt) {
      return { sent: 0, queued: this.queue.length, skipped: 'backoff' };
    }

    this._flushing = true;
    this._flushPromise = this._drain().finally(() => {
      this._flushing = false;
      this._flushPromise = null;
    });
    return this._flushPromise;
  }

  /** Waits out a flush already in flight, then forces one more. */
  async _flushAfterInflight() {
    if (this._flushPromise) await this._flushPromise.catch(noop);
    return this.flush({ force: true });
  }

  /**
   * Submits player feedback. Requires an active session.
   * @throws {RavensightError}
   */
  async submitFeedback(message, category, rating) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new RavensightError('feedback message is empty', 'empty_message');
    }
    // null, undefined and '' all mean "not given".
    const hasCategory = category != null && category !== '';
    const hasRating = rating != null && rating !== '';
    if (hasCategory && !FEEDBACK_CATEGORIES.includes(category)) {
      throw new RavensightError(
        'feedback category must be one of: ' + FEEDBACK_CATEGORIES.join(', '),
        'invalid_category',
      );
    }
    if (hasRating && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      throw new RavensightError('feedback rating must be an integer from 1 to 5', 'invalid_rating');
    }
    if (!this._hasKey) throw new RavensightError('no ingest key', 'no_key');
    if (!this.isActive) {
      throw new RavensightError('tracking is disabled', 'tracking_disabled');
    }

    const payload = { message };
    if (hasCategory) payload.category = category;
    if (hasRating) payload.rating = rating;

    const send = async () => {
      const token = await this._ensureSession();
      return this._request('POST', '/feedback', {
        headers: { 'X-Session-Token': token },
        body: payload,
      });
    };

    let res = await send();
    if (res.status === 401) {
      this._invalidateSession();
      res = await send();
    }

    if (res.status !== 201) {
      throw new RavensightError(
        'feedback submission failed (HTTP ' + res.status + ')',
        this._errorCode(res, 'feedback_failed'),
        res.status,
      );
    }
    return { ok: true };
  }

  /**
   * EXPERIMENTAL. Fetches AI generated design suggestions for this game.
   * Returns an empty array until the game has enough data. Shape may change.
   * @throws {RavensightError}
   */
  async fetchSuggestions() {
    if (!this._hasKey) throw new RavensightError('no ingest key', 'no_key');
    const res = await this._request('GET', '/agent/suggestions', {
      headers: { 'X-API-Key': this.ingestKey },
    });
    if (res.status !== 200) {
      throw new RavensightError(
        'fetch suggestions failed (HTTP ' + res.status + ')',
        this._errorCode(res, 'suggestions_failed'),
        res.status,
      );
    }
    const body = res.body;
    return body && Array.isArray(body.suggestions) ? body.suggestions : [];
  }

  /**
   * Local opt in/out. Disabling discards anything still queued so an opt out
   * does not leave player data sitting in memory.
   *
   * With consent 'opt_in', `true` is the player's yes: it is stored as
   * `ravensight_optin`, the device id is made, and an init() called before
   * the yes runs now. `false` removes the stored yes and keeps the device id
   * (resetDeviceId() forgets it). With 'opt_out' nothing is stored. Inert
   * (no key), only the flag changes and nothing is stored.
   */
  setEnabled(value) {
    const next = Boolean(value);
    if (this._hasKey && this.consent === 'opt_in' && !this._playtestToken) {
      if (next && !this._consented) {
        this._consented = true;
        this._writeOptIn(true);
        if (this.deviceId == null) this.deviceId = this._loadOrCreateDeviceId();
        else if (this._deviceIdUnsaved) this._persistDeviceId(this.deviceId);
        this._deviceIdUnsaved = false;
      } else if (!next && this._consented) {
        this._consented = false;
        this._writeOptIn(false);
      }
    }
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      this._configGeneration += 1;
      this._configs.clear();
      this.stats.dropped += this.queue.length;
      this.queue.length = 0;
      this._stopTimer();
      this._stopFrameLoop();
    } else if (this.initialized && this.trackingEnabled) {
      this._startTimer();
      if (this.performance) this._startFrameLoop();
    } else if (this._initRequested && !this.initialized && !this._disposed && !this._disposing) {
      this._initRequested = false;
      this.init().catch(noop);
    }
    if (next && this.performance && isBrowser()) {
      this._startPerformance();
      this._startFrameLoop();
    }
  }

  /** The same as setEnabled, under the name the LÖVE SDK uses. */
  setTrackingEnabled(value) {
    this.setEnabled(value);
  }

  _readOptIn(storage) {
    try {
      return Boolean(storage) && storage.getItem(OPTIN_KEY) === '1';
    } catch (_err) {
      return false;
    }
  }

  _writeOptIn(yes) {
    try {
      if (yes) this._storage.setItem(OPTIN_KEY, '1');
      else if (typeof this._storage.removeItem === 'function') this._storage.removeItem(OPTIN_KEY);
      else this._storage.setItem(OPTIN_KEY, '0');
    } catch (_err) {
      // Blocked storage: the choice holds for this client only.
    }
  }

  /**
   * Changes the device id, for example once a player signs in. The switch is
   * immediate: nothing is flushed or waited for. Events already queued keep
   * the id they were tracked under and drain under that id's own session,
   * which stays cached. The new id is stored under `ravensight_device_id`
   * and its session opens on the next flush.
   *
   * @returns {Promise<{previousId: string, queuedUnderPreviousId: number}>}
   * @throws {TypeError} when `id` is not a non-empty string.
   * @throws {RavensightError} code `disposed` after dispose().
   */
  async setDeviceId(id) {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');
    if (!isNonEmptyString(id)) {
      throw new TypeError('Ravensight: `id` must be a non-empty string');
    }
    const previousId = this.deviceId;
    const queuedUnderPreviousId = this.queue.filter((item) => item.deviceId === previousId).length;
    if (id !== previousId) {
      this.deviceId = id;
      this._persistDeviceId(id);
    }
    return { previousId, queuedUnderPreviousId };
  }

  /**
   * Switches to a fresh random device id, so nothing links later events to
   * this install's earlier ones. Same semantics as setDeviceId.
   *
   * @returns {Promise<string>} the new id.
   */
  async resetDeviceId() {
    const next = 'dev_' + randomId();
    await this.setDeviceId(next);
    return next;
  }

  /**
   * Joins a session opened elsewhere, typically the browser's, so server side
   * events for that player share its analytics session. `token` is the
   * browser's `rs.sessionToken`. The next session opened for `deviceId`
   * (default: the current id) carries it once; any session already cached
   * for that id is dropped. A refused join token falls back to a plain
   * session and is recorded as stats.lastError `invalid_join_token`.
   *
   * Idempotent per device id: repeating the token already joined for an id
   * does nothing and resolves `{ joined: false, reason: 'already_joined' }`.
   * A different token for the same id replaces the join. Otherwise the
   * session is opened now, bounded by the request timeout, and the promise
   * resolves `{ joined: true, synthetic }`, where `synthetic` is the server's
   * `true` or `false` (a persona account or not), or `null` when it did not
   * say. When the session cannot open, or the token is refused, it resolves
   * `{ joined: false, reason }` and never rejects. Read the answer later with
   * isSynthetic(deviceId).
   *
   * @returns {Promise<{joined: boolean, synthetic?: boolean|null, reason?: string}>}
   * @throws {TypeError} when `token` or `options.deviceId` is not a non-empty string.
   * @throws {RavensightError} code `disposed` after dispose().
   */
  joinSession(token, options) {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');
    if (!isNonEmptyString(token)) {
      throw new TypeError('Ravensight: `token` must be a non-empty string');
    }
    let deviceId = this.deviceId;
    if (options && options.deviceId !== undefined) {
      if (!isNonEmptyString(options.deviceId)) {
        throw new TypeError('Ravensight: `deviceId` must be a non-empty string');
      }
      deviceId = options.deviceId;
    }
    if (!this._hasKey) return Promise.resolve({ joined: false, reason: 'no_key' });
    const entry = this._sessionEntry(deviceId);
    if (entry.joinedWith === token) {
      // Still opening: share the pending answer. Settled: nothing to do.
      if (entry.joinPending) return entry.joinPending;
      return Promise.resolve({ joined: false, reason: 'already_joined' });
    }
    entry.joinedWith = token;
    entry.joinToken = token;
    entry.synthetic = null;
    entry.token = null;
    entry.expiresAt = 0;
    const pending = this._awaitJoin(deviceId, entry, token).finally(() => {
      if (entry.joinPending === pending) entry.joinPending = null;
    });
    entry.joinPending = pending;
    return pending;
  }

  async _awaitJoin(deviceId, entry, token) {
    const replaced = { joined: false, reason: 'replaced' };
    const fail = (reason) => {
      if (entry.joinedWith === token) entry.joinedWith = null;
      return { joined: false, reason };
    };
    // In backoff: say so at once, with no request and no longer backoff.
    if (this._clock() < this._nextAttemptAt) return fail('offline');
    // An open already in flight cannot carry this token (it started before
    // the join). Let it finish, then open again with the join.
    if (entry.promise) {
      try {
        await entry.promise;
      } catch (err) {
        // Its failure is not this join's; the open below reports its own.
      }
    }
    if (entry.joinedWith !== token) return replaced;
    if (this._clock() < this._nextAttemptAt) return fail('offline');
    try {
      await this.session(deviceId);
    } catch (err) {
      if (entry.joinedWith !== token) return replaced;
      return fail((err && err.code) || 'session_failed');
    }
    const outcome = entry.joinOutcome;
    if (entry.joinedWith !== token || !outcome || outcome.token !== token) return replaced;
    if (!outcome.joined) return fail(outcome.reason);
    return { joined: true, synthetic: outcome.synthetic };
  }

  /**
   * Whether the server judged the session joined for `deviceId` (default: the
   * current id) to belong to a synthetic (persona) account: `true`, `false`,
   * or `null` when no join has settled or the server did not say.
   */
  isSynthetic(deviceId = this.deviceId) {
    const entry = this._sessions.get(deviceId);
    return entry && typeof entry.synthetic === 'boolean' ? entry.synthetic : null;
  }

  /**
   * Shuts the client down. The timer and page listeners stop at once and
   * track() returns false from the first call. By default the queue is then
   * flushed, bounded by `timeoutMs`, and in a browser one last best effort
   * keepalive or beacon request carries whatever is left. Anything still
   * queued after that is dropped and counted in stats.dropped.
   *
   * @returns {Promise<{sent: number, dropped: number}>}
   */
  dispose(options = {}) {
    if (this._disposePromise) return this._disposePromise.then(() => ({ sent: 0, dropped: 0 }));
    const opts = options || {};
    const flush = opts.flush === undefined ? true : Boolean(opts.flush);
    const timeoutMs = opts.timeoutMs == null ? DEFAULT_DISPOSE_TIMEOUT_MS : Number(opts.timeoutMs);

    this._disposing = true;
    this._stopTimer();
    this._unbindLifecycle();

    this._disposePromise = this._finishDispose(flush, timeoutMs);
    return this._disposePromise;
  }

  async _finishDispose(flush, timeoutMs) {
    let sent = 0;

    if (flush && this.queue.length > 0 && this._canSend) {
      const sentBefore = this.stats.sent;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs > 0 ? timeoutMs : 0);
      });
      try {
        await Promise.race([this._flushAfterInflight().catch(noop), timeout]);
      } finally {
        clearTimeout(timer);
      }
      sent += this.stats.sent - sentBefore;

      // Events in a batch that is still awaiting an answer stay at the head
      // of the queue. Their outcome is unknown, so they are never re sent
      // (that could deliver them twice) and are counted as dropped below.
      const inflight = this._inflightSize;
      if (this.queue.length > inflight && (this._env || isBrowser())) {
        const before = this.queue.length;
        if (this._flushOnHidden(inflight)) sent += before - this.queue.length;
      }
    }

    const dropped = this.queue.length;
    this.stats.dropped += dropped;
    this.queue.length = 0;
    this._disposed = true;
    this._sessions.clear();
    this._configGeneration += 1;
    this._configs.clear();
    return { sent, dropped };
  }

  // --- Session ------------------------------------------------------------

  /** True when `deviceId` (default: the current id) has a session that has not expired. */
  isSessionValid(deviceId = this.deviceId) {
    const entry = this._sessions.get(deviceId);
    return Boolean(entry && entry.token) && this._clock() < entry.expiresAt - EXPIRY_SKEW_MS;
  }

  /** The cached session token for `deviceId` (default: the current id) while it is valid, else null. */
  sessionTokenFor(deviceId = this.deviceId) {
    return this.isSessionValid(deviceId) ? this._sessions.get(deviceId).token : null;
  }

  /**
   * Resolves with `{ token, expiresAt }` once `deviceId` (default: the current
   * id) has an open session, opening one if needed through the same path the
   * flush uses, so concurrent calls share one request. Rejects, never throws,
   * with a RavensightError whose `code` is the init reason: `no_key`,
   * `no_consent`, `invalid_key`, `tracking_disabled`, `offline`,
   * `rate_limited`, `session_failed`, `disabled` or `disposed` (also when dispose() runs mid-open), or
   * `session_failed` when a joinSession() race replaced the session mid-open.
   *
   * @returns {Promise<{token: string, expiresAt: number}>}
   */
  async session(deviceId = this.deviceId) {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');
    if (!this._hasKey) throw new RavensightError('no ingest key', 'no_key');
    if (!this._consented) throw new RavensightError('the player has not opted in', 'no_consent');
    if (!this.enabled) throw new RavensightError('client is disabled', 'disabled');
    if (this._invalidKey) throw new RavensightError('the ingest key was refused', 'invalid_key');
    if (!this.trackingEnabled || this._playtestClosed) {
      throw new RavensightError('tracking is disabled', 'tracking_disabled');
    }
    if (!isNonEmptyString(deviceId)) {
      throw new TypeError('Ravensight: `deviceId` must be a non-empty string');
    }
    let token;
    try {
      token = await this._ensureSession(deviceId);
    } catch (err) {
      const reason = (err && err.reason) || 'session_failed';
      throw new RavensightError((err && err.message) || 'session creation failed', reason, err && err.status);
    }
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');
    const entry = this._sessions.get(deviceId);
    // The entry changed while opening (a joinSession race): there is no
    // expiry to report for this token, so say the open did not settle.
    if (!entry || entry.token !== token) {
      throw new RavensightError('session changed while opening', 'session_failed');
    }
    return { token, expiresAt: entry.expiresAt };
  }

  _invalidateSession(deviceId = this.deviceId) {
    const entry = this._sessions.get(deviceId);
    if (!entry) return;
    entry.token = null;
    entry.expiresAt = 0;
  }

  /** The cache entry for `deviceId`, created if absent and marked most recently used. */
  _sessionEntry(deviceId) {
    let entry = this._sessions.get(deviceId);
    if (entry) {
      this._sessions.delete(deviceId);
      this._sessions.set(deviceId, entry);
    } else {
      entry = {
        token: null,
        expiresAt: 0,
        promise: null,
        joinToken: null,
        joinedWith: null,
        joinOutcome: null,
        joinPending: null,
        synthetic: null,
      };
      this._sessions.set(deviceId, entry);
      // Never the entry being created: the caller is about to use it.
      this._evictSessions(deviceId);
    }
    return entry;
  }

  /**
   * Drops least recently used sessions past `maxSessions`. Never `keepId`,
   * the current id, one still opening, or one holding a join token not yet
   * used. When every entry is protected the cache stays over the bound until
   * one frees up, so `maxSessions` is a soft bound.
   */
  _evictSessions(keepId) {
    if (this._sessions.size <= this.maxSessions) return;
    for (const [id, entry] of this._sessions) {
      if (this._sessions.size <= this.maxSessions) break;
      if (id === keepId || id === this.deviceId || entry.promise || entry.joinToken) continue;
      this._sessions.delete(id);
      this.stats.sessionsEvicted += 1;
    }
  }

  /** Returns a valid session token for `deviceId`, creating one if needed. Deduplicated per id. */
  _ensureSession(deviceId = this.deviceId) {
    const entry = this._sessionEntry(deviceId);
    if (this.isSessionValid(deviceId)) return Promise.resolve(entry.token);
    if (entry.promise) return entry.promise;

    entry.promise = this._createSession(deviceId, entry).finally(() => {
      entry.promise = null;
    });
    return entry.promise;
  }

  async _createSession(deviceId, entry) {
    const joinToken = entry.joinToken;
    const headers = { 'X-API-Key': this.ingestKey };
    if (this._playtestToken) headers['X-Ravensight-Playtest'] = 'Bearer ' + this._playtestToken;
    const body = { deviceId, gameVersion: this.gameVersion, platform: this.platform, sdk: 'js/' + VERSION };
    if (joinToken) body.joinToken = joinToken;
    if (this.distribution) body.distribution = this.distribution;

    const res = await this._request('POST', '/session', { headers, body });

    if (res.status === 201 && res.body && res.body.token) {
      const token = String(res.body.token);
      if (this._disposed) {
        // dispose() finished while this was in flight. Do not store it.
        return token;
      }
      // joinSession() was called again while this was in flight: the next
      // session for this id must carry the newer join token, so keep none.
      if (entry.joinToken !== joinToken) return token;
      if (joinToken) {
        const synthetic = typeof res.body.synthetic === 'boolean' ? res.body.synthetic : null;
        entry.joinOutcome = { token: joinToken, joined: res.body.joined !== false, synthetic };
        entry.synthetic = synthetic;
      }
      entry.joinToken = null;
      entry.token = token;
      entry.expiresAt = this._resolveExpiry(res.body);
      // The entry may have been evicted meanwhile; put it back.
      if (this._sessions.get(deviceId) !== entry) this._sessions.set(deviceId, entry);
      this.stats.sessions += 1;
      this._resetBackoff();
      this._evictSessions(deviceId);
      this._log('session ready');
      await this.fetchConfig(deviceId);
      return token;
    }

    const code = res.body && typeof res.body.error === 'string' ? res.body.error : null;

    // A stale or foreign join token. Forget it and open a plain session.
    if (res.status === 401 && joinToken && code === 'invalid_join_token') {
      if (entry.joinToken === joinToken) {
        entry.joinToken = null;
        entry.joinOutcome = { token: joinToken, joined: false, reason: 'invalid_join_token' };
      }
      this._recordError('invalid_join_token', 401);
      this._log('join token refused, opening a plain session');
      return this._createSession(deviceId, entry);
    }

    // The playtest job this token belongs to has finished: nothing more may
    // be sent, ever, by this client.
    if (res.status === 403 && code === 'playtest_job_closed') {
      this._playtestClosed = true;
      this._disableTracking();
      this._recordError('playtest_job_closed', 403);
      const closed = new RavensightError('playtest job closed', 'playtest_job_closed', 403);
      closed.reason = 'tracking_disabled';
      throw closed;
    }

    const reason = this._sessionFailure(res, code);
    this._recordError(reason, res.status);
    const err = new RavensightError('session creation failed (HTTP ' + res.status + ')', reason, res.status);
    err.reason = reason;
    throw err;
  }

  /**
   * Applies the side effects of a refused POST /session and names the reason.
   * Mapped on status, because the body text is not a contract, except for
   * the one 403 body that means the kill switch.
   */
  _sessionFailure(res, code) {
    const status = res.status;

    if (status === 0) {
      this._scheduleBackoff();
      return 'offline';
    }
    if (status === 403 && code === 'tracking_disabled') {
      this._disableTracking();
      return 'tracking_disabled';
    }
    if (status === 401 || status === 403) {
      this._refuseKey();
      return 'invalid_key';
    }
    if (status === 429) {
      this._applyRetryAfter(res);
      return 'rate_limited';
    }
    this._scheduleBackoff();
    return 'session_failed';
  }

  /** The server switched tracking off for this game. Same as the kill switch on init(). */
  _disableTracking() {
    this.trackingEnabled = false;
    this.queue.length = 0;
    this._stopTimer();
    this._log('tracking disabled by server kill switch');
  }

  /**
   * The key was refused by the settings check or POST /session. Retrying
   * cannot fix that, so the run ends: the queue is cleared, the timer stops,
   * nothing is retried and track() returns false. A new client starts over.
   */
  _refuseKey() {
    this._invalidKey = true;
    this.stats.dropped += this.queue.length;
    this.queue.length = 0;
    this._stopTimer();
    if (!this._invalidKeyWarned && typeof console !== 'undefined') {
      this._invalidKeyWarned = true;
      console.warn(
        '[ravensight] the ingest key was refused (invalid_key), so analytics is off for the rest of ' +
          'this run. Check your publishable key.',
      );
    }
  }

  _recordError(code, status) {
    this.stats.lastError = { code, status, at: this._clock() };
  }

  /** The error code for a failed request: offline, rate_limited, else the server's code or `fallback`. */
  _failureCode(res, fallback) {
    if (res.status === 0) return 'offline';
    if (res.status === 429) return 'rate_limited';
    return this._errorCode(res, fallback);
  }

  _resolveExpiry(body) {
    if (body.expiresAt != null) {
      if (typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)) {
        return body.expiresAt * 1000;
      }
      const parsed = Date.parse(String(body.expiresAt));
      if (Number.isFinite(parsed)) return parsed;
    }
    const expiresIn = Number(body.expiresIn);
    const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86400;
    return this._clock() + seconds * 1000;
  }

  // --- Flushing -----------------------------------------------------------

  async _drain() {
    let sent = 0;
    let batchLimit = MAX_BATCH_SIZE;
    let reauthAttempts = 0;

    while (this.queue.length > 0) {
      if (this._clock() < this._nextAttemptAt) break;

      // One request carries one device: the leading run sharing the head's id.
      const deviceId = this.queue[0].deviceId;
      let token;
      try {
        token = await this._ensureSession(deviceId);
      } catch (_err) {
        break;
      }
      if (this._disposed) break;
      if (this.queue.length === 0) break;
      // The head can change during the await: the queue cap may have shifted
      // this device's run out. Never send another device's events under this
      // token; re-evaluate the head run instead.
      if (this.queue[0].deviceId !== deviceId) continue;

      const size = Math.min(batchLimit, this._runLength(0));
      this._inflightSize = size;
      let res;
      try {
        res = await this._request('POST', '/track/batch', {
          headers: { 'X-Session-Token': token },
          body: { events: wireEvents(this.queue.slice(0, size)) },
        });
      } finally {
        this._inflightSize = 0;
      }

      // dispose() timed out while this batch was in flight and has already
      // counted the queue as dropped. Leave the cleared queue alone.
      if (this._disposed) break;

      if (res.status !== 202) this._recordError(this._failureCode(res, 'batch_failed'), res.status);

      if (res.status === 202) {
        this.queue.splice(0, size);
        sent += size;
        this.stats.sent += size;
        this.stats.flushes += 1;
        batchLimit = MAX_BATCH_SIZE;
        reauthAttempts = 0;
        this._resetBackoff();
        continue;
      }

      if (res.status === 401) {
        // That device's session expired or was revoked. Its events stay
        // queued and are re sent as soon as a fresh session is issued.
        this._invalidateSession(deviceId);
        reauthAttempts += 1;
        if (reauthAttempts > 2) break;
        this._log('session expired, re authenticating');
        continue;
      }

      if (res.status === 429) {
        this._applyRetryAfter(res);
        break;
      }

      if (res.status === 400) {
        if (size > 1) {
          // Payload too large for the server. Halve the batch and retry.
          batchLimit = Math.max(1, Math.floor(size / 2));
          this._log('batch rejected as oversize, splitting to ' + batchLimit);
          continue;
        }
        // A single event the server will never accept. Drop it so the rest of
        // the queue is not blocked forever.
        this.queue.shift();
        this.stats.dropped += 1;
        batchLimit = MAX_BATCH_SIZE;
        this._log('dropped one event rejected with HTTP 400');
        continue;
      }

      this._scheduleBackoff();
      break;
    }

    return { sent, queued: this.queue.length };
  }

  /** How many events from `offset` share that event's device id, capped at one batch. */
  _runLength(offset) {
    const head = this.queue[offset];
    if (!head) return 0;
    let n = 1;
    while (
      n < MAX_BATCH_SIZE &&
      offset + n < this.queue.length &&
      this.queue[offset + n].deviceId === head.deviceId
    ) {
      n += 1;
    }
    return n;
  }

  _resetBackoff() {
    this._backoffMs = DEFAULT_RETRY_MS;
    this._nextAttemptAt = 0;
  }

  /** The backoff wait with plus or minus 20 percent jitter, never past the 5 minute ceiling. */
  _scheduleBackoff() {
    let r = Number(this._random());
    if (!(r >= 0 && r < 1)) r = 0.5;
    const factor = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * r;
    const wait = Math.min(Math.round(this._backoffMs * factor), MAX_BACKOFF_MS);
    this._nextAttemptAt = this._clock() + wait;
    this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);
  }

  _applyRetryAfter(res) {
    const wait = parseRetryAfterMs(res.headers ? res.headers.get('retry-after') : null);
    if (wait > 0) {
      this._nextAttemptAt = this._clock() + wait;
      this._log('rate limited, honoring Retry-After of ' + wait + 'ms');
      return;
    }
    this._scheduleBackoff();
  }

  // --- Page unload --------------------------------------------------------

  _unloadEnv() {
    if (this._env) return this._env;
    let hasFetchKeepalive = false;
    try {
      hasFetchKeepalive = typeof Request === 'function' && 'keepalive' in Request.prototype;
    } catch (_err) {
      hasFetchKeepalive = false;
    }
    const hasBeacon =
      typeof navigator !== 'undefined' && navigator && typeof navigator.sendBeacon === 'function';
    return { hasFetchKeepalive, hasBeacon };
  }

  /**
   * Builds the request used for the last flush before a page goes away.
   * Pure and side effect free so it can be unit tested without a browser.
   */
  _buildUnloadRequest(events, token, env) {
    const transport = chooseUnloadTransport(env || this._unloadEnv());
    const body = JSON.stringify({ events: wireEvents(events) });
    const url = this.apiUrl + '/track/batch';

    if (transport === 'fetch-keepalive') {
      return {
        transport,
        url,
        body,
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      };
    }
    if (transport === 'beacon') {
      // sendBeacon cannot set headers, so the token rides INSIDE the JSON
      // body (never the URL, where proxies and logs could capture it). The
      // API accepts body.sessionToken on ingest POSTs for exactly this path.
      const parsed = JSON.parse(body);
      parsed.sessionToken = token;
      return {
        transport,
        url,
        body: JSON.stringify(parsed),
        headers: null,
      };
    }
    return { transport: 'none', url, body, headers: null };
  }

  /**
   * Best effort flush of one batch now, for a page that is going away: the
   * run of events sharing one device id, under that id's cached session, by
   * fetch keepalive or sendBeacon. Events in a batch request still awaiting
   * an answer are skipped, so nothing is sent twice. `offset` is accepted for
   * callers that track the in-flight count themselves (the LÖVE bridge); the
   * larger of it and the SDK's own count is used. Returns true when a
   * request was handed to the browser.
   */
  flushOnHidden(offset) {
    const given = Number.isInteger(offset) && offset > 0 ? offset : 0;
    return this._flushOnHidden(Math.max(given, this._inflightSize));
  }

  /**
   * Best effort flush of one batch while the page is being hidden: the run of
   * events sharing the device id at `offset`, under that id's cached session.
   * `offset` skips events already in a batch request awaiting an answer.
   */
  _flushOnHidden(offset = 0) {
    // There is no page to hide in Node.
    if (!this._env && !isBrowser()) return false;
    if (!this._canSend || this.queue.length <= offset) return false;
    const deviceId = this.queue[offset].deviceId;
    if (!this.isSessionValid(deviceId)) return false;

    const events = this.queue.slice(offset, offset + this._runLength(offset));
    const req = this._buildUnloadRequest(events, this._sessions.get(deviceId).token);
    if (req.transport === 'none') return false;

    try {
      if (req.transport === 'fetch-keepalive') {
        this._fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          keepalive: true,
        }).catch(noop);
      } else {
        const blob =
          typeof Blob === 'function' ? new Blob([req.body], { type: 'application/json' }) : req.body;
        navigator.sendBeacon(req.url, blob);
      }
      // Optimistic: the page may never come back to confirm delivery.
      this.queue.splice(offset, events.length);
      return true;
    } catch (_err) {
      return false;
    }
  }

  _bindLifecycle() {
    if (this._listenersBound) return;
    if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') {
      return;
    }
    this._onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this._flushOnHidden(this._inflightSize);
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._listenersBound = true;
  }

  /** Sends `game_exited` once, on the first `pagehide`, through the hidden-flush path. */
  _bindPageHide() {
    if (this._pageHideBound || typeof window === 'undefined' || !window) return;
    if (typeof window.addEventListener !== 'function') return;
    this._onPageHide = () => {
      if (this._exitSent || !this._startSent) return;
      this._exitSent = true;
      if (!this.track('game_exited')) return;
      this._flushOnHidden(this._inflightSize);
    };
    window.addEventListener('pagehide', this._onPageHide);
    this._pageHideBound = true;
  }

  _unbindPageHide() {
    if (!this._pageHideBound) return;
    try {
      window.removeEventListener('pagehide', this._onPageHide);
    } catch (_err) {
      // ignore
    }
    this._pageHideBound = false;
    this._onPageHide = null;
  }

  _unbindLifecycle() {
    this._unbindPageHide();
    this._stopPerformance();
    if (!this._listenersBound) return;
    try {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    } catch (_err) {
      // ignore
    }
    this._listenersBound = false;
    this._onVisibilityChange = null;
  }

  // --- Timer --------------------------------------------------------------

  _startTimer() {
    if (this._timer || !(this.autoFlushMs > 0) || this._invalidKey) return;
    this._timer = setInterval(() => {
      this.flush().catch(noop);
    }, this.autoFlushMs);
    // Do not hold a Node process open just for analytics.
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  // Config documents are public game settings, never credentials. A cache
  // is valid only for the exact endpoint, key, device, platform and build.
  _configScope(deviceId) {
    return JSON.stringify([this.apiUrl, this.ingestKey, deviceId, this.platform, this.gameVersion]);
  }

  _validConfig(input) {
    try {
      if (!input || typeof input !== 'object' || !input.values || Array.isArray(input.values) ||
          typeof input.values !== 'object' || !Array.isArray(input.experiments) || input.experiments.length > 10 ||
          Object.keys(input.values).length > 50 || typeof input.etag !== 'string' || !/^"[a-f0-9]{64}"$/.test(input.etag)) return null;
      const inspect = (value, depth = 0) => {
        if (depth > 20 || typeof value === 'number' && !Number.isFinite(value) ||
            ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('invalid config');
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('reserved property');
          inspect(child, depth + 1);
        }
      };
      for (const [key, value] of Object.entries(input.values)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || ["constructor", "prototype"].includes(key)) return null;
        inspect(value);
        if (utf8Length(JSON.stringify(value)) > 8192) return null;
      }
      const seen = new Set();
      for (const row of input.experiments) {
        if (!row || !/^[a-z][a-z0-9_]{0,63}$/.test(row.key) ||
            !/^[a-z][a-z0-9_-]{0,39}$/.test(row.variant) || seen.has(row.key)) return null;
        seen.add(row.key);
      }
      return JSON.parse(JSON.stringify({ values: input.values, experiments: input.experiments, etag: input.etag }));
    } catch { return null; }
  }

  _cachedConfig(deviceId) {
    if (!this.isActive) return null;
    const scope = this._configScope(deviceId);
    if (this._configs.has(scope)) return this._configs.get(scope);
    if (!this._playtestToken) try {
      const stored = JSON.parse(this._storage.getItem('ravensight_config_v1'));
      const doc = stored?.scope === scope ? this._validConfig(stored.document) : null;
      if (doc) { this._rememberConfig(scope, doc); return doc; }
    } catch { /* Storage is optional, including corrupt or unavailable storage. */ }
    return null;
  }

  _rememberConfig(scope, document) {
    this._configs.delete(scope);
    this._configs.set(scope, document);
    while (this._configs.size > this.maxSessions) this._configs.delete(this._configs.keys().next().value);
  }

  /** Fresh values cost one event; an unchanged ETag is free. Failures keep cached values. */
  fetchConfig(deviceId = this.deviceId) {
    if (!this.isActive || !isNonEmptyString(deviceId)) return Promise.resolve({ source: 'default', values: {} });
    const scope = this._configScope(deviceId);
    if (this._configRequests.has(scope)) return this._configRequests.get(scope);
    const generation = this._configGeneration;
    const pending = this._fetchConfig(deviceId, scope, generation).finally(() => this._configRequests.delete(scope));
    this._configRequests.set(scope, pending);
    return pending;
  }

  async _fetchConfig(deviceId, scope, generation) {
    let document = this._cachedConfig(deviceId);
    let source = document ? 'cache' : 'default';
    const headers = { 'X-API-Key': this.ingestKey };
    if (document) headers['If-None-Match'] = document.etag;
    const query = new URLSearchParams({ deviceId, platform: this.platform, gameVersion: this.gameVersion });
    // Do not let a slow config service delay starting the game indefinitely.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => {
      controller?.abort(); resolve({ status: 0 });
    }, 5000); });
    const response = await Promise.race([
      this._request('GET', '/ingest/config?' + query, { headers, signal: controller?.signal }), timeout,
    ]).finally(() => clearTimeout(timer));
    if (!this.isActive || generation !== this._configGeneration || scope !== this._configScope(deviceId)) {
      return { source: 'default', values: {} };
    }
    if (response.status === 200) {
      const fresh = this._validConfig(response.body);
      if (fresh) {
        document = fresh; source = 'network'; this._rememberConfig(scope, fresh);
        if (!this._playtestToken) try {
          // One persisted entry bounds storage and avoids a trail of old player IDs.
          this._storage.setItem('ravensight_config_v1', JSON.stringify({ scope, document: fresh }));
        } catch { /* In-memory cache still works. */ }
      }
    }
    const result = { source, values: JSON.parse(JSON.stringify(document?.values || {})) };
    if (deviceId === this.deviceId && this.onConfigReady) try { this.onConfigReady(result); } catch { /* Game callbacks cannot break tracking. */ }
    return result;
  }

  /** No coercion. Objects are copied so a caller cannot mutate cached settings. */
  getConfig(key, fallback, deviceId = this.deviceId) {
    const values = this._cachedConfig(deviceId)?.values;
    if (!values || !Object.prototype.hasOwnProperty.call(values, key)) return fallback;
    const value = values[key];
    if (value === null ? fallback !== null : typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback)) return fallback;
    return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }

  // --- HTTP ---------------------------------------------------------------

  /**
   * Performs one request and normalizes every outcome into
   * { status, body, headers }. Network failures become status 0 so callers
   * treat them like any other retryable failure.
   */
  async _request(method, path, options = {}) {
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    const init = { method, headers };
    if (options.signal) init.signal = options.signal;

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await this._fetch(this.apiUrl + path, init);
    } catch (err) {
      this._log(method + ' ' + path + ' network error: ' + err.message);
      return { status: 0, body: null, headers: null };
    }

    let body = null;
    try {
      const text = await res.text();
      if (text) body = JSON.parse(text);
    } catch (_err) {
      body = null;
    }

    return { status: res.status, body, headers: res.headers };
  }

  async _checkSettings() {
    const res = await this._request('GET', '/settings', {
      headers: { 'X-API-Key': this.ingestKey },
    });
    if (res.status === 200 && res.body && typeof res.body.trackingEnabled === 'boolean') {
      this.trackingEnabled = res.body.trackingEnabled;
      return;
    }
    const code = res.body && typeof res.body.error === 'string' ? res.body.error : null;
    if (res.status === 403 && code === 'tracking_disabled') {
      this._recordError('tracking_disabled', 403);
      this._disableTracking();
      return;
    }
    // A refused key ends the run, the same as on POST /session.
    if (res.status === 401 || res.status === 403) {
      this._recordError('invalid_key', res.status);
      this._refuseKey();
      return;
    }
    // Unreachable or malformed: assume tracking is on, same as the Godot SDK.
    this.trackingEnabled = true;
    this._recordError(this._failureCode(res, 'settings_failed'), res.status);
    if (res.status !== 200) this._log('settings check failed (HTTP ' + res.status + '), assuming enabled');
  }

  _errorCode(res, fallback) {
    if (res.body && typeof res.body.error === 'string') return res.body.error;
    return fallback;
  }

  // --- Misc ---------------------------------------------------------------

  _loadOrCreateDeviceId() {
    try {
      const existing = this._storage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
    } catch (_err) {
      // ignore
    }
    const created = 'dev_' + randomId();
    this._persistDeviceId(created);
    return created;
  }

  _persistDeviceId(id) {
    if (this._playtestToken) return;
    // Inert, or opt-in before the yes: nothing is stored. The yes stores it.
    if (!this._hasKey || !this._consented) {
      this._deviceIdUnsaved = this._hasKey;
      return;
    }
    try {
      this._storage.setItem(DEVICE_ID_KEY, id);
    } catch (_err) {
      // Non persistent device id. Sessions still work, retention will be noisy.
    }
  }

  _log(message) {
    if (this.debug && typeof console !== 'undefined') console.log('[ravensight] ' + message);
  }
}

export default Ravensight;
