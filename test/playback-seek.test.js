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

test('seeks reuse produced HLS segments after the browser evicts them from its buffer', () => {
  for (const paused of [true, false]) {
    const f = fixture(paused);
    f.state.player.currentTime = 120;
    f.state.player.buffered = { length: 1, start: () => 90, end: () => 150 };
    f.state.player.seekable = { length: 1, start: () => 0, end: () => 180 };
    for (const target of [130, 270]) {
      f.state.seekToPosition(target);
      assert.equal(f.state.player.currentTime, target - 100);
      assert.equal(f.state.resumeStreamOffset, 100);
      assert.equal(f.state.player.paused, paused);
      assert.equal(f.scheduled, 0, 'already produced segments must not start a new conversion');
      assert.equal(f.warmups, 0);
    }
  }
});

test('a seek into produced segments cancels a pending conversion seek', () => {
  const f = fixture();
  const timers = new Map();
  f.state.setTimeout = callback => { timers.set(1, callback); return 1; };
  f.state.clearTimeout = id => timers.delete(id);
  f.state.player.seekable = { length: 1, start: () => 0, end: () => 180 };
  f.state.seekToPosition(420);
  assert.equal(timers.size, 1);
  f.state.seekToPosition(270);
  assert.equal(timers.size, 0);
  assert.equal(f.state.player.currentTime, 170);
  assert.equal(f.state.resumeStreamOffset, 100);
  assert.equal(f.warmups, 0);
});

test('positions outside produced ranges and at the unfinished edge still prepare a new stream', () => {
  for (const target of [90, 220, 279.75, 280, 420]) {
    const f = fixture();
    f.state.player.buffered = { length: 0 };
    f.state.player.seekable = { length: 2, start: i => i === 0 ? 0 : 140, end: i => i === 0 ? 100 : 180 };
    f.state.seekToPosition(target);
    assert.equal(f.scheduled, 1, `target ${target} needs fresh segments`);
    assert.equal(f.state.player.currentTime, 20);
  }
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
