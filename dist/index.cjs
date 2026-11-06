/**
 * Ravensight JavaScript SDK
 *
 * Zero dependency client for the hosted Ravensight analytics API.
 * Works in browsers and in Node 18+ (built in global fetch).
 *
 * Docs: https://ravensight.io/docs/
 */

const VERSION = '0.5.1';

const DEFAULT_API_URL = 'https://api.ravensight.io/api/v1';

/** Server hard limit on POST /track/batch. */
const MAX_BATCH_SIZE = 50;

/** Feedback categories the API accepts. Anything else is rejected locally. */
const FEEDBACK_CATEGORIES = Object.freeze(['bug', 'suggestion', 'complaint', 'praise', 'playtest', 'other']);

/**
 * Values the reserved `rs_kind` property accepts: what an event means for the
 * level funnel. Property keys starting with `rs_` are reserved for Ravensight.
 */
const RS_KINDS = Object.freeze([
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
  'rs_severity', 'rs_message', 'rs_stack', 'rs_source', 'rs_error_type', 'rs_trail',
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
const MAX_EVENT_BYTES = 8192;
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

  removeItem(key) {
    this._map.delete(key);
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

// --- Automatic error capture ----------------------------------------------
//
// One set of page hooks shared by every client that has error capture on.
// The hooks only observe: they chain to whatever was there, never swallow an
// error, never read a request or response body, and never change what the
// game's own code sees. Each client applies its own caps.

/** Per-session device caps from the error capture contract. */
const ERROR_CAPS = Object.freeze({
  total: 30,
  perKey: 3,
  trails: 10,
  perMinute: 6,
  console: 5,
  deadClick: 3,
});
const MAX_ERROR_TYPE_CHARS = 100;
const MAX_TRAIL_CHARS = 1500;
const MAX_TRAIL_LINE_CHARS = 120;
const TRAIL_LINES = 20;
const MAX_DEAD_CLICK_NAME_CHARS = 60;
const DEAD_CLICK_MS = 2000;
/** Captures held in memory before the first settings or session answer. */
const MAX_BOOT_ERRORS = 5;
/** After a dead click is reported, no new watch starts for this long. */
const DEAD_CLICK_COOLDOWN_MS = 30000;
/** Marks a wrapper so the SDK can find the function it wraps. */
const WRAPPED = typeof Symbol === 'function' ? Symbol.for('ravensight.wrapped') : '__ravensightWrapped';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUTTON_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]';

/** The function a Ravensight wrapper stands in for, else `fn` itself. */
function unwrapFn(fn) {
  return typeof fn === 'function' && typeof fn[WRAPPED] === 'function' ? fn[WRAPPED] : fn;
}

/**
 * The on-device scrub. Same rules as the server's, applied in this order:
 * a URL loses any user:password@, then its query and fragment; bearer tokens, JWT-shaped strings,
 * `gt_` keys become [token]; emails become [email]; home directories become
 * ~; IPv4 and IPv6 addresses become [ip]; a run of 32 or more base64 or hex
 * characters with a digit in it becomes [token], unless it is a path of
 * path words.
 */
const SCRUB_RULES = [
  // Anchored at a word boundary or a non-class character, so a long run
  // with no match is walked once, not once per start position.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/?#@]+@/gi, '$1'],
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#'"<>()]+)[?#][^\s'"<>()]*/gi, '$1'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[token]'],
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[token]'],
  [/\bgt_[A-Za-z0-9_]+/g, '[token]'],
  [/(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '$1[email]'],
  [/\/(?:Users|home)\/[^/\s:'"()]+/g, '~'],
  [/\b[A-Za-z]:\\Users\\[^\\\s:'"()]+/gi, '~'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [
    /(^|[^0-9A-Za-z:.])((?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|::[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})(?![0-9A-Za-z:])/g,
    // An address has a digit somewhere, so a scope like Face::Add is kept.
    (match, before, address) => (/\d/.test(address) ? before + '[ip]' : match),
  ],
  // A run with no digit is an identifier, not a secret. A run with '/' is
  // kept only when every piece is a path word, so file paths survive and a
  // secret with slashes does not.
  [/[A-Za-z0-9+/=_-]{32,}/g, (run) => (/\d/.test(run) && !isPathRun(run) ? '[token]' : run)],
];

const PATH_PARTS = [/^[a-z0-9]+$/, /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/, /^[A-Z0-9]{1,6}$/];

/**
 * True when a long run is a path: it has '/' and every piece is empty or a
 * path word under 32 characters. A path word is one or more parts joined by
 * '_' or '-', each part lowercase, CamelCase or an acronym of 1 to 6
 * capitals or digits.
 */
function isPathRun(run) {
  return (
    run.includes('/') &&
    run.split('/').every(
      (piece) =>
        piece === '' ||
        (piece.length < 32 &&
          piece.split(/[_-]/).every((part) => part !== '' && PATH_PARTS.some((word) => word.test(part)))),
    )
  );
}

function scrubText(value) {
  let text = String(value == null ? '' : value);
  for (const [pattern, replacement] of SCRUB_RULES) text = text.replace(pattern, replacement);
  return text;
}

/** Scrub, then cut to `max` characters. */
/**
 * Cut to 4 times `max`, scrub, then cut to `max`. Some scrub rules are
 * quadratic in their input, so they never see more than a bounded string.
 */
function cleanText(value, max) {
  return cutText(scrubText(preCut(value, max * 4)), max);
}

/** At most `max` characters, sliced cheaply first so a huge string is never walked whole. */
function preCut(value, max) {
  const text = String(value == null ? '' : value);
  return cutText(text.length > max * 2 ? text.slice(0, max * 2) : text, max);
}

/** The local dedupe template: numbers, hex runs, UUIDs, URLs and quoted text become placeholders. */
function messageTemplate(message) {
  return String(message)
    .replace(/[a-z][a-z0-9+.-]{0,30}:\/\/\S+/gi, '<url>')
    .replace(/(["'`])[^"'`]{0,200}\1/g, '<str>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>');
}

/** The file of the first stack frame, line and column dropped, or ''. */
function firstFrame(stack) {
  if (!stack) return '';
  for (const line of String(stack).split('\n')) {
    const match = /([^\s(@]+):\d+:\d+\)?\s*$/.exec(line);
    if (match) return match[1];
  }
  return '';
}

/** A path with number, long hex and UUID segments replaced by `:id`. */
function templatePath(pathname) {
  return String(pathname || '/')
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || UUID_RE.test(seg) ? ':id' : seg))
    .join('/');
}

/** The registrable part of a host name, near enough: the last two labels, three for `co.uk` shapes. */
function siteOf(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host)) return host;
  const parts = host.split('.');
  const n = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** The class or type of a thrown value, or undefined. */
function errorTypeOf(value) {
  try {
    if (value && typeof value === 'object') {
      if (typeof value.name === 'string' && value.name) return value.name;
      if (value.constructor && typeof value.constructor.name === 'string') return value.constructor.name;
      return undefined;
    }
  } catch (_err) {
    // A hostile getter.
  }
  return undefined;
}

/** A short text for any value, without running the game's own toString. */
function describeValue(value) {
  try {
    if (typeof value === 'string') return value;
    if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (typeof value === 'object' && typeof value.message === 'string') {
      const type = errorTypeOf(value);
      return type ? type + ': ' + value.message : value.message;
    }
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'symbol') return '[symbol]';
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.slice(0, 400) : '[object]';
  } catch (_err) {
    return '[object]';
  }
}

/** The shared hook state. Installed while at least one client has capture on. */
const errorHooks = {
  clients: new Set(),
  installed: false,
  undo: [],
  /** True between pagehide and pageshow: failures then are the page going away. */
  pageHidden: false,
  /** Re-entrancy guard: nothing the SDK does while capturing is captured. */
  capturing: false,
  /** Counts requests, navigations and track calls, for the dead click watcher. */
  activity: 0,
  /** Forms that fired submit, so a submit button is never a dead click. */
  submitted: typeof WeakSet === 'function' ? new WeakSet() : null,
  deadWatch: null,
  deadCooldownUntil: 0,
};
/** API bases of every keyed client: requests to them are the SDK's own. */
const sdkApiUrls = new Set();
/** Storage upload URLs the SDK is sending right now. */
const sdkUploadUrls = new Set();

function isSdkUrl(href) {
  if (sdkUploadUrls.has(href)) return true;
  for (const base of sdkApiUrls) {
    if (href === base || href.startsWith(base + '/') || href.startsWith(base + '?')) return true;
  }
  return false;
}

function eachErrorClient(fn) {
  if (errorHooks.capturing) return;
  errorHooks.capturing = true;
  try {
    for (const client of errorHooks.clients) {
      try {
        fn(client);
      } catch (_err) {
        // One client's failure never reaches the game or another client.
      }
    }
  } finally {
    errorHooks.capturing = false;
  }
}

function noteActivity() {
  errorHooks.activity += 1;
}

/** { url, method, signal } for an http(s) request that is not the SDK's own, else null. */
function describeRequest(input, init) {
  let raw = null;
  let method = null;
  let signal = null;
  if (typeof input === 'string') raw = input;
  else if (input && typeof input === 'object') {
    raw = typeof input.url === 'string' ? input.url : typeof input.href === 'string' ? input.href : null;
    if (typeof input.method === 'string') method = input.method;
    if (input.signal) signal = input.signal;
  }
  if (init && typeof init === 'object') {
    if (typeof init.method === 'string') method = init.method;
    if (init.signal) signal = init.signal;
  }
  if (raw == null) return null;
  let base;
  try {
    if (typeof document !== 'undefined' && document && typeof document.baseURI === 'string' && document.baseURI) {
      base = document.baseURI;
    } else if (typeof location !== 'undefined' && location && location.href) {
      base = location.href;
    }
  } catch (_err) {
    base = undefined;
  }
  const url = new URL(raw, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isSdkUrl(url.href)) return null;
  return { url, method: (method || 'GET').toUpperCase(), signal };
}

function isOffline() {
  try {
    return typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
  } catch (_err) {
    return false;
  }
}

/** A finished request: `status` 0 is a network failure. Aborts, unload and offline are not failures. */
function onRequestFinished(info, status, aborted) {
  if (aborted || (info.signal && info.signal.aborted)) return;
  if (errorHooks.pageHidden) return;
  if (status > 0 && status < 400) return;
  if (status === 0 && isOffline()) return;
  eachErrorClient((client) => client._captureRequest(info, status));
}

function wrapFetch(undo) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  let live = true;
  const wrapper = function fetch(input, init) {
    const result = original.apply(this, arguments);
    if (!live) return result;
    let returned = result;
    try {
      const info = describeRequest(input, init);
      if (info && result && typeof result.then === 'function') {
        noteActivity();
        // The game gets a promise that settles exactly as fetch's does: the
        // same response, or the same error rethrown. Observing never marks
        // a rejection handled, so one the game ignores is still unhandled.
        returned = result.then(
          (res) => {
            try {
              // An opaque (no-cors) answer hides its status: not a failure.
              if (!(res && (res.type === 'opaque' || res.type === 'opaqueredirect'))) {
                onRequestFinished(info, res ? Number(res.status) || 0 : 0, false);
              }
            } catch (_err) {
              // ignore
            }
            return res;
          },
          (err) => {
            try {
              onRequestFinished(info, 0, Boolean(err && err.name === 'AbortError'));
            } catch (_err) {
              // ignore
            }
            throw err;
          },
        );
      }
    } catch (_err) {
      // An unparseable URL: the original fetch has already answered for it.
    }
    return returned;
  };
  wrapper[WRAPPED] = original;
  globalThis.fetch = wrapper;
  undo.push(() => {
    live = false;
    if (globalThis.fetch === wrapper) globalThis.fetch = original;
  });
}

function wrapXhr(undo) {
  const Xhr = globalThis.XMLHttpRequest;
  if (typeof Xhr !== 'function' || !Xhr.prototype) return;
  const proto = Xhr.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') return;
  let live = true;
  const requests = new WeakMap();
  const open = function open(method, url) {
    try {
      if (live) {
        const info = describeRequest(String(url), { method: String(method) });
        const prior = requests.get(this);
        requests.set(this, { info, aborted: false, watched: prior ? prior.watched : false });
      }
    } catch (_err) {
      requests.delete(this);
    }
    return originalOpen.apply(this, arguments);
  };
  const send = function send() {
    try {
      const state = live ? requests.get(this) : null;
      if (state && state.info) {
        noteActivity();
        state.aborted = false;
        if (!state.watched) {
          state.watched = true;
          const xhr = this;
          xhr.addEventListener('abort', () => {
            const s = requests.get(xhr);
            if (s) s.aborted = true;
          });
          xhr.addEventListener('loadend', () => {
            try {
              const s = requests.get(xhr);
              if (!live || !s || !s.info) return;
              onRequestFinished(s.info, Number(xhr.status) || 0, s.aborted);
            } catch (_err) {
              // ignore
            }
          });
        }
      }
    } catch (_err) {
      // Observing must never stop the request.
    }
    return originalSend.apply(this, arguments);
  };
  open[WRAPPED] = originalOpen;
  send[WRAPPED] = originalSend;
  proto.open = open;
  proto.send = send;
  undo.push(() => {
    live = false;
    if (proto.open === open) proto.open = originalOpen;
    if (proto.send === send) proto.send = originalSend;
  });
}

function wrapConsole(undo) {
  if (typeof console === 'undefined' || !console) return;
  for (const [name, level] of [['error', 'error'], ['warn', 'warn']]) {
    const original = console[name];
    if (typeof original !== 'function') continue;
    let live = true;
    const wrapper = function () {
      const result = original.apply(this, arguments);
      if (live) {
        try {
          onConsole(level, arguments);
        } catch (_err) {
          // ignore
        }
      }
      return result;
    };
    wrapper[WRAPPED] = original;
    console[name] = wrapper;
    undo.push(() => {
      live = false;
      if (console[name] === wrapper) console[name] = original;
    });
  }
}

/** A warning printed by Node itself, such as "(node:123) ExperimentalWarning: ...". */
function isRuntimeWarning(text) {
  return /^\(node:\d*\)/.test(text) || /\b(?:Experimental|Deprecation)Warning\b/.test(text);
}

function onConsole(level, args) {
  if (errorHooks.capturing) return;
  // Nothing is stringified unless a trail or a capture will use it.
  let needed = false;
  for (const client of errorHooks.clients) {
    if (client._wantsConsole(level)) {
      needed = true;
      break;
    }
  }
  if (!needed) return;
  const parts = [];
  let thrown = null;
  for (let i = 0; i < args.length && i < 8; i++) {
    const arg = args[i];
    if (!thrown && arg && typeof arg === 'object' && typeof arg.message === 'string') thrown = arg;
    parts.push(preCut(describeValue(arg), MAX_STACK_CHARS));
  }
  const text = parts.join(' ');
  // The SDK's own log lines are never captured, nor Node's own process
  // warnings, which a game did not write.
  if (text.startsWith('[ravensight]') || isRuntimeWarning(text)) return;
  eachErrorClient((client) => {
    client._trailLine(level, text);
    if (level === 'error') {
      client._captureAuto({
        source: 'console',
        severity: 'warning',
        message: text,
        type: thrown ? errorTypeOf(thrown) : undefined,
        stack: thrown && typeof thrown.stack === 'string' ? thrown.stack : undefined,
      });
    }
  });
}

function onWindowError(event) {
  if (errorHooks.capturing || !event) return;
  const target = event.target;
  const win = typeof window !== 'undefined' ? window : null;
  if (target && target !== win && typeof target.tagName === 'string') {
    onResourceError(target);
    return;
  }
  const err = event.error;
  let message = null;
  let stack;
  try {
    if (err && typeof err === 'object' && typeof err.message === 'string') message = err.message;
    if (err && typeof err === 'object' && typeof err.stack === 'string') stack = err.stack;
  } catch (_err) {
    // A hostile getter.
  }
  if (message == null) message = typeof event.message === 'string' && event.message ? event.message : describeValue(err);
  if (!stack && typeof event.filename === 'string' && event.filename) {
    stack = 'at ' + event.filename + ':' + (event.lineno || 0) + ':' + (event.colno || 0);
  }
  const type = errorTypeOf(err);
  eachErrorClient((client) =>
    client._captureAuto({ source: 'uncaught', severity: 'error', message, type, stack }),
  );
}

function onResourceError(element) {
  let raw = '';
  try {
    raw = element.currentSrc || element.src || element.href || '';
  } catch (_err) {
    return;
  }
  if (typeof raw !== 'string' || !raw) return;
  let info;
  try {
    info = describeRequest(raw, null);
  } catch (_err) {
    return;
  }
  if (!info || errorHooks.pageHidden || isOffline()) return;
  const tag = element.tagName.toLowerCase();
  eachErrorClient((client) => client._captureResource(info, tag));
}

function onUnhandledRejection(event) {
  if (errorHooks.capturing || !event) return;
  const reason = event.reason;
  let message;
  let stack;
  try {
    message =
      reason && typeof reason === 'object' && typeof reason.message === 'string' ? reason.message : describeValue(reason);
    if (reason && typeof reason === 'object' && typeof reason.stack === 'string') stack = reason.stack;
  } catch (_err) {
    message = '[object]';
  }
  const type = errorTypeOf(reason);
  eachErrorClient((client) =>
    client._captureAuto({ source: 'unhandled_rejection', severity: 'error', message, type, stack }),
  );
}

/** Node: observes an uncaught exception without handling it, so exit behaviour is unchanged. */
function onNodeUncaught(err, origin) {
  if (errorHooks.capturing) return;
  let message;
  let stack;
  try {
    message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : describeValue(err);
    if (err && typeof err === 'object' && typeof err.stack === 'string') stack = err.stack;
  } catch (_err) {
    message = '[object]';
  }
  const source = origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught';
  const type = errorTypeOf(err);
  eachErrorClient((client) => {
    if (client._captureAuto({ source, severity: 'error', message, type, stack })) {
      // Best effort only: the process usually exits before this answers.
      client.flush({ force: true }).catch(noop);
    }
  });
}

function onNavigation() {
  noteActivity();
  let path = '/';
  try {
    path = templatePath(location.pathname);
  } catch (_err) {
    // ignore
  }
  eachErrorClient((client) => client._trailLine('nav', path));
}

function onPageHide() {
  errorHooks.pageHidden = true;
  noteActivity();
}

function onPageShow() {
  errorHooks.pageHidden = false;
}

function onSubmit(event) {
  noteActivity();
  try {
    if (errorHooks.submitted && event && event.target && typeof event.target === 'object') {
      errorHooks.submitted.add(event.target);
    }
  } catch (_err) {
    // ignore
  }
}

/** The element's accessible name, near enough: aria-label, labelledby, value, text, title, else its tag. */
function accessibleName(el) {
  try {
    const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);
    const label = attr('aria-label');
    if (label && label.trim()) return label;
    const labelledBy = attr('aria-labelledby');
    if (labelledBy && typeof document.getElementById === 'function') {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node && typeof node.textContent === 'string' ? node.textContent : '';
        })
        .join(' ')
        .trim();
      if (text) return text;
    }
    if (String(el.tagName).toLowerCase() === 'input' && typeof el.value === 'string' && el.value.trim()) {
      return el.value;
    }
    const text = typeof el.textContent === 'string' ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    if (text) return text;
    const title = attr('title');
    if (title && title.trim()) return title;
  } catch (_err) {
    // Fall through to the tag.
  }
  return String(el.tagName || 'element').toLowerCase();
}

function isDisabled(el) {
  try {
    if (el.disabled === true) return true;
    if (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true') return true;
    if (typeof el.matches === 'function' && el.matches(':disabled')) return true;
  } catch (_err) {
    // ignore
  }
  return false;
}

/**
 * True when a canvas covers more than half the viewport. A canvas UI changes
 * state the watcher cannot see, so dead clicks are off on such a page.
 */
function canvasCoversPage() {
  try {
    if (typeof document.querySelectorAll !== 'function') return false;
    const width = Number(window.innerWidth) || 0;
    const height = Number(window.innerHeight) || 0;
    if (!(width > 0 && height > 0)) return false;
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
      const visibleH = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
      if (visibleW * visibleH > (width * height) / 2) return true;
    }
  } catch (_err) {
    // Unknown layout: keep watching.
  }
  return false;
}

function onClick(event) {
  if (errorHooks.capturing || !event || event.isTrusted === false) return;
  let watcher = null;
  for (const client of errorHooks.clients) {
    if (client.captureDeadClicks) {
      watcher = client;
      break;
    }
  }
  if (!watcher || errorHooks.deadWatch || typeof MutationObserver !== 'function') return;
  const now = Date.now();
  if (now < errorHooks.deadCooldownUntil) return;
  let el = null;
  try {
    const target = event.target;
    el = target && typeof target.closest === 'function' ? target.closest(BUTTON_SELECTOR) : null;
  } catch (_err) {
    return;
  }
  if (!el || isDisabled(el) || canvasCoversPage()) return;

  const watch = { el, activity: errorHooks.activity, mutated: false, href: null, observer: null, timer: null };
  try {
    watch.href = location.href;
  } catch (_err) {
    // ignore
  }
  try {
    watch.observer = new MutationObserver(() => {
      // The first change settles it: stop observing at once.
      watch.mutated = true;
      try {
        watch.observer.disconnect();
      } catch (_err) {
        // ignore
      }
    });
    watch.observer.observe(document.documentElement || document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  } catch (_err) {
    return;
  }
  errorHooks.deadWatch = watch;
  watch.timer = setTimeout(() => finishDeadWatch(watch), watcher._deadClickMs);
  if (watch.timer && typeof watch.timer.unref === 'function') watch.timer.unref();
}

function stopDeadWatch(watch) {
  if (!watch) return;
  try {
    if (watch.observer) watch.observer.disconnect();
  } catch (_err) {
    // ignore
  }
  if (watch.timer) clearTimeout(watch.timer);
  if (errorHooks.deadWatch === watch) errorHooks.deadWatch = null;
}

function finishDeadWatch(watch) {
  // Read any pending records before deciding: a change made just now counts.
  try {
    if (watch.observer && typeof watch.observer.takeRecords === 'function' && watch.observer.takeRecords().length) {
      watch.mutated = true;
    }
  } catch (_err) {
    // ignore
  }
  stopDeadWatch(watch);
  if (watch.mutated || watch.activity !== errorHooks.activity || errorHooks.pageHidden) return;
  try {
    if (watch.href !== null && location.href !== watch.href) return;
  } catch (_err) {
    // ignore
  }
  const el = watch.el;
  try {
    const form = el.form || (typeof el.closest === 'function' ? el.closest('form') : null);
    if (form && errorHooks.submitted && errorHooks.submitted.has(form)) return;
  } catch (_err) {
    // ignore
  }
  const tag = String(el.tagName || 'element').toLowerCase();
  const name = cleanText(preCut(accessibleName(el), MAX_DEAD_CLICK_NAME_CHARS * 4).replace(/\s+/g, ' '), MAX_DEAD_CLICK_NAME_CHARS);
  // No quotes around the name, so the server's template keeps it.
  const message = 'Dead click: ' + tag + ' ' + name;
  let reported = false;
  eachErrorClient((client) => {
    if (!client.captureDeadClicks) return;
    if (client._captureAuto({ source: 'dead_click', severity: 'warning', message, type: 'DeadClick' })) reported = true;
  });
  if (reported) errorHooks.deadCooldownUntil = Date.now() + DEAD_CLICK_COOLDOWN_MS;
}

function installErrorHooks() {
  if (errorHooks.installed) return;
  errorHooks.installed = true;
  errorHooks.pageHidden = false;
  const undo = [];
  errorHooks.undo = undo;
  const listen = (target, type, fn, capture) => {
    try {
      target.addEventListener(type, fn, capture);
      undo.push(() => target.removeEventListener(type, fn, capture));
    } catch (_err) {
      // A partial environment: that hook is skipped.
    }
  };
  if (isBrowser()) {
    listen(window, 'error', onWindowError, true);
    listen(window, 'unhandledrejection', onUnhandledRejection, false);
    listen(window, 'pagehide', onPageHide, false);
    listen(window, 'pageshow', onPageShow, false);
    listen(window, 'popstate', onNavigation, false);
    listen(window, 'hashchange', onNavigation, false);
    listen(document, 'click', onClick, true);
    listen(document, 'submit', onSubmit, true);
    wrapFetch(undo);
    wrapXhr(undo);
    wrapConsole(undo);
  } else if (typeof process !== 'undefined' && process && typeof process.on === 'function') {
    // Monitor only: a monitor never handles the error, so the process exits
    // exactly as it would without the SDK. No unhandledRejection listener,
    // because adding one changes Node's exit behaviour; a rejection that
    // Node raises as uncaught reaches the monitor with that origin.
    process.on('uncaughtExceptionMonitor', onNodeUncaught);
    undo.push(() => process.removeListener('uncaughtExceptionMonitor', onNodeUncaught));
  }
}

function uninstallErrorHooks() {
  if (!errorHooks.installed) return;
  errorHooks.installed = false;
  stopDeadWatch(errorHooks.deadWatch);
  errorHooks.deadCooldownUntil = 0;
  const undo = errorHooks.undo;
  errorHooks.undo = [];
  for (let i = undo.length - 1; i >= 0; i--) {
    try {
      undo[i]();
    } catch (_err) {
      // ignore
    }
  }
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

    // Never the error capture wrapper: the SDK's own requests are not observed.
    const nativeFetch = unwrapFn(opts.fetch || (typeof fetch === 'function' ? fetch : null));
    this._fetch = opts.fetch ? nativeFetch : nativeFetch ? nativeFetch.bind(globalThis) : null;
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
      /** Errors captured automatically and queued. */
      errorsCaptured: 0,
      /** Automatic captures dropped on the device by the caps. */
      errorsCapped: 0,
    };

    // Automatic error capture. Installed at construction with a key and
    // consent, so boot errors are caught; at most 5 are held in memory until
    // the first settings or session answer says capture is on, and dropped
    // unsent if it says off. Never with the game's errorCapture.enabled false.
    this.captureErrors = opts.captureErrors === undefined ? true : Boolean(opts.captureErrors);
    this.captureDeadClicks = opts.captureDeadClicks === undefined ? true : Boolean(opts.captureDeadClicks);
    if (opts.captureRequestHosts != null && !Array.isArray(opts.captureRequestHosts)) {
      throw new TypeError('Ravensight: `captureRequestHosts` must be an array of host names');
    }
    this.captureRequestHosts = (opts.captureRequestHosts || [])
      .filter(isNonEmptyString)
      .map((host) => host.trim().toLowerCase());
    /** The game's switches from the settings and session answers. Absent means enabled, no trail. */
    this.errorCapture = { enabled: true, trail: false };
    this._errorHooked = false;
    /** True once a settings or session answer has been read. */
    this._errorAnswered = false;
    /** Captures waiting for that answer, at most MAX_BOOT_ERRORS. */
    this._bootErrors = [];
    this._trail = [];
    this._errorCaps = { total: 0, perKey: new Map(), trails: 0, console: 0, deadClick: 0, tokens: ERROR_CAPS.perMinute, refilledAt: this._clock() };
    this._deadClickMs = Number(opts._deadClickMs) > 0 ? Number(opts._deadClickMs) : DEAD_CLICK_MS;
    /** Set while the SDK queues its own capture, so it is not a track call or trail line. */
    this._internalTrack = false;
    if (this._hasKey) sdkApiUrls.add(this.apiUrl);

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
    this._syncErrorCapture();
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
    this._syncErrorCapture();

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

    const auto = this._internalTrack;
    if (this.queue.length >= this.maxQueueSize) {
      // Gameplay events keep their place ahead of automatic errors: a full
      // queue drops the incoming error, or the oldest queued error (never
      // one in a batch awaiting an answer) before any gameplay event.
      if (auto) {
        this.stats.dropped += 1;
        return false;
      }
      let at = -1;
      for (let i = this._inflightSize; i < this.queue.length; i++) {
        if (this.queue[i].auto) {
          at = i;
          break;
        }
      }
      if (at >= 0) this.queue.splice(at, 1);
      else this.queue.shift();
      this.stats.dropped += 1;
    }

    const item = {
      event,
      data: payload,
      timestamp: Math.floor(this._clock() / 1000),
      deviceId,
    };
    if (auto) item.auto = true;
    this.queue.push(item);
    this.stats.queued += 1;
    if (!auto && this._errorHooked) {
      noteActivity();
      this._trailLine('track', event);
    }

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

  /** severity is 'debug', 'info', 'warning', 'error' or 'critical'. Message is cut to 200 characters, stack to 2000, errorType to 100. */
  trackError(options, trackOptions) {
    const o = options || {};
    const props = this._typed('error', {
      rs_severity: o.severity,
      rs_message: cutText(o.message, MAX_MESSAGE_CHARS),
      rs_stack: cutText(o.stack, MAX_STACK_CHARS),
      rs_error_type: cutText(o.errorType, MAX_ERROR_TYPE_CHARS),
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

  // --- Automatic error capture --------------------------------------------

  /** True while this client's error hooks are installed. */
  get capturingErrors() {
    return this._errorHooked;
  }

  /** Reads `errorCapture: { enabled, trail }` from a settings or session answer. Absent keeps what we had. */
  _readErrorCapture(body) {
    const answer = body && body.errorCapture;
    if (answer && typeof answer === 'object') {
      this.errorCapture = { enabled: answer.enabled !== false, trail: answer.trail === true };
      if (!this.errorCapture.trail) this._trail.length = 0;
    }
    this._errorAnswered = true;
    this._syncErrorCapture();
    // Boot errors: sent now that capture is known to be on, else already discarded.
    const held = this._bootErrors.splice(0);
    if (this._errorHooked) for (const capture of held) this._captureAuto(capture);
  }

  /** Installs or removes this client's hooks to match its state. */
  _syncErrorCapture() {
    const want = this.captureErrors && this.errorCapture.enabled && this.isActive;
    if (want && !this._errorHooked) {
      this._errorHooked = true;
      errorHooks.clients.add(this);
      installErrorHooks();
    } else if (!want && this._errorHooked) {
      this._errorHooked = false;
      this._trail.length = 0;
      this._bootErrors.length = 0;
      errorHooks.clients.delete(this);
      if (errorHooks.clients.size === 0) uninstallErrorHooks();
    }
  }

  /** Whether a console line at `level` would reach this client's trail or a capture. */
  _wantsConsole(level) {
    if (!this._errorHooked || !this.isActive) return false;
    if (this.errorCapture.trail) return true;
    if (level !== 'error') return false;
    if (!this._errorAnswered) return this._bootErrors.length < MAX_BOOT_ERRORS;
    const caps = this._errorCaps;
    return caps.console < ERROR_CAPS.console && caps.total < ERROR_CAPS.total;
  }

  /** Adds one line to the trail ring, when the game's trail switch is on. */
  _trailLine(level, text) {
    if (!this._errorHooked || !this.errorCapture.trail) return;
    const flat = preCut(text, MAX_TRAIL_LINE_CHARS * 4).replace(/\s+/g, ' ').trim();
    const line = '+' + Math.max(0, this._clock() - this._startedAt) + ' ' + level + ' ' + flat;
    this._trail.push(cleanText(line, MAX_TRAIL_LINE_CHARS));
    if (this._trail.length > TRAIL_LINES) this._trail.shift();
  }

  /** The trail as one string, oldest first, cut from the oldest end to 1,500 characters. */
  _trailText() {
    const lines = this._trail.slice();
    let text = lines.join('\n');
    while (text.length > MAX_TRAIL_CHARS && lines.length > 1) {
      lines.shift();
      text = lines.join('\n');
    }
    return cutText(text, MAX_TRAIL_CHARS);
  }

  /** Whether a request to this host may be captured: the page's own site, or a listed host. */
  _requestHostAllowed(url) {
    const host = String(url.hostname || '').toLowerCase();
    for (const listed of this.captureRequestHosts) {
      if (host === listed) return true;
      if (listed.startsWith('*.') && host.endsWith(listed.slice(1))) return true;
    }
    let pageHost = '';
    try {
      pageHost = location.hostname;
    } catch (_err) {
      return false;
    }
    return Boolean(pageHost) && siteOf(host) === siteOf(pageHost);
  }

  /** A failed request: `status` 0 is a network failure. */
  _captureRequest(info, status) {
    if (!this._requestHostAllowed(info.url)) return false;
    const message =
      info.method + ' ' + info.url.host + templatePath(info.url.pathname) + ' ' + (status > 0 ? status : 'network');
    return this._captureAuto({
      source: 'request',
      severity: status === 0 || status >= 500 ? 'error' : 'warning',
      message,
    });
  }

  /** A script, image, style or media file that failed to load. */
  _captureResource(info, tag) {
    if (!this._requestHostAllowed(info.url)) return false;
    return this._captureAuto({
      source: 'request',
      severity: 'warning',
      message: tag + ' ' + info.url.host + templatePath(info.url.pathname) + ' failed',
      type: 'ResourceError',
    });
  }

  /**
   * Queues one automatic capture after the device caps and the scrub.
   * Returns true when it was queued. Over a cap it is dropped silently.
   */
  _captureAuto(capture) {
    if (!this._errorHooked || !this.isActive) return false;
    if (!this._errorAnswered) {
      // Before the first answer: hold, unscrubbed caps applied later on release.
      // Warnings (console lines, requests, dead clicks) never push a real
      // error out: a full hold makes room for an error by dropping the
      // oldest warning.
      const held = this._bootErrors;
      if (held.length >= MAX_BOOT_ERRORS) {
        const at = capture.severity === 'error' ? held.findIndex((c) => c.severity !== 'error') : -1;
        this.stats.errorsCapped += 1;
        if (at < 0) return false;
        held.splice(at, 1);
      }
      held.push(capture);
      return false;
    }
    const caps = this._errorCaps;
    const now = this._clock();
    // Token bucket: 6 a minute, refilled continuously.
    const perMs = ERROR_CAPS.perMinute / 60000;
    caps.tokens = Math.min(ERROR_CAPS.perMinute, caps.tokens + Math.max(0, now - caps.refilledAt) * perMs);
    caps.refilledAt = now;
    const capped = () => {
      this.stats.errorsCapped += 1;
      return false;
    };
    if (caps.total >= ERROR_CAPS.total || caps.tokens < 1) return capped();
    if (capture.source === 'console' && caps.console >= ERROR_CAPS.console) return capped();
    if (capture.source === 'dead_click' && caps.deadClick >= ERROR_CAPS.deadClick) return capped();

    const message = cleanText(capture.message == null ? '' : capture.message, MAX_MESSAGE_CHARS) || '(no message)';
    const stack = capture.stack ? cleanText(capture.stack, MAX_STACK_CHARS) : '';
    const type = capture.type ? cleanText(capture.type, MAX_ERROR_TYPE_CHARS) : '';
    const key = type + '\u0000' + messageTemplate(message) + '\u0000' + firstFrame(stack);
    const seen = caps.perKey.get(key) || 0;
    if (seen >= ERROR_CAPS.perKey) return capped();

    const props = {
      rs_kind: 'error',
      rs_severity: capture.severity,
      rs_message: message,
      rs_source: capture.source,
    };
    if (type) props.rs_error_type = type;
    if (stack) props.rs_stack = stack;
    const withTrail = this.errorCapture.trail && this._trail.length > 0 && caps.trails < ERROR_CAPS.trails;
    if (withTrail) props.rs_trail = this._trailText();

    this._internalTrack = true;
    let queued = false;
    try {
      queued = this.track('error', props);
    } finally {
      this._internalTrack = false;
    }
    if (!queued) return false;
    caps.total += 1;
    caps.tokens -= 1;
    caps.perKey.set(key, seen + 1);
    if (withTrail) caps.trails += 1;
    if (capture.source === 'console') caps.console += 1;
    if (capture.source === 'dead_click') caps.deadClick += 1;
    this.stats.errorsCaptured += 1;
    return true;
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

  /** Prepare once, then reuse this object for retries. Never captures the screen automatically. */
  async createReport(input = {}) {
    const bad = message => { throw new RavensightError(message, 'invalid_report'); };
    const payload = { clientId: input.clientId || randomId(), capturedAt: input.capturedAt ?? Math.floor(Date.now() / 1000),
      category: input.category || 'other', source: input.source || 'player', context: { ...(input.context || {}) } };
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(payload.clientId)) bad('Use a stable report clientId of 8–80 letters, digits, underscores or hyphens.');
    if (!FEEDBACK_CATEGORIES.includes(payload.category)) bad('Unknown report category.');
    if (!['player', 'tester'].includes(payload.source)) bad('Report source must be player or tester.');
    if (!Number.isSafeInteger(payload.capturedAt) || payload.capturedAt < Date.now() / 1000 - 86400 || payload.capturedAt > Date.now() / 1000 + 60) bad('Capture time must be within the last day.');
    for (const [key, max] of Object.entries({ message: 500, level: 100, expected: 500, steps: 1000, frequency: 80 })) {
      const value = input[key] ?? '';
      if (typeof value !== 'string' || value.length > max || (key === 'message' && !value.trim())) bad(`Invalid report ${key} (maximum ${max} characters).`);
      payload[key] = value.trim();
    }
    if (input.context != null && (typeof input.context !== 'object' || Array.isArray(input.context))) bad('Context must be a scalar object.');
    for (const [key, value] of Object.entries(payload.context)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || !['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 500) bad('Context must contain short scalar fields.');
    }
    if (new TextEncoder().encode(JSON.stringify(payload.context)).length > 8000) bad('Context exceeds 8 KB.');
    let image = null;
    if (input.screenshot != null) {
      const source = input.screenshot;
      const size = source instanceof Blob ? source.size : source.byteLength;
      if (!(source instanceof Blob || source instanceof Uint8Array || source instanceof ArrayBuffer) || !size || size > 1000000) bad('Screenshot must be a Blob, Uint8Array or ArrayBuffer of at most 1 MB.');
      const bytes = new Uint8Array(source instanceof Blob ? await source.arrayBuffer() : source instanceof ArrayBuffer ? source.slice(0) : source.slice());
      const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
      if (!png && !jpeg && !webp) bad('Screenshot must be PNG, JPEG or WebP.');
      const subtle = globalThis.crypto?.subtle || (typeof process !== 'undefined' && process.versions?.node ? (await import('node:crypto')).webcrypto.subtle : null);
      if (!subtle) throw new RavensightError('Screenshot hashing needs Web Crypto (HTTPS or localhost in a browser).', 'crypto_unavailable');
      payload.sha256 = Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      payload.image = true; payload.bytes = bytes.length;
      image = new Blob([bytes], { type: 'application/octet-stream' });
    }
    Object.freeze(payload.context);
    const report = Object.freeze({ clientId: payload.clientId, capturedAt: payload.capturedAt, hasScreenshot: !!image });
    this._reports ||= new WeakMap();
    this._reports.set(report, { payload: Object.freeze(payload), image, token: null, id: null, uploaded: false, pending: null });
    return report;
  }

  /** Captures only the supplied game canvas; call after the player's consent and preview before sending. */
  async captureScreenshot(canvas) {
    if (!canvas || !canvas.width || !canvas.height || typeof document === 'undefined') throw new RavensightError('Provide a nonempty game canvas in a browser.', 'invalid_canvas');
    const scale = Math.min(1, 1600 / canvas.width, 1600 / canvas.height);
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(canvas.width * scale));
    output.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = output.getContext('2d');
    if (!ctx) throw new RavensightError('Canvas capture is unavailable.', 'capture_failed');
    try {
      ctx.drawImage(canvas, 0, 0, output.width, output.height);
      for (const quality of [0.85, 0.7, 0.5]) {
        const blob = await new Promise(resolve => output.toBlob(resolve, 'image/jpeg', quality));
        if (blob?.size && blob.size <= 1000000) return blob;
      }
    } catch (_) { throw new RavensightError('The game canvas could not be captured. Cross-origin images may prevent capture.', 'capture_failed'); }
    throw new RavensightError('Screenshot exceeds 1 MB after encoding.', 'image_too_large');
  }

  _reportState(report) {
    const state = this._reports?.get(report);
    if (!state) throw new RavensightError('Prepare this report with createReport on the same SDK instance.', 'invalid_report');
    if (state.token && state.token !== this.sessionToken) throw new RavensightError('The original report session is no longer active.', 'report_session_changed');
    if (state.deviceId && state.deviceId !== this.deviceId) throw new RavensightError('The report belongs to a different player session.', 'report_session_changed');
    if (!this._hasKey) throw new RavensightError('No ingest key.', 'no_key');
    if (!this.isActive) throw new RavensightError('Tracking is disabled.', 'tracking_disabled');
    return state;
  }

  async _reportRequest(state, method, path, body) {
    this._reportState(state.report);
    const response = await this._request(method, path, { headers: { 'X-Session-Token': state.token }, body, signal: AbortSignal.timeout(30000) });
    if (response.status < 200 || response.status >= 300) throw new RavensightError(response.body?.message || 'Player report request failed.', this._errorCode(response, 'report_failed'), response.status);
    return response.body;
  }

  /** Returns complete or processing; processing is accepted, not yet visible in the inbox. No automatic retries or new session. */
  async submitReport(report) {
    const state = this._reportState(report);
    if (state.pending) return state.pending;
    state.report = report;
    state.pending = this._submitPreparedReport(state).finally(() => { state.pending = null; });
    return state.pending;
  }

  async _submitPreparedReport(state) {
    state.deviceId ||= this.deviceId;
    state.token ||= await this._ensureSession();
    const current = state.id
      ? await this._reportRequest(state, 'GET', `/reports/${encodeURIComponent(state.id)}`)
      : await this._reportRequest(state, 'POST', '/reports', state.payload);
    if (!current?.id || !['pending', 'processing', 'complete', 'canceled'].includes(current.status)) throw new RavensightError('Invalid report response.', 'invalid_response');
    state.id = current.id;
    if (!state.image || current.status !== 'pending') return current;
    if (!state.uploaded) {
      const grant = await this._reportRequest(state, 'POST', `/reports/${encodeURIComponent(state.id)}/upload`, {});
      let url;
      try { url = new URL(grant.url); } catch (_) { throw new RavensightError('Invalid upload URL.', 'invalid_upload'); }
      if (url.protocol !== 'https:' || url.username || url.password || !grant.fields || typeof grant.fields !== 'object') throw new RavensightError('Invalid upload authorization.', 'invalid_upload');
      const form = new FormData();
      for (const [key, value] of Object.entries(grant.fields)) form.append(key, value);
      form.append('file', state.image, 'screenshot');
      this._reportState(state.report);
      let response;
      sdkUploadUrls.add(url.href);
      try { response = await this._fetch(url.href, { method: 'POST', body: form, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) }); }
      catch (_) { throw new RavensightError('Screenshot upload failed. Retry the same prepared report.', 'upload_failed'); }
      finally { sdkUploadUrls.delete(url.href); }
      if (response.status < 200 || response.status >= 300) throw new RavensightError('Screenshot upload failed. Retry the same prepared report.', 'upload_failed', response.status);
      state.uploaded = true;
    }
    return this._reportRequest(state, 'POST', `/reports/${encodeURIComponent(state.id)}/finalize`, {});
  }

  /** Poll explicitly while processing; keep using the same prepared report. */
  async getReportStatus(report) {
    const state = this._reportState(report);
    if (!state.id) throw new RavensightError('Submit the report first.', 'report_not_submitted');
    state.report = report;
    return this._reportRequest(state, 'GET', `/reports/${encodeURIComponent(state.id)}`);
  }

  async cancelReport(report) {
    const state = this._reportState(report);
    if (state.pending) throw new RavensightError('Wait for the current submission request.', 'report_busy');
    if (!state.id) return { canceled: false };
    state.report = report;
    return this._reportRequest(state, 'DELETE', `/reports/${encodeURIComponent(state.id)}`);
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
    if (next === this.enabled) {
      this._syncErrorCapture();
      return;
    }
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
    this._syncErrorCapture();
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
    this._syncErrorCapture();

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
      this._readErrorCapture(res.body);
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
    this._syncErrorCapture();
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
    this._syncErrorCapture();
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

      // A 413 is the same problem as a 400: split, then drop the one bad
      // event. Never retried as is.
      if (res.status === 400 || res.status === 413) {
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
        this._log('dropped one event rejected with HTTP ' + res.status);
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
      this._readErrorCapture(res.body);
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



// --- CommonJS exports (generated by scripts/build-cjs.mjs) ---
module.exports = Ravensight;
module.exports.default = Ravensight;
module.exports.VERSION = VERSION;
module.exports.DEFAULT_API_URL = DEFAULT_API_URL;
module.exports.MAX_BATCH_SIZE = MAX_BATCH_SIZE;
module.exports.FEEDBACK_CATEGORIES = FEEDBACK_CATEGORIES;
module.exports.RS_KINDS = RS_KINDS;
module.exports.MAX_EVENT_BYTES = MAX_EVENT_BYTES;
module.exports.RavensightError = RavensightError;
module.exports.MemoryStorage = MemoryStorage;
module.exports.Ravensight = Ravensight;
module.exports.normalizeApiUrl = normalizeApiUrl;
module.exports.parseRetryAfterMs = parseRetryAfterMs;
module.exports.chooseUnloadTransport = chooseUnloadTransport;
module.exports.ERROR_CAPS = ERROR_CAPS;
module.exports.scrubText = scrubText;
