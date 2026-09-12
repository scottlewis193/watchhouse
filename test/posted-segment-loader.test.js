import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostedSegmentLoader, writePostedFileRange } from '../src/lib/server/streamer.js';

const posted = { segments: [{ id: 'part-1', number: 1, decodedBytes: 4 }, { id: 'part-2', number: 2, decodedBytes: 4 }] };
async function article(onLine, bytes, begin, total = 8) {
  await onLine(`=ybegin part=2 total=2 line=128 size=${total} name=video.mkv`);
  await onLine(`=ypart begin=${begin} end=${begin + bytes.length - 1}`);
  await onLine(Buffer.from([...bytes].map(byte => byte + 42)).toString('latin1'));
  await onLine(`=yend size=${bytes.length} part=2`);
}

for (const mismatch of ['size', 'range', 'file']) {
  test(`retries a ${mismatch} mismatch before emitting bytes to the converter`, async () => {
    let connections = 0, closed = 0;
    const requested = [], output = [];
    const loader = createPostedSegmentLoader(posted, { maxConnections: 1 }, new Map(), async () => {
      const attempt = ++connections;
      return {
        async body(id, onLine) {
          requested.push(id);
          if (attempt === 1) await article(onLine, Buffer.from(mismatch === 'size' ? 'XY' : 'WXYZ'), mismatch === 'range' ? 1 : 5, mismatch === 'file' ? 80 : 8);
          else await article(onLine, Buffer.from('EFGH'), 5);
        },
        close() { closed++; }
      };
    });
    try {
      await writePostedFileRange(posted, 4, 7, loader.load, chunk => output.push(chunk));
      assert.equal(Buffer.concat(output).toString(), 'EFGH');
      assert.deepEqual(requested, ['part-2', 'part-2']);
      assert.equal(connections, 2);
      assert.equal(closed, 1);
    } finally { await loader.close(); }
    assert.equal(closed, 2);
  });
}

test('persistent invalid articles fail after a bounded retry without emitting corrupt bytes', async () => {
  let connections = 0, emitted = 0, closed = 0;
  const loader = createPostedSegmentLoader(posted, { maxConnections: 1 }, new Map(), async () => {
    connections++;
    return { body: (_id, onLine) => article(onLine, Buffer.from('XY'), 5), close() { closed++; } };
  });
  try {
    await assert.rejects(writePostedFileRange(posted, 4, 7, loader.load, () => emitted++), /yEnc|metadata/);
    assert.equal(emitted, 0);
    assert.equal(connections, 6);
    assert.equal(closed, 6);
  } finally { await loader.close(); }
});

test('keeps repeated invalid responses out of the stream until a valid article arrives', async () => {
  let connections = 0;
  const output = [];
  const loader = createPostedSegmentLoader(posted, { maxConnections: 1 }, new Map(), async () => {
    const attempt = ++connections;
    return {
      body: (_id, onLine) => article(onLine, Buffer.from(attempt < 6 ? 'XY' : 'EFGH'), 5),
      close() {}
    };
  });
  try {
    await writePostedFileRange(posted, 4, 7, loader.load, chunk => output.push(chunk));
    assert.equal(Buffer.concat(output).toString(), 'EFGH');
    assert.equal(connections, 6);
  } finally { await loader.close(); }
});

test('does not extend retries for provider connection failures', async () => {
  let connections = 0;
  const loader = createPostedSegmentLoader(posted, { maxConnections: 1 }, new Map(), async () => {
    connections++;
    throw new Error('Provider connection failed');
  });
  try {
    await assert.rejects(loader.load(posted.segments[1], 1), /Provider connection failed/);
    assert.equal(connections, 2);
  } finally { await loader.close(); }
});

test('probe and converter reads reuse validated bytes within a bounded cache', async () => {
  let reads=0;
  const loader=createPostedSegmentLoader(posted,{maxConnections:1},new Map(),async()=>({body:async(_id,onLine)=>{reads++;await article(onLine,Buffer.from('EFGH'),5);},close(){}}));
  try {
    await loader.load(posted.segments[1],1);
    await loader.load(posted.segments[1],1);
    assert.equal(reads,1,'sequential reads should not fetch the same article twice');
  } finally {await loader.close();}
});

test('validated article cache evicts bytes at its memory limit', async () => {
  let reads=0;
  const loader=createPostedSegmentLoader(posted,{maxConnections:1},new Map(),async()=>({
    body:async(id,onLine)=>{reads++;await article(onLine,Buffer.from(id==='part-1'?'ABCD':'EFGH'),id==='part-1'?1:5);},close(){}
  }),4);
  try {
    for(const index of [0,1,0]) await loader.load(posted.segments[index],index);
    assert.equal(reads,3,'the evicted first part must be fetched again');
  } finally {await loader.close();}
});
