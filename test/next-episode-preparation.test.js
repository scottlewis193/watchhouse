import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { createPlaybackPlanCache, preparePlayback } from '../src/lib/server/streamer.js';
import { playbackScope } from '../src/lib/server/playback-persistence.js';

// Exercise the request handler's job construction as well as source selection,
// without touching real provider credentials, saved settings or playback caches.
const source = `<script>${readFileSync(new URL('../src/lib/server/streamer.js', import.meta.url), 'utf8')}</script>`;
const handler = parse(source).instance.content.body
  .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'handleRequest').declaration;
const handleRequestSource = source.slice(handler.start, handler.end);

for (const kind of ['archive', 'direct', 'saved direct']) {
  test(`next-episode request prepares a local ${kind} copy before reporting ready`, async () => {
    const media = { type: 'tv', id: 1, title: 'Fixture', season: 1, episode: 2, prepareAhead: true, backgroundFor: 'current' };
    const settings = { indexerUrl: 'fixture', indexerKey: 'fixture', usenetHost: 'fixture' };
    const plans = createPlaybackPlanCache();
    if (kind === 'saved direct') plans.set(media, { file: { subject: 'episode.mkv', segments: [{ number: 1, id: 'article' }] }, release: 'Fixture.S01E02', strategy: 'remux', prefetchedSegments: new Map() }, playbackScope(settings));
    const copied = [];
    let completion, response;
    const copy = async job => {
      assert.notEqual(job.status, 'ready', 'a source plan alone must not publish a ready next episode');
      copied.push(job.release);
      Object.assign(job, { status: 'ready', mode: 'cached', path: '/fixture/episode.mp4', strategy: 'raw' });
    };
    const state = {
      URL, Number, Date, Map,
      body: async () => media,
      readOfflineRecords: async () => new Map(), offlineMediaKey: () => 'tv:1:s1:e2',
      readSettings: async () => settings,
      posterPreparation: { take: () => null }, playbackScope: () => '',
      cancelUnusedPosterPreparations: async () => {},
      playbackJobs: new Map([['current', { id: 'current' }]]),
      randomUUID: () => 'next', jobEvent() {},
      setTimeout: () => ({ unref() {} }), publicJob: job => job,
      json: (_res, status, value) => { response = { status, value }; },
      preparePlayback: (job, settings) => completion = preparePlayback(job, settings, {
        search: async () => { assert.notEqual(kind, 'saved direct', 'a cached source must skip search'); return [{ title: 'Fixture.S01E02' }]; },
        load: async () => `<nzb><file subject="episode.${kind === 'archive' ? 'rar' : 'mkv'}"><segments><segment number="1">article</segment></segments></file></nzb>`,
        check: async () => Buffer.from('video'),
        health: { has: async () => false }, plans, persistence: null,
        progressive: async () => false, archive: copy, cache: copy
      })
    };
    runInNewContext(handleRequestSource, state);
    await state.handleRequest({ method: 'POST', url: '/api/play', headers: { host: 'fixture' } }, {});
    assert.equal(response.status, 202, response.value?.error);
    await completion;
    assert.equal(response.value.status, 'ready', response.value.message);
    assert.equal(response.value.mode, 'cached', 'next playback must not still need provider reads or live conversion');
    assert.deepEqual(copied, ['Fixture.S01E02']);
  });
}
