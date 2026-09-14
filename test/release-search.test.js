import test from 'node:test';
import assert from 'node:assert/strict';
import { findReleases } from '../src/lib/server/streamer.js';
const media = { type: 'tv', title: 'Silo', season: 1, episode: 1 };
const settings = { indexerUrl: 'https://indexer.example', indexerKey: 'test' };
const xml = (start, count, total) => `<rss><newznab:response offset="${start}" total="${total}" />${Array.from({length:count}, (_, i) => `<item><title>Silo.S01E01.1080p.H264.Release${start+i}</title><enclosure url="https://indexer.example/nzb/${start+i}" /></item>`).join('')}</rss>`;
test('release discovery follows all result pages and retains later uploads', async () => {
  const offsets=[];
  const releases=await findReleases(settings, media, true, {request:async url=>{
    const offset=Number(url.searchParams.get('offset'));offsets.push(offset);
    assert.equal(url.searchParams.get('season'),'1'); assert.equal(url.searchParams.get('ep'),'1');
    return {ok:true,text:async()=>xml(offset, Math.min(100,415-offset),415)};
  }});
  assert.deepEqual(offsets,[0,100,200,300,400]);assert.equal(releases.length,415);
  assert.ok(releases.some(r=>r.title.endsWith('Release414')));
});
test('release discovery stops when an indexer ignores pagination',async()=>{
  let calls=0;
  const releases=await findReleases(settings,media,true,{request:async()=>{calls++;return {ok:true,text:async()=>xml(0,100,415)};}});
  assert.equal(calls,2);assert.equal(releases.length,100);
});
test('release discovery keeps requests bounded for oversized result sets',async()=>{
  let calls=0;
  const releases=await findReleases(settings,media,true,{request:async url=>{calls++;return {ok:true,text:async()=>xml(Number(url.searchParams.get('offset')),100,100000)};}});
  assert.equal(calls,5);assert.equal(releases.length,500);
});
test('release discovery follows provider page limits smaller than requested',async()=>{
  const offsets=[];
  const releases=await findReleases(settings,media,true,{request:async url=>{
    const offset=Number(url.searchParams.get('offset'));offsets.push(offset);
    return {ok:true,text:async()=>xml(offset,Math.min(24,55-offset),55)};
  }});
  assert.deepEqual(offsets,[0,24,48]);assert.equal(releases.length,55);
});
test('a later-page failure preserves earlier candidates',async()=>{
  let calls=0;
  const releases=await findReleases(settings,media,true,{request:async()=>{
    if(calls++)throw new Error('Temporary indexer failure');
    return {ok:true,text:async()=>xml(0,100,415)};
  }});
  assert.equal(calls,2);assert.equal(releases.length,100);
});
test('cancellation propagates even after earlier pages succeeded',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(findReleases({...settings,signal:controller.signal},media,true,{request:async()=>{
    if(calls++){controller.abort();throw controller.signal.reason;}
    return {ok:true,text:async()=>xml(0,100,415)};
  }}),{name:'AbortError'});
});
