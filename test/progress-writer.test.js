import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressWriter } from '../src/lib/progress-writer.js';

test('pending forced saves retain the latest position and serialize watched updates', async () => {
  const writes = []; let release;
  const writer = createProgressWriter(async value => { writes.push(value); if (writes.length === 1) await new Promise(resolve => { release = resolve; }); return {}; });
  const initial = writer.enqueue('episode', { position: 10 });
  const final = writer.enqueue('episode', { position: 25 });
  writer.enqueue('episode', { position: 30, watched: true });
  release(); await initial; await final;
  assert.deepEqual(writes, [{ position: 10 }, { position: 30, watched: true }]);
});
test('transient writes retry, old-episode responses cannot update current state', async () => {
  let calls = 0, saved = 0;
  const writer = createProgressWriter(async () => { if (++calls === 1) throw new Error('Offline'); return {}; }, { delay: async () => {}, isCurrent: () => false, onSaved: () => saved++ });
  await writer.enqueue('old', { position: 10 });
  assert.equal(calls, 2); assert.equal(saved, 0);
});
test('exhausted writes report failure and subsequent writes still work', async () => {
  let broken = true, failures = 0, successes = 0;
  const writer = createProgressWriter(async () => { if (broken) throw new Error('Offline'); return {}; }, { delay: async () => {}, onError: () => failures++, onSaved: () => successes++ });
  await writer.enqueue('episode', { position: 10 }); broken = false;
  await writer.enqueue('episode', { position: 15 });
  assert.equal(failures, 1); assert.equal(successes, 1);
});

test('reactive proxy media snapshots serialize and remain isolated from later edits', async () => {
  let captured;const media=new Proxy({title:'Fixture'},{});
  const writer=createProgressWriter(async snapshot=>{captured=snapshot;});
  const pending=writer.enqueue('episode',{media,position:15});media.title='Changed';await pending;
  assert.equal(captured.media.title,'Fixture');
});

test('coalescing newer positions retains an explicit unwatched update', async()=>{
  const writes=[];let release;
  const writer=createProgressWriter(async snapshot=>{writes.push(snapshot);if(writes.length===1)await new Promise(resolve=>release=resolve);return{};});
  const pending=writer.enqueue('episode',{position:5});
  writer.enqueue('episode',{watched:false,reset:true});writer.enqueue('episode',{position:12});
  release();await pending;
  assert.deepEqual(writes.at(-1),{watched:false,position:12});
});
