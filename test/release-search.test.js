import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueAlternativeTitles, findReleases } from '../src/lib/server/streamer.js';
const media = { type: 'tv', title: 'Silo', season: 1, episode: 1 };
const settings = { indexerUrl: 'https://indexer.example', indexerKey: 'test' };
const xml = (start, count, total) => `<rss><newznab:response offset="${start}" total="${total}" />${Array.from({length:count}, (_, i) => `<item><title>Silo.S01E01.1080p.H264.Release${start+i}</title><enclosure url="https://indexer.example/nzb/${start+i}" /></item>`).join('')}</rss>`;
test('automatic search orders target resolution before lower fallbacks while manual search shows every release', async () => {
  const titles = ['Silo.S01E01.720p.H264', 'Silo.S01E01.1080p.H264', 'Silo.S01E01.2160p.HEVC'];
  const request = async () => ({ ok: true, text: async () => `<rss><newznab:response offset="0" total="3" />${titles.map((title, i) => `<item><title>${title}</title><enclosure url="https://indexer.example/nzb/${i}" /></item>`).join('')}</rss>` });
  const target = await findReleases({ ...settings, targetResolution: '2160p' }, media, true, { request });
  assert.deepEqual(target.map(release => release.title), [...titles].reverse());
  const capped = await findReleases({ ...settings, targetResolution: '1080p' }, media, true, { request });
  assert.deepEqual(capped.map(release => release.title), titles.slice(0, 2).reverse());
  const manual = await findReleases({ ...settings, targetResolution: '720p', manualReleaseSelection: true }, media, true, { request });
  assert.equal(manual.length, 3);
});
test('automatic and manual searches omit HDR releases that need CPU tone mapping', async () => {
  const titles = ['Silo.S01E01.2160p.HDR10.HEVC', 'Silo.S01E01.2160p.SDR.HEVC', 'Silo.S01E01.1080p.H264'];
  const request = async () => ({ ok: true, text: async () => `<rss><newznab:response offset="0" total="3" />${titles.map((title, i) => `<item><title>${title}</title><enclosure url="https://indexer.example/nzb/${i}" /></item>`).join('')}</rss>` });
  for (const manualReleaseSelection of [false, true]) {
    const releases = await findReleases({ ...settings, targetResolution: '2160p', manualReleaseSelection }, media, true, { request });
    assert.deepEqual(new Set(releases.map(release => release.title)), new Set([titles[1], titles[2]]));
  }
});
test('falls back to general indexer search when movie search returns no releases', async () => {
  const queries = [];
  const releases = await findReleases(settings, { id: 671, type: 'movie', title: "Harry Potter and the Philosopher's Stone", year: '2001' }, true, {
    request: async url => {
      const mode = url.searchParams.get('t');
      const query = url.searchParams.get('q');
      queries.push([mode, query]);
      const item = mode === 'search' && query === 'Harry Potter and the Philosophers Stone 2001'
        ? '<item><title>Harry.Potter.and.the.Philosophers.Stone.2001.1080p.WEB-DL</title><enclosure url="https://indexer.example/nzb/movie" /></item>'
        : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${item ? 1 : 0}" />${item}</rss>` };
    }
  });
  assert.ok(queries.some(([mode, query]) => mode === 'search' && query === 'Harry Potter and the Philosophers Stone 2001'));
  assert.deepEqual(releases.map(release => release.title), ['Harry.Potter.and.the.Philosophers.Stone.2001.1080p.WEB-DL']);
});
test('finds Sorcerer’s Stone releases when the selected film uses the Philosopher’s Stone title', async () => {
  const queries = [];
  const releases = await findReleases(settings, { type: 'movie', title: "Harry Potter and the Philosopher's Stone", year: '2001' }, true, {
    request: async url => {
      const query = url.searchParams.get('q');
      queries.push(query);
      const item = /Sorcerers Stone/.test(query)
        ? '<item><title>Harry.Potter.and.the.Sorcerers.Stone.2001.1080p.BluRay</title><enclosure url="https://indexer.example/nzb/stone" /></item>'
        : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${item ? 1 : 0}" />${item}</rss>` };
    }
  });
  assert.ok(queries.some(query => /Sorcerers Stone/.test(query)), `Missing alternate-title query: ${queries.join(', ')}`);
  assert.deepEqual(releases.map(release => release.title), ['Harry.Potter.and.the.Sorcerers.Stone.2001.1080p.BluRay']);
});
test('searches catalogue alternative titles and accepts their release names', async () => {
  const movie = { id: 42, type: 'movie', title: 'The Original Title', year: '2024' };
  const queried = [];
  const releases = await findReleases({ ...settings, tmdbToken: 'test' }, movie, true, {
    alternativeTitles: async () => ['The International Title'],
    request: async url => {
      const query = url.searchParams.get('q');
      queried.push([url.searchParams.get('t'), query]);
      const item = query.startsWith('The International Title')
        ? '<item><title>The.International.Title.2024.1080p.WEB-DL</title><enclosure url="https://indexer.example/nzb/alternate" /></item>'
        : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${item ? 1 : 0}" />${item}</rss>` };
    }
  });
  assert.deepEqual(queried, [
    ['movie', 'The Original Title 2024'],
    ['search', 'The Original Title 2024'],
    ['movie', 'The International Title 2024']
  ]);
  assert.deepEqual(releases.map(release => release.title), ['The.International.Title.2024.1080p.WEB-DL']);
});
test('reads movie and series alternative titles from their catalogue endpoints', async () => {
  const configured = { tmdbToken: 'test' };
  const movie = await catalogueAlternativeTitles(configured, { id: 42, type: 'movie' }, {
    request: async (_settings, path) => {
      assert.equal(path, 'movie/42/alternative_titles');
      return { titles: [{ iso_3166_1: 'FR', title: 'Le Film' }, { iso_3166_1: 'US', title: 'The Film' }] };
    }
  });
  const series = await catalogueAlternativeTitles(configured, { id: 7, type: 'tv' }, {
    request: async (_settings, path) => {
      assert.equal(path, 'tv/7/alternative_titles');
      return { results: [{ iso_3166_1: 'GB', title: 'The Show' }] };
    }
  });
  assert.deepEqual(movie, ['The Film', 'Le Film']);
  assert.deepEqual(series, ['The Show']);
});
test('searches a series alternative name with the selected episode', async () => {
  const queries = [];
  const releases = await findReleases({ ...settings, tmdbToken: 'test' }, { id: 7, type: 'tv', title: 'Original Series', season: 2, episode: 3 }, true, {
    alternativeTitles: async () => ['Other Series'],
    request: async url => {
      queries.push([url.searchParams.get('q'), url.searchParams.get('season'), url.searchParams.get('ep')]);
      const item = url.searchParams.get('q') === 'Other Series'
        ? '<item><title>Other.Series.S02E03.1080p.WEB-DL</title><enclosure url="https://indexer.example/nzb/series" /></item>'
        : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${item ? 1 : 0}" />${item}</rss>` };
    }
  });
  assert.deepEqual(queries, [
    ['Original Series', '2', '3'],
    ['Original Series S02E03', null, null],
    ['Other Series', '2', '3'],
    ['Other Series S02E03', null, null]
  ]);
  assert.deepEqual(releases.map(release => release.title), ['Other.Series.S02E03.1080p.WEB-DL']);
});

test('widens an episode search when TV search finds only one eligible release', async () => {
  const queries = [];
  const releases = await findReleases(settings, { type: 'tv', title: 'Attack on Titan', season: 1, episode: 17 }, true, {
    request: async url => {
      const mode = url.searchParams.get('t'), query = url.searchParams.get('q');
      queries.push([mode, query, url.searchParams.get('season'), url.searchParams.get('ep')]);
      const title = mode === 'tvsearch'
        ? 'Attack.on.Titan.S01E17.1080p.Dual-Audio.Bluray'
        : mode === 'search' && query === 'Attack on Titan S01E17'
          ? 'Attack.on.Titan.S01E17.720p.English.WEB-DL' : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${title ? 1 : 0}" />${title ? `<item><title>${title}</title><enclosure url="https://indexer.example/nzb/${mode}" /></item>` : ''}</rss>` };
    }
  });
  assert.deepEqual(releases.map(release => release.title).sort(), [
    'Attack.on.Titan.S01E17.1080p.Dual-Audio.Bluray',
    'Attack.on.Titan.S01E17.720p.English.WEB-DL'
  ].sort());
  assert.deepEqual(queries, [['tvsearch', 'Attack on Titan', '1', '17'], ['search', 'Attack on Titan S01E17', null, null]]);
});

test('searches series aliases even when the primary episode title has one release', async () => {
  const queries = [];
  const releases = await findReleases({ ...settings, tmdbToken: 'test' }, { id: 1429, type: 'tv', title: 'Attack on Titan', season: 1, episode: 17 }, true, {
    alternativeTitles: async () => ['Shingeki no Kyojin'],
    request: async url => {
      const mode = url.searchParams.get('t'), query = url.searchParams.get('q');
      queries.push([mode, query]);
      const title = mode === 'tvsearch' && query === 'Attack on Titan'
        ? 'Attack.on.Titan.S01E17.1080p.Dual-Audio.Bluray'
        : mode === 'search' && query === 'Shingeki no Kyojin S01E17'
          ? 'Shingeki.no.Kyojin.S01E17.720p.English.WEB-DL' : '';
      return { ok: true, text: async () => `<rss><newznab:response offset="0" total="${title ? 1 : 0}" />${title ? `<item><title>${title}</title><enclosure url="https://indexer.example/nzb/${mode}-${encodeURIComponent(query)}" /></item>` : ''}</rss>` };
    }
  });
  assert.equal(releases.length, 2);
  assert.ok(queries.some(([mode, query]) => mode === 'search' && query === 'Shingeki no Kyojin S01E17'));
});
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
