export declare const VERSION: string;
export declare const DEFAULT_API_URL: string;
export declare const MAX_BATCH_SIZE: number;
/** The largest event data the API accepts, in UTF-8 bytes of JSON (8192). Bigger events are dropped by track(). */
export declare const MAX_EVENT_BYTES: number;

/** 'opt_out' (default): on until the player opts out. 'opt_in': nothing until setEnabled(true). */
export type ConsentMode = 'opt_out' | 'opt_in';

export type FeedbackCategory = 'bug' | 'suggestion' | 'complaint' | 'praise' | 'playtest' | 'other';
/** The six feedback categories the API accepts, frozen. */
export declare const FEEDBACK_CATEGORIES: readonly FeedbackCategory[];

export type RsKind =
  | 'level_start' | 'level_complete' | 'death' | 'none'
  | 'purchase' | 'resource' | 'progression' | 'error' | 'health';
/** The values the reserved rs_kind property accepts, frozen. Keys starting with rs_ are reserved. */
export declare const RS_KINDS: readonly RsKind[];

export interface RavensightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional. Used to remove the opt-in yes; without it the no is stored as '0'. */
  removeItem?(key: string): void;
}

export interface RavensightOptions {
  /**
   * Publishable ingest key (gt_live_... or gt_pub_...). Missing, null or blank, the client is inert:
   * no storage writes, no requests, no timers, no listeners, and one console warning.
   */
  ingestKey?: string | null;
  /** true silences the one warning an inert (keyless) client prints. Default false. */
  optional?: boolean;
  /** Default 'opt_out'. 'opt_in' makes no device id and sends nothing until setEnabled(true), stored as ravensight_optin. */
  consent?: ConsentMode;
  /** A short label sent on POST /session, such as 'web-itch'. At most 40 characters, no control characters. */
  distribution?: string | null;
  /** Base URL. "/api/v1" is appended when omitted. */
  apiUrl?: string;
  gameVersion?: string;
  platform?: string;
  /** Flush interval in ms. 0 disables the timer. */
  autoFlushMs?: number;
  /** Offline queue cap. Oldest events are dropped first. */
  maxQueueSize?: number;
  storage?: RavensightStorage;
  deviceId?: string;
  /** Sessions cached at once, one per device id, least recently used dropped first. Default 64. */
  maxSessions?: number;
  enabled?: boolean;
  /**
   * Send `game_started` at construction and `game_exited` on the first `pagehide`.
   * Browser only, never in Node. Default true. Pass false if your game tracks them itself.
   */
  autoEvents?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** 0 <= x < 1, for backoff jitter. Default Math.random. A fixed 0.5 gives the unjittered wait. */
  random?: () => number;
  /** Log SDK activity, and warn once per event and key about an unknown rs_kind or rs_ key. */
  debug?: boolean;
  /**
   * Sample the frame rate once per second (browser, needs requestAnimationFrame), keep at most 600
   * samples, and send one `health` event on the first `pagehide`. Nothing is sent if no sample was
   * taken. Default false.
   */
  performance?: boolean;
}

/** Fields shared by every typed helper. Reserved rs_ keys win over `data`. */
export interface TypedEventBase {
  /** Overrides the default event name. */
  event?: string;
  /** Extra properties, merged first. */
  data?: Record<string, unknown>;
}

export interface PurchaseOptions extends TypedEventBase {
  /** Whole minor units of the currency (499 is 4.99), an integer or a digit string. */
  amount: number | string;
  /** Three letters, upper-cased by the helper. */
  currency: string;
  itemType: string;
  itemId: string;
  cart?: string;
  transactionId?: string;
}

export interface ResourceOptions extends TypedEventBase {
  flow: 'source' | 'sink';
  resource: string;
  /** A plain number, not money. */
  amount: number;
  itemType?: string;
  itemId?: string;
}

export interface ProgressionOptions extends TypedEventBase {
  status: 'start' | 'complete' | 'fail';
  p1: string;
  p2?: string;
  p3?: string;
  score?: number;
}

export interface ErrorOptions extends TypedEventBase {
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  /** Cut to 200 characters. */
  message: string;
  /** Cut to 2000 characters. */
  stack?: string;
}

export interface TrackedEvent {
  event: string;
  data: Record<string, unknown>;
  /** Unix seconds. */
  timestamp: number;
  /** The device the event was tracked as. Local only: never sent, the server stamps it from the session. */
  deviceId: string;
}

export interface TrackOptions {
  /** Send this event as another device, with its own session. A non-empty string. */
  deviceId?: string;
}

export interface SetDeviceIdResult {
  previousId: string | null;
  /** Events still queued under the previous id. They drain under its own session. */
  queuedUnderPreviousId: number;
}

/** Why init() could not open a session. invalid_key ends the run. */
export type InitReason =
  | 'no_key'
  | 'no_consent'
  | 'invalid_key'
  | 'tracking_disabled'
  | 'disabled'
  | 'offline'
  | 'rate_limited'
  | 'session_failed';

export interface InitResult {
  trackingEnabled: boolean;
  sessionReady: boolean;
  /** null when the session is ready. */
  reason: InitReason | null;
}

export interface RavensightLastError {
  /** An InitReason, invalid_join_token, event_too_large, event_not_serializable, offline, rate_limited, or the server's error code. */
  code: string;
  /** HTTP status, 0 for a network failure. */
  status: number;
  /** Epoch ms. */
  at: number;
}

export interface FlushResult {
  sent: number;
  queued: number;
  skipped?: 'inactive' | 'in-progress' | 'backoff';
}

export interface DisposeOptions {
  /** Flush the queue before shutting down. Default true. */
  flush?: boolean;
  /** Upper bound on the flush, in ms. Default 2000. */
  timeoutMs?: number;
}

export interface DisposeResult {
  sent: number;
  dropped: number;
}

export interface RavensightStats {
  queued: number;
  sent: number;
  dropped: number;
  flushes: number;
  sessions: number;
  /** Cached sessions dropped to stay within maxSessions. */
  sessionsEvicted: number;
  /** The last failed request, from POST /session, GET /settings or a batch. */
  lastError: RavensightLastError | null;
}

export declare class RavensightError extends Error {
  readonly name: 'RavensightError';
  readonly code: string;
  readonly status: number;
  constructor(message: string, code?: string, status?: number);
}

export declare class MemoryStorage implements RavensightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export declare function normalizeApiUrl(url?: string): string;
export declare function parseRetryAfterMs(value: string | null | undefined): number;
export declare function chooseUnloadTransport(env: {
  hasFetchKeepalive?: boolean;
  hasBeacon?: boolean;
}): 'fetch-keepalive' | 'beacon' | 'none';

export declare class Ravensight {
  constructor(options?: RavensightOptions);

  readonly apiUrl: string;
  /** null while inert, and with consent 'opt_in' before the first yes. */
  readonly deviceId: string | null;
  readonly consent: ConsentMode;
  readonly distribution: string | null;
  readonly optional: boolean;
  readonly queue: TrackedEvent[];
  readonly stats: RavensightStats;
  readonly isActive: boolean;
  readonly retryInMs: number;
  readonly maxSessions: number;
  /** True when a Ravensight Playtest token was found at construction (window.__RAVENSIGHT_PLAYTEST__, then localStorage ravensight.playtest). */
  readonly isPlaytest: boolean;
  /** The current device id's session token, or null. */
  readonly sessionToken: string | null;
  /** When the current device id's session expires, epoch ms, or 0. */
  readonly sessionExpiresAt: number;

  enabled: boolean;
  readonly autoEvents: boolean;
  /** True when opt-in performance sampling was requested. */
  readonly performance: boolean;
  trackingEnabled: boolean;
  initialized: boolean;

  /** Concurrent calls share one promise. */
  init(): Promise<InitResult>;
  /** True only while the client is running and collecting: a key, consent, not opted out, not switched off, the key not refused, not disposed. */
  isEnabled(): boolean;
  /**
   * Queues an event; its data is a copy carrying rs_event_id. Returns false when tracking is off or the
   * data is over MAX_EVENT_BYTES as JSON (dropped, warned once). Throws TypeError when options.deviceId
   * is given and is not a non-empty string.
   */
  track(event: string, data?: Record<string, unknown>, options?: TrackOptions): boolean;
  /** Typed event helpers over track(). Default event name `purchase`. Never throws on bad input; the server flags it. */
  trackPurchase(options: PurchaseOptions, trackOptions?: TrackOptions): boolean;
  /** Default event name `resource_source` or `resource_sink` by flow. */
  trackResource(options: ResourceOptions, trackOptions?: TrackOptions): boolean;
  /** Default event name `progression_start`, `progression_complete` or `progression_fail`. */
  trackProgression(options: ProgressionOptions, trackOptions?: TrackOptions): boolean;
  /** Default event name `error`. */
  trackError(options: ErrorOptions, trackOptions?: TrackOptions): boolean;
  flush(options?: { force?: boolean }): Promise<FlushResult>;
  /** null, undefined and '' mean not given. Rejects with code invalid_category, or invalid_rating unless rating is an integer 1 to 5, before any request. */
  submitFeedback(message: string, category?: FeedbackCategory | null, rating?: number | null): Promise<{ ok: true }>;
  fetchSuggestions(): Promise<unknown[]>;
  /** With consent 'opt_in', true is the player's yes (stored as ravensight_optin) and false removes it. */
  setEnabled(value: boolean): void;
  /** Alias of setEnabled, the LÖVE SDK's name. */
  setTrackingEnabled(value: boolean): void;
  /**
   * Best effort keepalive or beacon flush of one batch for a page going away. Never resends the batch in
   * flight: uses the larger of `offset` and the SDK's own in-flight count. False in Node.
   */
  flushOnHidden(offset?: number): boolean;
  /** For deviceId, default the current id. */
  isSessionValid(deviceId?: string): boolean;
  /** The cached session token for deviceId (default: the current id) while valid, else null. Synchronous. */
  sessionTokenFor(deviceId?: string): string | null;
  /**
   * Resolves once deviceId (default: the current id) has an open session, opening one if needed.
   * Concurrent calls share one request. Rejects with a RavensightError whose code is no_key, no_consent,
   * invalid_key, tracking_disabled, offline, rate_limited, session_failed, disabled or disposed.
   */
  session(deviceId?: string): Promise<{ token: string; expiresAt: number }>;
  /** Switches at once and stores the id; nothing is flushed. Queued events keep their id and its session. Rejects with code disposed after dispose(). */
  setDeviceId(id: string): Promise<SetDeviceIdResult>;
  /**
   * Joins a session opened elsewhere (the browser's rs.sessionToken), so this device id's next
   * session shares its analytics session. Used once; a refused token falls back to a plain session.
   * Idempotent per device id: the same token again resolves { joined: false, reason: 'already_joined' };
   * a different token replaces the join. Opens the session now and resolves { joined: true, synthetic }
   * (synthetic is null when the server did not say), or { joined: false, reason } and never rejects.
   * Throws TypeError on a bad token or deviceId, RavensightError code disposed after dispose().
   */
  joinSession(token: string, options?: TrackOptions): Promise<JoinResult>;
  /** The server's synthetic (persona account) answer for the session joined for this id, or null. */
  isSynthetic(deviceId?: string): boolean | null;
  /** Switches to a fresh random device id. Same semantics as setDeviceId. Resolves with the new id. */
  resetDeviceId(): Promise<string>;
  dispose(options?: DisposeOptions): Promise<DisposeResult>;
}

export type JoinResult =
  | { joined: true; synthetic: boolean | null }
  | {
      joined: false;
      reason:
        | 'already_joined'
        | 'no_key'
        | 'no_consent'
        | 'replaced'
        | 'invalid_join_token'
        | 'invalid_key'
        | 'tracking_disabled'
        | 'offline'
        | 'rate_limited'
        | 'session_failed'
        | 'disabled'
        | 'disposed'
        | 'playtest_job_closed';
    };

export default Ravensight;
