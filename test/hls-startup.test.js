import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHlsConversion } from '../src/lib/server/streamer.js';
import { createHlsSession } from '../src/lib/server/hls-session.js';
const run = promisify(execFile);

test('HLS fills its initial buffer promptly without changing the resumed video', { timeout: 20000 }, async t => {
  const help = (await run('ffmpeg', ['-hide_banner', '-h', 'full'], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  if (!help.includes('-readrate_initial_burst')) return t.skip('This FFmpeg uses the compatible legacy pacing path.');
  const root = await mkdtemp(join(tmpdir(), 'hls-startup-'));
  let session, baseline;
  try {
    const input = join(root, 'source.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', input]);
    const job = { mode: 'cached-convert', sourcePath: input, strategy: 'remux', release: 'SDR', events: [] };
    const started = performance.now();
    session = await createHlsSession({ root, produce: directory => startHlsConversion(job, {}, 10, directory) });
    await session.ready();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1800, `startup pacing delayed the first resumed segment to ${Math.round(elapsed)}ms (budget 1800ms)`);
    const playlist = join(session.directory, 'index.m3u8');
    baseline = await createHlsSession({ root, produce: directory => startHlsConversion({ ...job }, {}, 10, directory, () => {}, async () => ['-readrate', '1.5']) });
    await baseline.ready();
    // Only input pacing changes; compare decoded output against the old pace.
    const hashes = async (path, seek = []) => (await run('ffmpeg', ['-v', 'error', ...seek, '-i', path, '-map', '0:v:0', '-frames:v', '25', '-f', 'framemd5', '-'])).stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    assert.deepEqual(await hashes(playlist), await hashes(join(baseline.directory, 'index.m3u8')));
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', playlist])).stdout);
    assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  } finally { await session?.close(); await baseline?.close(); await rm(root, { recursive: true, force: true }); }
});

test('encoding overlaps validation but a failed check never releases the HLS session', { timeout: 15000 }, async () => {
  const { readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'hls-validation-'));
  let failValidation, conversionStarted;
  const validated = new Promise((_resolve, reject) => { failValidation = reject; });
  void validated.catch(() => {});
  const started = new Promise(resolve => { conversionStarted = resolve; });
  let pending, settled = false;
  try {
    const input = join(root, 'source.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', input]);
    pending = createHlsSession({ root, produce: directory => startHlsConversion(
      { mode: 'cached-convert', sourcePath: input, strategy: 'remux', release: 'SDR' }, {}, 1, directory,
      conversionStarted, async () => [], () => ({ metadata: Promise.resolve({ audioIndex: null, duration: 20 }), validated })
    ) });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await started;
    let produced = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const files = await readdir(root, { recursive: true });
      if (files.some(name => name.endsWith('.m4s'))) { produced = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!produced && settled) await pending;
    assert.equal(produced, true, 'video must be encoded while validation is still pending');
    assert.equal(settled, false, 'the player must not receive unvalidated output');
    failValidation(new Error('Invalid source timeline'));
    await assert.rejects(pending, /Invalid source timeline/);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('hls-')), [], 'discard speculative output after rejection');
  } finally { failValidation(new Error('cleanup')); await pending?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
