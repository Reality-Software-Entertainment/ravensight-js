export declare const VERSION: string;
export declare const DEFAULT_API_URL: string;
export declare const MAX_BATCH_SIZE: number;

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

export interface RavensightStats {
  queued: number;
  sent: number;
  dropped: number;
  flushes: number;
  sessions: number;
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

  enabled: boolean;
  trackingEnabled: boolean;
  initialized: boolean;
  sessionToken: string | null;
  sessionExpiresAt: number;

  init(): Promise<InitResult>;
  track(event: string, data?: Record<string, unknown>): boolean;
  flush(options?: { force?: boolean }): Promise<FlushResult>;
  submitFeedback(message: string, category?: string, rating?: number): Promise<{ ok: true }>;
  fetchSuggestions(): Promise<unknown[]>;
  setEnabled(value: boolean): void;
  isSessionValid(): boolean;
  dispose(): void;
}

export default Ravensight;
