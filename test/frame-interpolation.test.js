import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegArgs, playbackNeedsToneMapping, publicSettings, startHlsConversion } from '../src/lib/server/streamer.js';
import { createHlsSession } from '../src/lib/server/hls-session.js';
import { playbackScope } from '../src/lib/server/playback-persistence.js';
const run = promisify(execFile);

test('interpolation defaults off and separates prepared playback scopes', () => {
  assert.equal(publicSettings({}).frameInterpolation, false);
  assert.notEqual(playbackScope({}), playbackScope({ frameInterpolation: true }));
  assert.equal(playbackScope({}), playbackScope({ frameInterpolation: false }));
});

test('interpolation forces software motion processing while ordinary remux stays unchanged', () => {
  const plain = ffmpegArgs('remux', 'input.mkv', 'output.mp4');
  assert.equal(plain.includes('-vf'), false);
  assert.equal(plain[plain.indexOf('-c:v') + 1], 'copy');
  for (const acceleration of [null, {kind: 'vaapi', device: '/dev/dri/renderD128'}, {kind: 'nvenc'}]) {
    const args = ffmpegArgs('remux', 'input.mkv', 'output.mp4', false, 0, 2, true, false, acceleration, null, true);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args.includes('-hwaccel'), false);
    assert.match(args[args.indexOf('-vf') + 1], /minterpolate=fps=60:mi_mode=mci/);
  }
});

test('opted-in cached HLS creates 60 FPS video with genuinely intermediate frames', {timeout: 20000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frame-interpolation-'));
  let session;
  try {
    const input = join(root, 'input.mkv');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=4','-c:v','libx264','-preset','ultrafast',input]);
    const job = { mode: 'cached', path: input, strategy: 'raw', release: 'SDR', events: [] };
    session = await createHlsSession({ root, produce: directory => startHlsConversion(job, { frameInterpolation: true }, 0, directory) });
    await session.ready();
    const playlist = join(session.directory, 'index.m3u8');
    const probe = JSON.parse((await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=r_frame_rate','-of','json',playlist])).stdout);
    assert.equal(probe.streams[0].r_frame_rate, '60/1');
    assert.match(job.videoAcceleration, /60 FPS motion interpolation/);
    // Decode the first output frames: mci should synthesize differing frames, not a 25->60 duplication cadence.
    const hashes = (await run('ffmpeg',['-v','error','-i',playlist,'-frames:v','12','-f','framemd5','-'])).stdout.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1).trim());
    assert.equal(hashes.length, 12);
    assert.ok(new Set(hashes).size >= 10, 'motion interpolation must produce intermediate frame content');
  } finally { await session?.close(); await rm(root, {recursive: true, force: true}); }
});


test('interpolating prepared HDR copies does not apply tone mapping twice', () => {
  assert.equal(playbackNeedsToneMapping({release: 'Movie.2160p.HDR', sourcePath: '/saved/movie.mkv'}), true);
  assert.equal(playbackNeedsToneMapping({release: 'Movie.2160p.HDR', path: '/saved/movie.mkv.browser.mp4'}), false);
  assert.equal(playbackNeedsToneMapping({release: 'Movie.1080p.SDR', path: '/saved/movie.mp4'}), false);
});
