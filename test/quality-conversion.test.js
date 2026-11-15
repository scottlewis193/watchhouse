import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegArgs } from '../src/lib/server/streamer.js';

const run = promisify(execFile);

test('Best quality conversion retains more dark-scene detail than Balanced', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dark-scene-quality-'));
  try {
    const source = join(root, 'source.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "testsrc2=size=320x180:rate=24:duration=2,lutyuv=y='val*0.15+16',noise=alls=2:allf=t+u:all_seed=7", '-c:v', 'ffv1', source]);
    const fidelity = {};
    for (const preference of ['balanced', 'quality']) {
      const output = join(root, `${preference}.mp4`);
      await run('ffmpeg', ffmpegArgs('transcode', source, output, false, 0, 1, true, false, null, null, false, preference));
      const { stderr } = await run('ffmpeg', ['-i', output, '-i', source, '-lavfi', 'ssim', '-f', 'null', '-']);
      fidelity[preference] = Number(stderr.match(/All:([\d.]+)/)?.[1]);
    }
    assert.ok(fidelity.quality > fidelity.balanced + 0.0001, `dark-scene SSIM: ${JSON.stringify(fidelity)}`);
    console.log(`Dark-scene SSIM: ${JSON.stringify(fidelity)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Best quality remux preserves H.264 video packets without another lossy encode', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-video-copy-'));
  try {
    const source = join(root, 'source.mkv'), output = join(root, 'output.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1', '-c:v', 'libx264', source]);
    await run('ffmpeg', ffmpegArgs('remux', source, output, false, 0, 1, true, false, null, null, false, 'quality'));
    const packets = async path => JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', path])).stdout).packets.map(packet => packet.data_hash);
    assert.deepEqual(await packets(output), await packets(source));
  } finally { await rm(root, { recursive: true, force: true }); }
});
