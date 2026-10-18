import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { Ravensight, MemoryStorage } from '../src/index.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=', 'base64'));
const response = (body, status = 200) => ({ status, headers: new Headers(), text: async () => JSON.stringify(body) });
function setup(t, override = () => undefined) {
  const calls = [];
  const rs = new Ravensight({ ingestKey: 'key', deviceId: 'player', storage: new MemoryStorage(), autoFlushMs: 0, autoEvents: false,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      const custom = await override(url, init); if (custom) return custom;
      if (url.endsWith('/session')) return response({ token: 'session-one', expiresIn: 86400 }, 201);
      if (url.endsWith('/settings')) return response({ trackingEnabled: true });
      if (url.endsWith('/reports')) return response({ id: 'submission-one', status: 'pending' }, 201);
      if (url.endsWith('/upload')) return response({ url: 'https://storage.example/upload', fields: { key: 'one', policy: 'signed' } });
      if (url === 'https://storage.example/upload') return response(null, 204);
      if (url.endsWith('/finalize')) return response({ id: 'submission-one', status: 'processing' }, 202);
      return response({ id: 'submission-one', status: 'complete', reportId: 'report-one' });
    } });
  t.after(() => rs.dispose({ flush: false }));
  return { rs, calls };
}
test('screenshot is hashed, uploaded without credentials and finalized; status is explicit', async t => {
  const { rs, calls } = setup(t);
  const report = await rs.createReport({ message: 'Door stuck', screenshot: image, context: { level: 2 } });
  assert.equal((await rs.submitReport(report)).status, 'processing');
  const begin = calls.find(c => c.url.endsWith('/reports'));
  assert.equal(JSON.parse(begin.body).sha256, createHash('sha256').update(image).digest('hex'));
  assert.equal(JSON.parse(begin.body).bytes, image.length);
  const upload = calls.find(c => c.url === 'https://storage.example/upload');
  assert.equal(upload.headers, undefined); assert.equal(upload.credentials, 'omit'); assert.equal(upload.redirect, 'error');
  assert.deepEqual([...upload.body.keys()], ['key', 'policy', 'file']);
  assert.equal((await rs.getReportStatus(report)).reportId, 'report-one');
  assert.equal((await rs.submitReport(report)).status, 'complete');
  assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 1);
});
test('a failed creation retries the same payload and session, never a new purchase identity', async t => {
  let tries = 0;
  const { rs, calls } = setup(t, url => url.endsWith('/reports') && ++tries === 1 ? response({ error: 'offline' }, 503) : undefined);
  const report = await rs.createReport({ message: 'Door stuck', screenshot: image });
  await assert.rejects(rs.submitReport(report), { code: 'offline' });
  await rs.submitReport(report);
  const requests = calls.filter(c => c.url.endsWith('/reports'));
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers['X-Session-Token'], requests[1].headers['X-Session-Token']);
});
test('concurrent submissions share one request and copied bytes cannot change', async t => {
  const { rs, calls } = setup(t); const bytes = image.slice();
  const report = await rs.createReport({ message: 'Door stuck', screenshot: bytes }); bytes.fill(0);
  const [a, b] = await Promise.all([rs.submitReport(report), rs.submitReport(report)]);
  assert.deepEqual(a, b); assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 1);
  assert.equal(JSON.parse(calls.find(c => c.url.endsWith('/reports')).body).sha256, createHash('sha256').update(image).digest('hex'));
});
test('text reports do not request image storage', async t => {
  const { rs, calls } = setup(t, url => url.endsWith('/reports') ? response({ id: 'text-one', status: 'complete', reportId: 'text-report' }, 201) : undefined);
  assert.equal((await rs.submitReport(await rs.createReport({ message: 'Nice game' }))).status, 'complete');
  assert.equal(calls.some(c => c.url.endsWith('/upload')), false);
});
test('rejects invalid reports before reserving usage', async t => {
  const { rs, calls } = setup(t);
  for (const data of [{ message: '' }, { message: 'x', screenshot: new Uint8Array(1000001) }, { message: 'x', screenshot: new Uint8Array([1, 2]) }, { message: 'x', context: { a: Infinity } }, { message: 'x', capturedAt: 1 }]) {
    await assert.rejects(rs.createReport(data), { code: 'invalid_report' });
  }
  assert.equal(calls.filter(c => c.url.includes('/reports')).length, 0);
});
test('does not refresh a failed session or silently fall back to text', async t => {
  const { rs, calls } = setup(t, url => url.endsWith('/reports') ? response({ error: 'invalid_session' }, 401) : undefined);
  const report = await rs.createReport({ message: 'x', screenshot: image });
  await assert.rejects(rs.submitReport(report), { code: 'invalid_session' });
  assert.equal(calls.filter(c => c.url.endsWith('/session')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 1);
});
test('rejects an unsafe presigned upload URL', async t => {
  const { rs } = setup(t, url => url.endsWith('/upload') ? response({ url: 'http://storage.example/upload', fields: {} }) : undefined);
  await assert.rejects(rs.submitReport(await rs.createReport({ message: 'x', screenshot: image })), { code: 'invalid_upload' });
});
test('an upload failure is resumed using the same submission without a second reserve', async t => {
  let uploadTries = 0;
  const { rs, calls } = setup(t, url => {
    if (url === 'https://storage.example/upload' && ++uploadTries === 1) return response(null, 503);
    if (url.endsWith('/reports/submission-one')) return response({ id: 'submission-one', status: 'pending' });
  });
  const report = await rs.createReport({ message: 'x', screenshot: image });
  await assert.rejects(rs.submitReport(report), { code: 'upload_failed' });
  assert.equal((await rs.submitReport(report)).status, 'processing');
  assert.equal(calls.filter(c => c.url.endsWith('/reports')).length, 1);
});
test('session identity changes cannot resend the prepared report as another player', async t => {
  const { rs } = setup(t);
  const report = await rs.createReport({ message: 'x', screenshot: image });
  await rs.submitReport(report);
  await rs.setDeviceId('new-player');
  await assert.rejects(rs.submitReport(report), { code: 'report_session_changed' });
});
test('invalid or nonbrowser canvas capture fails without sending anything', async t => {
  const { rs, calls } = setup(t);
  await assert.rejects(rs.captureScreenshot(null), { code: 'invalid_canvas' });
  assert.equal(calls.filter(c => c.url.includes('/reports')).length, 0);
});
test('CommonJS exposes the same report methods', async () => {
  const { createRequire } = await import('node:module');
  const SDK = createRequire(import.meta.url)('../dist/index.cjs');
  for (const name of ['createReport', 'submitReport', 'captureScreenshot', 'getReportStatus', 'cancelReport']) assert.equal(typeof SDK.prototype[name], 'function');
});
test('Node can hash screenshots when Web Crypto is not installed globally', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const { rs } = setup(t);
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const report = await rs.createReport({ message: 'x', screenshot: image });
    assert.equal(report.hasScreenshot, true);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
