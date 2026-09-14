// Run on the isolated app using playwright-cli run-code --filename=...
// Add ?benchmark=prewarm to exercise poster preparation, or ?benchmark=first
// to open S01E01 from zero with no progress returned to the browser.
// Viewing-history writes are intercepted; the real saved position is untouched.
async page => {
  const origin = page.url().startsWith('http') ? page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1') : 'http://localhost:5189';
  const firstPlay = page.url().includes('benchmark=first');
  const episode = firstPlay ? 1 : 2;
  const prewarm = page.url().includes('benchmark=prewarm');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const state = await (await page.request.get(`${origin}/api/state`)).json();
  const entry = state.progress.find(item => item.media.id === 95480 && item.media.season === 1 && item.media.episode === episode);
  await page.route('**/api/state/progress', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }) : route.continue());
  await page.route('**/api/play/*/background', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  if (!prewarm) await page.route('**/api/play/prewarm', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"prepared":false}' }));
  if (firstPlay) await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.progress = body.progress.filter(item => !(item.media.id === 95480 && item.media.season === 1 && item.media.episode === episode));
    await route.fulfill({ response, json: body });
  });
  await page.goto(origin);
  const button = page.getByRole('link', { name: 'Play Slow Horses, season 1, episode 2: Work Drinks', exact: true });
  if (!firstPlay) await button.waitFor({ state: 'visible' });
  if (prewarm) { await button.hover(); await page.waitForTimeout(15000); }
  const events = [];
  let start = Date.now();
  const listener = async response => {
    const path = response.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (!/^\/api\/play(?:\/[^/]+)?(?:\/hls)?$/.test(path)) return;
    try {
      const body = await response.json();
      events.push({ ms: Date.now() - start, path, id: body.id, status: body.status, activity: body.diagnostics?.events?.at(-1)?.activity, message: body.message, diagnostics: body.diagnostics?.events });
    } catch {}
  };
  page.on('response', listener);
  let playing = false;
  try {
    if (firstPlay) await page.goto(`${origin}/watch/tv/95480?title=Slow%20Horses&season=1&episode=1&play=1`);
    else await button.click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.readyState >= 3 && video.getVideoPlaybackQuality().totalVideoFrames > 2 && video.currentTime > 0.2;
    }, {}, { timeout: 45000 });
    playing = true;
  } catch {}
  const elapsed = Date.now() - start;
  const jobId = events.find(event => event.path === '/api/play' && event.id)?.id;
  const finalJob = jobId ? await (await page.request.get(`${origin}/api/play/${jobId}`)).json() : null;
  const videos = await page.locator('video').evaluateAll(videos => videos.map(video => ({ time: video.currentTime, readyState: video.readyState, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames, dropped: video.getVideoPlaybackQuality().droppedVideoFrames })));
  const text = playing ? undefined : (await page.locator('body').innerText()).slice(-1400);
  page.off('response', listener);
  await page.goto('about:blank');
  const after = await (await page.request.get(`${origin}/api/state`)).json();
  const saved = after.progress.find(item => item.media.id === 95480 && item.media.season === 1 && item.media.episode === episode);
  return { playing, elapsed, release: finalJob?.diagnostics?.release, stages: finalJob?.diagnostics?.events, prewarm, firstPlay, position: firstPlay ? 0 : entry?.position, historyUnchanged: JSON.stringify(entry) === JSON.stringify(saved), events, videos, text };
}
