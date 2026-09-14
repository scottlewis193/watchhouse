import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReleaseHealthStore } from '../src/lib/server/release-health.js';

test('rejected releases survive restart, stay provider-specific and expire', async () => {
  const dir=await mkdtemp(join(tmpdir(),'release-health-'));
  try {
    let now=100;
    const options={now:()=>now,ttl:100};
    const path=join(dir,'health.json'), provider={usenetHost:'one'}, media={type:'tv',id:1,season:1,episode:4};
    const store=createReleaseHealthStore(path,options);
    await store.reject(provider,media,'broken');
    const restarted=createReleaseHealthStore(path,options);
    assert.equal(await restarted.has(provider,media,'broken'),true);
    assert.equal(await restarted.has({usenetHost:'two'},media,'broken'),false);
    assert.equal(await restarted.has(provider,{...media,episode:3},'broken'),false);
    now=201;
    assert.equal(await restarted.has(provider,media,'broken'),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('upload identity separates reposts and stays stable across API key changes',async()=>{
  const {releaseIdentity}=await import('../src/lib/server/release-health.js');
  const one=releaseIdentity({title:'Same title',nzbUrl:'https://indexer.example/api?id=one&apikey=secret'});
  assert.equal(one,releaseIdentity({title:'Same title',nzbUrl:'https://indexer.example/api?apikey=changed&id=one'}));
  assert.notEqual(one,releaseIdentity({title:'Same title',nzbUrl:'https://indexer.example/api?id=two'}));
  assert.match(one,/^upload:[a-f0-9]{64}$/);
});
