# ravensight

Official JavaScript SDK for [Ravensight](https://ravensight.io) player analytics.

Zero dependencies. Works in the browser and in Node 18 or newer. Ships both ESM
and CommonJS. Handles sessions, batching, the offline queue, rate limits and the
server side kill switch for you.

* API base: `https://api.ravensight.io/api/v1`
* Docs: https://ravensight.io/docs/
* Privacy: a random per-install device id, no advertising identifier, a local opt-out (`rs.setEnabled(false)`), no tracking permission prompt needed. What your store label can say: https://ravensight.io/docs/#privacy-label

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

rs.track('game_started');
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
// Browser: send the token to your server with your own request.
await fetch('/api/link-analytics', {
  method: 'POST',
  body: JSON.stringify({ rsToken: rs.sessionToken }),
});

// Server: one call per player, before that player's next event.
rs.joinSession(body.rsToken, { deviceId: player.id });
rs.track('purchase_verified', { sku: 'gold_pack' }, { deviceId: player.id });
```

The next session opened for that id carries the token once, and the server
copies the browser's device id. The local id is only the key the SDK caches
the session under. If the server refuses the token, the SDK opens a plain
session instead and records `invalid_join_token` in `stats.lastError`.

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
| `ingestKey` | required | Your publishable `gt_live_...` key. Safe to ship in a client build. |
| `apiUrl` | `https://api.ravensight.io/api/v1` | Base URL. `/api/v1` is appended if you leave it off. |
| `gameVersion` | `'1.0.0'` | Reported with the session. |
| `platform` | auto | `'web'` in a browser, `node-<platform>` in Node. |
| `autoFlushMs` | `15000` | Flush interval. Set `0` to flush only on demand. |
| `maxQueueSize` | `500` | Offline queue cap. Oldest events are dropped first. |
| `maxSessions` | `64` | Sessions cached at once, one per device id. The least recently used is dropped first, never the current id. |
| `storage` | auto | Anything with `getItem` and `setItem`. Used for the device id. |
| `deviceId` | auto | Override the generated device id entirely. |
| `enabled` | `true` | Start opted out by passing `false`. |
| `fetch` | global | Inject a custom fetch. |
| `debug` | `false` | Log SDK activity to the console, and warn about reserved `rs_` keys. |

### `await rs.init()`

Reads `GET /settings` for the kill switch, then opens a session with
`POST /session`. Returns `{ trackingEnabled, sessionReady, reason }`. It never
throws on a network failure: if the settings call fails the SDK assumes
tracking is on, and if the session call fails events keep queueing until a
retry succeeds.

`reason` is `null` when the session is ready, otherwise one of:

| Reason | Meaning |
| --- | --- |
| `invalid_key` | The key was refused (`401`, or a `403` other than the kill switch). The flush timer stops; see below. |
| `tracking_disabled` | Tracking is switched off for this game. Nothing is sent. |
| `offline` | No answer from the network. Retried with backoff. |
| `rate_limited` | `429`. Retried after `Retry-After`. |
| `session_failed` | Any other answer. Retried with backoff. |

With `invalid_key` the SDK stops its flush timer and the automatic flush at
50 queued events, because retrying on a timer cannot fix a wrong key.
`track()` keeps queueing up to `maxQueueSize`. `flush()` and `init()` still
try again, and the first session that opens restarts the timer. With
`debug: true` it warns once.

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
off. Timestamps are recorded as unix seconds at the moment of the call, so a
delayed flush still reports when the thing actually happened.

`deviceId` sends this one event as another device, under that id's own
session. It must be a non-empty string or `track()` throws a `TypeError`.
Leave it out to use the client's own id. See
[Node servers with many players](#node-servers-with-many-players).

Property keys starting with `rs_` are reserved for Ravensight. `rs_kind` says
what an event means for the level funnel and must be one of `RS_KINDS`:
`level_start`, `level_complete`, `death` or `none`. With `debug: true`, the SDK
warns once per event and key about an `rs_kind` outside that list or an `rs_`
key Ravensight does not read. It never throws and still queues the event.

### `await rs.flush()`

Sends queued events now. Returns `{ sent, queued }`. Concurrent calls are safe.

### `await rs.submitFeedback(message, category?, rating?)`

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

### `rs.setEnabled(bool)`

Local opt in and opt out, for a privacy toggle in your settings menu. Disabling
clears anything still queued, so an opt out does not leave player data sitting
in memory.

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

### `rs.joinSession(token, { deviceId }?)`

Joins a session opened elsewhere, normally the browser's `rs.sessionToken`,
so the next session for `deviceId` (default: the client's own id) shares its
analytics session. Any session already cached for that id is dropped. The
token is used once. See
[Joining the browser's session](#joining-the-browsers-session).

### `await rs.dispose({ flush = true, timeoutMs = 2000 })`

Shuts the client down. The timer and page listeners stop at once and `track()`
returns `false` from that moment. By default the queue is then flushed, bounded
by `timeoutMs`. In a browser, whatever is still queued after that goes out in
one last best effort keepalive or beacon request. Anything left is dropped and
counted in `rs.stats.dropped`. Resolves with `{ sent, dropped }`. Events in a
request that timed out are counted as dropped even if it later lands, and are
never sent a second time. Like `flush()`, it sends even if `init()` was never
called.

Pass `{ flush: false }` to discard the queue without sending. The client cannot
be reused afterwards.

## Device id and privacy

The SDK generates a random device id on first run (`crypto.randomUUID`
where available) and stores it in `localStorage` under
`ravensight_device_id`. No hardware identifier, advertising id, IP based
fingerprint or personal data is collected by the SDK itself. Only the
events you choose to send leave the browser.

`rs.setEnabled(false)` stops all sending and discards anything still
queued, so an opt out does not leave player data sitting in memory.

The opt-out is not stored by the SDK: keep the player's choice in your own
settings and call `rs.setEnabled(false)` before the first event on every
launch. To forget this install's analytics identity, call
`await rs.resetDeviceId()`, or remove `ravensight_device_id` from
`localStorage`. Later events go out under a fresh id and nothing links the old
one back.

A game that sends gameplay events and nothing else can declare Device ID and
Product Interaction as not linked to the player and not used for tracking,
and needs no tracking permission prompt. The row by row answers for the App
Store and Google Play forms are at https://ravensight.io/docs/#privacy-label.

## How delivery works

* **Batching.** Up to 50 events per request, the server hard limit. A flush
  keeps sending batches until the queue drains.
* **Offline queue.** Events accumulate up to `maxQueueSize` (default 500). Past
  that the oldest are dropped so the newest are always kept.
* **Never dropped on failure.** Events are only removed from the queue after the
  server answers `202`.
* **One device per batch.** Each request carries the leading run of queued
  events that share one device id, under that id's session.
* **Session expiry.** A `401` clears that device's session only, opens a new
  one and re sends the same batch.
* **Invalid key.** A refused key stops the flush timer instead of retrying
  forever. Events keep queueing; `flush()` or `init()` try again.
* **Rate limits.** A `429` honors `Retry-After` in seconds. With no such header
  the SDK backs off exponentially from 10 seconds up to a 5 minute ceiling. The
  queue is held, never discarded.
* **Oversize batches.** A `400` halves the batch and retries, down to a single
  event. An event that is still rejected on its own is dropped so it cannot
  block everything behind it.
* **No re-send while in flight.** The page-hide flush never sends a batch that
  is still in flight, so a batch aborted by a real unload can be lost rather
  than duplicated. A batch whose response is lost, from a network error or a
  `5xx` after the server already stored it, stays queued and can be sent again
  on the next flush; ingest does not remove duplicates.

## Flush on page hide

In a browser the SDK listens for `visibilitychange` and sends one last batch when
the page goes hidden. It prefers `fetch` with `keepalive: true` rather than
`navigator.sendBeacon`, because `sendBeacon` cannot set request headers and the
batch endpoint authenticates with `X-Session-Token`. `sendBeacon` is used only
where keepalive is unavailable, and then the token travels inside the JSON body
as `sessionToken`, never in the URL, where proxies and logs could capture it.

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
