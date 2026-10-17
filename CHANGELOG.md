# Changelog

## 0.5.1 (held)

- Add session-start config fetching, scoped persistent/offline caching, ETags, typed fallback getters and an optional readiness callback.
- Add automatic experiment exposure properties to tracked events, scoped to their device and build.
- Respect consent and discard late config responses after shutdown or opt-out.

## 0.5.0

For games whose builds or source anyone can download: a public repository,
a demo, a game jam entry, a web build. A game that passes a key and none of
the new options behaves as on 0.4.2, except for the changes listed first.
See "Public builds" in the README.

### Changes for 0.4.2 games

* A `401` or `403` answer to `GET /settings` or `POST /session` (other than
  `403 tracking_disabled`, the kill switch, and `403 playtest_job_closed`)
  now ends the run instead of stopping only the timer. The queue is
  cleared and counted in `stats.dropped`, nothing is retried, `track()`
  returns `false`, and `init()`, `flush()` and `session()` do not try the
  key again; a new client does. `init()` resolves
  `{ trackingEnabled: false, sessionReady: false, reason: 'invalid_key' }`
  (it said `trackingEnabled: true` before). One console warning is printed,
  with or without `debug`. A batch `401` still means "open a new session"
  and is retried as before.
* Retry waits carry plus or minus 20 percent jitter, so copies of a game
  that lost the network together do not come back together. `Retry-After`
  is still honored exactly, and the 5 minute ceiling holds. A new `random`
  option (default `Math.random`) makes the wait exact in tests: `() => 0.5`
  is the unjittered wait.
* Every event's data gains an `rs_event_id` key, and the queued data is a
  copy of yours: changing your object after `track()` no longer changes the
  queued event. An `rs_event_id` of your own is replaced.
* An event whose data is over 8,192 bytes as JSON (UTF-8, the size the
  server checks; the event name and timestamp are not counted), or that
  cannot be serialized at all, is dropped by `track()`, which returns
  `false`. It counts in `stats.dropped`, sets `stats.lastError` to
  `event_too_large` or `event_not_serializable`, and the first one per
  client prints one console warning. Before, an oversize event was sent and
  split out by the server's `400`, and unserializable data broke the flush.
* `new Ravensight()` with no `ingestKey`, or a blank one, no longer throws.
  It makes an inert client (below). A key that is not a string still throws
  a `TypeError`.

### Added

* **Inert without a key.** No storage writes (not even the `localStorage`
  probe), no request, no timer, no listener and no automatic events.
  `isEnabled()` is `false`, `deviceId` is `null`, every call is a no-op:
  `init()` resolves reason `no_key`, `session()`, `submitFeedback()` and
  `fetchSuggestions()` reject with code `no_key`, `joinSession()` resolves
  `{ joined: false, reason: 'no_key' }`. One console warning, which
  `optional: true` silences.
* **`rs.isEnabled()`**, `true` only while the client is collecting: a key,
  consent, not opted out, not switched off by the server, the key not
  refused, not disposed.
* **`consent: 'opt_in'`** (default `'opt_out'`, the 0.4.2 behavior). Nothing
  happens before the player's yes: no device id, no storage write, no
  settings check, no session, no automatic events, no listeners; events
  tracked before the yes are dropped. `setEnabled(true)` is the yes: it is
  stored as `ravensight_optin` in the same storage the device id uses, the
  device id is made, and an `init()` called before the yes runs then;
  events tracked right after it are queued while the settings check runs.
  `setEnabled(false)` removes the stored yes and keeps the device id
  (`resetDeviceId()` forgets it). `init()` before the yes resolves reason
  `no_consent`. Under a Ravensight Playtest no yes is needed and nothing is
  stored. An unknown `consent` value throws a `TypeError`.
* **`rs.setTrackingEnabled(value)`**, an alias of `setEnabled`, the name the
  LÖVE SDK uses.
* **`distribution`** option: a label of up to 40 characters with no control
  characters, such as `'web-itch'`, sent on `POST /session` as
  `distribution` when set. Anything else throws a `TypeError`.
* **`rs_event_id`** on every event, inside its data: the first 16
  characters of the device id the event is tracked under (characters
  outside `A-Z a-z 0-9 _ -` become `_`), the client's start time in hex, an
  8 hex character nonce made once per client from `crypto.getRandomValues`,
  and a counter. It matches `^[A-Za-z0-9_-]{1,64}$`. A resend after a
  failure, a session refresh, a `400` split or the page hide flush carries
  the same id, and so do events sent under a joined session.
* **`rs.flushOnHidden(offset?)`**, the public form of `_flushOnHidden`. It
  sends one batch by keepalive or beacon for a page going away and never
  resends the batch in flight: it uses the larger of `offset` and the SDK's
  own in-flight count. `_flushOnHidden(offset)` is kept.
* `MAX_EVENT_BYTES` (8192) is exported. `MemoryStorage` gains `removeItem`.
* `init()` calls made while one is running share its promise.

### Compatibility

* TypeScript: `ingestKey` is optional, `deviceId` and
  `SetDeviceIdResult.previousId` are `string | null`, and `InitReason`,
  `JoinResult` and the `session()` codes gain `no_key` and `no_consent`.
* The LÖVE bridge's `rs.flushOnHidden(inflight)` call is now served by the
  public method; older SDKs fall back to `_flushOnHidden`.
* There is still no saved queue in this SDK: events not sent before a page
  closes are lost, as before, so `rs_event_id` protects resends within a
  page's life.

### Added

* Typed event helpers `rs.trackPurchase`, `rs.trackResource`,
  `rs.trackProgression` and `rs.trackError`. Each builds the reserved `rs_`
  properties and calls `rs.track()`, so delivery is unchanged. Reserved keys
  win over `data`, `event` overrides the default event name, and bad input is
  passed through for the server to flag. TypeScript declarations included.
* Opt-in performance sampling, `performance: true`. In a browser the SDK
  samples the frame rate once per second, keeps at most 600 samples and sends
  one `health` event per session on `pagehide`. Nothing is sent without a
  sample.
* The session request now carries `sdk: "js/<version>"`.

### Changed

* `RS_KINDS` also lists `purchase`, `resource`, `progression`, `error` and
  `health`, and the debug reserved-key check knows every typed key. It still
  warns on `rs_invalid`, which only the server writes.

## 0.4.2

### Changed

* `rs.joinSession(token, { deviceId }?)` is idempotent per device id. Joining
  the same token again for the same id does nothing and resolves
  `{ joined: false, reason: 'already_joined' }`, so a game server no longer
  needs its own list of joined tokens. A different token for the same id
  replaces the join as before.
* `joinSession` now returns a promise. It opens the session at once, bounded
  by the request timeout, and resolves `{ joined: true, synthetic }`, where
  `synthetic` is the server's `true` or `false` for a persona account, or
  `null` when the server did not say. It never rejects after argument
  checks: a refused token or a failed open resolves `{ joined: false, reason }`.
  Code that ignored the old `undefined` return keeps working.

### Added

* `rs.isSynthetic(deviceId?)` answers `true`, `false` or `null` for the
  session joined for that id, so a game server can read it instead of
  trusting a flag the client sends.

## 0.4.1

### Added

* `rs.session(deviceId?)` returns a promise for `{ token, expiresAt }` that
  resolves once the device's session is open, opening it if needed. Use it to
  hand the browser's session to your server without polling `rs.sessionToken`.
  It rejects with an error whose `code` is the init reason.
* `rs.sessionTokenFor(deviceId?)` returns a device's cached session token, or
  `null`, synchronously.

## 0.4.0

The browser SDK now sends the same two lifecycle events as the LÖVE SDK, so
dashboards that cover both platforms count sessions the same way.

### Breaking

* New option `autoEvents` (default `true`). In a browser the client queues
  `game_started` at construction (only when enabled) and `game_exited` on the
  first `pagehide`, flushed with keepalive. Never sent from Node. Games that
  already track `game_started` themselves should pass `autoEvents: false` or
  remove their call, or sessions will count twice.

### Fixed

* `init()` on a client that is opted out (`enabled: false`) no longer reads the
  settings or opens a session. It makes no network call and returns the reason
  `disabled`.

### Upgrading from 0.3.0

Delete your own `rs.track('game_started')` or pass `autoEvents: false`,
otherwise every browser session counts twice.

### Docs

* README: "Automatic events", "Telling players" (consent copy and an opt-out
  toggle example) and a comparison table with the LÖVE SDK.

## 0.3.0

One client can now speak for many players, `init()` says why a session is
not ready, and a refused key no longer retries forever.

### Breaking

* `setDeviceId(id)` no longer flushes or waits. It switches at once, stores
  the id and resolves with `{ previousId, queuedUnderPreviousId }`. Events
  queued before the switch keep the id they were tracked under and drain
  later under that id's own session, which stays cached. In 0.2.0 they were
  flushed first, and any that could not be sent moved to the new id.
  `resetDeviceId()` follows the same rules and still resolves with the new id.
* `dispose()` accounting: the last keepalive or beacon request in a browser
  carries only the run of events at the head of the queue that share one
  device id, because one request is one session. Events queued under other
  ids that the bounded flush could not send are counted as dropped.
* `sessionToken` and `sessionExpiresAt` are read only views of the current
  device id's session. Assigning to them throws a `TypeError`.
* `rs.queue` items carry a `deviceId` field. It is stripped before sending:
  the server stamps the device id from the session.

### Added

* `track(event, data, { deviceId })` sends one event as another device, with
  its own session, so one Node client serves many players.
* `maxSessions` option (default 64): sessions are cached per device id and
  the least recently used is dropped past the cap, never the current id or
  one still opening. `stats.sessionsEvicted` counts them.
* `rs.joinSession(token, { deviceId })` joins a session opened elsewhere,
  normally the browser's `rs.sessionToken`, so server side events share the
  player's analytics session. A refused join token falls back to a plain
  session.
* `init()` resolves with `reason`: `invalid_key`, `tracking_disabled`,
  `offline`, `rate_limited`, `session_failed`, or `null` when the session is
  ready.
* `stats.lastError` is `{ code, status, at }` for the last failed session,
  settings or batch request.
* `RS_KINDS`, the four values the reserved `rs_kind` property accepts. With
  `debug: true`, `track()` warns once per event and key about an `rs_kind`
  outside it or an `rs_` key Ravensight does not read.
* Ravensight Playtest support: a token left by the playtest runner in
  `window.__RAVENSIGHT_PLAYTEST__` or `localStorage` `ravensight.playtest`
  is sent on `POST /session` as
  `X-Ravensight-Playtest`. `rs.isPlaytest` reports it.

### Changed

* A flush sends one device per request: the leading run of events sharing
  the head's device id, up to 50. A `401` re opens only that device's
  session.
* A refused ingest key (`401`, or a `403` other than `tracking_disabled`)
  stops the flush timer and the 50 event auto flush. `track()` keeps
  queueing up to `maxQueueSize`; `flush()` and `init()` try again, and the
  first session that opens restarts the timer. With `debug: true` it warns
  once.
* A `403 tracking_disabled` from `POST /session` switches tracking off
  locally, the same as the kill switch read from `GET /settings`.
* Under a playtest no device id is read from or written to storage, and a
  `403 playtest_job_closed` stops the client for good.

## 0.2.0

First release on npm: `npm install ravensight`.

### Changed

* `dispose()` is now `async dispose({ flush = true, timeoutMs = 2000 })` and
  flushes the queue before shutting down. In a browser, whatever a timed out
  flush leaves goes out in one last keepalive or beacon request. It resolves
  with `{ sent, dropped }`. Events in a request that timed out are counted
  as dropped and never re sent, so nothing arrives twice. `{ flush: false }`
  keeps the 0.1.0 behavior of discarding the queue.
* The page-hide flush never re sends a batch that is still in flight, so a
  batch aborted by a real unload can be lost rather than duplicated. A batch
  whose response is lost, from a network error or a `5xx` after the server
  already stored it, can still be sent again on the next flush.
* `submitFeedback` rejects a category outside `FEEDBACK_CATEGORIES` with
  `invalid_category`, and a rating that is not an integer from 1 to 5 with
  `invalid_rating`, before any request is made. `null`, `undefined` and `''`
  still mean "not given" for both. A rating of `0` used to be silently left
  out and is now rejected, and a string rating such as `'4'`, which 0.1.0
  coerced to a number, is now rejected too.
* TypeScript: `category` is typed as the `FeedbackCategory` union, so a caller
  passing a plain `string` needs that type or a cast.

### Added

* `setDeviceId(id)` changes the device id after construction. Queued events
  are flushed under the old session first, then the next flush opens a new
  session for the new id. A session already opening under the old id is
  waited out first. `resetDeviceId()` switches to a fresh random id.
* `FEEDBACK_CATEGORIES`: `bug`, `suggestion`, `complaint`, `praise`,
  `playtest`, `other`.
* README sections on running one client per player on a Node server, and on
  how the dashboard reads your events.

### Fixed

* The README and the `chooseUnloadTransport` comment said the beacon fallback
  puts the session token in the query string. It goes in the JSON body as
  `sessionToken`, which is what the code has always done.

## 0.1.0

Initial release, installable from git.
