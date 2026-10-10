# Changelog

## 0.2.0

First release on npm: `npm install ravensight`.

### Changed

* `dispose()` is now `async dispose({ flush = true, timeoutMs = 2000 })` and
  flushes the queue before shutting down. In a browser, whatever a timed out
  flush leaves goes out in one last keepalive or beacon request. It resolves
  with `{ sent, dropped }`. Events in a request that timed out are counted
  as dropped and never re sent, so nothing arrives twice. `{ flush: false }`
  keeps the 0.1.0 behavior of discarding the queue.
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
