// Browser regression: playwright-cli -s=<session> run-code --filename=scripts/check-playback-startup.js
// Run with a browser already on the local app. All API requests are fixtures.
// Add ?startup=first to that URL to test S01E01 with no saved progress.
async page => {
  const firstPlay = page.url().includes('startup=first');
  const episode = firstPlay ? 1 : 2, position = firstPlay ? 0 : 48;
  const origin = await page.evaluate(() => location.origin);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const media = { id: 95480, type: 'tv', title: 'Slow Horses', season: 1, episode, episodeTitle: firstPlay ? 'Failures, Contagious' : 'Work Drinks' };
  const ready = { id: 'startup-fixture', status: 'ready', mode: 'direct', progress: 100, streamUrl: '/api/play/startup-fixture/stream', hlsUrl: '/api/play/startup-fixture/hls' };
  const starts = [];
  let manual = false, emptySeasons = false, playCount = 0;
  let playRequested = false, playOverlapped = false, notifyPlay;
  const playStarted = new Promise(resolve => { notifyPlay = resolve; });
  let episodeRequested = false, episodeOverlapped = false, polls = 0, notifyEpisode, notifyHls;
  const episodeStarted = new Promise(resolve => { notifyEpisode = resolve; });
  const hlsStarted = new Promise(resolve => { notifyHls = resolve; });
  const routeApi = async route => {
    const path = route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    let body = {};
    if (path === '/api/settings') body = { autoPlayNextEpisode: false, downloadNextEpisode: false, manualReleaseSelection: manual };
    else if (path === '/api/state' || path === '/api/state/progress') body = { library: [], progress: firstPlay ? [] : [{ media, position, duration: 3120, watched: false }] };
    else if (path === '/api/offline') body = { downloads: [], jobs: [] };
    else if (path.endsWith('/seasons')) {
      await Promise.race([episodeStarted, page.waitForTimeout(250)]);
      episodeOverlapped = episodeRequested;
      body = { seasons: emptySeasons ? [] : [{ number: 1, name: 'Season 1' }] };
    } else if (path.endsWith('/episodes')) { episodeRequested = true; notifyEpisode(); await Promise.race([playStarted, page.waitForTimeout(250)]); playOverlapped = playRequested; body = { episodes: [{ number: episode, name: media.episodeTitle, runtime: 52 }] }; }
    else if (path === '/api/releases') body = { releases: [] };
    else if (path === '/api/play') { playCount++; playRequested = true; notifyPlay(); body = ready; }
    else if (path === '/api/play/startup-fixture') { polls++; body = ready; }
    else if (path === ready.hlsUrl) {
      starts.push(JSON.parse(route.request().postData()).start); notifyHls();
      body = { sessionUrl: '/api/play/startup-fixture/hls/session', playlistUrl: '/api/play/startup-fixture/hls/session/index.m3u8', duration: 3120 };
    } else if (path.endsWith('.m3u8')) {
      return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  };
  await page.route('**/api/**', routeApi);
  try {
    await page.goto(`${origin}/watch/tv/95480?title=Slow+Horses&year=2022&season=1&episode=${episode}&play=1${firstPlay ? '' : '&resume=1'}`);
    await Promise.race([hlsStarted, page.waitForTimeout(5000).then(() => { throw new Error('No stream setup request within 5 seconds'); })]);
    await page.waitForTimeout(150);
    const initial = { passed: playOverlapped && episodeOverlapped && polls === 0 && starts.length === 1 && starts[0] === position, episodeOverlapped, playOverlapped, polls, starts: [...starts] };
    await page.goto('about:blank');
    manual = true;
    const beforeManual = playCount;
    await page.goto(`${origin}/watch/tv/95480?title=Slow+Horses&year=2022&season=1&episode=${episode}&play=1${firstPlay ? '' : '&resume=1'}`);
    await page.getByText('No compatible releases were found for this title.', { exact: true }).waitFor();
    const manualPreserved = playCount === beforeManual && starts.length === 1;
    await page.goto('about:blank');
    manual = false; emptySeasons = true;
    await page.goto(`${origin}/watch/tv/95480?title=Slow+Horses&year=2022&season=1&episode=${episode}&play=1${firstPlay ? '' : '&resume=1'}`);
    await page.getByText('No selectable seasons were found for this show.', { exact: true }).waitFor();
    await page.waitForTimeout(100);
    const catalogueValidationPreserved = starts.length === 1;
    return { ...initial, passed: initial.passed && manualPreserved && catalogueValidationPreserved, manualPreserved, catalogueValidationPreserved };
  } finally {
    await page.goto('about:blank');
    await page.unroute('**/api/**', routeApi);
  }
}
