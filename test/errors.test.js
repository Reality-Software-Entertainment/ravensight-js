// Automatic error capture: page hooks, the request observer, console, the
// trail, dead clicks, caps, the scrub, consent and the 413 split. The page is
// a small fake DOM, the same approach as the other browser tests here.
import test from 'node:test';
import assert from 'node:assert/strict';

import Ravensight, { MemoryStorage, ERROR_CAPS, scrubText } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startMockServer, fakeClock } from './helpers/mock-server.js';

const SCRUB_VECTORS = JSON.parse(readFileSync(new URL('./fixtures/scrub-vectors.json', import.meta.url), 'utf8'));

const INGEST_KEY = 'gt_live_test_key';
const REAL_FETCH = globalThis.fetch;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sets globals for the length of a test, restoring them after. */
function setGlobals(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  };
}

function eventTarget(name, listeners) {
  return {
    addEventListener(type, fn) {
      const key = name + ':' + type;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn) {
      const key = name + ':' + type;
      if (listeners.has(key)) listeners.get(key).delete(fn);
    },
  };
}

/** A fake element. `closest` walks `parent`, matching button-like tags. */
function element(tagName, props = {}) {
  const attrs = props.attrs || {};
  const el = {
    tagName: tagName.toUpperCase(),
    textContent: props.text || '',
    disabled: Boolean(props.disabled),
    form: props.form || null,
    parent: props.parent || null,
    value: props.value,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    matches: () => false,
    closest(selector) {
      if (selector === 'form') return this.form;
      for (let node = this; node; node = node.parent) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'button' || node.getAttribute('role') === 'button') return node;
      }
      return null;
    },
  };
  return el;
}

/**
 * A fake page: window, document, location, navigator, MutationObserver,
 * XMLHttpRequest, a game fetch with programmable answers, and silent console
 * spies. Clients registered with `dom.own(rs)` are disposed before the
 * globals are restored.
 */
function withDom(t, { href = 'https://game.example.com/play/index.html' } = {}) {
  const listeners = new Map();
  const win = eventTarget('window', listeners);
  const doc = Object.assign(eventTarget('document', listeners), {
    visibilityState: 'visible',
    documentElement: {},
    getElementById: () => null,
  });
  const url = new URL(href);
  const loc = { href, hostname: url.hostname, pathname: url.pathname, host: url.host };
  const nav = { onLine: true, userAgent: 'test' };

  const observers = new Set();
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
  }

  const xhrs = [];
  class FakeXhr {
    constructor() {
      this.listeners = {};
      this.status = 0;
    }
    open(method, target) {
      this.method = method;
      this.url = target;
    }
    send() {
      xhrs.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] || []) fn({ type });
    }
    finish(status) {
      this.status = status;
      this.fire(status === 0 ? 'error' : 'load');
      this.fire('loadend');
    }
    abort() {
      this.status = 0;
      this.fire('abort');
      this.fire('loadend');
    }
  }
  const originalXhrOpen = FakeXhr.prototype.open;

  const routes = new Map();
  const fetchCalls = [];
  const gameFetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    fetchCalls.push({ url: target, init });
    const answer = routes.has(target) ? routes.get(target) : 200;
    if (answer === 'network') throw new TypeError('Failed to fetch');
    if (answer === 'abort') {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    if (answer === 'opaque') return { status: 0, type: 'opaque' };
    return { status: answer, type: 'basic' };
  };

  const consoleCalls = { error: [], warn: [] };
  const savedConsole = { error: console.error, warn: console.warn };
  // Node may print its own process warning here the first time a global is
  // touched; the tests count only the game's calls.
  const fromNode = (args) => typeof args[0] === 'string' && args[0].startsWith('(node:');
  console.error = (...args) => (fromNode(args) ? 0 : consoleCalls.error.push(args));
  console.warn = (...args) => (fromNode(args) ? 0 : consoleCalls.warn.push(args));
  const errorSpy = console.error;
  const warnSpy = console.warn;

  const restore = setGlobals(t, {
    window: win,
    document: doc,
    location: loc,
    navigator: nav,
    MutationObserver: FakeMutationObserver,
    XMLHttpRequest: FakeXhr,
    fetch: gameFetch,
  });
  const owned = [];
  t.after(async () => {
    for (const rs of owned) await rs.dispose({ flush: false }).catch(() => {});
    restore();
    console.error = savedConsole.error;
    console.warn = savedConsole.warn;
  });

  return {
    win,
    doc,
    loc,
    nav,
    xhrs,
    routes,
    fetchCalls,
    gameFetch,
    consoleCalls,
    errorSpy,
    warnSpy,
    FakeXhr,
    originalXhrOpen,
    own(rs) {
      owned.push(rs);
      return rs;
    },
    count: (name, type) => (listeners.get(name + ':' + type) ? listeners.get(name + ':' + type).size : 0),
    totalListeners: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    /** Listeners other than the SDK's own page-hide flush. */
    captureListeners: () =>
      [...listeners.entries()]
        .filter(([key]) => key !== 'document:visibilitychange')
        .reduce((n, [, set]) => n + set.size, 0),
    fire(name, type, extra) {
      const event = Object.assign({ type, isTrusted: true, defaultPrevented: false }, extra);
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
      for (const fn of [...(listeners.get(name + ':' + type) || [])]) fn(event);
      return event;
    },
    mutate() {
      for (const observer of [...observers]) observer.callback([{ type: 'childList' }]);
    },
    observerCount: () => observers.size,
  };
}

function makeClient(server, overrides = {}) {
  return new Ravensight(
    Object.assign(
      {
        ingestKey: INGEST_KEY,
        apiUrl: server.url,
        gameVersion: '1.2.3',
        platform: 'test',
        autoFlushMs: 0,
        autoEvents: false,
        storage: new MemoryStorage(),
        random: () => 0.5,
        // The SDK talks to the mock API over the real network.
        fetch: REAL_FETCH,
        _deadClickMs: 30,
      },
      overrides,
    ),
  );
}

async function startCapturing(t, dom, serverConfig = {}, overrides = {}) {
  const server = await startMockServer(serverConfig);
  t.after(() => server.close());
  const rs = dom.own(makeClient(server, overrides));
  await rs.init();
  return { server, rs };
}

const errors = (rs) => rs.queue.filter((item) => item.event === 'error').map((item) => item.data);

// --- Off until allowed -----------------------------------------------------

test('without a key nothing is installed and nothing goes on the network', async (t) => {
  const dom = withDom(t);
  const spy = [];
  const rs = dom.own(new Ravensight({ optional: true, apiUrl: 'http://127.0.0.1:9/api/v1', fetch: async (...a) => spy.push(a) }));
  await rs.init();
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.totalListeners(), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
  assert.equal(console.error, dom.errorSpy);
  assert.equal(dom.FakeXhr.prototype.open, dom.originalXhrOpen);
  assert.equal(spy.length, 0);
});

test('before the opt-in yes nothing is installed and no request is made', async (t) => {
  const dom = withDom(t);
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = dom.own(makeClient(server, { consent: 'opt_in' }));
  await rs.init();
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.totalListeners(), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
  assert.equal(server.state.requests.length, 0);
  dom.fire('window', 'error', { error: new TypeError('boom'), message: 'boom' });
  assert.equal(server.state.requests.length, 0);
});

test('boot errors: hooks install at construction and hold at most 5 captures until the answer', async (t) => {
  const dom = withDom(t);
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = dom.own(makeClient(server));
  assert.equal(rs.capturingErrors, true, 'installed before any answer, to catch boot errors');
  assert.equal(server.state.requests.length, 0, 'installing makes no request');
  for (let i = 0; i < 8; i++) {
    dom.fire('window', 'error', { target: dom.win, error: new Error('boot ' + 'abcdefgh'[i]) });
  }
  assert.equal(errors(rs).length, 0, 'held in memory, not queued');
  assert.equal(rs._bootErrors.length, 5);
  await rs.init();
  assert.deepEqual(errors(rs).map((d) => d.rs_message), ['boot a', 'boot b', 'boot c', 'boot d', 'boot e']);
  assert.equal(rs._bootErrors.length, 0);
});

test('boot errors are discarded unsent when the answer says capture is off', async (t) => {
  const dom = withDom(t);
  const server = await startMockServer({ errorCapture: { enabled: false, trail: false } });
  t.after(() => server.close());
  const rs = dom.own(makeClient(server));
  dom.fire('window', 'error', { target: dom.win, error: new Error('boot') });
  await rs.init();
  await rs.flush();
  assert.equal(rs.capturingErrors, false);
  assert.equal(errors(rs).length, 0);
  assert.equal(server.state.events.length, 0);
});

test('captureErrors: false is a full opt out', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, {}, { captureErrors: false });
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.count('window', 'error'), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
});

test("the game's errorCapture.enabled false keeps every hook out", async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: false, trail: false } });
  assert.deepEqual(rs.errorCapture, { enabled: false, trail: false });
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.captureListeners(), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
});

test('an absent errorCapture means enabled, the default', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  assert.deepEqual(rs.errorCapture, { enabled: true, trail: false });
  assert.equal(rs.capturingErrors, true);
  assert.equal(dom.count('window', 'error'), 1);
  assert.equal(dom.count('window', 'unhandledrejection'), 1);
  assert.equal(dom.count('document', 'click'), 1);
  assert.notEqual(globalThis.fetch, dom.gameFetch);
});

test('a later session answer with enabled false removes the hooks', async (t) => {
  const dom = withDom(t);
  const { rs, server } = await startCapturing(t, dom);
  assert.equal(rs.capturingErrors, true);
  server.state.errorCapture = { enabled: false, trail: false };
  await rs.setDeviceId('another-player');
  await rs.session();
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.captureListeners(), 0);
});

test('consent withdrawal and dispose remove every hook and restore every wrapper', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  assert.equal(rs.capturingErrors, true);
  rs.setEnabled(false);
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.captureListeners(), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
  assert.equal(console.error, dom.errorSpy);
  assert.equal(console.warn, dom.warnSpy);
  assert.equal(dom.FakeXhr.prototype.open, dom.originalXhrOpen);

  rs.setEnabled(true);
  assert.equal(rs.capturingErrors, true);
  await rs.dispose({ flush: false });
  assert.equal(rs.capturingErrors, false);
  assert.equal(dom.captureListeners(), 0);
  assert.equal(globalThis.fetch, dom.gameFetch);
});

test('a wrapper someone installed on top of ours is left in place on uninstall', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const ours = globalThis.fetch;
  const theirs = (...args) => ours(...args);
  globalThis.fetch = theirs;
  await rs.dispose({ flush: false });
  assert.equal(globalThis.fetch, theirs, 'their wrapper stays');
  dom.routes.set('https://game.example.com/api/x', 500);
  await globalThis.fetch('https://game.example.com/api/x');
  assert.equal(errors(rs).length, 0, 'ours now only passes through');
});

// --- Uncaught errors and rejections ------------------------------------------

test('an uncaught error becomes an error event, scrubbed, and the event is not touched', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const err = new TypeError('Cannot read properties of undefined (reading kickoff) for bob@example.com');
  err.stack = 'TypeError: x\n    at kickOff (https://game.example.com/assets/main.js?v=3:10:5)\n    at /Users/bob/game/x.js:1:1';
  let gameSaw = null;
  dom.win.addEventListener('error', (event) => {
    gameSaw = event;
  });
  const event = dom.fire('window', 'error', { target: dom.win, error: err, message: err.message });
  assert.equal(gameSaw, event, "the game's own listener still runs");
  assert.equal(event.defaultPrevented, false);
  const [data] = errors(rs);
  assert.equal(data.rs_kind, 'error');
  assert.equal(data.rs_source, 'uncaught');
  assert.equal(data.rs_severity, 'error');
  assert.equal(data.rs_error_type, 'TypeError');
  assert.match(data.rs_message, /\[email\]/);
  assert.doesNotMatch(data.rs_stack, /v=3|\/Users\/bob/);
  assert.match(data.rs_stack, /main\.js/);
  assert.equal(rs.stats.errorsCaptured, 1);
});

test('a cross-origin Script error without an error object is still captured with its file', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.fire('window', 'error', { target: dom.win, message: 'Script error.', filename: 'https://cdn.example.net/a.js', lineno: 1, colno: 2 });
  const [data] = errors(rs);
  assert.equal(data.rs_message, 'Script error.');
  assert.equal(data.rs_stack, 'at https://cdn.example.net/a.js:1:2');
  assert.equal(data.rs_error_type, undefined);
});

test('an unhandled rejection is captured with its reason', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.fire('window', 'unhandledrejection', { reason: new RangeError('bad level 12') });
  dom.fire('window', 'unhandledrejection', { reason: { code: 7 } });
  const [first, second] = errors(rs);
  assert.equal(first.rs_source, 'unhandled_rejection');
  assert.equal(first.rs_error_type, 'RangeError');
  assert.equal(first.rs_message, 'bad level 12');
  assert.equal(second.rs_message, '{"code":7}');
  assert.equal(second.rs_error_type, 'Object');
});

test('a resource that fails to load is a warning with its element and templated URL', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const img = element('img');
  img.src = 'https://game.example.com/sprites/12345/hero.png?token=abc';
  dom.fire('window', 'error', { target: img });
  const script = element('script');
  script.src = 'https://ads.other-site.com/tag.js';
  dom.fire('window', 'error', { target: script });
  const all = errors(rs);
  assert.equal(all.length, 1, 'a cross-site resource is not captured');
  assert.equal(all[0].rs_source, 'request');
  assert.equal(all[0].rs_severity, 'warning');
  assert.equal(all[0].rs_message, 'img game.example.com/sprites/:id/hero.png failed');
});

// --- Requests --------------------------------------------------------------

test('a failed fetch is captured per the contract, and the game gets the original promise', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const kickoff = 'https://api.example.com/v1/kickoff/42?team=7#x';
  dom.routes.set(kickoff, 500);
  const wrapped = globalThis.fetch;
  const res = await wrapped(kickoff, { method: 'post', body: 'secret body' });
  assert.equal(res.status, 500, 'the game sees the real answer');
  await tick();
  assert.equal(dom.fetchCalls[0].init.body, 'secret body', 'the body is passed through untouched');
  // api.example.com shares a site with game.example.com.
  const [data] = errors(rs);
  assert.equal(data.rs_message, 'POST api.example.com/v1/kickoff/:id 500');
  assert.equal(data.rs_severity, 'error');
  assert.equal(data.rs_source, 'request');
});

test('4xx is a warning, a network failure is an error, and the rejection reaches the game', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  dom.routes.set('https://game.example.com/api/save/' + uuid, 404);
  dom.routes.set('https://game.example.com/api/score/deadbeef1234', 'network');
  await fetch('https://game.example.com/api/save/' + uuid);
  await assert.rejects(fetch('https://game.example.com/api/score/deadbeef1234'), /Failed to fetch/);
  await tick();
  const [notFound, down] = errors(rs);
  assert.equal(notFound.rs_message, 'GET game.example.com/api/save/:id 404');
  assert.equal(notFound.rs_severity, 'warning');
  assert.equal(down.rs_message, 'GET game.example.com/api/score/:id network');
  assert.equal(down.rs_severity, 'error');
});

test('a relative URL and a Request object are read without touching the body', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.routes.set('/api/match/9', 502);
  const request = {
    url: '/api/match/9',
    method: 'PUT',
    get body() {
      throw new Error('the body must never be read');
    },
  };
  await fetch(request);
  await tick();
  assert.equal(errors(rs)[0].rs_message, 'PUT game.example.com/api/match/:id 502');
});

test('success, aborts, opaque answers, offline and after pagehide are not captured', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.routes.set('https://game.example.com/ok', 204);
  dom.routes.set('https://game.example.com/aborted', 'abort');
  dom.routes.set('https://game.example.com/opaque', 'opaque');
  dom.routes.set('https://game.example.com/down', 'network');
  await fetch('https://game.example.com/ok');
  await fetch('https://game.example.com/aborted').catch(() => {});
  const controller = new AbortController();
  controller.abort();
  dom.routes.set('https://game.example.com/signal', 500);
  await fetch('https://game.example.com/signal', { signal: controller.signal });
  await fetch('https://game.example.com/opaque');
  dom.nav.onLine = false;
  await fetch('https://game.example.com/down').catch(() => {});
  dom.nav.onLine = true;
  dom.fire('window', 'pagehide', {});
  await fetch('https://game.example.com/down').catch(() => {});
  await tick();
  assert.equal(errors(rs).length, 0);
  dom.fire('window', 'pageshow', {});
  await fetch('https://game.example.com/down').catch(() => {});
  await tick();
  assert.equal(errors(rs).length, 1, 'captured again once the page is shown');
});

test('cross-site hosts are skipped unless listed in captureRequestHosts', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, {}, { captureRequestHosts: ['backend.partner.io', '*.cdn.net'] });
  dom.routes.set('https://tracker.elsewhere.com/x', 500);
  dom.routes.set('https://backend.partner.io/match', 500);
  dom.routes.set('https://eu.cdn.net/pack', 503);
  await fetch('https://tracker.elsewhere.com/x');
  await fetch('https://backend.partner.io/match');
  await fetch('https://eu.cdn.net/pack');
  await tick();
  assert.deepEqual(errors(rs).map((d) => d.rs_message), [
    'GET backend.partner.io/match 500',
    'GET eu.cdn.net/pack 503',
  ]);
});

test('XMLHttpRequest failures are observed; aborts are not', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const a = new XMLHttpRequest();
  a.open('post', 'https://game.example.com/api/kickoff/7');
  a.send('body');
  a.finish(503);
  const b = new XMLHttpRequest();
  b.open('GET', '/api/state');
  b.send();
  b.abort();
  const c = new XMLHttpRequest();
  c.open('GET', '/api/state');
  c.send();
  c.finish(0);
  const d = new XMLHttpRequest();
  d.open('GET', '/api/ok');
  d.send();
  d.finish(200);
  assert.deepEqual(errors(rs).map((x) => [x.rs_message, x.rs_severity]), [
    ['POST game.example.com/api/kickoff/:id 503', 'error'],
    ['GET game.example.com/api/state network', 'error'],
  ]);
});

// --- No feedback loop --------------------------------------------------------

test("the SDK's own failing requests are never captured, wrapped fetch or not", async (t) => {
  const dom = withDom(t);
  // The game page's fetch is the real one, so the SDK's calls go through it.
  globalThis.fetch = REAL_FETCH;
  const server = await startMockServer({ batchStatus: 503 });
  t.after(() => server.close());
  const first = dom.own(makeClient(server, { fetch: undefined }));
  await first.init();
  assert.notEqual(globalThis.fetch, REAL_FETCH, 'fetch is wrapped now');
  // A client made after the wrap resolves the native fetch underneath it.
  const second = dom.own(makeClient(server, { fetch: undefined }));
  await second.init();
  first.track('a');
  await first.flush();
  // The page itself calling the API base is also the SDK's host: skipped.
  await globalThis.fetch(server.url + '/track/batch', { method: 'POST', body: '{}' });
  await tick();
  assert.equal(server.requestsTo('/api/v1/track/batch').length >= 2, true);
  assert.equal(errors(first).length, 0);
  assert.equal(errors(second).length, 0);
  assert.equal(first.stats.errorsCaptured + second.stats.errorsCaptured, 0);
});

test("the SDK's own console lines and Node's process warnings are not captured or trailed", async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: true, trail: true } });
  console.warn('[ravensight] something about the SDK');
  console.error('[ravensight] also the SDK');
  console.error('(node:4242) ExperimentalWarning: localStorage is not available');
  console.error('(node:4242) [DEP0040] DeprecationWarning: The punycode module is deprecated.');
  console.warn('DeprecationWarning: Buffer() is deprecated');
  assert.equal(rs._trail.length, 0);
  assert.equal(errors(rs).length, 0);
});

test('observing a fetch never marks its rejection handled', () => {
  // In a child process: node:test reports an unhandled rejection as a failure.
  const script = `
    const { default: Ravensight, MemoryStorage } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
    const target = { addEventListener() {}, removeEventListener() {} };
    Object.assign(globalThis, { window: target, document: { ...target }, location: { href: 'https://game.example.com/', hostname: 'game.example.com' } });
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'test' }, configurable: true });
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const rs = new Ravensight({ ingestKey: 'gt_live_x', apiUrl: 'http://127.0.0.1:9/api/v1', autoEvents: false, storage: new MemoryStorage(), fetch: async () => ({ status: 0 }) });
    if (!rs.capturingErrors) throw new Error('hooks not installed');
    const seen = [];
    process.on('unhandledRejection', (reason) => seen.push(String(reason)));
    await fetch('https://game.example.com/handled').catch(() => {});
    fetch('https://game.example.com/ignored');
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log(JSON.stringify(seen));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), ['TypeError: Failed to fetch']);
});

test('relative URLs resolve against document.baseURI', async (t) => {
  const dom = withDom(t);
  dom.doc.baseURI = 'https://game.example.com/build/v2/';
  const { rs } = await startCapturing(t, dom);
  dom.routes.set('api/kickoff/5', 500);
  await fetch('api/kickoff/5');
  await tick();
  assert.equal(errors(rs)[0].rs_message, 'GET game.example.com/build/v2/api/kickoff/:id 500');
});

// --- console.error -----------------------------------------------------------

test('console arguments are not stringified when no trail or capture will use them', async (t) => {
  const dom = withDom(t);
  const clock = fakeClock();
  await startCapturing(t, dom, { errorCapture: { enabled: true, trail: false } }, { now: clock });
  let reads = 0;
  const noisy = { toJSON: () => (reads += 1) };
  console.warn('warn', noisy);
  assert.equal(reads, 0, 'a warning with the trail off is never read');
  for (let i = 0; i < ERROR_CAPS.console; i++) {
    clock.advance(60000);
    console.error('line ' + 'abcdef'[i]);
  }
  console.error('past the cap', noisy);
  assert.equal(reads, 0, 'past the console cap nothing is read');
  assert.equal(dom.consoleCalls.error.length, ERROR_CAPS.console + 1, 'the console still gets every call');
});

test('console.error chains to the original and is a capped warning capture', async (t) => {
  const dom = withDom(t);
  const clock = fakeClock();
  const { rs } = await startCapturing(t, dom, {}, { now: clock });
  const thrown = new Error('save failed');
  console.error('could not save', thrown);
  assert.equal(dom.consoleCalls.error.length, 1);
  assert.equal(dom.consoleCalls.error[0][1], thrown, 'the original sees the same arguments');
  const [data] = errors(rs);
  assert.equal(data.rs_source, 'console');
  assert.equal(data.rs_severity, 'warning');
  assert.equal(data.rs_message, 'could not save Error: save failed');
  assert.equal(data.rs_error_type, 'Error');
  for (let i = 0; i < 20; i++) {
    clock.advance(60000);
    console.error('distinct line ' + 'abcdefghijklmnopqrstuvwxyz'[i]);
  }
  assert.equal(errors(rs).filter((d) => d.rs_source === 'console').length, ERROR_CAPS.console);
  assert.equal(dom.consoleCalls.error.length, 21, 'every call still reaches the console');
});

// --- Caps --------------------------------------------------------------------

test('device caps: a token bucket of 6 a minute, 3 per key and 30 a session', async (t) => {
  const dom = withDom(t);
  const clock = fakeClock();
  const { rs } = await startCapturing(t, dom, {}, { now: clock });
  const fire = (message) => dom.fire('window', 'error', { target: dom.win, error: new Error(message) });

  for (let i = 0; i < 10; i++) fire('burst ' + 'abcdefghij'[i]);
  assert.equal(errors(rs).length, 6, 'the bucket holds 6');

  clock.advance(60000);
  for (let i = 0; i < 5; i++) fire('same error ' + i); // numbers template to one key
  assert.equal(errors(rs).length, 9, 'three per dedupe key');

  for (let i = 0; i < 60; i++) {
    clock.advance(60000);
    fire('loop ' + 'abcdefghijklmnopqrstuvwxyz'[i % 26] + 'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]);
  }
  assert.equal(errors(rs).length, ERROR_CAPS.total, 'never more than 30 a session');
  assert.equal(rs.stats.errorsCaptured, 30);
  assert.ok(rs.stats.errorsCapped > 0);
});

// --- Trail -------------------------------------------------------------------

test('with the trail off no rs_trail is sent', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: true, trail: false } });
  rs.track('level_start');
  console.warn('low memory');
  dom.fire('window', 'error', { target: dom.win, error: new Error('x') });
  assert.equal(errors(rs)[0].rs_trail, undefined);
  assert.equal(rs._trail.length, 0);
});

test('with the trail on: track calls, console and navigation, 20 lines, at most 10 trails', async (t) => {
  const dom = withDom(t);
  const clock = fakeClock();
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: true, trail: true } }, { now: clock });
  clock.advance(1500);
  rs.track('kickoff_pressed', { team: 'blue' });
  console.warn('slow frame for bob@example.com');
  dom.loc.pathname = '/play/match/1234';
  dom.fire('window', 'popstate', {});
  dom.fire('window', 'error', { target: dom.win, error: new Error('boom') });
  const [data] = errors(rs);
  assert.equal(
    data.rs_trail,
    ['+1500 track kickoff_pressed', '+1500 warn slow frame for [email]', '+1500 nav /play/match/:id'].join('\n'),
  );

  for (let i = 0; i < 30; i++) rs.track('step_' + i);
  dom.fire('window', 'error', { target: dom.win, error: new Error('second') });
  const lines = errors(rs)[1].rs_trail.split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines[19], '+1500 track step_29');
  assert.ok(lines.every((line) => line.length <= 120));

  for (let i = 0; i < 25; i++) {
    clock.advance(60000);
    rs.track('x');
    dom.fire('window', 'error', { target: dom.win, error: new Error('distinct ' + 'abcdefghijklmnopqrstuvwxyz'[i]) });
  }
  assert.equal(errors(rs).filter((d) => d.rs_trail).length, ERROR_CAPS.trails);
  assert.ok(errors(rs).length > ERROR_CAPS.trails, 'errors past the trail cap are still sent, without one');
});

test('a long trail is cut from the oldest end to 1,500 characters', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: true, trail: true } });
  for (let i = 0; i < 20; i++) rs.track('e'.repeat(150));
  dom.fire('window', 'error', { target: dom.win, error: new Error('x') });
  const trail = errors(rs)[0].rs_trail;
  assert.ok(trail.length <= 1500);
  assert.ok(trail.split('\n').every((line) => line.length <= 120));
});

// --- Dead clicks ---------------------------------------------------------------

test('a click on a button that changes nothing for the window is a dead click', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const button = element('button', { text: '  Kick   Off ' });
  const span = element('span', { parent: button });
  dom.fire('document', 'click', { target: span });
  await sleep(60);
  const [data] = errors(rs);
  assert.equal(data.rs_source, 'dead_click');
  assert.equal(data.rs_severity, 'warning');
  assert.equal(data.rs_message, 'Dead click: button Kick Off');
  assert.equal(dom.observerCount(), 0, 'the observer is disconnected');
});

test('the accessible name prefers aria-label and is scrubbed and cut', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const button = element('div', { attrs: { role: 'button', 'aria-label': 'Invite friend@example.com ' + 'x'.repeat(100) } });
  dom.fire('document', 'click', { target: button });
  await sleep(60);
  const message = errors(rs)[0].rs_message;
  assert.match(message, /^Dead click: div Invite \[email\] x+$/);
  assert.equal(message.length, 'Dead click: div '.length + 60);
});

test('no dead click when the page changes, a request starts, a track call is made or it navigates', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const button = element('button', { text: 'Go' });

  dom.fire('document', 'click', { target: button });
  dom.mutate();
  await sleep(60);

  dom.fire('document', 'click', { target: button });
  await fetch('https://game.example.com/api/start');
  await sleep(60);

  dom.fire('document', 'click', { target: button });
  rs.track('start_pressed');
  await sleep(60);

  dom.fire('document', 'click', { target: button });
  dom.loc.href = 'https://game.example.com/play/next';
  await sleep(60);

  assert.equal(errors(rs).length, 0);
});

test('no dead click for disabled buttons, submitted forms, non-buttons or untrusted clicks', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.fire('document', 'click', { target: element('button', { text: 'Off', disabled: true }) });
  await sleep(60);
  dom.fire('document', 'click', { target: element('button', { text: 'Aria off', attrs: { 'aria-disabled': 'true' } }) });
  await sleep(60);
  const form = { tagName: 'FORM' };
  dom.fire('document', 'click', { target: element('button', { text: 'Send', form }) });
  // The submit fires as the click's default action, inside the watch.
  dom.fire('document', 'submit', { target: form });
  await sleep(60);
  dom.fire('document', 'click', { target: element('canvas') });
  await sleep(60);
  dom.fire('document', 'click', { target: element('button', { text: 'Script' }), isTrusted: false });
  await sleep(60);
  assert.equal(errors(rs).length, 0);
});

test('the observer disconnects at the first mutation', async (t) => {
  const dom = withDom(t);
  await startCapturing(t, dom);
  dom.fire('document', 'click', { target: element('button', { text: 'Go' }) });
  assert.equal(dom.observerCount(), 1);
  dom.mutate();
  assert.equal(dom.observerCount(), 0);
  await sleep(60);
});

test('dead clicks are off while a canvas covers more than half the viewport', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  dom.win.innerWidth = 1000;
  dom.win.innerHeight = 800;
  let rect = { left: 0, top: 0, right: 1000, bottom: 500 };
  dom.doc.querySelectorAll = (selector) => (selector === 'canvas' ? [{ getBoundingClientRect: () => rect }] : []);
  dom.fire('document', 'click', { target: element('button', { text: 'Menu' }) });
  assert.equal(dom.observerCount(), 0, 'a canvas over 62 percent of the page');
  rect = { left: 0, top: 0, right: 300, bottom: 200 };
  dom.fire('document', 'click', { target: element('button', { text: 'Menu' }) });
  assert.equal(dom.observerCount(), 1, 'a small canvas leaves the watcher on');
  await sleep(60);
  assert.equal(errors(rs).length, 1);
});

test('captureDeadClicks: false never watches a click', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, {}, { captureDeadClicks: false });
  dom.fire('document', 'click', { target: element('button', { text: 'Go' }) });
  assert.equal(dom.observerCount(), 0);
  await sleep(60);
  assert.equal(errors(rs).length, 0);
});

test('dead clicks are throttled: one watch at a time and a cooldown after a report', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const button = element('button', { text: 'Go' });
  dom.fire('document', 'click', { target: button });
  dom.fire('document', 'click', { target: button });
  dom.fire('document', 'click', { target: button });
  assert.equal(dom.observerCount(), 1);
  await sleep(60);
  dom.fire('document', 'click', { target: element('button', { text: 'Other' }) });
  assert.equal(dom.observerCount(), 0, 'cooling down after a report');
  await sleep(60);
  assert.equal(errors(rs).length, 1);
});

// --- Node ----------------------------------------------------------------------

test('Node: uncaughtExceptionMonitor only, no unhandledRejection listener, removed on dispose', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const monitorsBefore = process.listenerCount('uncaughtExceptionMonitor');
  const rejectionsBefore = process.listenerCount('unhandledRejection');
  const exceptionsBefore = process.listenerCount('uncaughtException');
  const rs = makeClient(server);
  await rs.init();
  assert.equal(rs.capturingErrors, true);
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorsBefore + 1);
  assert.equal(process.listenerCount('unhandledRejection'), rejectionsBefore);
  assert.equal(process.listenerCount('uncaughtException'), exceptionsBefore);
  assert.equal(globalThis.fetch, REAL_FETCH, 'no request wrapping in Node');

  const err = new SyntaxError('bad save file at /home/alice/.game/save.json');
  process.emit('uncaughtExceptionMonitor', err, 'uncaughtException');
  process.emit('uncaughtExceptionMonitor', new Error('rejected'), 'unhandledRejection');
  const [crash, rejection] = errors(rs);
  assert.equal(crash.rs_source, 'uncaught');
  assert.equal(crash.rs_error_type, 'SyntaxError');
  assert.equal(crash.rs_message, 'bad save file at ~/.game/save.json');
  assert.equal(rejection.rs_source, 'unhandled_rejection');
  await waitForBatch(server);

  await rs.dispose();
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorsBefore);
});

async function waitForBatch(server) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (server.state.events.some((e) => e.event === 'error')) return;
    await sleep(10);
  }
  throw new Error('no error batch arrived');
}

// --- Queue -----------------------------------------------------------------------

test('a full queue drops errors before gameplay events', async (t) => {
  const dom = withDom(t);
  const server = await startMockServer({ sessionStatus: 503 });
  t.after(() => server.close());
  const rs = dom.own(makeClient(server, { maxQueueSize: 3 }));
  await rs.init();
  assert.equal(rs.capturingErrors, true, 'installed even while the session is not open yet');
  rs.track('a');
  dom.fire('window', 'error', { target: dom.win, error: new Error('one') });
  rs.track('b');
  assert.deepEqual(rs.queue.map((e) => e.event), ['a', 'error', 'b']);
  rs.track('c');
  assert.deepEqual(rs.queue.map((e) => e.event), ['a', 'b', 'c'], 'the queued error goes first');
  dom.fire('window', 'error', { target: dom.win, error: new Error('two') });
  assert.deepEqual(rs.queue.map((e) => e.event), ['a', 'b', 'c'], 'an incoming error never evicts gameplay');
  assert.equal(rs.queue.some((e) => 'auto' in (e.data || {})), false);
});

test('a 413 splits the batch like a 400 and drops the one bad event, never resending it as is', async (t) => {
  const server = await startMockServer({ batchOverrides: [{ status: 413 }, { status: 413 }] });
  t.after(() => server.close());
  const rs = makeClient(server);
  await rs.init();
  rs.track('too_big');
  rs.track('fine');
  await rs.flush();
  const batches = server.requestsTo('/api/v1/track/batch');
  assert.deepEqual(batches.map((r) => r.body.events.map((e) => e.event)), [['too_big', 'fine'], ['too_big'], ['fine']]);
  assert.deepEqual(server.state.events.map((e) => e.event), ['fine']);
  assert.equal(rs.stats.dropped, 1);
  await rs.dispose();
});

test('the wire never carries the local auto marker', async (t) => {
  const dom = withDom(t);
  const { rs, server } = await startCapturing(t, dom);
  dom.fire('window', 'error', { target: dom.win, error: new Error('wire') });
  await rs.flush();
  const sent = server.requestsTo('/api/v1/track/batch')[0].body.events;
  assert.deepEqual(Object.keys(sent[0]).sort(), ['data', 'event', 'timestamp']);
  assert.equal(sent[0].data.rs_source, 'uncaught');
});

// --- Manual trackError ---------------------------------------------------------

test('trackError takes errorType as rs_error_type', async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  const rs = makeClient(server, { captureErrors: false });
  await rs.init();
  rs.trackError({ severity: 'error', message: 'm', errorType: 'T'.repeat(150) });
  assert.equal(rs.queue[0].data.rs_error_type.length, 100);
  await rs.dispose({ flush: false });
});

// --- Scrub -----------------------------------------------------------------------

test('scrubText follows the contract rules', () => {
  const cases = [
    ['mail bob.smith+x@mail.example.co.uk now', 'mail [email] now'],
    ['Authorization: Bearer abc.DEF-123_xyz=', 'Authorization: [token]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nature_1 end', 'jwt [token] end'],
    ['key gt_live_AbC123 used', 'key [token] used'],
    ['hex 0123456789abcdef0123456789abcdef!', 'hex [token]!'],
    ['b64 QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890== x', 'b64 [token] x'],
    ['camel ThisIsAVeryLongFunctionNameWithoutDigits stays', 'camel ThisIsAVeryLongFunctionNameWithoutDigits stays'],
    ['from 192.168.1.20 ok', 'from [ip] ok'],
    ['v6 2001:db8:85a3::8a2e:370:7334 and ::1 and fe80:0:0:0:0:0:0:1', 'v6 [ip] and [ip] and [ip]'],
    ['std::vector and 12:30:45 stay', 'std::vector and 12:30:45 stay'],
    ['at /Users/jacob/game/main.js:1:2', 'at ~/game/main.js:1:2'],
    ['at /home/alice/srv/x.js', 'at ~/srv/x.js'],
    ['C:\\Users\\Bob\\AppData\\game.exe', '~\\AppData\\game.exe'],
    ['GET https://api.example.com/a/b?token=1&u=me@x.io#frag done', 'GET https://api.example.com/a/b done'],
    ['at (https://cdn.example.com/app.js?v=9:10:5)', 'at (https://cdn.example.com/app.js)'],
    ['plain text stays', 'plain text stays'],
  ];
  for (const [input, expected] of cases) assert.equal(scrubText(input), expected, input);
  assert.equal(scrubText(null), '');
});

test('scrubText produces every shared contract vector', () => {
  assert.ok(SCRUB_VECTORS.cases.length > 0);
  for (const { name, in: input, out } of SCRUB_VECTORS.cases) assert.equal(scrubText(input), out, name);
});

test('a 200,000 character line is cut before the scrub, so capture stays fast', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom, { errorCapture: { enabled: true, trail: true } });
  // Long letter runs are the slow case for the URL and email rules.
  const huge = 'a'.repeat(100000) + '@' + 'b'.repeat(99999);
  const started = performance.now();
  console.error(huge);
  dom.fire('window', 'error', { target: dom.win, error: Object.assign(new Error(huge), { stack: huge }) });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, 'took ' + elapsed.toFixed(1) + ' ms');
  const [fromConsole, uncaught] = errors(rs);
  assert.ok(fromConsole.rs_message.length <= 200);
  assert.ok(uncaught.rs_stack.length <= 2000);
  assert.ok(uncaught.rs_trail.length <= 1500);
});

test('the scrub runs before the cut, so a token past the limit cannot leak a prefix', async (t) => {
  const dom = withDom(t);
  const { rs } = await startCapturing(t, dom);
  const message = 'x'.repeat(190) + ' gt_live_ABCDEFGHIJ1234567890';
  dom.fire('window', 'error', { target: dom.win, error: new Error(message) });
  const data = errors(rs)[0];
  assert.ok(data.rs_message.length <= 200);
  assert.doesNotMatch(data.rs_message, /gt_live/);
});

test('ERROR_CAPS is the contract numbers, frozen', () => {
  assert.deepEqual({ ...ERROR_CAPS }, { total: 30, perKey: 3, trails: 10, perMinute: 6, console: 5, deadClick: 3 });
  assert.ok(Object.isFrozen(ERROR_CAPS));
});
