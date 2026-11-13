import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { assertPlayableHlsOpening, preflightLiveCandidate } from '../src/lib/server/streamer.js';
import { createHlsSession } from '../src/lib/server/hls-session.js';

const run = promisify(execFile);

test('preflight marks conversion so archive fallback stays with release selection', async () => {
  let preflightFlag;
  let position = 2;
  await preflightLiveCandidate({ id: 'job', playbackTracks: [] }, {}, 0, {
    sessionFactory: async ({ produce }) => {
      await produce('/unused');
      return { directory: '/unused', read: async () => Buffer.from('#EXTINF:2.0,'), health: () => ({ position, completed: false }), close: async () => {} };
    },
    convert: async (_job, settings) => { preflightFlag = settings.preflight; },
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    wait: async ms => { if (ms === 2000) position += 8; }
  });
  assert.equal(preflightFlag, true);
});

test('rejects a large opening timestamp gap like the observed buffered-only tail', () => {
  assert.doesNotThrow(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '0.023' }, { codec_type: 'audio', start_time: '0.023' }]));
  assert.doesNotThrow(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '10.7' }, { codec_type: 'audio', start_time: '10.6' }]));
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio', start_time: '0' }]), { code: 'INVALID_MEDIA_TIMELINE' });
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '0' }, { codec_type: 'audio', start_time: '10' }]), { code: 'INVALID_MEDIA_TIMELINE' });
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '10' }]), { code: 'INVALID_MEDIA_TIMELINE' });
  assert.throws(() => assertPlayableHlsOpening([]), { code: 'PLAYBACK_SEGMENT_PROBE_FAILED' });
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio' }]), { code: 'PLAYBACK_SEGMENT_PROBE_FAILED' });
  assert.throws(() => assertPlayableHlsOpening([{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio', start_time: null }]), { code: 'PLAYBACK_SEGMENT_PROBE_FAILED' });
});

test('retries an empty opening probe before accepting a playable segment', async () => {
  let inspections = 0, position = 2;
  const job = { id: 'job', playbackTracks: [] };
  await preflightLiveCandidate(job, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {},
    inspect: async () => ++inspections === 1 ? [] : [{ codec_type: 'video', start_time: '0' }],
    wait: async ms => { if (ms === 2000) position += 8; }
  });
  assert.equal(inspections, 2);
});

test('waits for an audio timestamp before judging a nonzero HLS origin', async () => {
  let inspections = 0, position = 2;
  const result = await preflightLiveCandidate({ id: 'job', playbackTracks: [] }, {}, 23, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {},
    inspect: async () => ++inspections === 1
      ? [{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio' }]
      : [{ codec_type: 'video', start_time: '125.3' }, { codec_type: 'audio', start_time: '125.28' }],
    wait: async ms => { if (ms === 2000) position += 8; }
  });
  assert.equal(inspections, 2);
  assert.equal(result.start, 23);
});

test('accepts an HLS opening whose audio and video share a nonzero timestamp origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchhouse-hls-origin-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', '-output_ts_offset', '10', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_list_size', '0', '-hls_segment_filename',
      join(directory, 'segment-%06d.m4s'), join(directory, 'index.m3u8')]);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', join(directory, 'index.m3u8')]);
    const streams = JSON.parse(stdout).streams;
    assert.ok(Number(streams.find(stream => stream.codec_type === 'video').start_time) > 3);
    assert.doesNotThrow(() => assertPlayableHlsOpening(streams));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('keeps a candidate that produces segments faster than playback', async () => {
  let closed = false, position = 2;
  let onClose;
  const waits = [];
  const job = { id: 'job', playbackTracks: [], diagnosticsEnabled: true, events: [] };
  const result = await preflightLiveCandidate(job, {}, 120, {
    sessionFactory: async options => { onClose = options.onClose; return ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => { closed = true; }
    }); },
    convert: async () => {},
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    wait: async ms => { waits.push(ms); position += 8; }
  });
  assert.equal(result.start, 120);
  assert.match(result.playlistUrl, /index\.m3u8$/);
  assert.equal(closed, false);
  job.preparedSession = result;
  onClose();
  assert.equal(job.preparedSession, undefined);
  assert.deepEqual(waits, [2000], 'a healthy converter must not wait through the six-second slow-path check');
  assert.equal(job.events.find(event => event.activity === 'playback-speed').producedSeconds, 8);
});

test('checks output speed while probing the first segment', async () => {
  let position = 2, observationStarted = false;
  const result = await preflightLiveCandidate({ id: 'job', playbackTracks: [] }, {}, 120, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {},
    inspect: async () => {
      assert.equal(observationStarted, true, 'the speed observation should already be running during the HLS probe');
      return [{ codec_type: 'video', start_time: '0' }, { codec_type: 'audio', start_time: '0' }];
    },
    wait: async ms => {
      if (ms === 2000) { observationStarted = true; position += 4; }
    }
  });
  assert.equal(result.start, 120);
});

test('a slow HLS probe does not inflate the measured conversion rate', async () => {
  let elapsed = 0, position = 2;
  await assert.rejects(preflightLiveCandidate({ id: 'job', playbackTracks: [] }, {}, 120, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {},
    inspect: async () => {
      elapsed += 5000;
      position = 8;
      return [{ codec_type: 'video', start_time: '0' }, { codec_type: 'audio', start_time: '0' }];
    },
    now: () => elapsed,
    wait: async ms => { elapsed += ms; }
  }), { code: 'PLAYBACK_TOO_SLOW' });
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

test('a torrent startup burst cannot substitute for sustained playback output', async () => {
  let elapsed = 0, position = 2, burst = false, closed = false;
  await assert.rejects(preflightLiveCandidate({ id: 'torrent-burst' }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => { closed = true; }
    }),
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    now: () => elapsed,
    wait: async ms => { elapsed += ms; position += ms / 1000 * 0.6; if (!burst) { position += 8; burst = true; } },
    observationMs: 10000, minimumRate: 1.25, sustained: true
  }), { code: 'PLAYBACK_TOO_SLOW' });
  assert.equal(closed, true);
});

for (const rate of [1.1, 1.3]) test(`torrent output at ${rate}x ${rate < 1.25 ? 'fails' : 'passes'} the playback headroom requirement`, async () => {
  let elapsed = 0, position = 2;
  const check = preflightLiveCandidate({ id: `torrent-rate-${rate}` }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    now: () => elapsed,
    wait: async ms => { elapsed += ms; position += ms / 1000 * rate; },
    observationMs: 10000, minimumRate: 1.25, sustained: true
  });
  if (rate < 1.25) await assert.rejects(check, { code: 'PLAYBACK_TOO_SLOW' });
  else assert.match((await check).playlistUrl, /index\.m3u8$/);
});

test('cancelling a sustained playback check closes its session promptly', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let closed = false;
  await assert.rejects(preflightLiveCandidate({ id: 'torrent-cancel' }, { signal: controller.signal }, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position: 2, completed: false }),
      close: async () => { closed = true; }
    }),
    inspect: async () => {
      controller.abort();
      return [{ codec_type: 'video', start_time: '0' }];
    },
    observationMs: 10000, minimumRate: 1.25, sustained: true
  }), { name: 'AbortError' });
  assert.equal(closed, true);
});

test('the overall deadline cancels a stalled opening inspection and frees its session', { timeout: 1000 }, async () => {
  let closed = false, inspectionSignal;
  await assert.rejects(preflightLiveCandidate({ id: 'stalled-opening' }, {}, 0, {
    timeoutMs: 20,
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position: 2, completed: false }),
      close: async () => { closed = true; }
    }),
    inspect: async (_directory, signal) => {
      inspectionSignal = signal;
      return new Promise(() => {});
    },
    wait: async () => {}
  }), { code: 'PLAYBACK_PREFLIGHT_TIMEOUT' });
  assert.equal(inspectionSignal.aborted, true);
  assert.equal(closed, true);
});

test('Usenet preflight retains its default overall deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let inspecting, closed = false, settled = false;
  const started = new Promise(resolve => { inspecting = resolve; });
  const pending = preflightLiveCandidate({ id: 'usenet-deadline' }, {}, 0, {
    sessionFactory: async () => ({
      read: async () => Buffer.from('#EXTINF:2.0,'),
      health: () => ({ position: 2, completed: false }),
      close: async () => { closed = true; }
    }),
    inspect: async () => { inspecting(); return new Promise(() => {}); },
    wait: async () => {}
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started;
  t.mock.timers.tick(44999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, { code: 'PLAYBACK_PREFLIGHT_TIMEOUT' });
  assert.equal(closed, true);
});

test('parent cancellation also closes a session that finishes opening after cancellation', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let finishOpening, closed = false, conversionSignal;
  const pending = preflightLiveCandidate({ id: 'stalled-session' }, { signal: controller.signal }, 0, {
    sessionFactory: async ({ produce }) => {
      await produce('/unused');
      return new Promise(resolve => { finishOpening = () => resolve({ close: async () => { closed = true; } }); });
    },
    convert: async (_job, settings) => { conversionSignal = settings.signal; }
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(conversionSignal.aborted, true);
  finishOpening();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
});

for (const stage of ['headers', 'body']) test(`torrent preflight kills a source stalled at HTTP ${stage} within its inspection budget and allows a fresh inspection`, { timeout: 10000 }, async t => {
  const { stdout: video } = await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'matroska', 'pipe:1'], { encoding: 'buffer' });
  const job = { id: `stalled-${stage}`, mode: 'cached-convert', strategy: 'remux', torrentSource: {}, diagnosticsEnabled: true, events: [] };
  let reachedStall, connectionClosed, stalledRequests = 0;
  const server = createServer((_req, res) => {
    stalledRequests++;
    res.on('close', () => connectionClosed());
    if (stage === 'body') {
      res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': video.length });
      res.write(video.subarray(0, 512));
    }
    reachedStall();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  job.sourcePath = `http://127.0.0.1:${server.address().port}/video.mkv`;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      job.events.length = 0;
      const stalled = new Promise(resolve => { reachedStall = resolve; });
      const disconnected = new Promise(resolve => { connectionClosed = resolve; });
      let settled = false;
      const pending = preflightLiveCandidate(job, { repairVideoTimeline: true }, 0, { timeoutMs: 30000 });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await stalled;
      t.mock.timers.tick(19999);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'the source still has its stage budget before the deadline');
      t.mock.timers.tick(1);
      await assert.rejects(pending, { code: 'PLAYBACK_PROBE_TIMEOUT' });
      await disconnected;
      assert.equal(job.preparedSession, undefined);
    }
    assert.equal(stalledRequests, 2, 'a timed-out inspection must not be reused for the same source');
  } finally {
    t.mock.timers.reset();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('torrent Matroska opening remains playable when tail ranges are unavailable', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'torrent-forward-opening-'));
  let server, session;
  try {
    const input = join(directory, 'source.mkv');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', '4M', '-minrate', '4M', '-maxrate', '4M', '-bufsize', '4M', '-x264-params', 'nal-hrd=cbr', '-c:a', 'aac', input]);
    const video = await readFile(input);
    server = createServer((req, res) => {
      if (Number(req.headers.range?.match(/^bytes=(\d+)-/)?.[1]) > 0) return;
      const headers = { 'content-type': 'video/x-matroska', 'content-length': video.length, 'accept-ranges': 'bytes' };
      if (req.headers.range) headers['content-range'] = `bytes 0-${video.length - 1}/${video.length}`;
      res.writeHead(req.headers.range ? 206 : 200, headers); res.end(video);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const job = { id: 'torrent-forward-opening', mode: 'cached-convert', strategy: 'remux',
      sourcePath: `http://127.0.0.1:${server.address().port}/source.mkv`, torrentSource: {} };
    await preflightLiveCandidate(job, { repairVideoTimeline: true }, 0, {
      timeoutMs: 8000,
      sessionFactory: async options => {
        session = await createHlsSession({ ...options, root: directory });
        return session;
      }
    });
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-nostats', '-progress', 'pipe:1',
      '-i', join(session.directory, 'index.m3u8'), '-t', '2', '-f', 'null', '-']);
    assert.ok([...stdout.matchAll(/^out_time_us=(\d+)/gm)].some(match => Number(match[1]) >= 1900000));
    assert.ok([...stdout.matchAll(/^frame=(\d+)/gm)].some(match => Number(match[1]) > 0));
    assert.ok(job.sourceDuration >= 8 && job.sourceDuration < 8.5);
  } finally {
    await session?.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
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

test('an advancing converter can finish a long first segment after the initial deadline', async () => {
  let elapsed = 0, position = 0;
  const job = { id: 'job', playbackTracks: [], diagnosticsEnabled: true, events: [] };
  await preflightLiveCandidate(job, {}, 6826, {
    sessionFactory: async () => ({
      read: async () => Buffer.from(elapsed >= 12000 ? '#EXTINF:10.4,' : '#EXTM3U'),
      health: () => ({ position, completed: false }),
      close: async () => {}
    }),
    convert: async () => {}, inspect: async () => [{ codec_type: 'video', start_time: '0' }],
    now: () => elapsed,
    wait: async ms => { elapsed += ms; if (elapsed >= 8000 && position === 0) position = 11.8; if (ms === 2000) position += 8; },
    firstSegmentMs: 8000
  });
  assert.equal(elapsed, 14000);
  assert.ok(job.events.some(event => event.message?.includes('waiting for the first segment boundary')));
});
