/**
 * Ravensight JavaScript SDK
 *
 * Zero dependency client for the hosted Ravensight analytics API.
 * Works in browsers and in Node 18+ (built in global fetch).
 *
 * Docs: https://ravensight.io/docs/
 */

const VERSION = '0.2.0';

const DEFAULT_API_URL = 'https://api.ravensight.io/api/v1';

/** Server hard limit on POST /track/batch. */
const MAX_BATCH_SIZE = 50;

/** Feedback categories the API accepts. Anything else is rejected locally. */
const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);

const DEFAULT_QUEUE_CAP = 500;
const DEFAULT_RETRY_MS = 10000;
const MAX_BACKOFF_MS = 300000;
const DEFAULT_AUTO_FLUSH_MS = 15000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2000;
const DEVICE_ID_KEY = 'ravensight_device_id';
/** Clock skew allowance so we refresh slightly before the server expires us. */
const EXPIRY_SKEW_MS = 5000;

/**
 * Error thrown by the explicit request helpers (submitFeedback,
 * fetchSuggestions). Carries a stable `code` for programmatic handling.
 * Event tracking never throws: it queues and retries instead.
 */
class RavensightError extends Error {
  constructor(message, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'RavensightError';
    this.code = code;
    this.status = status;
  }
}

/** Storage shim used when localStorage is unavailable (Node, private mode). */
class MemoryStorage {
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
function normalizeApiUrl(url) {
  const raw = String(url == null || url === '' ? DEFAULT_API_URL : url).trim();
  const trimmed = raw.replace(/\/+$/, '');
  return /\/api\/v1$/.test(trimmed) ? trimmed : trimmed + '/api/v1';
}

/** Parses a delta seconds Retry-After header. Returns 0 when absent/invalid. */
function parseRetryAfterMs(value) {
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
function chooseUnloadTransport(env) {
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
class Ravensight {
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
    this.debug = Boolean(opts.debug);

    this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!this._fetch) {
      throw new TypeError('Ravensight: no global fetch found. Use Node 18+ or pass `fetch`.');
    }

    this._clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._storage = detectStorage(opts.storage);
    this._env = opts.env || null;

    this.deviceId = opts.deviceId ? String(opts.deviceId) : this._loadOrCreateDeviceId();

    /** Local opt out. Combined with the server kill switch by `isActive`. */
    this.enabled = opts.enabled === undefined ? true : Boolean(opts.enabled);
    /** Server kill switch from GET /settings. Assumed on until told otherwise. */
    this.trackingEnabled = true;
    this.initialized = false;

    this.sessionToken = null;
    this.sessionExpiresAt = 0;

    this.queue = [];
    this.stats = { queued: 0, sent: 0, dropped: 0, flushes: 0, sessions: 0 };

    this._disposed = false;
    this._disposing = false;
    this._disposePromise = null;
    this._flushing = false;
    this._flushPromise = null;
    /** Events in the batch request currently awaiting an answer. */
    this._inflightSize = 0;
    this._sessionPromise = null;
    this._timer = null;
    this._nextAttemptAt = 0;
    this._backoffMs = DEFAULT_RETRY_MS;
    this._listenersBound = false;
    this._onVisibilityChange = null;
  }

  /** True when events may actually be sent. */
  get isActive() {
    return this._canSend && !this._disposing;
  }

  /** Like isActive, but still true while dispose() delivers the last events. */
  get _canSend() {
    return this.enabled && this.trackingEnabled && !this._disposed;
  }

  /** Milliseconds until the next allowed network attempt (0 when clear). */
  get retryInMs() {
    return Math.max(0, this._nextAttemptAt - this._clock());
  }

  /**
   * Reads the server kill switch, opens a session, and starts the flush timer.
   * Never throws on network failure: the SDK degrades to queue and retry.
   *
   * @returns {Promise<{trackingEnabled: boolean, sessionReady: boolean}>}
   */
  async init() {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');

    await this._checkSettings();
    this.initialized = true;

    if (!this.trackingEnabled) {
      this._log('tracking disabled by server kill switch');
      this.queue.length = 0;
      return { trackingEnabled: false, sessionReady: false };
    }

    let sessionReady = false;
    try {
      await this._ensureSession();
      sessionReady = true;
    } catch (err) {
      this._log('session not ready yet: ' + err.message);
    }

    this._startTimer();
    this._bindLifecycle();

    if (sessionReady && this.queue.length > 0) {
      this.flush().catch(noop);
    }

    return { trackingEnabled: true, sessionReady };
  }

  /**
   * Queues an event. Safe to call before init(): events are held and sent once
   * a session exists. Returns false when tracking is off.
   */
  track(event, data) {
    if (typeof event !== 'string' || event.trim() === '') {
      throw new TypeError('Ravensight: `event` must be a non-empty string');
    }
    if (!this.isActive) return false;

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.stats.dropped += 1;
    }

    this.queue.push({
      event,
      data: data && typeof data === 'object' ? data : {},
      timestamp: Math.floor(this._clock() / 1000),
    });
    this.stats.queued += 1;

    if (this.queue.length >= MAX_BATCH_SIZE) this.flush().catch(noop);
    return true;
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
   * Changes the device id, for example to the player's account id on a Node
   * server. Events queued before the switch are flushed first, under the old
   * session, because the server stamps the device id from the session. Then
   * the session is dropped, the id is stored under `ravensight_device_id`,
   * and the next flush opens a new session for the new id.
   *
   * Offline edge: events that could not be flushed (no network, rate limited)
   * stay queued and go out under the new id rather than being dropped.
   *
   * @throws {TypeError} when `id` is not a non-empty string.
   * @throws {RavensightError} code `disposed` after dispose().
   */
  async setDeviceId(id) {
    if (this._disposed || this._disposing) throw new RavensightError('client disposed', 'disposed');
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('Ravensight: `id` must be a non-empty string');
    }
    if (id === this.deviceId) return;

    // A session already opening was requested for the old id. Let it and any
    // flush in flight finish first, or it would land after the switch and
    // carry later events under the old identity.
    if (this._sessionPromise) await this._sessionPromise.catch(noop);
    if (this._flushPromise) await this._flushPromise.catch(noop);
    if (this.queue.length > 0) await this._flushAfterInflight();
    if (this._sessionPromise) await this._sessionPromise.catch(noop);

    // No await from here on, so nothing can open a session in between.
    this._invalidateSession();
    this.deviceId = id;
    try {
      this._storage.setItem(DEVICE_ID_KEY, id);
    } catch (_err) {
      // Non persistent device id, same as on first run.
    }
  }

  /**
   * Switches to a fresh random device id, so nothing links later events to
   * this install's earlier ones. Same flush semantics as setDeviceId.
   *
   * @returns {Promise<string>} the new id.
   */
  async resetDeviceId() {
    const next = 'dev_' + randomId();
    await this.setDeviceId(next);
    return next;
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
    this._invalidateSession();
    return { sent, dropped };
  }

  // --- Session ------------------------------------------------------------

  isSessionValid() {
    return Boolean(this.sessionToken) && this._clock() < this.sessionExpiresAt - EXPIRY_SKEW_MS;
  }

  _invalidateSession() {
    this.sessionToken = null;
    this.sessionExpiresAt = 0;
  }

  /** Returns a valid session token, creating one if needed. Deduplicated. */
  _ensureSession() {
    if (this.isSessionValid()) return Promise.resolve(this.sessionToken);
    if (this._sessionPromise) return this._sessionPromise;

    this._sessionPromise = this._createSession().finally(() => {
      this._sessionPromise = null;
    });
    return this._sessionPromise;
  }

  async _createSession() {
    const res = await this._request('POST', '/session', {
      headers: { 'X-API-Key': this.ingestKey },
      body: {
        deviceId: this.deviceId,
        gameVersion: this.gameVersion,
        platform: this.platform,
      },
    });

    if (res.status === 201 && res.body && res.body.token) {
      if (this._disposed) {
        // dispose() finished while this was in flight. Do not store it.
        return String(res.body.token);
      }
      this.sessionToken = String(res.body.token);
      this.sessionExpiresAt = this._resolveExpiry(res.body);
      this.stats.sessions += 1;
      this._resetBackoff();
      this._log('session ready');
      return this.sessionToken;
    }

    if (res.status === 429) {
      this._applyRetryAfter(res);
      throw new RavensightError('session creation rate limited', 'rate_limited', 429);
    }

    this._scheduleBackoff();
    throw new RavensightError(
      'session creation failed (HTTP ' + res.status + ')',
      this._errorCode(res, 'session_failed'),
      res.status,
    );
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

      let token;
      try {
        token = await this._ensureSession();
      } catch (_err) {
        break;
      }
      if (this._disposed) break;

      const size = Math.min(batchLimit, this.queue.length);
      this._inflightSize = size;
      let res;
      try {
        res = await this._request('POST', '/track/batch', {
          headers: { 'X-Session-Token': token },
          body: { events: this.queue.slice(0, size) },
        });
      } finally {
        this._inflightSize = 0;
      }

      // dispose() timed out while this batch was in flight and has already
      // counted the queue as dropped. Leave the cleared queue alone.
      if (this._disposed) break;

      if (res.status === 202) {
        this.queue.splice(0, size);
        sent += size;
        this.stats.sent += size;
        this.stats.flushes += 1;
        batchLimit = MAX_BATCH_SIZE;
        this._resetBackoff();
        continue;
      }

      if (res.status === 401) {
        // Session expired or revoked. Events stay queued and are re sent as
        // soon as a fresh session is issued.
        this._invalidateSession();
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
    const body = JSON.stringify({ events });
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
   * Best effort flush of one batch while the page is being hidden. `offset`
   * skips events already in a batch request awaiting an answer.
   */
  _flushOnHidden(offset = 0) {
    if (!this._canSend || this.queue.length <= offset || !this.isSessionValid()) return false;

    const events = this.queue.slice(offset, offset + MAX_BATCH_SIZE);
    const req = this._buildUnloadRequest(events, this.sessionToken);
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
    if (this._timer || !(this.autoFlushMs > 0)) return;
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
    try {
      this._storage.setItem(DEVICE_ID_KEY, created);
    } catch (_err) {
      // Non persistent device id. Sessions still work, retention will be noisy.
    }
    return created;
  }

  _log(message) {
    if (this.debug && typeof console !== 'undefined') console.log('[ravensight] ' + message);
  }
}



// --- CommonJS exports (generated by scripts/build-cjs.mjs) ---
module.exports = Ravensight;
module.exports.default = Ravensight;
module.exports.VERSION = VERSION;
module.exports.DEFAULT_API_URL = DEFAULT_API_URL;
module.exports.MAX_BATCH_SIZE = MAX_BATCH_SIZE;
module.exports.FEEDBACK_CATEGORIES = FEEDBACK_CATEGORIES;
module.exports.RavensightError = RavensightError;
module.exports.MemoryStorage = MemoryStorage;
module.exports.Ravensight = Ravensight;
module.exports.normalizeApiUrl = normalizeApiUrl;
module.exports.parseRetryAfterMs = parseRetryAfterMs;
module.exports.chooseUnloadTransport = chooseUnloadTransport;
