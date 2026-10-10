/**
 * Minimal in process Ravensight API for tests. Speaks the real contract and
 * can be told to misbehave (401, 429 with Retry-After, 400 oversize) so the
 * SDK's retry paths are exercised against actual HTTP.
 */
import http from 'node:http';

const MAX_BATCH_SIZE = 50;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        resolve(null);
      }
    });
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startMockServer(config = {}) {
  const state = {
    requests: [],
    events: [],
    feedback: [],
    tokens: [],
    trackingEnabled: config.trackingEnabled !== false,
    settingsStatus: config.settingsStatus == null ? 200 : config.settingsStatus,
    sessionStatus: config.sessionStatus == null ? 201 : config.sessionStatus,
    sessionExpiresIn: config.sessionExpiresIn == null ? 86400 : config.sessionExpiresIn,
    suggestions: config.suggestions || [],
    /** Max events the server will accept in one batch (larger => HTTP 400). */
    maxBatchAccept: config.maxBatchAccept == null ? MAX_BATCH_SIZE : config.maxBatchAccept,
    /** Queue of one shot overrides for POST /track/batch. */
    batchOverrides: config.batchOverrides ? config.batchOverrides.slice() : [],
    /** Status for every POST /track/batch (e.g. 503 for a failing server). */
    batchStatus: config.batchStatus == null ? null : config.batchStatus,
    /** Delay before answering POST /track/batch, to simulate a hung server. */
    batchDelayMs: config.batchDelayMs == null ? 0 : config.batchDelayMs,
    /** Delay before answering POST /session, to hold a session open in flight. */
    sessionDelayMs: config.sessionDelayMs == null ? 0 : config.sessionDelayMs,
    seq: 0,
  };

  const currentToken = () => (state.tokens.length ? state.tokens[state.tokens.length - 1] : null);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = await readBody(req);
    state.requests.push({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    });

    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/v1/settings') {
      if (state.settingsStatus !== 200) return send(res, state.settingsStatus, { error: 'boom' });
      return send(res, 200, { trackingEnabled: state.trackingEnabled });
    }

    if (req.method === 'POST' && path === '/api/v1/session') {
      if (state.sessionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.sessionDelayMs).unref());
      }
      if (!String(req.headers['x-api-key'] || '').startsWith('gt_live_')) {
        return send(res, 401, { error: 'invalid_key' });
      }
      if (state.sessionStatus !== 201) {
        return send(res, state.sessionStatus, { error: 'session_rejected' });
      }
      state.seq += 1;
      const token = 'sess_' + state.seq;
      state.tokens.push(token);
      return send(res, 201, {
        token,
        expiresIn: state.sessionExpiresIn,
        expiresAt: Math.floor(Date.now() / 1000) + state.sessionExpiresIn,
      });
    }

    if (req.method === 'POST' && path === '/api/v1/track/batch') {
      if (state.batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.batchDelayMs).unref());
      }
      if (state.batchStatus != null) {
        return send(res, state.batchStatus, { error: 'unavailable' });
      }
      const override = state.batchOverrides.shift();
      if (override) {
        return send(res, override.status, override.body || { error: 'forced' }, override.headers || {});
      }
      if (req.headers['x-session-token'] !== currentToken()) {
        return send(res, 401, { error: 'session_expired' });
      }
      const events = body && Array.isArray(body.events) ? body.events : null;
      if (!events) return send(res, 400, { error: 'invalid_payload' });
      if (events.length > MAX_BATCH_SIZE) return send(res, 400, { error: 'batch_too_large' });
      if (events.length > state.maxBatchAccept) return send(res, 400, { error: 'payload_too_large' });
      state.events.push(...events);
      return send(res, 202, { accepted: events.length });
    }

    if (req.method === 'POST' && path === '/api/v1/track') {
      if (req.headers['x-session-token'] !== currentToken()) {
        return send(res, 401, { error: 'session_expired' });
      }
      state.events.push(body);
      return send(res, 202, { accepted: 1 });
    }

    if (req.method === 'POST' && path === '/api/v1/feedback') {
      if (req.headers['x-session-token'] !== currentToken()) {
        return send(res, 401, { error: 'session_expired' });
      }
      state.feedback.push(body);
      return send(res, 201, { ok: true });
    }

    if (req.method === 'GET' && path === '/api/v1/agent/suggestions') {
      if (!String(req.headers['x-api-key'] || '').startsWith('gt_live_')) {
        return send(res, 401, { error: 'invalid_key' });
      }
      return send(res, 200, { suggestions: state.suggestions });
    }

    return send(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    url: 'http://127.0.0.1:' + port + '/api/v1',
    /** Requests seen for a given path, in order. */
    requestsTo(path) {
      return state.requests.filter((r) => r.path === path);
    },
    /** Forces the next batch to 401 by rotating the accepted token. */
    expireSession() {
      state.tokens.push('rotated_' + (state.seq + 1000));
    },
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      // Do not wait on requests a test deliberately left hanging.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await closed;
    },
  };
}

/** A clock the tests can move by hand so backoff is testable without waiting. */
export function fakeClock(start = Date.now()) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
  };
  return now;
}
