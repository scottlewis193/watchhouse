import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { hasGrowingStreamDuration } from '../src/lib/playback-controls.js';
const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
const ast = parse(source);
const handler = ast.instance.content.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'seekToPosition');
function fixture(paused = true) {
  let warmups = 0, scheduled = 0;
  const state = { seekTimer:null,seekPaused:false,continuePlaybackOnReady:false, player: {paused,currentTime:20,buffered:{length:1,start:()=>0,end:()=>60}}, playback:{mode:'direct'}, resumeStreamOffset:100, seekPreview:null, playerPosition:20, bufferedRanges:[], videoFrameSample:null, measuredVideoFps:null, preparedSession:null, clearBufferedSourceRecovery(){}, savePlaybackProgress:async()=>{}, hasGrowingStreamDuration, controlTimeline:()=>({duration:1400}), beginPlaybackWarmup:()=>warmups++, setTimeout:()=>++scheduled, clearTimeout(){} };
  runInNewContext(source.slice(handler.start,handler.end),state);
  return {state,get warmups(){return warmups;},get scheduled(){return scheduled;}};
}
test('buffered streamed seeks reuse the source and preserve pause', () => {
  const f=fixture(); f.state.seekToPosition(130);
  assert.equal(f.state.player.currentTime,30);
  assert.equal(f.state.resumeStreamOffset,100);
  assert.equal(f.warmups,0); assert.equal(f.scheduled,0);
});

test('rapid unbuffered seeks replace pending work and preserve paused state', () => {
  const f=fixture();const timers=new Map();let id=0;
  f.state.setTimeout=callback=>{timers.set(++id,callback);return id;};
  f.state.clearTimeout=id=>timers.delete(id);
  f.state.seekToPosition(300);f.state.seekToPosition(420);
  assert.equal(timers.size,1);
  for(const callback of timers.values())callback();
  assert.equal(f.state.resumeStreamOffset,420);assert.equal(f.state.seekPaused,true);
  assert.equal(f.state.continuePlaybackOnReady,false);assert.equal(f.warmups,1);
});
