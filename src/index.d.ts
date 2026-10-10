export declare const VERSION: string;
export declare const DEFAULT_API_URL: string;
export declare const MAX_BATCH_SIZE: number;

export type FeedbackCategory = 'bug' | 'suggestion' | 'complaint' | 'praise' | 'playtest' | 'other';
/** The six feedback categories the API accepts, frozen. */
export declare const FEEDBACK_CATEGORIES: readonly FeedbackCategory[];

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
  fetch?: typeof fetch;
  now?: () => number;
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

export interface InitResult {
  trackingEnabled: boolean;
  sessionReady: boolean;
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
  /** The current device id's session token, or null. */
  readonly sessionToken: string | null;
  /** When the current device id's session expires, epoch ms, or 0. */
  readonly sessionExpiresAt: number;

  enabled: boolean;
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
  /** Switches at once and stores the id; nothing is flushed. Queued events keep their id and its session. Rejects with code disposed after dispose(). */
  setDeviceId(id: string): Promise<SetDeviceIdResult>;
  /** Switches to a fresh random device id. Resolves with the new id. */
  resetDeviceId(): Promise<string>;
  dispose(options?: DisposeOptions): Promise<DisposeResult>;
}

export default Ravensight;
