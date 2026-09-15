import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { readPlaybackSetup, playbackSetupProgress } from '../src/lib/playback-setup.js';
import { respond } from '../src/lib/server/response.js';
import { archivePlaybackSetupProgress } from '../src/lib/server/streamer.js';

test('preparation reports real milestones before the playback session is ready', async () => {
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const request = new Request('http://localhost/api/play/example/hls');
  const response = await respond(request, new URL(request.url), async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"progress","completed":0}\n');
    await ready;
    res.end('{"type":"progress","completed":1,"message":"Restoring your saved position","detail":"420 MB of about 950 MB prepared","percent":36}\n{"type":"progress","completed":2}\n{"type":"ready","session":{"sessionUrl":"/session","playlistUrl":"/index.m3u8"}}\n');
  });
  const milestones = [];
  const pending = readPlaybackSetup(response, value => milestones.push(value));
  await setImmediate();
  assert.deepEqual(milestones.map(value => value.completed), [0]);
  finish();
  assert.equal((await pending).sessionUrl, '/session');
  assert.deepEqual(milestones.map(value => value.percent), [0, 36, 50]);
  assert.deepEqual(milestones[1], {
    completed: 1, total: 4, percent: 36,
    message: 'Restoring your saved position', detail: '420 MB of about 950 MB prepared'
  });
  assert.equal(playbackSetupProgress(3).message, 'Starting playback');
  assert.equal(playbackSetupProgress(4).percent, 100);
});

test('long archive resumes report useful byte progress towards the saved position', () => {
  const progress = archivePlaybackSetupProgress({
    progressiveArchive: true,
    sourceDuration: 2800,
    archiveSource: { complete: false, available: 450 * 1024 ** 2, metadata: { size: 8 * 1024 ** 3 } }
  }, 350, 1);
  assert.equal(progress.message, 'Restoring your saved position at 5:50');
  assert.equal(progress.detail, '450 MB of about 1.0 GB prepared');
  assert.equal(progress.percent, 36);
});

test('live archive detail expands the hero preparation card for a third line', () => {
  const page = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  assert.match(page, /class:hero-action-slot-detailed=\{resumeStarting && setupProgress\?\.detail\}/);
  assert.match(styles, /\.hero-action-slot-detailed\s*\{[^}]*height:\s*4\.2rem;/s);
  assert.match(styles, /\.hero-action-slot-detailed \.hero-preparation\s*\{[^}]*padding:/s);
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
