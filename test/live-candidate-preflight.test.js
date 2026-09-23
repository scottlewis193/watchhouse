import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlayableHlsOpening, preflightLiveCandidate } from '../src/lib/server/streamer.js';

test('rejects a large opening timestamp gap like the observed buffered-only tail', () => {
  assert.doesNotThrow(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '0.023' }, { codec_type: 'audio', start_time: '0.023' }]));
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio', start_time: '0' }]), { code: 'INVALID_MEDIA_TIMELINE' });
});

test('keeps a candidate that produces segments faster than playback', async () => {
  let closed = false, position = 2;
  const waits = [];
  const job = { id: 'job', playbackTracks: [], diagnosticsEnabled: true, events: [] };
  const result = await preflightLiveCandidate(job, {}, 120, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => { closed = true; }
    }),
    convert: async () => {},
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    wait: async ms => { waits.push(ms); position += 8; }
  });
  assert.equal(result.start, 120);
  assert.match(result.playlistUrl, /index\.m3u8$/);
  assert.equal(closed, false);
  assert.deepEqual(waits, [2000], 'a healthy converter must not wait through the six-second slow-path check');
  assert.equal(job.events.find(event => event.activity === 'playback-speed').producedSeconds, 8);
});

test('rejects and closes a candidate that cannot keep producing segments', async () => {
  let closed = false;
  const waits = [];
  await assert.rejects(preflightLiveCandidate({ id: 'job' }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position: 2, completed: false }),
      close: async () => { closed = true; }
    }),
    convert: async () => {}, inspect: async () => [{ codec_type: 'video', start_time: '0' }], wait: async ms => { waits.push(ms); }
  }), { code: 'PLAYBACK_TOO_SLOW' });
  assert.equal(closed, true);
  assert.deepEqual(waits, [2000, 4000], 'a slow converter still gets the full observation window');
});

test('a converter that recovers after a slow start can pass the longer check', async () => {
  let position = 2;
  const waits = [];
  await preflightLiveCandidate({ id: 'job' }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {}, inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    wait: async ms => { waits.push(ms); position += ms === 2000 ? 1 : 6; }
  });
  assert.deepEqual(waits, [2000, 4000]);
});

test('a candidate with no first segment fails within the short startup budget', async () => {
  let elapsed = 0, closed = false;
  const job = { id: 'job', diagnosticsEnabled: true, events: [] };
  await assert.rejects(preflightLiveCandidate(job, {}, 0, {
    sessionFactory: async () => ({
      read: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
      close: async () => { closed = true; }
    }),
    convert: async () => {}, now: () => elapsed, wait: async ms => { elapsed += ms; }
  }), { code: 'NO_PLAYABLE_SEGMENT' });
  assert.equal(elapsed, 8000);
  assert.equal(closed, true);
  assert.equal(job.events.find(event => event.activity === 'playback-speed').firstSegmentMs, 8000);
});

test('a slow-starting converter can pass a longer first-segment budget', async () => {
  let elapsed = 0, position = 0;
  const job = { id: 'job', playbackTracks: [] };
  const result = await preflightLiveCandidate(job, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from(elapsed >= 10000 ? '#EXTINF:2.0,' : '#EXTM3U'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {}, inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    now: () => elapsed,
    wait: async ms => { elapsed += ms; if (ms >= 2000) position += 8; },
    firstSegmentMs: 15000
  });
  assert.match(result.playlistUrl, /index\.m3u8$/);
  assert.equal(elapsed, 12000);
});
