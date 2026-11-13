import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlayback } from '../src/lib/server/streamer.js';

for (const cached of [false, true]) {
  test(`conversion capacity exhaustion preserves healthy ${cached ? 'saved' : 'new'} sources instead of scanning alternatives`, async () => {
    const media = { type: 'movie', id: 42, title: 'Film', year: '2024' };
    const releases = ['Preferred', 'Alternative'].map(name => ({ title: `Film.2024.1080p.English.${name}` }));
    const file = { subject: 'film.mkv', segments: [{ id: 'article', number: 1 }] };
    const plan = { release: releases[0].title, releaseKey: 'saved', file, strategy: 'remux', prefetchedSegments: new Map() };
    let searches = 0, probes = 0, deleted = 0, rejected = 0;
    const job = { id: `capacity-${cached}`, media, events: [], status: 'selecting' };
    await preparePlayback(job, { usenetHost: 'provider', playbackQuality: 'quality' }, {
      search: async () => { searches++; return releases; },
      load: async () => '<nzb><file subject="film.mkv"><segments><segment number="1">article</segment></segments></file></nzb>',
      check: async () => Buffer.from('header'),
      preflight: async () => { probes++; throw Object.assign(new Error('All playback conversion slots are in use.'), { code: 'PLAYBACK_BUSY' }); },
      cache: async () => { throw new Error('Unexpected downloaded fallback'); },
      plans: { get: () => cached ? plan : null, set() {}, delete: () => { deleted++; } },
      archivePlans: { get: () => null, delete() {} },
      health: { has: async () => false, reject: async () => { rejected++; } },
      persistence: null
    });
    assert.equal(job.status, 'error');
    assert.equal(probes, 1);
    assert.match(job.message, /conversion slots are in use/);
    assert.equal(searches, cached ? 0 : 1);
    assert.equal(deleted, 0);
    assert.equal(rejected, 0);
  });
}
