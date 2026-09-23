import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlayableHlsOpening, preflightLiveCandidate } from '../src/lib/server/streamer.js';

test('rejects a large opening timestamp gap like the observed buffered-only tail', () => {
  assert.doesNotThrow(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '0.023' }, { codec_type: 'audio', start_time: '0.023' }]));
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio', start_time: '0' }]), { code: 'INVALID_MEDIA_TIMELINE' });
});

test('keeps a candidate that produces segments faster than playback', async () => {
  let closed = false, position = 2;
  const result = await preflightLiveCandidate({ id: 'job', playbackTracks: [] }, {}, 120, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => { closed = true; }
    }),
    convert: async () => {},
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    wait: async () => { position += 8; },
    sampleMs: 6000
  });
  assert.equal(result.start, 120);
  assert.match(result.playlistUrl, /index\.m3u8$/);
  assert.equal(closed, false);
});

test('rejects and closes a candidate that cannot keep producing segments', async () => {
  let closed = false;
  await assert.rejects(preflightLiveCandidate({ id: 'job' }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position: 2, completed: false }),
      close: async () => { closed = true; }
    }),
    convert: async () => {}, inspect: async () => [{ codec_type: 'video', start_time: '0' }], wait: async () => {}, sampleMs: 6000
  }), { code: 'PLAYBACK_TOO_SLOW' });
  assert.equal(closed, true);
});
