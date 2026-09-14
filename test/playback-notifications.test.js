import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyPlayback, waitForPlayback } from '../src/lib/server/playback-notifications.js';

test('ready notification wakes a held request immediately and cannot lose a preceding update', async () => {
  const job = { status: 'selecting', revision: 1 };
  let returned = false;
  const pending = waitForPlayback(job, 1).then(() => { returned = true; });
  await Promise.resolve(); assert.equal(returned, false);
  job.status = 'ready'; notifyPlayback(job); await pending;
  assert.equal(returned, true);
  await waitForPlayback(job, 1);
});
test('abandoning a readiness request releases its listener', async () => {
  const controller = new AbortController(), job = { status: 'selecting' };
  const pending = waitForPlayback(job, 0, { signal: controller.signal });
  controller.abort(); await pending;
  notifyPlayback(job);
});

test('readiness waits work through the real Svelte HTTP response adapter', async () => {
  const { respond } = await import('../src/lib/server/response.js');
  const job = { status: 'selecting', revision: 1 };
  const result = respond(new Request('http://localhost/api/play/job?after=1'), new URL('http://localhost/api/play/job?after=1'), async (req, res) => {
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    await waitForPlayback(job, 1, { signal: controller.signal });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(job));
  });
  await Promise.resolve();
  job.status = 'ready'; notifyPlayback(job);
  assert.equal((await (await result).json()).status, 'ready');
});
