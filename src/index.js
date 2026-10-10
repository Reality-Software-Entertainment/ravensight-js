/**
 * Ravensight JavaScript SDK
 *
 * Zero dependency client for the hosted Ravensight analytics API.
 * Works in browsers and in Node 18+ (built in global fetch).
 *
 * Docs: https://ravensight.io/docs/
 */

export const VERSION = '0.3.0';

export const DEFAULT_API_URL = 'https://api.ravensight.io/api/v1';

/** Server hard limit on POST /track/batch. */
export const MAX_BATCH_SIZE = 50;

/** Feedback categories the API accepts. Anything else is rejected locally. */
export const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);

/**
 * Values the reserved `rs_kind` property accepts: what an event means for the
 * level funnel. Property keys starting with `rs_` are reserved for Ravensight.
 */
export const RS_KINDS = Object.freeze(['level_start', 'level_complete', 'death', 'none']);

/** The reserved keys Ravensight reads. Any other `rs_` key is a typo or a clash. */
const KNOWN_RS_KEYS = Object.freeze(['rs_kind', 'rs_doctor']);

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
const PLAYTEST_QUERY_PARAM = 'rs_playtest';
/** Clock skew allowance so we refresh slightly before the server expires us. */
const EXPIRY_SKEW_MS = 5000;

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

function detectStorage(injected) {
  if (injected) return injected;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
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
 * The Ravensight Playtest runner hands the game a token, read in this order:
 * `window.__RAVENSIGHT_PLAYTEST__`, the `?rs_playtest=` query parameter, then
 * `localStorage['ravensight.playtest']`. Null outside a playtest.
 */
function readPlaytestToken(storage) {
  try {
    if (typeof window !== 'undefined' && window) {
      const fromGlobal = playtestTokenFrom(window[PLAYTEST_GLOBAL]);
      if (fromGlobal) return fromGlobal;
      const search = window.location && window.location.search;
      if (search && typeof URLSearchParams === 'function') {
        const fromQuery = playtestTokenFrom(new URLSearchParams(search).get(PLAYTEST_QUERY_PARAM));
        if (fromQuery) return fromQuery;
      }
    }
  } catch (_err) {
    // A hostile or partial window object. Fall through to storage.
  }
  const stores = [storage];
  try {
    if (typeof localStorage !== 'undefined' && localStorage && localStorage !== storage) stores.push(localStorage);
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

    if (typeof opts.ingestKey !== 'string' || opts.ingestKey.trim() === '') {
      throw new TypeError('Ravensight: `ingestKey` is required (your gt_live_... publishable key)');
    }

    this.ingestKey = opts.ingestKey.trim();
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.gameVersion = opts.gameVersion == null ? '1.0.0' : String(opts.gameVersion);
    this.platform = opts.platform == null ? detectPlatform() : String(opts.platform);
    this.autoFlushMs = opts.autoFlushMs == null ? DEFAULT_AUTO_FLUSH_MS : Number(opts.autoFlushMs);
    this.maxQueueSize = opts.maxQueueSize == null ? DEFAULT_QUEUE_CAP : Number(opts.maxQueueSize);
    this.maxSessions =
      opts.maxSessions == null ? DEFAULT_MAX_SESSIONS : Math.max(1, Math.floor(Number(opts.maxSessions)) || 1);
    this.debug = Boolean(opts.debug);

    this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!this._fetch) {
      throw new TypeError('Ravensight: no global fetch found. Use Node 18+ or pass `fetch`.');
    }

    this._clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._storage = detectStorage(opts.storage);
    this._env = opts.env || null;

    // Under a playtest the server decides the device id from the token, so
    // nothing is read from or written to the player's own storage.
    this._playtestToken = readPlaytestToken(this._storage);
    if (opts.deviceId) this.deviceId = String(opts.deviceId);
    else this.deviceId = this._playtestToken ? 'dev_' + randomId() : this._loadOrCreateDeviceId();

    /** Local opt out. Combined with the server kill switch by `isActive`. */
    this.enabled = opts.enabled === undefined ? true : Boolean(opts.enabled);
    /** Server kill switch from GET /settings. Assumed on until told otherwise. */
    this.trackingEnabled = true;
    this.initialized = false;

    /**
     * One cached session per device id, least recently used first:
     * deviceId -> { token, expiresAt, promise, joinToken }.
     */
    this._sessions = new Map();

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
    /** Set when POST /session refuses the key. Stops the timer until a session opens. */
    this._invalidKey = false;
    this._invalidKeyWarned = false;
    /** event + key pairs already warned about in debug mode. */
    this._reservedWarned = new Set();
    /** Set by a 403 playtest_job_closed. Permanent for this client. */
    this._playtestClosed = false;
  }

  /** True when events may actually be sent. */
  get isActive() {
    return this._canSend && !this._disposing;
  }

  /** Like isActive, but still true while dispose() delivers the last events. */
  get _canSend() {
    return this.enabled && this.trackingEnabled && !this._playtestClosed && !this._disposed;
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
   * `reason` says why the session is not ready: `invalid_key`,
   * `tracking_disabled`, `offline`, `rate_limited`, `session_failed`, or null.
   *
   * @returns {Promise<{trackingEnabled: boolean, sessionReady: boolean, reason: string|null}>}
   */
  async init() {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');

    await this._checkSettings();
    this.initialized = true;
    if (this._playtestClosed) this.trackingEnabled = false;

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
   * a session exists. Returns false when tracking is off.
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

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.stats.dropped += 1;
    }

    this.queue.push({
      event,
      data: data && typeof data === 'object' ? data : {},
      timestamp: Math.floor(this._clock() / 1000),
      deviceId,
    });
    this.stats.queued += 1;

    // While the key is refused only an explicit flush() or init() retries.
    if (this.queue.length >= MAX_BATCH_SIZE && !this._invalidKey) this.flush().catch(noop);
    return true;
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
   */
  setEnabled(value) {
    const next = Boolean(value);
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      this.stats.dropped += this.queue.length;
      this.queue.length = 0;
      this._stopTimer();
    } else if (this.initialized && this.trackingEnabled) {
      this._startTimer();
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
    const entry = this._sessionEntry(deviceId);
    entry.joinToken = token;
    entry.token = null;
    entry.expiresAt = 0;
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
    return { sent, dropped };
  }

  // --- Session ------------------------------------------------------------

  /** True when `deviceId` (default: the current id) has a session that has not expired. */
  isSessionValid(deviceId = this.deviceId) {
    const entry = this._sessions.get(deviceId);
    return Boolean(entry && entry.token) && this._clock() < entry.expiresAt - EXPIRY_SKEW_MS;
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
      entry = { token: null, expiresAt: 0, promise: null, joinToken: null };
      this._sessions.set(deviceId, entry);
      this._evictSessions();
    }
    return entry;
  }

  /**
   * Drops least recently used sessions past `maxSessions`. Never the current
   * id, one still opening, or one holding a join token not yet used.
   */
  _evictSessions() {
    if (this._sessions.size <= this.maxSessions) return;
    for (const [id, entry] of this._sessions) {
      if (this._sessions.size <= this.maxSessions) break;
      if (id === this.deviceId || entry.promise || entry.joinToken) continue;
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
    const body = { deviceId, gameVersion: this.gameVersion, platform: this.platform };
    if (joinToken) body.joinToken = joinToken;

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
      entry.joinToken = null;
      entry.token = token;
      entry.expiresAt = this._resolveExpiry(res.body);
      // The entry may have been evicted meanwhile; put it back.
      if (this._sessions.get(deviceId) !== entry) this._sessions.set(deviceId, entry);
      this.stats.sessions += 1;
      this._resetBackoff();
      this._evictSessions();
      if (this._invalidKey) {
        this._invalidKey = false;
        if (this.initialized && this.isActive) this._startTimer();
      }
      this._log('session ready');
      return token;
    }

    const code = res.body && typeof res.body.error === 'string' ? res.body.error : null;

    // A stale or foreign join token. Forget it and open a plain session.
    if (res.status === 401 && joinToken && code === 'invalid_join_token') {
      if (entry.joinToken === joinToken) entry.joinToken = null;
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
   * The key was refused. Retrying on a timer cannot fix that, so the timer
   * stops; track() still queues, and flush() or init() try again.
   */
  _refuseKey() {
    this._invalidKey = true;
    this._stopTimer();
    if (this.debug && !this._invalidKeyWarned && typeof console !== 'undefined') {
      this._invalidKeyWarned = true;
      console.warn(
        '[ravensight] the ingest key was refused (invalid_key). Automatic flushing is stopped ' +
          'until a session opens; check your gt_live_ key. Events keep queueing.',
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

  _scheduleBackoff() {
    this._nextAttemptAt = this._clock() + this._backoffMs;
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

  _unbindLifecycle() {
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

  // --- HTTP ---------------------------------------------------------------

  /**
   * Performs one request and normalizes every outcome into
   * { status, body, headers }. Network failures become status 0 so callers
   * treat them like any other retryable failure.
   */
  async _request(method, path, options = {}) {
    const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    const init = { method, headers };

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
