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
  const first = await postedFileAvailable(file, { maxConnections: 2 }, connect);
  const reads = checked.length;
  const source = await openPostedRangeServer({ file, prefetchedSegments: new Map([[0, first]]) }, { maxConnections: 2 }, connect);
  try {
    const tail = await fetch(source.url, { headers: { range: 'bytes=28-31' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
    assert.equal(checked.length, reads, 'inspection must not redownload a tail article already read during availability checks');
  } finally { await source.close(); }
});
