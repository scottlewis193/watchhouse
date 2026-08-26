import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { archiveFiles, audioAwarePlaybackStrategy, connectionTestSettings, decodeYenc, fetchDiscoveryShelves, ffmpegArgs, indexerEndpoint, NntpClient, orderedPrefetch, searchResults, streamPostedFile, testNntp, videoFile, videoType, writeStreamToResponse, yencName } from '../src/lib/server/streamer.js';
import { episodeTag, englishAudioRelease, mapTmdbEpisodes, mapTmdbRuntime, mapTmdbSeasons, mapTmdbTitles, playbackStrategy, rankReleases, releaseReadiness, titleVariants, tmdbImage } from '../media.js';
import { canSavePlaybackProgress, canUseFallback, createPlaybackRequestGuard, episodePlaybackMedia, firstUnwatchedEpisode, playbackInterruptionAction, playbackTimeline, progressDuration, resumePosition, resumeStreamUrl, shouldMarkWatched, shouldRecoverPlaybackInterruption, shouldShowUpNext } from '../src/lib/playback-controls.js';
import { offlineAvailability, offlineEpisodes, offlineMediaKey } from '../src/lib/offline.js';

test('adds the Newznab API path when given an indexer host', () => {
  assert.equal(indexerEndpoint('https://api.nzbgeek.info').href, 'https://api.nzbgeek.info/api');
});

test('uses entered connection values for a test without overwriting saved secrets', () => {
  assert.deepEqual(connectionTestSettings(
    { usenetHost: 'saved.example', usenetUser: 'saved-user', usenetPass: 'saved-secret', usenetPort: '563' },
    { usenetHost: 'entered.example', usenetUser: 'entered-user', usenetPass: 'entered-secret', usenetPort: '119' }
  ), { usenetHost: 'entered.example', usenetUser: 'entered-user', usenetPass: 'entered-secret', usenetPort: '119' });
});

test('tests NNTP credentials when server replies are split across TCP packets', async () => {
  const server = net.createServer(socket => {
    socket.write('200 local'); setTimeout(() => socket.write(' NNTP ready\r\n'), 0);
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n'), command = input.slice(0, end); input = input.slice(end + 2);
        if (command.startsWith('AUTHINFO USER ')) { socket.write('381 password'); setTimeout(() => socket.write(' required\r\n'), 0); }
        if (command.startsWith('AUTHINFO PASS ')) socket.write('281 authentication accepted\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const { port } = server.address();
    await testNntp({ usenetHost: '127.0.0.1', usenetPort: port, usenetUser: 'user', usenetPass: 'password' });
  } finally { server.close(); }
});

test('rejects reads after the provider closes between article requests', async () => {
  const socket = new EventEmitter();
  socket.write = () => true;
  socket.end = () => {};
  const client = new NntpClient(socket);
  socket.emit('close');
  await assert.rejects(Promise.race([
    client.line(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('NNTP read remained pending')), 25))
  ]), /Provider server closed the connection/);
});

test('reconnects and retries an article when a direct-stream lane closes', async () => {
  let connections = 0;
  const connect = async () => {
    const connection = ++connections;
    let reads = 0;
    return {
      async body(_id, onLine) {
        reads++;
        if (connection === 1 && reads === 2) throw new Error('Provider server closed the connection.');
        await onLine(connection === 1 ? 'k' : 'l');
      },
      close() {}
    };
  };
  const chunks = [];
  await streamPostedFile({ segments: [{ id: 'one' }, { id: 'two' }] }, { maxConnections: 1 }, chunk => chunks.push(chunk), connect);
  assert.equal(Buffer.concat(chunks).toString(), 'AB');
  assert.equal(connections, 2);
});

test('preserves an explicitly configured API path and query', () => {
  assert.equal(indexerEndpoint('https://indexer.example/api?foo=bar').href, 'https://indexer.example/api?foo=bar');
});

test('selects a directly playable NZB file and keeps segment order', () => {
  const nzb = '<nzb><file subject="archive.rar"><segments><segment number="1">rar</segment></segments></file><file subject="movie.mp4 yEnc"><segments><segment number="2">second</segment><segment number="1">first</segment></segments></file></nzb>';
  assert.deepEqual(videoFile(nzb), { subject: 'movie.mp4 yEnc', segments: [{ number: 1, id: 'first' }, { number: 2, id: 'second' }] });
});

test('recognises H.264 MOV posts as direct video', () => {
  const nzb = '<nzb><file subject="big_buck_bunny.mov yEnc"><segments><segment number="1">first</segment></segments></file></nzb>';
  assert.equal(videoFile(nzb).subject, 'big_buck_bunny.mov yEnc');
});

test('detects video MIME type inside a Usenet subject', () => {
  assert.equal(videoType('release - "video.mov" yEnc (1/173)'), 'video/mp4');
});

test('decodes yEnc line data', () => {
  assert.deepEqual(decodeYenc('klm'), Buffer.from([65, 66, 67]));
});

test('discovers the real filename from an obfuscated yEnc post', () => {
  assert.equal(yencName('=ybegin part=1 line=128 size=734003200 name=movie.part01.rar'), 'movie.part01.rar');
});

test('recognises multi-part RAR releases for extraction', () => {
  const nzb = '<nzb><file subject="The.Matrix.part01.rar yEnc"><segments><segment number="1">one</segment></segments></file><file subject="The.Matrix.part02.rar yEnc"><segments><segment number="1">two</segment></segments></file></nzb>';
  assert.equal(archiveFiles(nzb).length, 2);
});

test('recognises split 7z and ZIP releases for extraction', () => {
  const nzb = '<nzb><file subject="release.7z.001 yEnc"><segments><segment number="1">one</segment></segments></file><file subject="release.zip yEnc"><segments><segment number="1">two</segment></segments></file></nzb>';
  assert.equal(archiveFiles(nzb).length, 2);
});

test('decodes XML entities in Newznab enclosure URLs', () => {
  const xml = '<rss><item><title>Test</title><enclosure url="https://indexer.example/api?t=get&amp;id=abc123&amp;apikey=" length="100" /></item></rss>';
  const target = new URL(searchResults(xml)[0].nzbUrl);
  assert.equal(target.searchParams.get('id'), 'abc123');
  assert.equal(target.searchParams.has('amp;id'), false);
});

test('maps only TMDB movies and shows from catalogue results', () => {
  const results = mapTmdbTitles({ results: [
    { id: 101, media_type: 'movie', title: 'Film', release_date: '2024-03-01', overview: 'Film overview', poster_path: '/film.jpg' },
    { id: 102, media_type: 'tv', name: 'Show', first_air_date: '2023-02-01', overview: '', poster_path: null },
    { id: 103, media_type: 'person', name: 'Actor' }
  ] });
  assert.deepEqual(results, [
    { id: 101, type: 'movie', title: 'Film', year: '2024', overview: 'Film overview', poster: 'https://image.tmdb.org/t/p/w500/film.jpg' },
    { id: 102, type: 'tv', title: 'Show', year: '2023', overview: '', poster: null }
  ]);
});

test('builds TMDB image URLs without an extra API request', () => {
  assert.equal(tmdbImage('/poster.jpg'), 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.equal(tmdbImage('/still.jpg', 'w300'), 'https://image.tmdb.org/t/p/w300/still.jpg');
  assert.equal(tmdbImage(null), null);
});

test('maps a TMDB movie runtime to seconds for progress display', () => {
  assert.equal(mapTmdbRuntime({ runtime: 123 }), 7380);
  assert.equal(mapTmdbRuntime({ runtime: null }), 0);
});

test('loads homepage discovery without bursting concurrent catalogue requests', async () => {
  let active = 0, nextId = 300;
  const requests = [];
  const request = async (path, params) => {
    requests.push({ path, params });
    active++;
    try {
      if (active > 1) throw new Error('TMDB returned HTTP 429.');
      await new Promise(resolve => setImmediate(resolve));
      if (path === 'genre/movie/list') return { genres: [
        { id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 878, name: 'Science Fiction' }
      ] };
      if (path === 'genre/tv/list') return { genres: [
        { id: 10759, name: 'Action & Adventure' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 10765, name: 'Sci-Fi & Fantasy' }
      ] };
      return { results: [{ id: nextId++, title: 'Title', release_date: '2025-01-01', poster_path: '/poster.jpg' }] };
    } finally { active--; }
  };
  const shelves = await fetchDiscoveryShelves(request);
  assert.equal(requests.length, 21);
  assert.deepEqual(shelves.slice(2, 11).map(shelf => shelf.id), [
    'netflix-shows', 'prime-video-shows', 'disney-plus-shows', 'apple-tv-shows', 'hbo-shows',
    'bbc-one-shows', 'itv1-shows', 'channel-4-shows', 'sky-atlantic-shows'
  ]);
  assert.deepEqual(requests.slice(4, 13).map(({ path, params }) => ({ path, network: params.with_networks, sort: params.sort_by })), [
    { path: 'discover/tv', network: 213, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 1024, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 2739, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 2552, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 49, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 4, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 9, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 26, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 1063, sort: 'popularity.desc' }
  ]);
});

test('maps and orders TMDB seasons and episodes', () => {
  assert.deepEqual(mapTmdbSeasons({ seasons: [{ id: 2, season_number: 2, name: 'Season 2', episode_count: 13 }, { id: 1, season_number: 1, name: null, episode_count: 7 }, { id: 0, season_number: 0, name: 'Specials' }] }), [
    { id: 1, number: 1, name: 'Season 1', episodeCount: 7 },
    { id: 2, number: 2, name: 'Season 2', episodeCount: 13 }
  ]);
  assert.deepEqual(mapTmdbEpisodes({ episodes: [{ id: 12, episode_number: 2, name: 'Second', air_date: '2024-01-08', overview: 'Two', runtime: 52, still_path: '/two.jpg' }, { id: 11, episode_number: 1, name: 'Pilot', air_date: '2024-01-01' }] }), [
    { id: 11, number: 1, name: 'Pilot', airDate: '2024-01-01', overview: '', runtime: 0, still: null },
    { id: 12, number: 2, name: 'Second', airDate: '2024-01-08', overview: 'Two', runtime: 52, still: 'https://image.tmdb.org/t/p/w300/two.jpg' }
  ]);
});

test('formats and prioritizes the selected episode', () => {
  const media = { title: 'Show', season: 2, episode: 3 };
  assert.equal(episodeTag(media), 'S02E03');
  const ranked = rankReleases([{ title: 'Show S02E04 1080p' }, { title: 'Show S02E03 720p' }], media);
  assert.match(ranked[0].title, /S02E03/);
});

test('builds a valid playback payload for the selected episode', () => {
  const show = { id: 42, type: 'tv', title: 'Example Show', year: '2024' };
  const media = episodePlaybackMedia(show, '2', '3', [{ number: 2, name: 'Second' }, { number: 3, name: 'Third', runtime: 52 }]);
  assert.deepEqual(media, { ...show, season: 2, episode: 3, episodeTitle: 'Third', durationHint: 3120 });
  assert.equal(episodePlaybackMedia(show, '2', '', [{ number: 3, name: 'Third' }]), null);
});

test('selects the first episode that has not been watched', () => {
  const episodes = [{ number: 1 }, { number: 2 }, { number: 3 }];
  assert.equal(firstUnwatchedEpisode(episodes, new Set([1]))?.number, 2);
  assert.equal(firstUnwatchedEpisode(episodes, new Set([1, 2, 3])), null);
});

test('resumes unfinished playback and marks the final 30 seconds watched', () => {
  assert.equal(resumePosition({ position: 420, duration: 1200, watched: false }, 1200), 420);
  assert.equal(resumePosition({ position: 1190, duration: 1200, watched: false }, 1200), 0);
  assert.equal(resumePosition({ position: 420, duration: 1200, watched: true }, 1200), 0);
  assert.equal(resumePosition({ position: 24.043586, duration: 0, watched: false }, 7200), 24.043586);
  assert.equal(shouldMarkWatched(1170, 1200), true);
  assert.equal(shouldMarkWatched(1169, 1200), false);
  assert.equal(shouldMarkWatched(2.981375, 2.981375), false);
  assert.equal(progressDuration('direct', 1200), 0);
  assert.equal(progressDuration('cached-convert', 1200), 0);
  assert.equal(progressDuration('cached', 1200), 1200);
  assert.equal(resumeStreamUrl('/api/play/job/stream', 'direct', 120), '/api/play/job/stream?start=120');
  assert.equal(resumeStreamUrl('/api/play/job/stream', 'direct', 2), '/api/play/job/stream?start=2');
  assert.equal(resumeStreamUrl('/api/play/job/stream', 'cached', 120), '/api/play/job/stream');
  const args = ffmpegArgs('remux', 'pipe:0', 'pipe:1', true, 120);
  assert.ok(args.indexOf('-ss') > args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '120');
  const maps = args.flatMap((arg, index) => arg === '-map' ? [args[index + 1]] : []);
  assert.deepEqual(maps, ['0:v:0', '0:a:m:language:eng:?', '0:a:m:language:en:?', '0:a:1?', '0:a:0?']);
  assert.ok(args.includes('-disposition:a:0'));
  assert.equal(args[args.indexOf('-disposition:a:0') + 1], 'default');
  const thirdTrackArgs = ffmpegArgs('remux', 'pipe:0', 'pipe:1', true, 0, 3);
  assert.ok(thirdTrackArgs.includes('0:a:2?'));
});

test('completed media cannot be overwritten by a trailing playback progress save', () => {
  assert.equal(canSavePlaybackProgress('tv:20:s1:e2', ''), true);
  assert.equal(canSavePlaybackProgress('tv:20:s1:e2', 'tv:20:s1:e2'), false);
  assert.equal(canSavePlaybackProgress('tv:20:s1:e3', 'tv:20:s1:e2'), true);
});

test('uses the full media runtime for streams whose browser duration grows', () => {
  assert.deepEqual(playbackTimeline('direct', 30, 2700, 600, 1200), { position: 1230, duration: 2700 });
  assert.deepEqual(playbackTimeline('cached-convert', 30, 2700, 35), { position: 30, duration: 2700 });
  assert.deepEqual(playbackTimeline('cached', 30, 2700, 600, 1200), { position: 30, duration: 600 });
});

test('shows Up Next only during the final 30 seconds of the full runtime', () => {
  assert.equal(shouldShowUpNext(true, 35, 2700), false);
  assert.equal(shouldShowUpNext(true, 2670, 2700), true);
  assert.equal(shouldShowUpNext(false, 2670, 2700), false);
});

test('detects a direct stream that ends long before the media runtime', () => {
  assert.equal(shouldRecoverPlaybackInterruption('direct', 127, 2700), true);
  assert.equal(shouldRecoverPlaybackInterruption('direct', 2675, 2700), false);
  assert.equal(shouldRecoverPlaybackInterruption('cached', 127, 2700), false);
});

test('asks before replacing interrupted direct playback with a full download', () => {
  assert.equal(playbackInterruptionAction('direct', 127, 2700), 'prompt');
  assert.equal(playbackInterruptionAction('direct', 2675, 2700), 'continue');
  assert.equal(playbackInterruptionAction('cached', 127, 2700), 'continue');
});

test('writes a media stream to the SvelteKit response interface without pipe()', async () => {
  const chunks = [];
  const response = {
    write(chunk) { chunks.push(Buffer.from(chunk)); return false; },
    end() { chunks.push(Buffer.from('end')); }
  };
  await writeStreamToResponse(Readable.from([Buffer.from('video')]), response);
  assert.equal(Buffer.concat(chunks.slice(0, -1)).toString(), 'video');
  assert.equal(chunks.at(-1).toString(), 'end');
});

test('prefetches stream segments concurrently while preserving article order', async () => {
  let active = 0, maximumActive = 0;
  const consumed = [];
  await orderedPrefetch([0, 1, 2, 3, 4, 5], 3, async value => {
    active++; maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, (3 - value % 3) * 2));
    active--;
    return value;
  }, async value => { consumed.push(value); });
  assert.deepEqual(consumed, [0, 1, 2, 3, 4, 5]);
  assert.ok(maximumActive > 1);
});

test('contains rejection from a prefetched batch after its consumer stops', async () => {
  await assert.rejects(() => orderedPrefetch([0, 1, 2, 3], 2,
    async value => { if (value === 2) throw new Error('future batch failed'); return value; },
    async () => { throw new Error('consumer stopped'); }
  ), /consumer stopped/);
  await new Promise(resolve => setImmediate(resolve));
});

test('searches apostrophe titles both verbatim and without apostrophes', () => {
  assert.deepEqual(titleVariants("The Handmaid's Tale"), ["The Handmaid's Tale", 'The Handmaids Tale']);
  assert.deepEqual(titleVariants('Schitt’s Creek'), ['Schitt’s Creek', 'Schitts Creek']);
  assert.deepEqual(titleVariants('Breaking Bad'), ['Breaking Bad']);
});

test('ranks high-quality matching-year releases ahead of poor captures', () => {
  const ranked = rankReleases([{ title: 'Film 2024 CAM' }, { title: 'Film 2024 1080p WEB-DL' }], { year: '2024' });
  assert.match(ranked[0].title, /1080p/);
});

test('auto-selection excludes releases explicitly labelled with non-English audio', () => {
  const releases = [
    { title: 'Show.S01E01.1080p.WEB-DL.GERMAN.DL' },
    { title: 'Show.S01E01.720p.WEB-DL.ENGLISH' },
    { title: 'Show.S01E01.2160p.WEB-DL.MULTI.ENG' }
  ];
  assert.equal(englishAudioRelease(releases[0]), false);
  assert.equal(englishAudioRelease(releases[1]), true);
  assert.equal(englishAudioRelease(releases[2]), true);
  assert.deepEqual(rankReleases(releases, { title: 'Show', season: 1, episode: 1 }).map(item => item.title), [
    'Show.S01E01.2160p.WEB-DL.MULTI.ENG',
    'Show.S01E01.720p.WEB-DL.ENGLISH'
  ]);
});

test('treats dual, multi-audio, and dubbed titles as possible English-track releases', () => {
  const releases = [
    { title: 'Show.S01E01.1080p.WEB-DL' },
    { title: 'Show.S01E01.1080p.WEB-DL.GERMAN.DUAL.AUDIO' },
    { title: 'Show.S01E01.1080p.WEB-DL.JAPANESE.MULTI' },
    { title: 'Show.S01E01.1080p.WEB-DL.FRENCH.DUBBED' },
    { title: 'Show.S01E01.1080p.WEB-DL.ENGLISH' },
    { title: 'Show.S01E01.1080p.WEB-DL.GERMAN' }
  ];
  assert.deepEqual(rankReleases(releases, { title: 'Show', season: 1, episode: 1 }).map(item => item.title), [
    'Show.S01E01.1080p.WEB-DL.ENGLISH',
    'Show.S01E01.1080p.WEB-DL.GERMAN.DUAL.AUDIO',
    'Show.S01E01.1080p.WEB-DL.JAPANESE.MULTI',
    'Show.S01E01.1080p.WEB-DL.FRENCH.DUBBED',
    'Show.S01E01.1080p.WEB-DL'
  ]);
});

test('ignores playback responses from an episode superseded by a quick selection', async () => {
  const guard = createPlaybackRequestGuard();
  let displayedJob = null;
  const first = guard.begin();
  const second = guard.begin();
  if (guard.isCurrent(second)) displayedJob = { episode: 2, status: 'ready' };
  if (guard.isCurrent(first)) displayedJob = { episode: 1, status: 'ready' };
  assert.deepEqual(displayedJob, { episode: 2, status: 'ready' });
});

test('identifies persistent offline copies for movies and individual episodes', () => {
  const movie = { id: 10, type: 'movie', title: 'Film' };
  const episode = { id: 20, type: 'tv', title: 'Show', season: 2, episode: 3 };
  assert.equal(offlineMediaKey(movie), 'movie:10');
  assert.equal(offlineMediaKey(episode), 'tv:20:s2:e3');
  const downloads = [{ status: 'ready', media: episode }, { status: 'error', media: { ...episode, episode: 4 } }];
  assert.deepEqual(offlineAvailability({ id: 20, type: 'tv' }, downloads), { available: true, count: 1 });
  assert.deepEqual(offlineEpisodes(downloads, 20), [episode]);
});

test('keeps title-only fallback ranking anchored to the selected year', () => {
  const ranked = rankReleases([{ title: 'The.Matrix.Reloaded.2003.2160p' }, { title: 'The.Matrix.1999.1080p' }], { title: 'The Matrix', year: '1999' });
  assert.match(ranked[0].title, /1999/);
});

test('prefers practical H.264 playback over expensive HEVC conversion', () => {
  const ranked = rankReleases([{ title: 'Film.2024.2160p.HEVC' }, { title: 'Film.2024.1080p.H264.WEB-DL' }], { title: 'Film', year: '2024' });
  assert.match(ranked[0].title, /H264/);
});

test('can favour a quick-start release and explains release readiness', () => {
  const ranked = rankReleases([
    { title: 'Film.2024.2160p.HEVC.BluRay' },
    { title: 'Film.2024.1080p.H264.WEB-DL.mp4' }
  ], { title: 'Film', year: '2024' }, { playbackQuality: 'fast' });
  assert.match(ranked[0].title, /H264/);
  assert.deepEqual(releaseReadiness({ title: 'Film.2024.part01.rar' }), { kind: 'download', label: 'Download first' });
  assert.deepEqual(releaseReadiness({ title: 'Film.2024.1080p.H264.mp4' }), { kind: 'direct', label: 'Likely direct' });
});

test('only requests a download fallback for a direct stream', () => {
  assert.equal(canUseFallback({ mode: 'direct', status: 'ready' }), true);
  assert.equal(canUseFallback({ mode: 'cached', status: 'ready' }), false);
});

test('chooses browser conversion strategies from container and codec', () => {
  assert.equal(playbackStrategy('movie.mp4 yEnc', 'Movie H.264'), 'remux');
  assert.equal(playbackStrategy('movie.webm yEnc', 'Movie VP9'), 'transcode');
  assert.equal(playbackStrategy('movie.mkv yEnc', 'Movie x264 DTS'), 'remux');
  assert.equal(playbackStrategy('movie.mkv yEnc', 'Movie HEVC'), 'transcode');
  assert.equal(audioAwarePlaybackStrategy('raw', [{ codec_type: 'video' }, { codec_type: 'audio' }, { codec_type: 'audio', tags: { language: 'eng' } }]), 'remux');
  assert.equal(audioAwarePlaybackStrategy('raw', [{ codec_type: 'video' }, { codec_type: 'audio' }]), 'raw');
});
