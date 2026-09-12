import test from 'node:test';
import assert from 'node:assert/strict';
import { openPostedRangeServer, recoverPlaybackSource } from '../src/lib/server/streamer.js';

test('an invalid article rejects its release and concurrent retries select one replacement', async () => {
  const job = { file: { subject: 'video.mkv', segments: [{id:'one',number:1,decodedBytes:4},{id:'two',number:2,decodedBytes:4}] }, release: 'broken', media: { type:'tv', id:1,season:1,episode:4 }, mode:'direct', status:'ready' };
  const source = await openPostedRangeServer(job, {maxConnections:1}, async () => ({
    async body(_id, onLine) { await onLine('=ybegin size=80 name=wrong.mkv');await onLine('=ypart begin=5 end=8');await onLine('klmn');await onLine('=yend size=4'); }, close() {}
  }));
  try {
    await assert.rejects(async () => (await fetch(source.url, {headers:{Range:'bytes=4-7'}})).arrayBuffer());
    assert.equal(job.rejectedReleases.has('broken'), true);
    let preparations=0;
    const prepare = async target => { preparations++; await new Promise(r=>setTimeout(r,10)); target.release='replacement';target.status='ready'; };
    await Promise.all([recoverPlaybackSource(job,{},prepare), recoverPlaybackSource(job,{},prepare)]);
    assert.equal(preparations,1);
    assert.equal(job.release,'replacement');
    await recoverPlaybackSource(job,{},prepare);
    assert.equal(preparations,1);
  } finally { await source.close(); }
});

test('source replacement is bounded and respects a manually selected release', async () => {
  for(const extra of [{manualRelease:{}},{rejectedReleases:new Set(['one','two','broken'])}]) {
    const job={release:'broken',rejectedReleases:new Set(['broken']),...extra};
    await assert.rejects(recoverPlaybackSource(job,{},()=>assert.fail('must not reselect')),/release|source/i);
  }
});

test('replacement candidates match the series name rather than another shows episode title', async () => {
  const { rankReleases } = await import('../media.js');
  const correct = { title: 'Friday.Night.Dinner.S01E04.1080p.WEB.H264-SKYFiRE' };
  const wrong = { title: 'A.Million.Little.Things.S01E04.Friday.Night.Dinner.1080p.AMZN.WEB-DL.DD5.1.H264' };
  assert.deepEqual(rankReleases([wrong, correct], { type:'tv', title:'Friday Night Dinner', season:1, episode:4 }), [correct]);
});

test('an exhausted replacement search remains terminal instead of re-running on every retry', async () => {
  const job = { release: 'broken', rejectedReleases: new Set(['broken']), mode: 'direct' };
  let searches = 0;
  const prepare = async () => { searches++; job.status = 'error'; };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(recoverPlaybackSource(job, {}, prepare), { code: 'SOURCE_UNAVAILABLE' });
  }
  assert.equal(searches, 1);
});
