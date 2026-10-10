# Changelog

## 0.2.0

First release on npm: `npm install ravensight`.

### Changed

* `dispose()` is now `async dispose({ flush = true, timeoutMs = 2000 })` and
  flushes the queue before shutting down. In a browser, whatever a timed out
  flush leaves goes out in one last keepalive or beacon request. It resolves
  with `{ sent, dropped }`. `{ flush: false }` keeps the 0.1.0 behavior of
  discarding the queue.
* `submitFeedback` rejects a category outside `FEEDBACK_CATEGORIES` with
  `invalid_category`, and a rating that is not an integer from 1 to 5 with
  `invalid_rating`, before any request is made. A rating of `0` used to be
  silently left out; it is now rejected.

### Added

* `setDeviceId(id)` changes the device id after construction. Queued events
  are flushed under the old session first, then the next flush opens a new
  session for the new id. `resetDeviceId()` switches to a fresh random id.
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
