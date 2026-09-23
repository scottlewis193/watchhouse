import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHlsSession } from '../src/lib/server/hls-session.js';

test('retries read identical completed segments without restarting conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-test-'));
  let starts = 0, stops = 0;
  let directory;
  const session = await createHlsSession({ root, async produce(dir) {
    starts++; directory = dir;
    await writeFile(join(dir, 'segment-000000.m4s'), 'encoded segment');
    await writeFile(join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment-000000.m4s\n');
    return { completion: new Promise(() => {}), stop() { stops++; } };
  }});
  try {
    await session.ready();
    const first = await session.read('segment-000000.m4s');
    const retry = await session.read('segment-000000.m4s');
    assert.deepEqual(first, retry);
    assert.equal(starts, 1);
    assert.match((await session.read('index.m3u8')).toString(), /segment-000000.m4s/);
    await assert.rejects(session.read('../settings.json'));
    await assert.rejects(session.read('segment-000000.m4s.tmp'));
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(stops, 1);
  await assert.rejects(access(directory));
});

test('idle sessions stop conversion and remove their segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-idle-'));
  let stopped;
  const didStop = new Promise(resolve => { stopped = resolve; });
  const session = await createHlsSession({ root, idleMs: 20, produce: async () => ({ completion: new Promise(() => {}), stop: stopped }) });
  try {
    await Promise.race([didStop, new Promise((_, reject) => setTimeout(() => reject(new Error('Idle converter was not stopped')), 500))]);
    await session.close();
    await assert.rejects(access(session.directory));
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('output monitoring marks a converter held for a full playback buffer as paused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-monitor-'));
  let observed;
  const sample = new Promise(resolve => { observed = resolve; });
  const session = await createHlsSession({ root, checkMs: 5, onMonitor: observed,
    produce: async () => ({ completion: new Promise(() => {}), position: () => 100, stop() {} }) });
  try {
    const state = await sample;
    assert.equal(state.position, 100);
    assert.equal(state.paused, true);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('conversion failure reaches playlist readers rather than silently hanging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-failure-'));
  const session = await createHlsSession({ root, produce: async () => ({ completion: Promise.reject(new Error('broken input')), stop() {} }) });
  try { await assert.rejects(session.ready(), /broken input/); }
  finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('real converted segments support identical full and resumed HTTP responses', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { ffmpegArgs, serveHlsAsset } = await import('../src/lib/server/streamer.js');
  const { hlsOutputArgs } = await import('../src/lib/server/hls-session.js');
  const { respond } = await import('../src/lib/server/response.js');
  const root = await mkdtemp(join(tmpdir(), 'hls-http-'));
  let starts = 0;
  let conversionDone;
  const session = await createHlsSession({ root, async produce(directory) {
    starts++;
    const args = ffmpegArgs('transcode', 'testsrc2=size=160x90:rate=25:duration=5', 'unused', true);
    args.splice(args.indexOf('-i'), 0, '-f', 'lavfi');
    const child = spawn('ffmpeg', hlsOutputArgs(args, directory));
    let error = ''; child.stderr.on('data', data => { error += data; });
    const completion = once(child, 'close').then(([code]) => { assert.equal(code, 0, error); });
    conversionDone = completion;
    return { completion, stop: () => completion };
  }});
  const request = async (asset, headers = {}, method = 'GET') => {
    const url = new URL(`http://localhost/${asset}`);
    return respond(new Request(url, { headers, method }), url, (req, res) => serveHlsAsset(req, res, session, asset));
  };
  try {
    await session.ready();
    await conversionDone;
    const playlist = await (await request('index.m3u8')).text();
    assert.match(playlist, /#EXT-X-MAP:URI="init.mp4"/);
    assert.match(playlist, /#EXT-X-ENDLIST/);
    const full = Buffer.from(await (await request('segment-000000.m4s')).arrayBuffer());
    const retry = await request('segment-000000.m4s', { range: 'bytes=100-' });
    assert.equal(retry.status, 206);
    assert.equal(retry.headers.get('content-range'), `bytes 100-${full.length - 1}/${full.length}`);
    assert.deepEqual(Buffer.from(await retry.arrayBuffer()), full.subarray(100));
    assert.deepEqual(Buffer.from(await (await request('segment-000000.m4s')).arrayBuffer()), full);
    const head = await request('init.mp4', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const invalid = await request('segment-000000.m4s', { range: `bytes=${full.length}-` });
    assert.equal(invalid.status, 416); await invalid.text();
    assert.equal(starts, 1);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('segmented playback selects one English track ahead of configured fallback', async () => {
  const { preferredAudioStream } = await import('../src/lib/server/streamer.js');
  const streams = [{ index: 0, codec_type: 'video' }, { index: 1, codec_type: 'audio', tags: { language: 'fra' } }, { index: 2, codec_type: 'audio', tags: { language: 'eng', title: 'English' } }];
  assert.equal(preferredAudioStream(streams, 1), 2);
  assert.equal(preferredAudioStream(streams.map(stream => ({ ...stream, tags: {} })), 2), 2);
  assert.equal(preferredAudioStream(streams.slice(0, 2), 2), 1);
  assert.equal(preferredAudioStream(streams.slice(0, 1)), null);
});

test('does not advertise end of playback before conversion succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-pending-end-'));
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const session = await createHlsSession({ root, async produce(directory) {
    await writeFile(join(directory, 'index.m3u8'), '#EXTM3U\n#EXTINF:4,\nsegment-000000.m4s\n#EXT-X-ENDLIST\n');
    return { completion, expectedDuration: 4, stop() {} };
  }});
  try {
    await session.ready();
    assert.doesNotMatch((await session.read('index.m3u8')).toString(), /#EXT-X-ENDLIST/);
    finish(); await completion;
    assert.match((await session.read('index.m3u8')).toString(), /#EXT-X-ENDLIST/);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed converter cannot turn truncated playback into a completed episode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-failed-end-'));
  let fail;
  const completion = new Promise((_, reject) => { fail = reject; });
  const session = await createHlsSession({ root, async produce(directory) {
    await writeFile(join(directory, 'index.m3u8'), '#EXTM3U\n#EXTINF:4,\nsegment-000000.m4s\n#EXT-X-ENDLIST\n');
    return { completion, expectedDuration: 12, stop() {} };
  }});
  try {
    assert.doesNotMatch((await session.read('index.m3u8')).toString(), /#EXT-X-ENDLIST/);
    fail(new Error('input ended prematurely'));
    await assert.rejects(completion);
    await assert.rejects(session.read('index.m3u8'), /input ended prematurely/);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('a late converter failure keeps a playlist that covers the expected remaining runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-covered-end-'));
  let fail;
  const completion = new Promise((_, reject) => { fail = reject; });
  const session = await createHlsSession({ root, async produce(directory) {
    await writeFile(join(directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment-000000.m4s\n#EXTINF:4,\nsegment-000001.m4s\n#EXT-X-ENDLIST\n');
    return { completion, expectedDuration: 8, stop() {} };
  }});
  try {
    fail(new Error('input ended with a damaged trailing packet'));
    await assert.rejects(completion);
    await session.ready();
    assert.match((await session.read('index.m3u8')).toString(), /#EXT-X-ENDLIST/);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('resume readiness allows extraction progress beyond the ordinary startup deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hls-resume-progress-'));
  let now = 0, bytes = 0;
  t.mock.method(Date, 'now', () => now);
  const session = await createHlsSession({ root, produce: async () => ({ completion: new Promise(() => {}), stop() {} }) });
  try {
    const ready = session.ready({ progress: () => bytes, maxWaitMs: 300000 });
    await writeFile(`${session.directory}/index.m3u8`, '#EXTM3U\n#EXTINF:4,\nsegment-000000.m4s\n');
    bytes = 1000000; now = 50000;
    await ready;
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('extended resume preparation still stops on inactivity or its hard deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hls-resume-limit-'));
  let now = 0, bytes = 0;
  t.mock.method(Date, 'now', () => now);
  try {
    for (const progresses of [false, true]) {
      now = 0; bytes = 0;
      const session = await createHlsSession({ root, produce: async () => ({ completion: new Promise(() => {}), stop() {} }) });
      try {
        const ready = session.ready({ progress: () => bytes, maxWaitMs: 300000 });
        now = progresses ? 300001 : 45001;
        if (progresses) bytes = 1000000;
        await assert.rejects(ready, /Timed out/);
      } finally { await session.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('admission limits release slots after producer setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-admission-'));
  let finish;
  try {
    const pending = createHlsSession({root,maxSessions:1,produce:()=>new Promise(resolve=>{finish=resolve;})});
    await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(createHlsSession({root,maxSessions:1,produce:()=>assert.fail('must not start another converter')}),{code:'PLAYBACK_BUSY'});
    finish({completion:Promise.resolve(),stop:async()=>{}});
    const session=await pending; await session.close();
    const replacement=await createHlsSession({root,maxSessions:1,produce:async()=>({completion:Promise.resolve(),stop:async()=>{}})});
    await replacement.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('paused and far-ahead producers stop growing and resume near the playhead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-pause-')); const states=[];
  const session=await createHlsSession({root,produce:async()=>({completion:Promise.resolve(),stop:async()=>{},position:()=>100,setPaused:value=>states.push(value)})});
  try {
    session.playbackState({paused:true,position:90});
    session.playbackState({paused:false,position:0});
    session.playbackState({paused:false,position:60});
    assert.deepEqual(states,[true,true,false]);
  } finally {await session.close();await rm(root,{recursive:true,force:true});}
});

test('temporary output exceeding its quota closes the converter and removes assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hls-quota-')); let stopped=0,finish;
  const closed=new Promise(resolve=>finish=resolve);
  const session=await createHlsSession({root,maxBytes:4,checkMs:10,onClose:finish,produce:async directory=>{
    await writeFile(join(directory,'segment-000000.m4s'),'oversized');
    return {completion:Promise.resolve(),stop:async()=>{stopped++;}};
  }});
  try {
    await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Quota not enforced')),1000))]);
    assert.equal(stopped,1); assert.equal(session.health().closed,true);
    assert.deepEqual(await readdir(root),[]);
  } finally {await session.close();await rm(root,{recursive:true,force:true});}
});
