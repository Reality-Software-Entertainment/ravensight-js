# ravensight

Official JavaScript SDK for [Ravensight](https://ravensight.io) player analytics.

Zero dependencies. Works in the browser and in Node 18 or newer. Ships both ESM
and CommonJS. Handles sessions, batching, the offline queue, rate limits and the
server side kill switch for you.

* API base: `https://api.ravensight.io/api/v1`
* Docs: https://ravensight.io/docs/
* Privacy: a random per-install device id, no advertising identifier, a local opt-out (`rs.setEnabled(false)`) or an opt-in mode (`consent: 'opt_in'`), no tracking permission prompt needed. What your store label can say: https://ravensight.io/docs/#privacy-label
* Public builds: with no key the client is inert, so a public repository or a fork sends nothing. See [Public builds](#public-builds).

## Install

```bash
npm install ravensight
```

There is no build step for consumers. The ESM entry is plain source and the
CommonJS build ships alongside it.

## Quickstart: browser game

```js
import Ravensight from 'ravensight';

const rs = new Ravensight({
  ingestKey: 'gt_live_your_publishable_key',
  gameVersion: '1.4.0',
});

// Reads the server kill switch and opens a session.
await rs.init();

rs.track('level_completed', { level: 3, deaths: 2, seconds: 91 });

// Optional: player feedback from an in game form.
await rs.submitFeedback('The boss fight is too long', 'suggestion', 4);
```

Events are queued and sent in batches of up to 50, on a timer and when the page
is hidden. You do not need to call `flush()` yourself, but you can.

Without a bundler, load it as a module directly:

```html
<script type="module">
  import Ravensight from './node_modules/ravensight/src/index.js';
  const rs = new Ravensight({ ingestKey: 'gt_live_...' });
  await rs.init();
  rs.track('page_loaded');
</script>
```

## Quickstart: Node

```js
// ESM
import Ravensight from 'ravensight';

// CommonJS
// const Ravensight = require('ravensight');

const rs = new Ravensight({
  ingestKey: process.env.RAVENSIGHT_KEY,
  gameVersion: '1.4.0',
  platform: 'dedicated-server',
});

await rs.init();
rs.track('match_finished', { mode: 'ranked', durationSec: 620 });

// Node has no localStorage, so the device id lives in memory by default.
// Give it a stable id or your own storage if you want it to persist.
```

A Node process that serves many players needs only one client: pass each
player's id with the event. See
[Node servers with many players](#node-servers-with-many-players).

Persisting the device id in Node:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const fileStorage = {
  getItem: (k) => {
    try { return readFileSync(`./.${k}`, 'utf8'); } catch { return null; }
  },
  setItem: (k, v) => writeFileSync(`./.${k}`, v, 'utf8'),
};

const rs = new Ravensight({ ingestKey: 'gt_live_...', storage: fileStorage });
```

## Node servers with many players

The server stamps the device id from the session, so every device needs its
own session. The SDK keeps one per device id for you. On a game server, create
one client and pass the player's id as the third argument to `track()`:

```js
import Ravensight, { MemoryStorage } from 'ravensight';

const rs = new Ravensight({
  ingestKey: process.env.RAVENSIGHT_KEY,
  gameVersion: '1.4.0',
  platform: 'dedicated-server',
  // Explicit, so the server's own device id never lands in a shared
  // localStorage polyfill or a file another process reads.
  storage: new MemoryStorage(),
});
await rs.init();

function onMatchFinished(player, match) {
  rs.track('match_finished', { mode: match.mode, durationSec: match.seconds }, { deviceId: player.id });
}

// On shutdown, the last flush for every player at once.
process.on('SIGTERM', async () => {
  await rs.dispose({ timeoutMs: 5000 });
  process.exit(0);
});
```

* **One request is one device.** A flush sends the run of queued events that
  share the device id at the head of the queue, up to 50, under that id's
  session, then the next run. Interleaved players cost more requests than one
  player, but nothing is ever sent under the wrong id.
* **Sessions are cached per id**, up to `maxSessions` (default 64). Past that
  the least recently used is dropped and reopens on that player's next
  event. Raise it if more players than that are active at once. It is a soft
  bound: a session still opening, one holding a join token not yet used, and
  the client's own id are never dropped, so the cache can briefly hold more.
* **Limits are per game, shared by every player** on the client: 60 session
  creations and 600 tracked events a minute. A burst past that gets `429`
  with `Retry-After`, and the SDK holds the events and retries for all of
  them. See the [limits](https://ravensight.io/docs/#limits).
* **`dispose()` is the last flush.** Call it on shutdown. Anything it cannot
  send inside `timeoutMs` is counted in `stats.dropped`.

### Joining the browser's session

When the same player also runs the browser SDK, the browser can hand its
session to your server, so server side events land in the same analytics
session as the player's own:

```js
// Browser: wait for the session, then send the token to your server.
const { token } = await rs.session();
await fetch('/api/link-analytics', {
  method: 'POST',
  body: JSON.stringify({ rsToken: token }),
});

// Server: join, then read what the server says about the account.
const join = await rs.joinSession(body.rsToken, { deviceId: player.id });
if (join.joined && join.synthetic === true) {
  // A persona account: keep it out of your other tools. This comes from the
  // Ravensight server, not from a flag the browser sent.
  player.synthetic = true;
}
rs.track('purchase_verified', { sku: 'gold_pack' }, { deviceId: player.id });
```

`rs.session()` resolves as soon as the session is open, so there is no timer
to poll `rs.sessionToken`. On the server, `await rs.session(player.id)` opens
a player's session eagerly if you want it open before their first event;
`joinSession` itself needs no wait before `track`.

The next session opened for that id carries the token once, and the server
copies the browser's device id. The local id is only the key the SDK caches
the session under. If the server refuses the token, the SDK opens a plain
session instead and records `invalid_join_token` in `stats.lastError`.

`joinSession` is idempotent per device id, so you do not need your own list of
joined tokens. Joining the token already joined for an id does nothing and
resolves `{ joined: false, reason: 'already_joined' }`; a different token for
the same id replaces the join. The promise opens the session, bounded by the
request timeout, and resolves `{ joined: true, synthetic }`. `synthetic` is
`true` or `false` as the Ravensight server judged the account, or `null` when
it did not say (an older server). It never rejects: a refused token or a
failed open resolves `{ joined: false, reason }`. After the join,
`rs.isSynthetic(player.id)` gives the same answer, or `null` if none has
settled. If that id's session is evicted past `maxSessions` the SDK forgets the join
and the answer, so the same token joins again on the next call.

## itch.io and HTML5 exports

Ravensight works from an itch.io HTML5 page with no extra setup, with two things
worth knowing:

* itch.io serves games from a sandboxed subdomain of `hwcdn.net` or
  `itch.zone`. All calls are cross origin, and the API sends the CORS headers
  needed for that. If you self host Ravensight, allow your itch domain.
* Some browsers block `localStorage` inside the itch iframe. The SDK catches
  that and falls back to an in memory device id, so tracking still works, but
  returning players look new. Ticking "Click to launch in fullscreen" or serving
  the game from your own domain avoids it.

For Godot HTML5 exports, use the Godot SDK instead. This package is for
JavaScript and TypeScript engines such as Phaser, PixiJS, three.js, Excalibur
and hand written canvas games.

## API

### `new Ravensight(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `ingestKey` | none | Your publishable `gt_live_...` key, or a public `gt_pub_...` key. Safe to ship in a client build. Missing or blank, the client is inert (see [Public builds](#public-builds)). |
| `optional` | `false` | `true` silences the one warning an inert client prints. |
| `consent` | `'opt_out'` | `'opt_in'` makes no device id and sends nothing until `setEnabled(true)`. See [Public builds](#public-builds). |
| `distribution` | none | A short label sent on the session, such as `'web-itch'`. At most 40 characters, no control characters. |
| `apiUrl` | `https://api.ravensight.io/api/v1` | Base URL. `/api/v1` is appended if you leave it off. |
| `gameVersion` | `'1.0.0'` | Reported with the session. |
| `platform` | auto | `'web'` in a browser, `node-<platform>` in Node. |
| `autoFlushMs` | `15000` | Flush interval. Set `0` to flush only on demand. |
| `maxQueueSize` | `500` | Offline queue cap. Oldest events are dropped first. |
| `maxSessions` | `64` | Sessions cached at once, one per device id. The least recently used is dropped first, never the current id. |
| `storage` | auto | Anything with `getItem` and `setItem`. Used for the device id. |
| `deviceId` | auto | Override the generated device id entirely. |
| `enabled` | `true` | Start opted out by passing `false`. |
| `autoEvents` | `true` | Send `game_started` and `game_exited` for you, in a browser. See [Automatic events](#automatic-events). |
| `fetch` | global | Inject a custom fetch. |
| `random` | `Math.random` | Source for the backoff jitter. `() => 0.5` gives the exact, unjittered wait in tests. |
| `performance` | `false` | Sample the frame rate and send one `health` event per session on page hide. See [Typed events](#typed-events). |
| `debug` | `false` | Log SDK activity to the console, and warn about reserved `rs_` keys. |
| `captureErrors` | `true` | Capture errors automatically. `false` opts this client out. See [Automatic error capture](#automatic-error-capture). |
| `captureDeadClicks` | `true` | In a browser, report a click on a button that changes nothing for 2 seconds. |
| `captureRequestHosts` | `[]` | Hosts outside your page's own site whose failed requests may be captured: `'api.partner.io'`, or `'*.cdn.example'` for its subdomains. |

Read `rs.capturingErrors` to see whether this client's error hooks are in.

### `await rs.init()`

Reads `GET /settings` for the kill switch, then opens a session with
`POST /session`. Returns `{ trackingEnabled, sessionReady, reason }`. It never
throws on a network failure: if the settings call fails the SDK assumes
tracking is on, and if the session call fails events keep queueing until a
retry succeeds.

`reason` is `null` when the session is ready, otherwise one of:

| Reason | Meaning |
| --- | --- |
| `no_key` | No `ingestKey`: the client is inert. |
| `no_consent` | `consent: 'opt_in'` and no yes yet. `setEnabled(true)` runs this `init()` for you. |
| `invalid_key` | The key was refused (`401`, or a `403` other than the kill switch) by the settings check or `POST /session`. The run has ended; see below. |
| `tracking_disabled` | Tracking is switched off for this game. Nothing is sent. |
| `disabled` | The client is opted out (`enabled: false` or `setEnabled(false)`). `init()` makes no network call. Call `setEnabled(true)` and then `init()` to start. |
| `offline` | No answer from the network. Retried with backoff. |
| `rate_limited` | `429`. Retried after `Retry-After`. |
| `session_failed` | Any other answer. Retried with backoff. |

With `invalid_key` the run ends, because a retry cannot fix a revoked,
rotated or wrong key: the queue is cleared (counted in `stats.dropped`), the
timer stops, `track()` returns `false`, and `init()`, `flush()` and
`session()` do not try the key again. It warns once on the console. A new
client, normally the next launch, tries the key again. A batch `401` is
different: it means the session expired, and the SDK opens a new one.

Concurrent `init()` calls share one promise.

If the server has tracking switched off for your game, the queue is cleared,
`track()` becomes a no op and nothing further is sent.

`rs.stats.lastError` holds the last failed request as `{ code, status, at }`
(`at` in epoch ms, `status` 0 for a network failure), from the session,
settings or batch requests, or `null`. Read it when events are not arriving.
It can show `session_expired` after a routine batch `401`, which the SDK has
already recovered from by opening a new session; look at it together with
whether `rs.queue` is draining.

### `rs.track(event, data?, { deviceId }?)`

Queues an event. Safe to call before `init()`. Returns `false` when tracking is
off. Timestamps are recorded as unix milliseconds at the moment of the call, so a
delayed flush still reports when the thing actually happened.

`deviceId` sends this one event as another device, under that id's own
session. It must be a non-empty string or `track()` throws a `TypeError`.
Leave it out to use the client's own id. See
[Node servers with many players](#node-servers-with-many-players).

The queued data is a copy of yours carrying an `rs_event_id` (see
[Public builds](#public-builds)), so changing your object afterwards does not
change the event. Data over `MAX_EVENT_BYTES` (8,192 bytes as JSON), or data
that cannot be serialized, is dropped: `track()` returns `false`, the drop
counts in `stats.dropped` and `stats.lastError` (`event_too_large` or
`event_not_serializable`), and the first one prints one console warning.

Property keys starting with `rs_` are reserved for Ravensight. `rs_kind` says
what an event means for the level funnel and must be one of `RS_KINDS`:
`level_start`, `level_complete`, `death` or `none`, or one of the typed kinds the
helpers below set (`purchase`, `resource`, `progression`, `error`, `health`). With `debug: true`, the SDK
warns once per event and key about an `rs_kind` outside that list or an `rs_`
key Ravensight does not read. It never throws and still queues the event.

### Typed events

Four helpers build the reserved `rs_` properties for you and call `rs.track()`,
so queueing, batching, retries and opt out behave exactly as before. They
return what `track()` returns. Each takes an options object, and an optional
second argument is `track()`'s own `{ deviceId }`. `data` holds extra
properties, merged first, so the reserved keys always win. `event` overrides
the default event name. The helpers never throw on bad input: the server
marks a wrong value `rs_invalid`, and it shows on the Implementation health
card.

```js
// Money is whole minor units: 499 is 4.99. An integer or a digit string.
// Currency is three letters and is upper-cased for you. Event name: purchase.
rs.trackPurchase({ amount: 499, currency: 'usd', itemType: 'bundle', itemId: 'starter', cart: 'c1', transactionId: 'tx9' });

// flow is 'source' or 'sink'. Amount is a plain number, not money.
// Event name: resource_source or resource_sink.
rs.trackResource({ flow: 'source', resource: 'gold', amount: 50, itemType: 'quest', itemId: 'q1' });

// status is 'start', 'complete' or 'fail'. p2, p3 and score are optional.
// Event name: progression_start, progression_complete or progression_fail.
rs.trackProgression({ status: 'complete', p1: 'world1', p2: 'level3', score: 1200 });

// severity is 'debug', 'info', 'warning', 'error' or 'critical'.
// The message is cut to 200 characters and the stack to 2000. Event name: error.
rs.trackError({ severity: 'error', message: err.message, stack: err.stack });
```

| Helper | Required | Optional | Default event name |
| --- | --- | --- | --- |
| `trackPurchase` | `amount`, `currency`, `itemType`, `itemId` | `cart`, `transactionId` | `purchase` |
| `trackResource` | `flow`, `resource`, `amount` | `itemType`, `itemId` | `resource_source`, `resource_sink` |
| `trackProgression` | `status`, `p1` | `p2`, `p3`, `score` | `progression_start`, `progression_complete`, `progression_fail` |
| `trackError` | `severity`, `message` | `stack`, `errorType` (sent as `rs_error_type`) | `error` |

**Health sampling is opt in.** Pass `performance: true` in a browser and the
SDK samples the frame rate once per second from `requestAnimationFrame`, keeps
at most 600 samples, and sends exactly one `health` event per session on
`pagehide`, with the median and 10th percentile frames per second, the JS heap
in MB where the browser exposes it, and milliseconds from page start to the
client's construction. If no sample was taken, nothing is sent. The frame hook
itself never sends. It does nothing in Node.

### Positions for Level heatmaps

`rs.trackAt(event, { x, y }, data?, { deviceId }?)` is `rs.track()` with a
position. It sends `x` and `y` as the reserved keys `rs_x` and `rs_y`, in your
game's own world units, one top-down plane per level, with y growing downward.
Put the level in `data` so the map knows which level the point belongs to.

```js
ravensight.trackAt('player_died', { x: player.x, y: player.y }, { level: 'cave_2', rs_kind: 'death' });
```

It is one ordinary event, sent and counted like any other: nothing extra is
sent. `rs_x` and `rs_y` win over the same keys in `data`. If either coordinate
is not a finite number (missing, `NaN`, `Infinity` or a string), the event is
still sent, without `rs_x` and `rs_y`, and with `debug: true` the SDK warns
once per event name. A bad position never throws; the event name and options
follow `track()`. It returns what `track()` returns.

Level heatmaps read `rs_x` and `rs_y` first, then plain `x` and `y`, so events
you already send with `x` and `y` keep working.

### `await rs.flush()`

Sends queued events now. Returns `{ sent, queued }`. Concurrent calls are safe.

### `await rs.submitFeedback(message, category?, rating?, options?)`

An accepted text submission uses one event on the shared meter. Each call generates
a stable submission ID that is reused if its session must be renewed. For an
explicit retry after an uncertain response, pass the same
`{ submissionId: 'your-stable-submission-id' }` as the fourth argument with the
same message, category and rating. IDs contain 8 to 80 letters, digits,
underscores or hyphens and are scoped to this game and device. Changed content
under the same ID is refused. A new ID represents a new submission. Older
clients that omit the ID remain supported as independent submissions.

Posts to `POST /feedback`. `category` is optional and must be one of the values
below, also exported as `FEEDBACK_CATEGORIES`. `rating` is optional and must be
an integer from 1 to 5. Leave either out with `undefined`, `null` or `''`. Bad
input is rejected before any request is made.

| Category | Use it for |
| --- | --- |
| `bug` | Something is broken. |
| `suggestion` | An idea or a change the player wants. |
| `complaint` | Something the player dislikes. |
| `praise` | Something the player enjoyed. |
| `playtest` | Notes from a playtest session. |
| `other` | Anything else. |

Throws a `RavensightError` with a `code`: `empty_message`, `invalid_category`,
`invalid_rating`, `tracking_disabled`, or the server's own error string.

### `await rs.fetchSuggestions()`

EXPERIMENTAL. Returns the AI generated design suggestions for your game as an
array. Empty until your game has enough data for a weekly digest. The shape of
each suggestion may change, so do not build game logic on it.

### `rs.setEnabled(bool)` and `rs.setTrackingEnabled(bool)`

Local opt in and opt out, for a privacy toggle in your settings menu. Disabling
clears anything still queued, so an opt out does not leave player data sitting
in memory. `setTrackingEnabled` is the same method under the LÖVE SDK's name.

With `consent: 'opt_in'`, `true` is the player's yes and is stored as
`ravensight_optin`; `false` removes it. With the default `'opt_out'` nothing
is stored. See [Public builds](#public-builds).

### `rs.isEnabled()`

`true` only while the client is collecting: it has a key and consent, and
nobody switched it off (`enabled: false`, the player, the server's kill
switch, a refused key or `dispose()`). Use it to skip work that only feeds
analytics.

### `rs.flushOnHidden(offset?)`

Sends one batch now by `fetch` keepalive or `sendBeacon`, for a page that is
going away, and returns `true` when a request was handed to the browser. The
SDK already does this on `visibilitychange` and `pagehide`; call it from your
own exit path (the LÖVE bridge does). It never resends the batch still in
flight: it uses the larger of `offset` and the SDK's own in-flight count.
Always `false` in Node.

### `await rs.setDeviceId(id)` and `await rs.resetDeviceId()`

Changes the device id after construction, for example once a player signs in
on a shared machine. `id` must be a non-empty string. It rejects with code
`disposed` after `dispose()`.

The switch is immediate: nothing is flushed or waited for. The new id is
stored under `ravensight_device_id`, and its session opens on the next flush.
Events already queued keep the id they were tracked under and go out under
that id's own session, which stays cached, so nothing is ever sent under the
wrong id. Resolves with `{ previousId, queuedUnderPreviousId }`, the old id
and how many of its events are still queued. Setting the current id again
changes nothing.

`resetDeviceId()` does the same with a fresh random id and resolves with it.
Use it for a "reset analytics id" button.

### Identify players who sign in

If your game has its own login, call `identify` once the player signs in and
`resetIdentity` when they sign out. One person on two devices, or before and
after signing in, then counts as one player.

```js
await rs.identify(account.id);   // after your own sign-in
await rs.resetIdentity();        // on sign-out
```

* **What is sent:** a salted hash of the id (`accountHash`, 64 hex
  characters, keyed with your game's own salt from the session answer) and
  the session token, once per session. The raw account id, an email or a
  name is never sent and never stored; until the first session answer the
  id is held in memory only.
* **Pass an opaque internal id**, such as a database key or a UUID. Any value
  containing `@` is refused, as are empty values and values over 256 bytes of
  UTF-8. A refusal rejects with a `TypeError` whose `code` is `not_text`,
  `empty`, `too_long` or `looks_like_email`, and changes nothing. A whole
  number is used as its decimal digits.
* **One event per identified session** on your usage balance. The same
  account again in the same session sends nothing; a refused or failed
  request is tried once more at the next session, never in a loop.
* **A different account** on the same device first does `resetIdentity()`.
  `resetIdentity()` forgets the stored hash and switches to a fresh device id
  (as `resetDeviceId()` does), so the next player is not linked to the last
  one. `resetDeviceId()` alone keeps the identity.
* The hash is stored beside the device id under `ravensight_identity`. It
  never enters the event queue and never delays an event. Without a key, or
  before the opt-in yes, it is held in memory only; `setEnabled(false)`
  deletes it. `rs.isIdentified` says whether an account is set.

### `rs.session(deviceId?)` and `rs.sessionTokenFor(deviceId?)`

`session()` resolves with `{ token, expiresAt }` once the device (default: the
client's own id) has an open session, opening one if needed. Concurrent calls
share one request. It rejects with an error whose `code` is the reason
`init()` would give: `invalid_key`, `tracking_disabled`, `offline`,
`rate_limited`, `session_failed`, `disabled` or `disposed`.
`sessionTokenFor()` returns the cached token or `null`, synchronously.

### `rs.joinSession(token, { deviceId }?)`

Joins a session opened elsewhere, normally the browser's `rs.sessionToken`,
so the next session for `deviceId` (default: the client's own id) shares its
analytics session. Any session already cached for that id is dropped. The
token is used once. Repeating the same token for the same id is a no-op that
resolves `{ joined: false, reason: 'already_joined' }`; otherwise it resolves
`{ joined: true, synthetic }` once the session opens, with `synthetic` `true`,
`false` or `null` (not said). `rs.isSynthetic(deviceId?)` reads it later. See
[Joining the browser's session](#joining-the-browsers-session).

### `await rs.dispose({ flush = true, timeoutMs = 2000 })`

Shuts the client down. The timer and page listeners stop at once and `track()`
returns `false` from that moment. By default the queue is then flushed, bounded
by `timeoutMs`. In a browser, whatever is still queued after that goes out in
one last best effort keepalive or beacon request. With the persisted queue on
(the default), anything left stays stored for the next launch and is counted
in `kept`; with `persistQueue: false` it is dropped and counted in
`rs.stats.dropped`. Resolves with `{ sent, dropped, kept }`. Events in a
request that timed out are counted as dropped even if it later lands, and are
never sent a second time. Like `flush()`, it sends even if `init()` was never
called.

Pass `{ flush: false }` to discard the queue without sending. The client cannot
be reused afterwards.

## Automatic events

In a browser the SDK sends two lifecycle events for you, so you do not track
them by hand:

* `game_started`, queued when you construct the client, under the current
  device id and with no data. It is only queued when the client is enabled at
  that moment. If the game starts with `enabled: false` and later calls
  `setEnabled(true)`, `game_started` is not sent retroactively.
* `game_exited`, queued on the first `pagehide` event and sent best effort
  through the page hide flush (keepalive). It needs a session, so `init()` must
  have opened one first, otherwise it stays queued. It is only queued when this
  client queued `game_started`, so a client that starts disabled sends neither
  automatic event. It is sent once, however many `pagehide` events fire, and
  `dispose()` removes the listener. A page restored from the back-forward cache
  sends no second `game_started`. A game that calls `dispose()` mid-page (for
  example a single-page app unmounting the game) should track `game_exited`
  itself first, because `dispose()` unbinds the page hide listener and sends no
  exit.

A game that sets its own device id should pass `deviceId` in the constructor
options so `game_started` carries it, rather than calling `setDeviceId`
afterwards.

Neither is ever sent from Node, where one client serves many players and there
is no single game to start or exit. Pass `autoEvents: false` to turn both off.
A game that already sends `game_started` itself should pass `autoEvents: false`
or remove its own call, otherwise every session counts twice. These are the
same two names the LÖVE SDK sends, so a dashboard covering both platforms
counts sessions the same way. Playtest sessions run in a browser, so they send
them too.

## Automatic error capture

A broken button should not wait for a player's screenshot. With a key and
consent, the SDK reports errors as ordinary `error` events (`rs_kind: 'error'`)
that the dashboard groups into issues.

### What is captured

| Source (`rs_source`) | What | Severity |
| --- | --- | --- |
| `uncaught` | An error nothing caught (the window `error` event). | `error` |
| `unhandled_rejection` | A promise rejection nothing handled. | `error` |
| `request` | A `fetch` or `XMLHttpRequest` that answered 5xx or never reached the server. | `error` |
| `request` | One that answered 4xx, and a script, image, style or media file that failed to load. | `warning` |
| `console` | A `console.error` call, at most 5 a session. | `warning` |
| `dead_click` | A click on a button followed by 2 seconds with no change to the page, no navigation, no request and no `track` call. | `warning` |

A failed request is sent as its method, host and path with ids replaced, never
a query string, header or body: `POST api.example.com/v1/kickoff/:id 500`. Path
segments that are numbers, hex of 8 or more characters or UUIDs become `:id`.
Only requests to your page's own site are captured (`game.example.com` and
`api.example.com` are one site), plus any host you list in
`captureRequestHosts`. Aborted requests, requests made while the browser is
offline and requests cut off by the page closing are not failures. A dead
click names the button by its accessible name (its `aria-label`, or its text),
cut to 60 characters. Disabled buttons and buttons that submitted a form are
ignored, and after one dead click is reported no other is watched for 30
seconds. Dead clicks are off on a page where a canvas covers more than half
the window, because a canvas UI changes in ways the watcher cannot see.

In Node the SDK listens to `uncaughtExceptionMonitor` only. It never handles
the error, so your process exits exactly as it would without the SDK, and it
adds no `unhandledRejection` listener (one would change how Node exits). A
rejection Node raises as uncaught is reported with `rs_source:
'unhandled_rejection'`. Requests and the console are not observed in Node.
Sending is best effort: the process usually exits before the request
finishes, so a server that must keep a crash should call `rs.trackError()`
and `await rs.flush()` in its own handler.

### How it behaves

* The hooks only observe. They run beside your own handlers, never stop an
  error, never change what your code sees, and never read a request or
  response body. `fetch` returns a promise that settles exactly as the
  original does, with the same response or the same error, and a rejection
  your code ignores is still reported as unhandled.
* The SDK's own requests and log lines are never captured.
* Hooks go in when the client is made, so errors during loading are caught.
  At most 5 are held in memory until the first answer from Ravensight, and a
  warning never pushes a real error out of them. If
  the game's error capture switch is on they are sent; if it is off they are
  discarded and the hooks come out. Nothing is installed without a key or
  before the player's yes under `consent: 'opt_in'`, and `setEnabled(false)`
  and `dispose()` remove everything.
* Each page session sends at most 30 errors, at most 3 of the same error and
  at most 6 a minute. The caps belong to the client, so in Node they cover
  the life of the process, not one player. Anything past that is dropped on the device. Read
  `rs.stats.errorsCaptured` and `rs.stats.errorsCapped`.
* When the queue is full, errors are dropped before your gameplay events.

### Privacy

Before anything is queued, the message, stack and trail are scrubbed on the
device: emails become `[email]`, bearer tokens, JWTs, `gt_` keys and long
token-like runs become `[token]`, IP addresses become `[ip]`, home folders
(`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`,
`C:\Documents and Settings\<name>`, the whole name, spaces included) become
`~`, and a URL
loses any `user:password@`, its query and its fragment. Long text is cut
before it is scrubbed, so a huge log line costs little. The server scrubs
again. Messages are cut to
200 characters and stacks to 2,000. Text you send yourself with
`trackError()` is sent as you wrote it and scrubbed by the server.

### The trail

When the game's trail switch is on in the dashboard (off by default), an
error carries the last 20 things that happened before it, as `rs_trail`:
your `track` calls by name, `console.warn` and `console.error` lines, and page
navigations, each with the milliseconds since the client started. It is kept
in memory only, sent only with an error, and on at most 10 errors a session.

### Turning it off

* For one build: `new Ravensight({ captureErrors: false })`.
* Dead clicks only: `captureDeadClicks: false`.
* For the whole game, without a new build: switch error capture off in the
  game's settings on the dashboard. The SDK reads it from Ravensight's answer.

### Cost

Each captured error is one event on your ordinary event meter, like any
`track` call. The trail adds nothing. The device caps above bound what one
player can send.

## Ads and attribution

```js
// A paid impression, in micros of the currency: 0.0015 USD is "1500".
rs.trackAdRevenue('admob', 'rewarded', 'level_end', '1500', 'USD');

// A mediation callback that reports a double in major units:
rs.trackAdRevenue('applovin', adFormatFrom(ad.format), ad.placement, microsFromRevenue(ad.revenue), 'USD');

// Clicks, rewards and failures carry no revenue.
rs.trackAd('admob', 'rewarded', 'rewarded', { placement: 'level_end' });

// Where this install came from, once per device.
rs.setAttribution({ source: 'store_referrer', network: 'google', campaign: 'spring' });
```

`trackAd(network, format, result, { placement, revenueMicros, currency })` sends
one `rs_ad` event. `format` is `banner`, `interstitial`, `rewarded`, `native`,
`app_open` or `other`; `result` is `shown`, `clicked`, `failed` or `rewarded`.
Revenue is a digit string of whole micros, sent only with `shown`, always with
a three letter currency, never converted. `microsFromDecimalString('0.0015')`
and `microsFromRevenue(0.0015)` both give `"1500"`, working on the decimal
digits and rounding half up past six decimals, so no float is ever multiplied.
The helpers return `false` and send nothing for a value the server would flag,
such as revenue without a currency.

`setAttribution({ source, network, campaign, adset, creative, touchTime })`
sends one `rs_attribution` event per device id: a flag stored beside the device
id (`ravensight_attribution_sent`) makes every later call return `false`, across
restarts. In a browser the SDK does this for you on the first load of a new
device id when the landing URL has a UTM parameter: `utm_source` becomes the
network, `utm_campaign` the campaign, `utm_term` the ad set and `utm_content`
the creative, with source `utm`. No other parameter is read. An attribution
partner's install callback names the device by `rs.deviceId`; pass it to the
partner as its customer user id before the partner starts.

### Campaign links

A Ravensight campaign link (`https://go.ravensight.io/...`) that points at a
web page adds `rs_link=<link id>` to the address it redirects to. When the SDK
runs on that page, it reads `rs_link` from `location.search` once, when the
client starts, and sends it as `campaignLink` with the first `POST /session`
it opens. Later sessions of the same page do not send it, nothing is stored,
and the page address is left exactly as it is. The server keeps it only when
it names a link of the same game, and then counts the player and the session
on the Campaign links page, by link. The id is one the studio created, not
personal data. It follows the same consent as everything else: with
`consent: 'opt_in'` it goes with the first session after the player's yes,
and an opted out player sends nothing. Nothing to call; it needs SDK 0.8.0 or
later.

## Public builds

For a game anyone can download, fork or play in a browser: a demo, a game
jam entry, an open source project, a web build. Nothing here changes a game
that passes a key and none of these options.

* **The key.** Use a public `gt_pub_...` key or your `gt_live_...` key.
  Inject it at build time, from an environment variable or your CI's
  secrets, into release builds only, and never commit it to the repository.
* **No key, no analytics.** With no `ingestKey`, or a blank one, the client
  is inert: no storage writes (not even the `localStorage` probe), no
  request, no timer, no listener and no automatic events. `isEnabled()` is
  `false`, `deviceId` is `null` and every call is a quiet no-op: `init()`
  resolves `{ trackingEnabled: false, sessionReady: false, reason: 'no_key' }`,
  `track()` returns `false`, and `session()`, `submitFeedback()` and
  `fetchSuggestions()` reject with code `no_key`. It prints one console
  warning; `optional: true` silences it. So a clone or a development build
  sends nothing.

  ```js
  // RAVENSIGHT_KEY is defined by your build step for release builds only.
  const rs = new Ravensight({
    ingestKey: typeof RAVENSIGHT_KEY === 'string' ? RAVENSIGHT_KEY : undefined,
    optional: true,
    distribution: 'web-itch',
  });
  await rs.init();
  ```

* **`consent: 'opt_in'`** sends nothing until the player says yes: no device
  id is made, nothing is stored, and not even the settings check is sent
  before `setEnabled(true)` (or its alias `setTrackingEnabled(true)`). The
  yes is stored as `ravensight_optin` in the same storage the device id uses
  (`localStorage`, or the `storage` you pass), so the next launch starts
  with it. An `init()` called before the yes resolves reason `no_consent`
  and runs by itself at the yes. Events tracked before the yes are dropped,
  not held for later; events tracked right after it are queued while the
  settings check runs. Saying no again (`setEnabled(false)`) removes the
  stored yes and keeps the device id; to forget it too, call
  `resetDeviceId()`. The default, `'opt_out'`, keeps the 0.4 behavior.
  Under a Ravensight Playtest no yes is needed and nothing is stored.

  ```js
  const rs = new Ravensight({ ingestKey: KEY, consent: 'opt_in' });
  await rs.init(); // sends nothing until the yes

  function onAnalyticsChoice(yes) {
    rs.setEnabled(yes); // the yes is stored and starts everything
  }
  ```

* **`distribution`** is a short label of your own, such as
  `'native-release'`, `'web-pages'` or `'web-itch'`, sent on `POST /session`
  so you can tell builds apart. At most 40 characters with no control
  characters; it is not sent when unset.
* **`rs_event_id`** is added to every event's data: the first 16 characters
  of the device id, the client's start time in hex, an 8 hex character value
  made once per client from a secure random source, and a counter, matching
  `^[A-Za-z0-9_-]{1,64}$`. A resend after a failure carries the same id, so
  the server can recognise it as the same event. Events sent under a joined
  session carry one too. There is no saved queue in this SDK, so this
  covers resends within one page's life.
* **A refused key ends the run.** A `401` or `403` answer to the settings
  check or to `POST /session` (other than the kill switch and a closed
  playtest job) means the key was revoked, rotated or is wrong, so the SDK
  stops for the rest of the run: queue cleared, nothing retried, one
  warning. The next launch tries the key again.
* **Jitter.** Retry waits are multiplied by a random factor between 0.5 and
  1, never past 5 minutes. A server's `Retry-After` is obeyed exactly.
* **Events whose data is over 8,192 bytes** as JSON are dropped by `track()`
  with one warning and never sent.

What a request carries, exactly: the settings check is a `GET` with no body;
the session sends `deviceId`, `gameVersion`, `platform` and, when set,
`joinToken` and `distribution`; a batch sends `events`, each with `event`,
`data` and `timestamp` (a beacon adds `sessionToken`); feedback sends
`message` and, when given, `category` and `rating`.

## Device id and privacy

The SDK generates a random device id on first run (`crypto.randomUUID`
where available) and stores it in `localStorage` under
`ravensight_device_id`. No hardware identifier, advertising id, IP based
fingerprint or personal data is collected by the SDK itself. Besides the
events you send, the SDK sends:

* **Device fields**, once per session on `POST /session`: `gpu`, the WebGL
  renderer name, in a browser where `WEBGL_debug_renderer_info` answers
  without a prompt; `osVersion`, the OS release, in Node. The device model is
  never probed on the web. Each value is at most 128 printable characters and
  none is a hardware identifier. Pass `device: { model, osVersion, gpu }` to
  send your own values instead. The server derives the country itself; the SDK
  never sends one.
* **Attribution**, once per install: the `utm_source`, `utm_campaign`,
  `utm_term` and `utm_content` values of the landing URL when any is present.
* **Campaign link**, once per page load, on the first `POST /session`: the
  `rs_link` value of the landing URL when it is a link id, and nothing else
  from the URL.

The persisted queue holds queued events and each session's opaque origin
stamp in the same storage; never the session's signing secret.

**Backups.** In a browser the queue lives in the page's `localStorage`, which
the SDK cannot keep out of any backup the browser or the player makes. In
Node the queue file is `~/.ravensight/queue-<hash>.json` in the home directory
of the user running the process (or `queueDir`); it is included in whatever
backs up that home directory. It holds origin stamps and scrubbed error
captures, never a trail or a secret; point `queueDir` at a folder your backups
skip if that matters for your deployment.

`rs.setEnabled(false)` stops all sending and discards anything still
queued, so an opt out does not leave player data sitting in memory.

With the default consent the opt-out is not stored by the SDK: keep the
player's choice in your own settings and call `rs.setEnabled(false)` before
the first event on every launch. With `consent: 'opt_in'` the SDK stores the
yes itself (see [Public builds](#public-builds)). To forget this install's analytics identity, call
`await rs.resetDeviceId()`, or remove `ravensight_device_id` from
`localStorage`. Later events go out under a fresh id and nothing links the old
one back.

A game that sends gameplay events and nothing else can declare Device ID and
Product Interaction as not linked to the player and not used for tracking,
and needs no tracking permission prompt. The row by row answers for the App
Store and Google Play forms are at https://ravensight.io/docs/#privacy-label.

## Telling players

Tell players what the game sends and give them a switch. A paragraph you can
show in your settings or first launch screen:

> This game sends anonymous gameplay events (what happens in the game, never
> who you are) to Ravensight so we can improve it. You can turn this off in
> Settings at any time.

With the default consent the SDK does not remember the player's choice, so
store it in your own settings and apply it on every launch (or use
`consent: 'opt_in'`, where the SDK stores the yes):

```js
const settings = JSON.parse(localStorage.getItem('my_game_settings') || '{}');

// Pass the stored choice at construction so nothing is queued while opted out.
const rs = new Ravensight({
  ingestKey: 'gt_live_your_publishable_key',
  enabled: settings.analytics !== false,
});

// Wire this to the checkbox in your Settings screen.
function onAnalyticsToggled(checked) {
  settings.analytics = checked;
  localStorage.setItem('my_game_settings', JSON.stringify(settings));
  rs.setEnabled(checked);
  if (!checked) rs.resetDeviceId(); // optional: also forget this install's id
}
```

## How this compares with the LÖVE SDK

| | JavaScript (this SDK) | LÖVE |
| --- | --- | --- |
| Automatic events | `game_started`, `game_exited` (browser only) | `game_started`, `game_exited` |
| `apiUrl` | with or without `/api/v1` | with or without `/api/v1` |
| `maxQueueSize` default | 500 | 500 |
| `enabled` option | yes | yes |
| Opt-out | `setEnabled` (alias `setTrackingEnabled`) | `setTrackingEnabled` |
| Running and collecting | `isEnabled()` | `enabled()` |
| No key | inert, reason `no_key` (0.5.0) | inert, reason `no_key` (0.3.0) |
| `optional` | yes | yes |
| `consent: 'opt_in'` | yes, yes stored as `ravensight_optin` in the storage the device id uses | yes, `ravensight_optin` in the save folder |
| `distribution` | yes | yes (desktop; on the web the page's SDK sends it) |
| Refused key | ends the run | ends the run |
| Retry jitter | a factor between 0.5 and 1 (0.7.0) | plus or minus 20 percent |
| `rs_event_id` | yes | yes |
| 8,192 byte event cap | dropped at `track()`, `stats.lastError` | dropped, `flush_failed` |
| Saved queue | yes, `localStorage` or a file, sent on the next launch (0.7.0) | yes, sent on the next launch |
| Batching | timer (`autoFlushMs`, 15 s) | 2 s |
| Web | native | bridge (`rs.flushOnHidden(inflight)` on exit) |

## How delivery works

* **Batching.** Up to 50 events per request, the server hard limit. A flush
  keeps sending batches until the queue drains.
* **Persisted queue.** On by default. In a browser the queue lives in one
  `localStorage` entry per ingest key (`ravensight_queue_<hash>`), written on
  every change and on `pagehide`; in Node it is one file per key,
  `~/.ravensight/queue-<hash>.json` (or `queueDir`), written through a
  temporary file and a rename so a partial write never replaces a good one.
  It is read back once at start, so events survive a reload, a crash, a closed
  tab or a lost network. At most 500 events are kept (the oldest go first) and
  anything older than 89 days is dropped at start and counted in
  `stats.expired`. `persistQueue: false` keeps the queue in memory only. Two
  tabs of the same game share one entry, so the last tab to write wins.
* **Original session, build and platform.** Each event remembers the session
  it was tracked under (the `origin` the server returned with that session).
  An event sent on a later launch carries that origin, so the server stores it
  under the run it happened in, not the one that sent it. The origin is opaque,
  is kept only with the queue and is never logged.
* **Timestamps.** Every event carries the unix milliseconds of the moment it
  was tracked, never the moment it was sent.
* **Removed only once delivered.** An event leaves the queue, and the removal
  is written to storage, only after a `2xx`, or a `400` that names it by
  `index`. Everything else keeps it.
* **Errors behind gameplay.** Gameplay events go ahead of queued automatic
  captures (never inside a batch awaiting an answer). In a full queue an
  incoming capture evicts the oldest capture, or is dropped, and never
  evicts gameplay. A capture is written to storage at once, without its
  `rs_trail`, which stays in memory only. `resetDeviceId()` and an opt-out
  delete persisted captures.
* **One device per batch.** Each request carries the leading run of queued
  events that share one device id, under that id's session.
* **Answers.** `400` with `index` drops that event and resends the rest;
  `400 batch_too_large` halves the batch, and a single event still too large is
  dropped; any other `400` drops the request's events. A `401` opens one new
  session and resends with the same ids; a second `401` in a row waits for the
  backoff. A `403` keeps the events and stops sending until the next launch.
  `413` splits the batch; `415` resends once uncompressed. `429`, and `503`
  with `Retry-After`, wait exactly the server's `Retry-After`. Anything else
  backs off.
* **Backoff.** From 10 seconds, doubling to a 5 minute ceiling, each wait
  multiplied by a random factor between 0.5 and 1 so devices that failed
  together do not retry together. `rs.flush()` cuts a backoff short; nothing
  cuts a `Retry-After` short.
* **Compression.** A request body of 1,024 bytes or more is sent gzip
  compressed (`Content-Encoding: gzip`). Page-hide sends are never compressed.
* **Signed requests.** When `POST /session` answers with `signing` (sessions
  opened with a public key), every batch is signed with that session's secret:
  `X-Ravensight-Timestamp` and `X-Ravensight-Signature: v1=<hex>`, an
  HMAC-SHA256 of `v1:<timestamp>:<body>` over the uncompressed body, with the
  device clock corrected by the server's time. The secret is kept in memory
  only. A beacon, which cannot set headers, carries the signed body envelope
  instead.
* **Invalid key.** A key refused by the settings check or `POST /session`
  ends the run: the queue is cleared and nothing is retried.
* **Oversize events.** An event whose data is over 8,192 bytes as the server
  measures it (JSON bytes, with a typed error's message and stack counted one
  byte a character) is dropped by `track()` and never sent.
* **Duplicates.** Every event carries an `rs_event_id`, kept across resends,
  so a resend whose first copy was stored is dropped by the server as a
  duplicate within its duplicate window (24 hours by default).

## Flush on page hide

In a browser the SDK listens for `visibilitychange` and sends one last batch when
the page goes hidden. It prefers `fetch` with `keepalive: true` rather than
`navigator.sendBeacon`, because `sendBeacon` cannot set request headers and the
batch endpoint authenticates with `X-Session-Token`. `sendBeacon` is used only
where keepalive is unavailable, and then the token travels inside the JSON body
as `sessionToken`, never in the URL, where proxies and logs could capture it.
On a signing session the beacon body is the signed envelope
`{ sessionToken, signed: { v, t, body, sig } }`.

A page that is going away cannot wait for an answer, so the events of that
last batch stay in the persisted queue marked unconfirmed. A keepalive answer
of `2xx` removes them. Otherwise the next launch resends them if it comes
within 23 hours, inside the server's 24 hour duplicate window, where a copy
that did arrive is dropped; past that they are presumed delivered.

## Ravensight Playtest

When a Ravensight Playtest run drives your web build, the runner leaves a
token in the page. The SDK reads it at construction from
`window.__RAVENSIGHT_PLAYTEST__`, then `localStorage` `ravensight.playtest`,
and sends it on `POST /session` as `X-Ravensight-Playtest`. You do not need
to do anything. It is never read from the URL, so a link cannot turn a
visitor into a playtest.

The server then marks the session as a playtest, so it never counts as a real
player, and decides its device id, so the SDK neither reads nor stores one.
When the playtest job has finished the server answers
`403 playtest_job_closed` and the client stops for good. `rs.isPlaytest` says
whether a token was found.

## What the dashboard does with your events

Some event names and fields have meaning on the dashboard, for example which
events count as a level start, a completion or a death, and which field names
the level. See [the JavaScript SDK section of the docs](https://ravensight.io/docs/#javascript-sdk)
before you name your events.

## Development

```bash
npm run build   # regenerate dist/index.cjs from src/index.js
npm test        # node --test, no dependencies
```

There is no bundler. `src/index.js` is the source of truth and
`scripts/build-cjs.mjs` strips its `export` keywords and appends a CommonJS
footer to produce `dist/index.cjs`.

## License

MIT. Copyright 2026 Reality Software Entertainment.

## Remote configuration and experiments

Held release: deploy the platform config endpoint before using these methods.
After opening a session, the SDK fetches config using your existing ingest key.
Config is public game data. Never store secrets in it.

```js
const rs = new Ravensight({
  ingestKey: 'YOUR_PUBLISHABLE_INGEST_KEY',
  onConfigReady: ({ source }) => console.log('Config ready:', source),
});
await rs.init();
const speed = rs.getConfig('movement_speed', 4.0);
const hints = rs.getConfig('show_hints', true);
await rs.fetchConfig(); // Explicit refresh, including the last ETag.
```

`getConfig(key, fallback, deviceId?)` never coerces types. Missing or mismatched
values return your fallback; arrays and objects return copies. `fetchConfig(deviceId?)`
resolves with `{ source: 'network' | 'cache' | 'default', values }` and shares
concurrent requests for the same context. Requests time out after five seconds.
Offline, rejected or malformed responses keep the last valid cache. Cache scope
includes endpoint, ingest key, device, platform and build. One persisted document
bounds browser storage; multi-player servers also have a bounded in-memory cache.
No config requests happen before opt-in consent or while tracking is disabled.
Playtest runs do not read or write the persistent cache.

A fetch alone is not an exposure. The first `getConfig` read in a session
exposes that player to every experiment the config answer lists: the SDK sends
one `rs_exposure` event, and every event queued after it in that session
carries `rs_exp_<key>: <variant>` for each, typed helpers included. Events
queued before the read stay untagged, a new session starts untagged until its
own first read, and an experiment missing from a later fetch (stopped) is no
longer tagged. Tags are added when an event is queued, so an event sent later
from the persisted queue keeps the variant it happened under. A well formed
`rs_exp_<key>` of your own is left alone; a malformed one is replaced. For
multi-player servers, call `await rs.fetchConfig(playerId)` and read with
`getConfig(key, fallback, playerId)` before tracking that player's experiment
events.
Changing devices or builds never borrows another context's assignments. An
unchanged ETag response is free; a fresh config response uses one ordinary event
from the shared event allowance. Keep safe defaults in the game.

### Player Reports with screenshots

The held release adds `createReport`, `submitReport`, `getReportStatus` and
`cancelReport`. Reports appear under **Player reports** in the dashboard for the
same game/environment. Open the report or its thumbnail to read the message and
see the screenshot. They are separate from AI Playtest screenshot artifacts.

```js
// Run only after the player chooses to attach a screenshot. Preview it and
// let the player hide private content in your game's UI before submission.
const screenshot = await rs.captureScreenshot(gameCanvas);
const report = await rs.createReport({
  message: 'The cave door stays locked after collecting all three keys.',
  category: 'bug',
  level: 'cave',
  context: { keys: 3 },
  screenshot, // omit for a text-only report
});
const receipt = await rs.submitReport(report);
// 'processing' means accepted for image validation, not yet in the inbox.
// Query later from your UI; do not poll in a tight loop.
const status = await rs.getReportStatus(report);
if (status.status === 'complete') console.log(status.reportId);
```

`captureScreenshot` captures only the supplied game canvas and returns a JPEG
Blob, scaled within 1600×1600 and at most 1 MB. It never requests desktop capture
or captures automatically. Tainted canvases cannot be captured. In Node, or when
your engine captures its own image, pass a Blob, Uint8Array or ArrayBuffer to
`createReport`. Input must be a still PNG, JPEG or WebP under 1,000,000 bytes;
the server also validates a maximum of 4,000,000 pixels and strips metadata.
Browser screenshot hashing requires a secure context (HTTPS or localhost).

Prepare the report **once** and keep that object on the same SDK instance for a
retry. Its content, client ID, capture time and screenshot bytes are fixed.
Concurrent sends share one request. Retries retain the original session token;
an expired session fails instead of silently creating a second paid report.
Do not reconstruct the report with a new ID after a timeout. After changing the
player identity the SDK refuses that prepared report. A `processing` result is
not a failure; use `getReportStatus`. To abandon an incomplete upload explicitly,
call `cancelReport`. Unfinished uploads expire after 15 minutes. The server allows
two upload authorizations per submission. There is no persistent offline report
queue or automatic retry/text fallback.

Text counts as one usage event; attaching an image adds 20,000 events, reserved
before upload. Failed/canceled image processing releases the reservation. These
are the existing Player Reports rates, not Playtest-run pricing. Capture and
preview alone make no network request and reserve no usage.

The server must enable Player Reports and billing v2, configure private report
storage and run the image-processing worker. Public ingest keys must explicitly
allow `allow_reports`. Studio credentials never belong in the game. See the
platform's held-release checklist before enabling this in production.
# Website analytics (0.10.0)

Create your company website from Company Home, or a title's separate site in
Game Website. Add the exact allowed origins (including www when used) and copy
that website's key. A title has one website across its gameplay environments;
its website key is separate from every gameplay ingest key. Website mode is
independent of the game client:

```js
import { createSiteTracker } from 'ravensight';
const site = createSiteTracker({
  key: 'gt_site_YOUR_WEBSITE_KEY',
  consent: 'opt_in',
  heatmaps: false,
  engagement: false,
});
// Run after the visitor agrees in your consent UI:
site.grantConsent();
site.track('wishlist_click');
```

Initial loads and SPA history/hash navigation record page views. Set
`autoPageviews: false` when your router calls `site.pageView()` after a completed
navigation. Custom events accept machine names. Registered actions can carry
their approved scalar dimensions, for example
`site.track('cta_dashboard_clicked', { section: 'hero' })`. Unknown property
names, free text, account details and form values are rejected. Sessions expire
after 30 minutes of inactivity. Website mode uses no cookies, honors Do Not
Track and Global Privacy Control, and stores only random browser/session IDs in
local storage (with memory fallback), plus first-seen time and sanitized campaign
snapshots. Query strings are removed except bounded
campaign parameters; referrers contain only their origin. Add
`data-ravensight-private` or `data-ravensight-ignore` to sensitive regions.
Forms, editable controls, element text, IDs, classes, and values are excluded
from heatmap capture. Optional heatmaps combine clicks and scroll depth into one
bounded summary, sent on navigation/hide or after five active minutes. At most
six summaries are emitted per page visit, and idle pages emit none.

The core analytics extension requires a compatible server with
`CORE_ANALYTICS_ENABLED=true`. `engagement: true` adds visible active time and
elapsed duration to bounded summaries, combined with heatmap data when enabled.
Each accepted combined summary is one event. Periodic summaries occur at most
once per five minutes; the six-summary limit reserves a final page summary.
Background time is excluded from active time, and an idle page stops accumulating
active time after 30 seconds. Collection is an estimate and does not record
screen contents, keystrokes, or a session replay. Engagement is off by default.

Authentication, OAuth, account and receipt routes are excluded. Add any additional
private route prefixes with `excludedPaths: ['/settings']`. All DNT variants and
GPC are honored. `getAttribution()` returns sanitized first/last landing and
campaign snapshots for an explicitly separate authenticated acquisition handoff;
it never exposes browser/account identity. Direct revisits do not overwrite the
last campaign. The static browser module is available at `dist/site.js`.

When a page loads, the tracker asks the collector for a short-lived page token
(`GET /site/collect/token`) and attaches it to that page's page views once it
has been held for the collector's minimum (one second). The token names the
website and the time only, nothing about the visitor. The collector bills a
page view only when it carries a token held long enough; a page view sent
sooner is counted as bot traffic and not billed. A failed token request never
blocks collection. Pass `pageToken: false` to turn this off.

`site.optOut()` clears queued events and identity; `site.reset()` starts a new
anonymous identity. Call `site.destroy()` when removing the tracker. Delivery
retries preserve event IDs and acknowledge partial batches. A funding pause
clears the queue and stops capture: it does not accumulate a later catch-up
bill. After a one-minute cooldown, fresh activity can try again without a page
reload; the SDK sends no heartbeat or old events to probe capacity. Calling
`site.resume()` explicitly starts collection sooner after capacity is restored.
Each accepted page view, custom event, or combined engagement/heatmap summary consumes one
event from the same account meter as gameplay and forms. The Website dashboard
shows the last accepted event so you can verify installation.

Heatmap collection requires `heatmaps: true`; it does not require an uploaded
image. The website report discovers recorded pages and screen sizes and draws
normalized click density with scroll-depth summaries. A reference image is
optional context, not a screenshot taken from a visitor. Enable `engagement: true`
when you also want active-time and engagement metrics. Navigation clicks are
recorded before application route handlers.

For an app with both public marketing and private gameplay, mount the website
tracker only on the intended public routes and destroy it before entering private
routes. Keep authenticated signup, purchase and gameplay outcomes in the existing
game client. A public signup click is an intent, not a completed signup.

With a scoped account MCP connection, discover the deployed tool schemas first.
Website setup uses `create_site`, `update_site` and `get_site_installation`;
`verify_site` checks received activity. `get_site_report` reads website reports,
including `heatmap_pages` to discover recorded page/screen pairs and `heatmaps`
for their click and scroll data. Website installation access requires write
permission in the selected company or project. MCP calls use the programmatic
meter separately from one-event website collection. See the current
[website documentation](https://ravensight.io/docs/websites/) and
[MCP documentation](https://ravensight.io/docs/mcp/) for deployed tools.

### Explicit signup and checkout outcomes

A compatible server can record a few explicitly named outcomes without recording
an authentication page. Use a separate tracker only when your integration needs
these counts, and retain the same consent policy. Destroy the normal public-page
tracker before entering private routes.

```js
const outcomes = createSiteTracker({
  key: 'gt_site_YOUR_WEBSITE_KEY',
  outcomesOnly: true,
  consent: 'opt_in',
});
// Only after your consent UI has established visitor permission:
outcomes.grantConsent();
outcomes.trackOutcome('signup_form_viewed');
// Map an application failure to an approved category; never pass a raw error.
outcomes.trackOutcome('signup_failed', { code: 'network' });
await outcomes.flush({ keepalive: true });
```

This mode installs no navigation, click, keyboard or scroll observers. It sends
only the website origin for validation, a fixed signup/checkout context, the
registered outcome fields and the website's anonymous session IDs. Collector
requests explicitly omit HTTP referrers and credentials. Reports store
no page address for these outcomes; no homepage view is invented. Lifecycle
listeners only flush queued outcomes on hide/exit. DNT, GPC, opt-out, funding
pauses and stable retry IDs apply. Do not copy authenticated identity into it.

Supported names are `signup_form_viewed`, `signup_failed` and `checkout_failed`.
Signup codes: `email_unconfirmed`, `invalid_input`, `email_in_use`, `rate_limited`,
`network`, `unavailable`, `unknown`. Checkout codes: `billing_disabled`,
`billing_misconfigured`, `already_subscribed`, `invalid_plan`, `rate_limited`,
`network`, `unavailable`, `unknown`; its optional `plan` is `monthly` or `annual`.
These are explicit funnel steps/failures, not proof of a completed account or
purchase. Successful authenticated outcomes remain in your gameplay integration.
Destroy this tracker before returning to ordinary public tracking.
