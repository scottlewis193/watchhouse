import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateOfflinePlaybackRecord } from '../src/lib/server/streamer.js';
const run = promisify(execFile);

test('previously timeline-validated offline copies still reject corrupt video packets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-decode-'));
  try {
    const healthy = join(root, 'healthy.mkv'), damaged = join(root, 'damaged.mkv');
    await run('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=2','-c:v','libx264','-preset','ultrafast',healthy]);
    const probe = JSON.parse((await run('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pos,size,flags','-of','json',healthy])).stdout);
    const packet = probe.packets.find(packet => !packet.flags.includes('K') && Number(packet.size) > 100);
    assert.ok(packet);
    const bytes = await readFile(healthy);
    // Break an H.264 NAL payload while retaining the container and timestamps.
    bytes.fill(0xff, Number(packet.pos) + 4, Number(packet.pos) + 8);
    await writeFile(damaged, bytes);
    const legacy = { key: 'episode', sourcePath: damaged, status: 'ready', timelineValidated: true };
    await assert.rejects(validateOfflinePlaybackRecord(legacy), { code: 'INVALID_MEDIA_DECODE' });
    const validated = await validateOfflinePlaybackRecord({ ...legacy, sourcePath: healthy });
    assert.equal(validated.decodeValidated, true);
    assert.equal(await validateOfflinePlaybackRecord(validated), validated);
  } finally { await rm(root, { recursive: true, force: true }); }
});
