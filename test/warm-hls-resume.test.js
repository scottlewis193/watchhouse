import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHlsSession, hlsOutputArgs } from '../src/lib/server/hls-session.js';
import { preflightLiveCandidate, preparePlayback } from '../src/lib/server/streamer.js';

for (const origin of [0, 40]) {
  test(`retained video from ${origin}s resumes without selection, conversion or a shifted media clock`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'warm-hls-resume-'));
    const media = { type: 'movie', id: 910043 + origin, title: 'Warm resume fixture', year: '2024' };
    const settings = { targetResolution: '2160p', playbackQuality: 'fast' };
    const original = { id: `warm-original-${origin}`, media, events: [], status: 'ready', mode: 'direct', strategy: 'transcode', release: 'Fixture.1080p.SDR', releaseKey: 'warm-fixture', sourceDuration: origin + 24 };
    let session, encodes = 0, completion;
    try {
      original.preparedSession = await preflightLiveCandidate(original, settings, origin, {
        sessionFactory: async options => session = await createHlsSession({ ...options, root }),
        convert: async (_job, _settings, _start, directory) => {
          encodes++;
          const child = spawn('ffmpeg', hlsOutputArgs(['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-movflags', '+faststart', 'unused'], directory, 2));
          let error = ''; child.stderr.on('data', bytes => { error += bytes; });
          completion = once(child, 'close').then(([code]) => { assert.equal(code, 0, error); });
          await completion;
          return { completion, stop: () => completion, position: () => 24, expectedDuration: 24 };
        }, observationMs: 0
      });
      await completion;
      const segment = await session.read('segment-000002.m4s');
      const oldSessionUrl = original.preparedSession.sessionUrl;
      session.detach();
      const misses = [[{ ...settings, targetResolution: '720p' }, origin + 5.125], [settings, origin + 24]];
      if (origin) misses.push([settings, origin - 1]);
      for (const [changedSettings, position] of misses) {
        let searched = false;
        const miss = { id: 'warm-miss', media, events: [], selectionStart: position };
        await preparePlayback(miss, changedSettings, { search: async () => { searched = true; return []; }, persistence: null });
        assert.equal(searched, true, 'incompatible or uncovered positions must use source selection');
        assert.equal(miss.status, 'error');
        assert.equal(session.health().detached, true);
      }
      const resumed = { id: `warm-resumed-${origin}`, media, events: [], selectionStart: origin + 5.125 };
      const started = performance.now();
      await preparePlayback(resumed, settings, { search: async () => assert.fail('retained video must not search for releases'), persistence: null });
      assert.equal(resumed.status, 'ready', resumed.message);
      assert.equal(resumed.preparedSession.start, origin + 5.125);
      assert.equal(resumed.preparedSession.offset, origin);
      assert.equal(resumed.preparedSession.position, 5.125);
      assert.notEqual(resumed.preparedSession.sessionUrl, oldSessionUrl);
      assert.deepEqual(await session.read('segment-000002.m4s'), segment);
      assert.equal(encodes, 1);
      assert.equal(session.health().detached, false);
      console.log(`Retained encoded resume lookup (origin ${origin}s): ${(performance.now() - started).toFixed(1)}ms`);
    } finally { await session?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
