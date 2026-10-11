# Changelog

## 0.4.0

The browser SDK now sends the same two lifecycle events as the LÖVE SDK, so
dashboards that cover both platforms count sessions the same way.

### Breaking

* New option `autoEvents` (default `true`). In a browser the client queues
  `game_started` at construction (only when enabled) and `game_exited` on the
  first `pagehide`, flushed with keepalive. Never sent from Node. Games that
  already track `game_started` themselves should pass `autoEvents: false` or
  remove their call, or sessions will count twice.

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
