import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { readPlaybackSetup, playbackSetupProgress } from '../src/lib/playback-setup.js';
import { respond } from '../src/lib/server/response.js';

test('preparation reports real milestones before the playback session is ready', async () => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const request = new Request('http://localhost/api/play/example/hls');
  const response = await respond(request, new URL(request.url), async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"progress","completed":0}\n');
    await ready;
    res.end('{"type":"progress","completed":2}\n{"type":"ready","session":{"sessionUrl":"/session","playlistUrl":"/index.m3u8"}}\n');
  });
  const milestones = [];
  const pending = readPlaybackSetup(response, value => milestones.push(value));
  await setImmediate();
  assert.deepEqual(milestones.map(value => value.completed), [0]);
  finish();
  assert.equal((await pending).sessionUrl, '/session');
  assert.deepEqual(milestones.map(value => value.percent), [0, 50]);
  assert.equal(playbackSetupProgress(3).message, 'Starting playback');
  assert.equal(playbackSetupProgress(4).percent, 100);
});

test('split progress records and server errors are decoded correctly', async () => {
  const encoder = new TextEncoder();
  const payload = '{"type":"progress","completed":1}\n{"type":"error","error":"Video unavailable…"}\n';
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of encoder.encode(payload)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }}), { headers: { 'content-type': 'application/x-ndjson' } });
  const milestones = [];
  await assert.rejects(readPlaybackSetup(response, value => milestones.push(value.completed)), /Video unavailable…/);
  assert.deepEqual(milestones, [1]);
});

test('an incomplete preparation response cannot be mistaken for a ready session', async () => {
  await assert.rejects(readPlaybackSetup(new Response('{"type":"progress","completed":1}\n', { headers: { 'content-type': 'application/x-ndjson' } })), /before the video was ready/);
});
