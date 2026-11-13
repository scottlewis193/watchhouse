import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHlsSession } from '../src/lib/server/hls-session.js';
import { preflightLiveCandidate } from '../src/lib/server/streamer.js';

test('abandoning successful speculative playback closes its retained HLS session and releases the viewer slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prewarm-session-lifetime-'));
  const controller = new AbortController();
  let prepared, foreground;
  const produce = async directory => {
    await writeFile(join(directory, 'index.m3u8'), '#EXTM3U\n#EXTINF:4,\nsegment-000000.m4s\n');
    let complete;
    return { completion: new Promise(resolve => { complete = resolve; }), stop: async () => complete(), position: () => 8 };
  };
  try {
    await preflightLiveCandidate({ id: 'speculative', media: { type: 'movie' }, events: [], speculative: true }, { signal: controller.signal }, 0, {
      sessionFactory: async options => { prepared = await createHlsSession({ ...options, root, maxSessions: 1, produce }); return prepared; },
      inspect: async () => [{ codec_type: 'video', start_time: '0' }, { codec_type: 'audio', start_time: '0' }],
      observationMs: 0, minimumRate: 0
    });
    assert.equal(prepared.health().closed, false);
    controller.abort(new Error('Play intent abandoned'));
    assert.equal(prepared.health().closed, true);
    await prepared.close();
    foreground = await createHlsSession({ root, maxSessions: 1, produce });
    assert.equal(foreground.health().closed, false);
  } finally {
    await prepared?.close();
    await foreground?.close();
    await rm(root, { recursive: true, force: true });
  }
});
