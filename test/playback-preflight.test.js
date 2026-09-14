import test from 'node:test';
import assert from 'node:assert/strict';
import { postedFileAvailable } from '../src/lib/server/streamer.js';

test('selection reads and validates sampled articles rather than trusting STAT', async () => {
  const file={subject:'video.mkv',segments:Array.from({length:8},(_,i)=>({id:String(i),number:i+1}))};
  const checked=[];
  const connect=async()=>({
    async body(id,onLine){
      const i=Number(id);checked.push(i);
      const bytes=i===0?Buffer.from([0x1a,0x45,0xdf,0xa3]):Buffer.from([1,2,3,4]);
      await onLine(`=ybegin size=${i===4?80:32} name=video.mkv`);
      await onLine(`=ypart begin=${i*4+1} end=${i*4+4}`);
      let encoded='';for(const b of bytes){let v=(b+42)&255;if([0,10,13,61].includes(v)){encoded+='=';v=(v+64)&255;}encoded+=String.fromCharCode(v);}
      await onLine(encoded);await onLine('=yend size=4');
    },async has(){return true;},close(){}
  });
  await assert.rejects(postedFileAvailable(file,{maxConnections:2},connect),{code:'INVALID_USENET_ARTICLE'});
  assert.ok(checked.includes(4),'must read a body from the middle of the file');
});

test('audio probing is shared across starts but retried after failure and audio-policy changes', async () => {
  const { cachedAudioProbe } = await import('../src/lib/server/streamer.js');
  const source={};let calls=0;
  const inspect=async()=>{calls++;return 2;};
  assert.deepEqual(await Promise.all([cachedAudioProbe(source,1,inspect),cachedAudioProbe(source,1,inspect)]),[2,2]);
  await cachedAudioProbe(source,1,inspect);
  assert.equal(calls,1);
  await cachedAudioProbe(source,2,inspect);
  assert.equal(calls,2);
  const broken={};
  await assert.rejects(cachedAudioProbe(broken,1,async()=>{throw new Error('temporary');}));
  assert.equal(await cachedAudioProbe(broken,1,inspect),2);
});

test('source inspection reuses all validated availability samples, including the file tail', async () => {
  const { openPostedRangeServer } = await import('../src/lib/server/streamer.js');
  const file = { subject: 'video.mkv', segments: Array.from({ length: 8 }, (_, i) => ({ id: String(i), number: i + 1 })) };
  const checked = [];
  const connect = async () => ({
    async body(id, onLine) {
      const i = Number(id); checked.push(i);
      const bytes = i === 0 ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) : Buffer.from([1, 2, 3, 4]);
      await onLine('=ybegin size=32 name=video.mkv');
      await onLine(`=ypart begin=${i * 4 + 1} end=${i * 4 + 4}`);
      let encoded = '';
      for (const b of bytes) { let v = (b + 42) & 255; if ([0, 10, 13, 61].includes(v)) { encoded += '='; v = (v + 64) & 255; } encoded += String.fromCharCode(v); }
      await onLine(encoded); await onLine('=yend size=4');
    }, close() {}
  });
  let connections = 0;
  const first = await postedFileAvailable(file, { maxConnections: 2 }, () => { connections++; return connect(); });
  assert.equal(connections, 2, 'reuse the authenticated header connection for the remaining samples');
  const reads = checked.length;
  const source = await openPostedRangeServer({ file, prefetchedSegments: new Map([[0, first]]) }, { maxConnections: 2 }, connect);
  try {
    const tail = await fetch(source.url, { headers: { range: 'bytes=28-31' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
    assert.equal(checked.length, reads, 'inspection must not redownload a tail article already read during availability checks');
  } finally { await source.close(); }
});

test('a single-article video releases the header connection even without further samples', async () => {
  let closed = 0;
  const bytes = Buffer.from('0000ftyp');
  const first = await postedFileAvailable({ subject: 'video.mp4', segments: [{ id: 'one', number: 1 }] }, {}, async () => ({
    async body(_id, line) {
      await line('=ybegin size=8 name=video.mp4');
      await line('=ypart begin=1 end=8');
      await line(Buffer.from(bytes.map(byte => (byte + 42) & 255)).toString('latin1'));
      await line('=yend size=8');
    }, close() { closed++; }
  }));
  assert.deepEqual(first, bytes);
  assert.equal(closed, 1);
});

test('cancelling speculative preparation interrupts authentication rather than waiting for its timeout', async () => {
  const { createServer } = await import('node:net');
  const { testNntp } = await import('../src/lib/server/streamer.js');
  const controller = new AbortController(), sockets = new Set();
  let authenticating;
  const started = new Promise(resolve => { authenticating = resolve; });
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('200 Ready\r\n');
    socket.on('data', data => {
      if (data.toString().includes('AUTHINFO USER')) socket.write('381 Password required\r\n');
      if (data.toString().includes('AUTHINFO PASS')) authenticating();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pending = testNntp({ usenetHost: '127.0.0.1', usenetPort: server.address().port, usenetUser: 'fixture', usenetPass: 'fixture', signal: controller.signal });
  void pending.catch(() => {});
  let timer;
  try {
    await started; controller.abort(new Error('Preparation superseded'));
    const interrupted = await Promise.race([pending.then(() => false, () => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 150); })]);
    assert.equal(interrupted, true, 'a cancelled login must release the provider slot immediately');
  } finally {
    clearTimeout(timer); for (const socket of sockets) socket.destroy();
    await pending.catch(() => {}); await new Promise(resolve => server.close(resolve));
  }
});
