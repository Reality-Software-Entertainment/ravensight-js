export declare const VERSION: string;
export declare const DEFAULT_API_URL: string;
export declare const MAX_BATCH_SIZE: number;

export type FeedbackCategory = 'bug' | 'suggestion' | 'complaint' | 'praise' | 'playtest' | 'other';
/** The six feedback categories the API accepts, frozen. */
export declare const FEEDBACK_CATEGORIES: readonly FeedbackCategory[];

export type RsKind = 'level_start' | 'level_complete' | 'death' | 'none';
/** The values the reserved rs_kind property accepts, frozen. Keys starting with rs_ are reserved. */
export declare const RS_KINDS: readonly RsKind[];

export interface RavensightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RavensightOptions {
  /** Publishable ingest key, format gt_live_... */
  ingestKey: string;
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
  /** Log SDK activity, and warn once per event and key about an unknown rs_kind or rs_ key. */
  debug?: boolean;
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
  previousId: string;
  /** Events still queued under the previous id. They drain under its own session. */
  queuedUnderPreviousId: number;
}

/** Why init() could not open a session. */
export type InitReason = 'invalid_key' | 'tracking_disabled' | 'disabled' | 'offline' | 'rate_limited' | 'session_failed';

export interface InitResult {
  trackingEnabled: boolean;
  sessionReady: boolean;
  /** null when the session is ready. */
  reason: InitReason | null;
}

export interface RavensightLastError {
  /** An InitReason for POST /session, invalid_join_token, offline, rate_limited, or the server's error code. */
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
}

export declare function normalizeApiUrl(url?: string): string;
export declare function parseRetryAfterMs(value: string | null | undefined): number;
export declare function chooseUnloadTransport(env: {
  hasFetchKeepalive?: boolean;
  hasBeacon?: boolean;
}): 'fetch-keepalive' | 'beacon' | 'none';

export declare class Ravensight {
  constructor(options: RavensightOptions);

  readonly apiUrl: string;
  readonly deviceId: string;
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
  trackingEnabled: boolean;
  initialized: boolean;

  init(): Promise<InitResult>;
  /** Throws TypeError when options.deviceId is given and is not a non-empty string. */
  track(event: string, data?: Record<string, unknown>, options?: TrackOptions): boolean;
  flush(options?: { force?: boolean }): Promise<FlushResult>;
  /** null, undefined and '' mean not given. Rejects with code invalid_category, or invalid_rating unless rating is an integer 1 to 5, before any request. */
  submitFeedback(message: string, category?: FeedbackCategory | null, rating?: number | null): Promise<{ ok: true }>;
  fetchSuggestions(): Promise<unknown[]>;
  setEnabled(value: boolean): void;
  /** For deviceId, default the current id. */
  isSessionValid(deviceId?: string): boolean;
  /** The cached session token for deviceId (default: the current id) while valid, else null. Synchronous. */
  sessionTokenFor(deviceId?: string): string | null;
  /**
   * Resolves once deviceId (default: the current id) has an open session, opening one if needed.
   * Concurrent calls share one request. Rejects with a RavensightError whose code is invalid_key,
   * tracking_disabled, offline, rate_limited, session_failed, disabled or disposed.
   */
  session(deviceId?: string): Promise<{ token: string; expiresAt: number }>;
  /** Switches at once and stores the id; nothing is flushed. Queued events keep their id and its session. Rejects with code disposed after dispose(). */
  setDeviceId(id: string): Promise<SetDeviceIdResult>;
  /**
   * Joins a session opened elsewhere (the browser's rs.sessionToken), so this device id's next
   * session shares its analytics session. Used once; a refused token falls back to a plain session.
   * Throws TypeError on a bad token or deviceId, RavensightError code disposed after dispose().
   */
  joinSession(token: string, options?: TrackOptions): void;
  /** Switches to a fresh random device id. Same semantics as setDeviceId. Resolves with the new id. */
  resetDeviceId(): Promise<string>;
  dispose(options?: DisposeOptions): Promise<DisposeResult>;
}

export default Ravensight;
