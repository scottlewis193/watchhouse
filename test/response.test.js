import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { respond } from '../src/lib/server/response.js';

test('cancelling playback stops its producer even when the request signal is not aborted', async () => {
  const request = new Request('http://localhost/api/play/test/stream');
  let stopped = 0;
  const response = await respond(request, new URL(request.url), async (req, res) => {
    req.on('close', () => { stopped++; });
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.write(Buffer.from('video'));
  });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'video');
  await reader.cancel();
  await setImmediate();
  assert.equal(request.signal.aborted, false);
  assert.equal(stopped, 1, 'abandoned converter must receive close');
});

test('disconnect releases a producer waiting for response backpressure', async () => {
  const controller = new AbortController();
  const request = new Request('http://localhost/api/play/test/stream', { signal: controller.signal });
  let drainResult;
  let stopped = 0;
  const response = await respond(request, new URL(request.url), async (req, res) => {
    req.on('close', () => { stopped++; });
    res.writeHead(200);
    assert.equal(res.write(Buffer.alloc(32 * 1024 * 1024)), false);
    drainResult = res.waitForDrain().then(() => 'drained', () => 'closed');
    // Abort before the web reader can drain the buffered output.
    controller.abort();
  });
  assert.equal(await drainResult, 'closed');
  await assert.rejects(response.body.cancel(), { name: 'AbortError' });
  await setImmediate();
  assert.equal(stopped, 1);
});

test('response bridge preserves complete streaming output', async () => {
  const request = new Request('http://localhost/api/play/test/stream');
  const response = await respond(request, new URL(request.url), async (req, res) => {
    res.writeHead(206, { 'content-type': 'video/mp4' });
    res.write(Buffer.from('first'));
    res.end(Buffer.from('last'));
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), 'firstlast');
});
