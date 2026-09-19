import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optimizeCachedVideo } from '../src/lib/server/streamer.js';

const run = promisify(execFile);

test('background downloads and prepared next episodes are browser-ready before they are marked ready', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'background-offline-'));
  try {
    const source = join(directory, 'episode.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'mpeg4', '-c:a', 'eac3', source]);
    for (const kind of ['offlineDownload', 'prepareAhead']) {
      const ready = await optimizeCachedVideo({ [kind]: true, backgroundFor: 'playing-episode', directory, release: 'SDR', untaggedAudioTrack: 1, events: [] }, source);
      assert.equal(ready.mode, undefined, `${kind} must not need live conversion during playback`);
      assert.match(ready.path, /\.browser\.mp4$/);
      assert.ok((await stat(ready.path)).size > 0);
      const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', ready.path])).stdout);
      assert.equal(probe.streams.find(stream => stream.codec_type === 'video')?.codec_name, 'h264');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
