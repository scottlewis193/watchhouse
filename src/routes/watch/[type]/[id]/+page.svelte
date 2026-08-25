<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import { canSavePlaybackProgress, canUseFallback, episodePlaybackMedia, firstUnwatchedEpisode, playbackTimeline, progressDuration, resumePosition, resumeStreamUrl, shouldMarkWatched } from '$lib/playback-controls.js';
  import PlaybackPreparation from '$lib/PlaybackPreparation.svelte';

  const media = { id: Number(page.params.id), type: page.params.type, title: page.url.searchParams.get('title') || '', year: page.url.searchParams.get('year') || '', poster: page.url.searchParams.get('poster') || '' };
  const requestedSeason = page.url.searchParams.get('season') || '', requestedEpisode = page.url.searchParams.get('episode') || '', shouldResume = page.url.searchParams.get('resume') === '1';
  let seasons = $state([]), episodes = $state([]), episodesBySeason = $state({}), selectedSeason = $state(''), selectedEpisode = $state('');
  let playback = $state(null), player = $state(), playerShell = $state(), manualReleaseSelection = $state(false), detailedPlaybackProgress = $state(false), releaseChoices = $state([]), pendingMedia = $state(null), pendingResume = $state(false);
  let currentMedia = $state(null), nextMedia = $state(null), nextJob = $state(null), showUpNext = $state(false), autoPlayNext = $state(true);
  let library = $state([]), progressEntries = $state([]);
  let resumeStreamOffset = $state(0), resumeStarting = $state(false), resumePlayback = $state(false), playbackSettled = $state(false), bulkUpdating = $state(false), bulkError = $state('');
  let playing = $state(false), playerPosition = $state(0), playerDuration = $state(0), seekPreview = $state(null), playerVolume = $state(1), playerMuted = $state(false), fullscreen = $state(false);
  let pollTimer, nextPollTimer, startupStableTimer, startupFallbackTimer, lastProgressSave = 0, progressWritePending = false, restoredMediaKey = '', autoMarkedMediaKey = '';

  onMount(() => {
    if (!media.title || !['movie', 'tv'].includes(media.type) || !Number.isInteger(media.id)) {
      playback = { status: 'error', message: 'This title link is invalid.', progress: 0 };
      return;
    }
    void initialise();
    return () => { void savePlaybackProgress(true); clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer); player?.pause(); };
  });

  async function initialise() {
    try { const settings = await api.get('/api/settings'); manualReleaseSelection = Boolean(settings.manualReleaseSelection); detailedPlaybackProgress = Boolean(settings.detailedPlaybackProgress); } catch { manualReleaseSelection = false; detailedPlaybackProgress = false; }
    try { const state = await api.get('/api/state'); library = state.library; progressEntries = state.progress; } catch {}
    if (media.type === 'movie') {
      const savedDuration = progressFor(media)?.duration;
      if (savedDuration) media.durationHint = savedDuration;
      else try { media.durationHint = (await api.get(`/api/catalog/movies/${media.id}/runtime`)).duration; } catch {}
      return startPlayback(media);
    }
    playback = { status: 'selecting', message: 'Loading seasons…', progress: 3 };
    try {
      seasons = (await api.get(`/api/catalog/shows/${media.id}/seasons`)).seasons;
      if (!seasons.length) throw new Error('No selectable seasons were found for this show.');
      selectedSeason = seasons.some(season => String(season.number) === requestedSeason) ? requestedSeason : String(seasons[0].number);
      await loadEpisodes(requestedEpisode);
      if (requestedEpisode) playEpisode(shouldResume);
      else await playNextUnwatchedEpisode();
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function episodesForSeason(season) {
    const key = String(season);
    if (episodesBySeason[key]) return episodesBySeason[key];
    const loaded = (await api.get(`/api/catalog/shows/${media.id}/episodes?season=${key}`)).episodes;
    episodesBySeason = { ...episodesBySeason, [key]: loaded };
    return loaded;
  }

  async function loadEpisodes(preferredEpisode = '') {
    if (!selectedSeason) return;
    episodes = []; selectedEpisode = '';
    playback = { status: 'selecting', message: `Loading season ${selectedSeason} episodes…`, progress: 5 };
    try {
      episodes = await episodesForSeason(selectedSeason);
      if (!episodes.length) throw new Error('No episodes were found for this season.');
      selectedEpisode = episodes.some(episode => String(episode.number) === String(preferredEpisode)) ? String(preferredEpisode) : String(episodes[0].number); playback = null;
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function startPlayback(selectedMedia, preparedJob = null, resume = false) {
    if (manualReleaseSelection && !selectedMedia.releaseId && !preparedJob) return chooseRelease(selectedMedia, resume);
    try {
      void savePlaybackProgress(true);
      clearTimeout(nextPollTimer); nextMedia = null; nextJob = null; showUpNext = false; autoPlayNext = true;
      if (selectedMedia.type === 'tv') {
        selectedSeason = String(selectedMedia.season);
        selectedEpisode = String(selectedMedia.episode);
        episodes = await episodesForSeason(selectedMedia.season);
      }
      currentMedia = selectedMedia;
      clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
      restoredMediaKey = ''; autoMarkedMediaKey = ''; resumeStreamOffset = 0; resumeStarting = false; resumePlayback = resume; playbackSettled = false; playerPosition = 0; playerDuration = 0; seekPreview = null;
      playback = preparedJob || { status: 'selecting', message: 'Finding the best available release…', progress: 3 };
      const job = preparedJob || await api.post('/api/play', selectedMedia);
      playback = job; void poll(job.id);
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function chooseRelease(selectedMedia, resume = false) {
    pendingMedia = selectedMedia; pendingResume = resume; releaseChoices = [];
    try {
      playback = { status: 'selecting', message: 'Finding available releases…', progress: 15 };
      releaseChoices = (await api.post('/api/releases', selectedMedia)).releases;
      if (!releaseChoices.length) throw new Error('No compatible releases were found for this title.');
      playback = null;
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function poll(id) {
    try {
      const job = await api.get(`/api/play/${id}`); playback = job;
      if (job.status === 'ready') {
        const entry = progressFor(currentMedia);
        const duration = progressDuration(job.mode, player?.duration) || currentMedia?.durationHint || entry?.duration || 0;
        resumeStreamOffset = resumePlayback && job.mode === 'direct' ? resumePosition(entry, duration) : 0;
        beginPlaybackWarmup();
        void prepareNextEpisode(currentMedia); return;
      }
      if (job.status !== 'error') pollTimer = setTimeout(() => void poll(id), 900);
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function prepareNextEpisode(selectedMedia) {
    if (manualReleaseSelection || selectedMedia?.type !== 'tv' || nextMedia) return;
    const candidate = await adjacentEpisodeMedia(selectedMedia, 1);
    if (!candidate || itemKey(currentMedia) !== itemKey(selectedMedia)) return;
    nextMedia = candidate;
    try { nextJob = await api.post('/api/play', nextMedia); void pollNextEpisode(nextJob.id); } catch { nextJob = { status: 'error' }; }
  }

  async function pollNextEpisode(id) {
    try { const job = await api.get(`/api/play/${id}`); nextJob = job; if (job.status !== 'ready' && job.status !== 'error') nextPollTimer = setTimeout(() => void pollNextEpisode(id), 900); }
    catch { nextJob = { status: 'error' }; }
  }

  function playEpisode(resume = true) {
    const selectedMedia = episodePlaybackMedia(media, selectedSeason, selectedEpisode, episodes);
    if (!selectedMedia) { playback = { status: 'error', message: 'Choose a valid season and episode before starting playback.', progress: 0 }; return; }
    void startPlayback(selectedMedia, null, resume && Boolean(progressFor(selectedMedia)?.position));
  }

  function playEpisodeNumber(episodeNumber) {
    selectedEpisode = String(episodeNumber);
    playEpisode();
  }

  function itemKey(item) { return item?.type === 'tv' ? `${item.type}:${item.id}:s${item.season}:e${item.episode}` : `${item?.type}:${item?.id}`; }
  function progressFor(item) { const key = itemKey(item); return progressEntries.find(entry => itemKey(entry.media) === key); }
  function selectedMediaItem() { return media.type === 'movie' ? media : episodePlaybackMedia(media, selectedSeason, selectedEpisode, episodes); }
  function isInLibrary() { return library.some(item => item.id === media.id && item.type === media.type); }
  function isWatched(item = selectedMediaItem()) { return Boolean(progressFor(item)?.watched); }
  function episodeMedia(season, episode) { return episodePlaybackMedia(media, season, episode.number, [episode]); }
  function watchedEpisodeNumbers(season) { return new Set(progressEntries.filter(entry => entry.media.type === 'tv' && entry.media.id === media.id && entry.media.season === Number(season) && entry.watched).map(entry => entry.media.episode)); }
  function isSeasonWatched() { return Boolean(episodes.length) && episodes.every(episode => watchedEpisodeNumbers(selectedSeason).has(episode.number)); }
  function isSeriesWatched() { return Boolean(seasons.length) && seasons.every(season => season.episodeCount > 0 && watchedEpisodeNumbers(season.number).size >= season.episodeCount); }

  async function playNextUnwatchedEpisode() {
    playback = { status: 'selecting', message: 'Finding your next unwatched episode…', progress: 5 };
    for (const season of seasons) {
      const seasonEpisodes = await episodesForSeason(season.number);
      const episode = firstUnwatchedEpisode(seasonEpisodes, watchedEpisodeNumbers(season.number));
      if (!episode) continue;
      selectedSeason = String(season.number); episodes = seasonEpisodes; selectedEpisode = String(episode.number);
      const selectedMedia = episodeMedia(season.number, episode);
      await startPlayback(selectedMedia, null, Boolean(progressFor(selectedMedia)?.position));
      return;
    }
    selectedSeason = String(seasons[0].number); episodes = await episodesForSeason(selectedSeason); selectedEpisode = episodes.length ? String(episodes[0].number) : '';
    playback = null;
  }

  async function adjacentEpisodeMedia(item, direction) {
    if (item?.type !== 'tv') return null;
    let seasonIndex = seasons.findIndex(season => season.number === Number(item.season));
    if (seasonIndex < 0) return null;
    let seasonEpisodes = await episodesForSeason(item.season);
    const episodeIndex = seasonEpisodes.findIndex(episode => episode.number === Number(item.episode));
    const adjacent = seasonEpisodes[episodeIndex + direction];
    if (adjacent) return episodeMedia(item.season, adjacent);
    for (seasonIndex += direction; seasonIndex >= 0 && seasonIndex < seasons.length; seasonIndex += direction) {
      seasonEpisodes = await episodesForSeason(seasons[seasonIndex].number);
      const episode = direction > 0 ? seasonEpisodes[0] : seasonEpisodes.at(-1);
      if (episode) return episodeMedia(seasons[seasonIndex].number, episode);
    }
    return null;
  }

  function canNavigateEpisode(direction) {
    if (currentMedia?.type !== 'tv') return false;
    const seasonIndex = seasons.findIndex(season => season.number === currentMedia.season);
    const episodeIndex = episodes.findIndex(episode => episode.number === currentMedia.episode);
    return direction < 0 ? episodeIndex > 0 || seasonIndex > 0 : episodeIndex >= 0 && (episodeIndex < episodes.length - 1 || seasonIndex < seasons.length - 1);
  }

  async function playAdjacentEpisode(direction) {
    const selectedMedia = await adjacentEpisodeMedia(currentMedia, direction);
    if (selectedMedia) await startPlayback(selectedMedia, null, Boolean(progressFor(selectedMedia)?.position));
  }

  async function setManyWatched(items, watched) {
    if (!items.length) return;
    bulkUpdating = true; bulkError = '';
    const keys = new Set(items.map(itemKey));
    if (watched && currentMedia && keys.has(itemKey(currentMedia))) autoMarkedMediaKey = itemKey(currentMedia);
    else if (!watched && keys.has(autoMarkedMediaKey)) autoMarkedMediaKey = '';
    try {
      const state = await api.put('/api/state/progress/bulk', { media: items, watched, reset: !watched });
      progressEntries = state.progress;
    } catch (error) { bulkError = error.message; }
    finally { bulkUpdating = false; }
  }

  function toggleSeasonWatched() { const watched = !isSeasonWatched(); void setManyWatched(episodes.map(episode => episodeMedia(selectedSeason, episode)), watched); }
  function runBulkAction(event, action) { event.currentTarget.closest('details')?.removeAttribute('open'); action(); }
  async function toggleSeriesWatched() {
    const watched = !isSeriesWatched();
    if (!watched) return setManyWatched(progressEntries.filter(entry => entry.media.type === 'tv' && entry.media.id === media.id).map(entry => entry.media), false);
    const items = [];
    try { for (const season of seasons) for (const episode of await episodesForSeason(season.number)) items.push(episodeMedia(season.number, episode)); }
    catch (error) { bulkError = error.message; return; }
    await setManyWatched(items, true);
  }

  async function toggleLibrary() {
    const state = await api.put('/api/state/library', { media, inLibrary: !isInLibrary() });
    library = state.library;
  }

  async function setWatched(item, watched) {
    if (!item) return;
    const key = itemKey(item), sameAsPlaying = key === itemKey(currentMedia);
    if (watched) autoMarkedMediaKey = key;
    else if (autoMarkedMediaKey === key) autoMarkedMediaKey = '';
    const state = await api.put('/api/state/progress', { media: item, watched, reset: !watched, ...(sameAsPlaying && player ? { position: currentPlaybackPosition(), duration: progressDuration(playback?.mode, player.duration) || currentMedia.durationHint || progressFor(currentMedia)?.duration || 0 } : {}) });
    progressEntries = state.progress;
  }

  function toggleWatched() { const item = selectedMediaItem(); void setWatched(item, !isWatched(item)); }

  async function savePlaybackProgress(force = false) {
    if (!player || !currentMedia || resumeStarting || progressWritePending || !Number.isFinite(player.currentTime)) return;
    const now = Date.now(), key = itemKey(currentMedia);
    if (!canSavePlaybackProgress(key, autoMarkedMediaKey)) return;
    const reliableDuration = progressDuration(playback?.mode, player.duration);
    const position = currentPlaybackPosition();
    if (shouldMarkWatched(position, reliableDuration)) {
      if (autoMarkedMediaKey !== key) await setWatched(currentMedia, true);
      return;
    }
    if (position < 1 || (!force && now - lastProgressSave < 10000)) return;
    progressWritePending = true; lastProgressSave = now;
    try {
      const duration = reliableDuration || currentMedia.durationHint || progressFor(currentMedia)?.duration || 0;
      const state = await api.put('/api/state/progress', { media: currentMedia, position, duration, watched: false });
      progressEntries = state.progress;
    } finally { progressWritePending = false; }
  }

  function restorePlaybackProgress() {
    const key = itemKey(currentMedia), entry = progressFor(currentMedia);
    if (playback?.mode === 'direct') { restoredMediaKey = key; return; }
    const duration = progressDuration(playback?.mode, player?.duration) || currentMedia?.durationHint || entry?.duration || 0;
    const position = resumePlayback ? resumePosition(entry, duration) : 0;
    if (!position || restoredMediaKey === key) return;
    player.currentTime = position; restoredMediaKey = key;
  }

  function currentPlaybackPosition() { return Math.max(0, Number(player?.currentTime) || 0) + (playback?.mode === 'direct' ? resumeStreamOffset : 0); }
  function playbackStreamUrl() { return resumeStreamUrl(playback?.streamUrl, playback?.mode, resumeStreamOffset); }

  function beginPlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
    playbackSettled = false; resumeStarting = true;
  }
  function settlePlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
    playbackSettled = true; resumeStarting = false;
  }
  function handleCanPlay() {
    if (playbackSettled) return;
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = setTimeout(settlePlaybackWarmup, 6000);
  }
  function handlePlaying() {
    playing = true;
    if (playbackSettled) return;
    clearTimeout(startupStableTimer);
    startupStableTimer = setTimeout(settlePlaybackWarmup, 1200);
  }
  function handleStartupBuffering() {
    if (playbackSettled) return;
    clearTimeout(startupStableTimer); resumeStarting = true;
  }
  function handlePause() {
    playing = false;
    if (!playbackSettled) clearTimeout(startupStableTimer);
    void savePlaybackProgress(true);
  }

  async function retryPlayback() {
    if (!playback?.id) return;
    try { playback = await api.post(`/api/play/${playback.id}/retry`); void poll(playback.id); } catch (e) { playback = { ...playback, status: 'error', message: e.message }; }
  }

  function formatPosition(seconds) { const value = Math.max(0, Math.round(seconds)); const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), remainder = value % 60; return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`; }
  function preparationTitle() { if (playback?.status === 'error') return 'Playback needs attention'; if (media.type === 'tv' && !currentMedia) return 'Choose an episode to begin'; return `Getting ${currentMedia?.episodeTitle || media.title || 'your title'} ready…`; }
  function formatAirDate(value) { if (!value) return ''; const [year, month, day] = value.split('-').map(Number); if (!year || !month || !day) return value; return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(year, month - 1, day)); }
  async function fallback() { if (!canUseFallback(playback)) { playback = { ...playback, status: 'error', message: 'The prepared video could not be played by this browser. The download is complete; try a different release or check this browser’s codec support.' }; return; } try { playback = await api.post(`/api/play/${playback.id}/fallback`); void poll(playback.id); } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; } }
  function playNextEpisode() { if (!nextMedia || nextJob?.status === 'error') return; void setWatched(currentMedia, true); const selectedMedia = nextMedia, job = nextJob; void startPlayback(selectedMedia, job, false); setTimeout(() => player?.play().catch(() => {}), 0); }
  function handleTimeUpdate() {
    playerPosition = Number.isFinite(player?.currentTime) ? player.currentTime : 0;
    playerDuration = Number.isFinite(player?.duration) ? player.duration : 0;
    restorePlaybackProgress();
    const duration = progressDuration(playback?.mode, player?.duration);
    if (nextMedia && duration && duration - player.currentTime <= 30) showUpNext = true;
    void savePlaybackProgress();
  }
  function handleEnded() {
    playing = false;
    if (autoPlayNext && nextMedia) playNextEpisode();
    else if (player && shouldMarkWatched(player.currentTime, progressDuration(playback?.mode, player.duration))) void setWatched(currentMedia, true);
    else if (player && playback?.mode === 'direct' && currentPlaybackPosition() >= 30) void setWatched(currentMedia, true);
    else void savePlaybackProgress(true);
  }

  function controlTimeline() {
    const entry = progressFor(currentMedia);
    const timeline = playbackTimeline(playback?.mode, playerPosition, currentMedia?.durationHint || entry?.duration || 0, playerDuration, resumeStreamOffset);
    return { ...timeline, position: seekPreview ?? timeline.position };
  }
  function togglePlayback() { if (!player) return; if (player.paused) void player.play(); else player.pause(); }
  function previewSeek(event) { const position = Number(event.currentTarget.value); if (Number.isFinite(position)) seekPreview = position; }
  function commitSeek(event) { seekToPosition(Number(event.currentTarget.value)); }
  function seekToPosition(position) {
    if (!player || !Number.isFinite(position)) return;
    const target = Math.min(controlTimeline().duration, Math.max(0, position));
    seekPreview = null;
    if (playback?.mode === 'direct') {
      void savePlaybackProgress(true);
      resumeStreamOffset = target;
      playerPosition = 0;
      beginPlaybackWarmup();
      setTimeout(() => player?.play().catch(() => {}), 0);
    } else player.currentTime = target;
  }
  function seekBy(seconds) { const timeline = controlTimeline(); if (timeline.duration) seekToPosition(timeline.position + seconds); }
  function setVolume(event) { if (!player) return; const volume = Number(event.currentTarget.value); if (!Number.isFinite(volume)) return; player.volume = volume; player.muted = volume === 0; }
  function toggleMute() { if (player) player.muted = !player.muted; }
  async function toggleFullscreen() { if (!playerShell) return; if (document.fullscreenElement) await document.exitFullscreen(); else await playerShell.requestFullscreen(); }
  function handlePlayerKeydown(event) {
    if (event.target.matches('button, input')) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(10); }
    else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute(); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); void toggleFullscreen(); }
  }
</script>

<svelte:window onfullscreenchange={() => { fullscreen = Boolean(document.fullscreenElement); }} />

<svelte:head><title>{media.title ? `${media.title} · Watchhouse` : 'Watch · Watchhouse'}</title></svelte:head>

<section class="py-2 sm:py-6">
  <a class="link link-hover text-sm text-base-content/60" href="/">← Back to discover</a>
  <div class="mt-6 border-b border-base-300 pb-6 sm:flex sm:items-end sm:justify-between sm:gap-6"><div><p class="text-xs font-semibold tracking-[0.18em] text-base-content/50">{media.type === 'tv' ? 'SERIES' : 'FILM'}{media.year ? ` · ${media.year}` : ''}</p><h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-5xl">{media.title || 'Watch'}</h1>{#if media.type === 'tv' && selectedSeason && selectedEpisode}<p class="mt-2 text-base-content/65">Season {selectedSeason}, episode {selectedEpisode}</p>{/if}</div><div class="mt-4 flex flex-wrap gap-2 sm:mt-0"><button class="btn btn-sm btn-outline" onclick={toggleLibrary}>{isInLibrary() ? 'Remove from library' : '+ Add to library'}</button><button class="btn btn-sm btn-ghost" onclick={toggleWatched} disabled={media.type === 'tv' && !selectedEpisode}>{isWatched() ? `Mark ${media.type === 'tv' ? 'episode ' : ''}unwatched` : `Mark ${media.type === 'tv' ? 'episode ' : ''}watched`}</button></div></div>
  {#if bulkError}<div class="alert alert-error mt-4"><span>{bulkError}</span><button class="btn btn-sm btn-ghost" aria-label="Dismiss bulk update error" onclick={() => { bulkError = ''; }}>Dismiss</button></div>{/if}
  <div class="mt-8 grid gap-8 {media.type === 'tv' || releaseChoices.length ? 'xl:grid-cols-[minmax(0,1fr)_24rem]' : ''}">
    <div>
      {#if currentMedia}
        <div class="player-shell group/player relative aspect-video overflow-hidden bg-black shadow-2xl" bind:this={playerShell}>
          {#if playback?.status === 'ready'}
            {@const timeline = controlTimeline()}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="h-full w-full bg-black object-contain transition-opacity focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" class:opacity-0={resumeStarting} bind:this={player} tabindex={resumeStarting ? -1 : 0} aria-hidden={resumeStarting} aria-label={`${media.title} video player`} autoplay playsinline preload="auto" src={playbackStreamUrl()} onclick={togglePlayback} onkeydown={handlePlayerKeydown} onerror={fallback} onloadedmetadata={() => { restorePlaybackProgress(); playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; }} oncanplay={handleCanPlay} ondurationchange={() => { playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; }} ontimeupdate={handleTimeUpdate} onplay={() => { playing = true; }} onplaying={handlePlaying} onwaiting={handleStartupBuffering} onstalled={handleStartupBuffering} onpause={handlePause} onvolumechange={() => { playerVolume = player?.volume ?? 1; playerMuted = player?.muted ?? false; }} onended={handleEnded}></video>
            {#if resumeStarting}
              <div class="absolute inset-0 z-20"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} /></div>
            {:else}<div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/85 to-transparent px-3 pb-3 pt-10 text-white sm:px-4 sm:pb-4">
            <label class="sr-only" for="playback-position">Playback position</label>
            <input id="playback-position" class="range range-primary range-xs block w-full" type="range" min="0" max={timeline.duration || 0} step="0.1" value={timeline.position} disabled={!timeline.duration} oninput={previewSeek} onchange={commitSeek} aria-valuetext={`${formatPosition(timeline.position)} of ${formatPosition(timeline.duration)}`} />
            <div class="mt-3 flex items-center gap-2 sm:gap-3">
              {#if media.type === 'tv'}<button class="grid size-9 place-items-center rounded-full transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-35" onclick={() => void playAdjacentEpisode(-1)} disabled={!canNavigateEpisode(-1)} aria-label="Previous episode"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4 4h2v12H4zm12.2.3a1 1 0 0 1 1.55.83v9.74a1 1 0 0 1-1.55.83L9.4 10.83a1 1 0 0 1 0-1.66z" /></svg></button>{/if}
              <button class="grid size-9 place-items-center rounded-full transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" onclick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>
                {#if playing}<svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4.5 3.5h4v13h-4zm7 0h4v13h-4z" /></svg>{:else}<svg class="size-5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 3.7a1 1 0 0 1 1.54-.84l9 6.3a1 1 0 0 1 0 1.68l-9 6.3A1 1 0 0 1 5 16.3z" /></svg>{/if}
              </button>
              {#if media.type === 'tv'}<button class="grid size-9 place-items-center rounded-full transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-35" onclick={() => void playAdjacentEpisode(1)} disabled={!canNavigateEpisode(1)} aria-label="Next episode"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M16 4h-2v12h2zM3.8 4.3a1 1 0 0 0-1.55.83v9.74a1 1 0 0 0 1.55.83l6.8-4.87a1 1 0 0 0 0-1.66z" /></svg></button>{/if}
              <button class="grid size-9 place-items-center rounded-full text-xs font-semibold transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" onclick={() => seekBy(-10)} aria-label="Rewind 10 seconds">−10</button>
              <button class="grid size-9 place-items-center rounded-full text-xs font-semibold transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" onclick={() => seekBy(10)} aria-label="Forward 10 seconds">+10</button>
              <span class="min-w-24 text-xs tabular-nums text-white/80">{formatPosition(timeline.position)} / {formatPosition(timeline.duration)}</span>
              <div class="ml-auto hidden items-center gap-2 sm:flex">
                <button class="grid size-9 place-items-center rounded-full transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" onclick={toggleMute} aria-label={playerMuted ? 'Unmute' : 'Mute'}>
                  {#if playerMuted || playerVolume === 0}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3zM13 8l4 4m0-4-4 4" /></svg>{:else}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3zM13 7a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10" /></svg>{/if}
                </button>
                <label class="sr-only" for="playback-volume">Volume</label><input id="playback-volume" class="range range-xs w-24" type="range" min="0" max="1" step="0.05" value={playerMuted ? 0 : playerVolume} oninput={setVolume} />
              </div>
              <button class="grid size-9 place-items-center rounded-full transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" onclick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                {#if fullscreen}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3v5H3m9-5v5h5M8 17v-5H3m9 5v-5h5" /></svg>{:else}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8V3h5m4 0h5v5M3 12v5h5m4 0h5v-5" /></svg>{/if}
              </button>
            </div>
            </div>{/if}
          {:else}
            <div class="absolute inset-0 z-20"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} /></div>
          {/if}
          {#if showUpNext && nextMedia}<div class="absolute inset-x-3 bottom-24 z-30 flex flex-wrap items-center justify-between gap-3 border border-primary/50 bg-base-200/95 p-4 text-base-content shadow-xl backdrop-blur-sm sm:left-auto sm:right-4 sm:w-96"><div><p class="text-xs font-semibold tracking-[0.14em] text-primary">UP NEXT</p><p class="mt-1">{nextMedia.episode}. {nextMedia.episodeTitle}{nextJob?.status === 'ready' ? ' · ready to play' : ' · preparing in background'}</p></div><div class="flex gap-2"><button class="btn btn-sm btn-primary" onclick={playNextEpisode}>Play next</button><button class="btn btn-sm btn-ghost" onclick={() => { autoPlayNext = false; showUpNext = false; }}>Cancel autoplay</button></div></div>{/if}
        </div>
      {:else}
        <div class="aspect-video"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} /></div>
      {/if}
      {#if playback?.status === 'error'}<div class="alert alert-error mt-4"><span>{playback.message}</span>{#if playback.id}<button class="btn btn-sm" onclick={retryPlayback}>Resume</button>{/if}</div>{/if}
    </div>
    {#if media.type === 'tv' || releaseChoices.length}<aside class="border-t border-base-300 pt-6 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
      {#if media.type === 'tv'}
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div><h2 class="text-lg font-semibold">Episodes</h2><p class="mt-1 text-xs text-base-content/55">Select an episode to start watching</p></div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <label class="form-control w-40"><span class="sr-only">Season</span><select class="select select-bordered select-sm w-full" aria-label="Season" aria-busy={!seasons.length && playback?.status !== 'error'} bind:value={selectedSeason} disabled={!seasons.length} onchange={() => loadEpisodes()}>{#if seasons.length}{#each seasons as season}<option value={String(season.number)}>{season.name}</option>{/each}{:else}<option value="">{playback?.status === 'error' ? 'Seasons unavailable' : 'Loading seasons…'}</option>{/if}</select></label>
            <details class="dropdown dropdown-end" class:pointer-events-none={!episodes.length || bulkUpdating}>
              <summary class="btn btn-sm btn-ghost" class:opacity-50={!episodes.length || bulkUpdating} aria-disabled={!episodes.length || bulkUpdating}>Bulk actions <span aria-hidden="true">⌄</span></summary>
              <ul class="menu dropdown-content z-30 mt-2 w-56 border border-base-300 bg-base-100 p-1 shadow-xl" aria-label="Bulk episode actions">
                <li><button onclick={(event) => runBulkAction(event, toggleSeasonWatched)}>{isSeasonWatched() ? 'Mark season unwatched' : 'Mark season watched'}</button></li>
                <li><button onclick={(event) => runBulkAction(event, () => void toggleSeriesWatched())}>{isSeriesWatched() ? 'Mark series unwatched' : 'Mark series watched'}</button></li>
              </ul>
            </details>
          </div>
        </div>
        {#if episodes.length}
          <div class="mt-4 max-h-[34rem] divide-y divide-base-300 overflow-y-auto border-y border-base-300">
            {#each episodes as episode}
              {@const episodeMedia = { ...media, season: Number(selectedSeason), episode: episode.number, episodeTitle: episode.name }}
              {@const episodeWatched = isWatched(episodeMedia)}
              <div
                class="group flex w-full items-center text-left transition-colors hover:bg-base-200"
                class:bg-base-200={String(episode.number) === selectedEpisode}
              >
                <button class="flex min-w-0 flex-1 items-center gap-4 px-2 py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" aria-current={String(episode.number) === selectedEpisode ? 'true' : undefined} aria-label={`Play episode ${episode.number}, ${episode.name}`} onclick={() => playEpisodeNumber(episode.number)}>
                  <span class="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-base-300 text-sm font-semibold text-base-content/65 transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-content">
                    {#if currentMedia?.type === 'tv' && currentMedia.season === Number(selectedSeason) && currentMedia.episode === episode.number && playback?.status === 'ready'}<span class="text-xs tracking-wide">NOW</span>{:else}<svg class="h-4 w-4 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 3.9a1 1 0 0 1 1.52-.85l9.1 6.1a1 1 0 0 1 0 1.7l-9.1 6.1a1 1 0 0 1-1.52-.85V3.9Z" /></svg>{/if}
                  </span>
                  <span class="min-w-0 flex-1"><span class="flex items-baseline gap-2"><span class="text-xs font-semibold text-base-content/50">{episode.number}</span><span class="truncate text-sm font-medium group-hover:text-primary">{episode.name}</span></span>{#if episode.airDate}<span class="mt-1 block text-xs text-base-content/50">{formatAirDate(episode.airDate)}</span>{/if}</span>
                </button>
                <button class="mr-2 grid size-9 shrink-0 place-items-center rounded-full text-sm hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary" class:text-primary={episodeWatched} aria-label={episodeWatched ? `Mark episode ${episode.number} unwatched` : `Mark episode ${episode.number} watched`} aria-pressed={episodeWatched} onclick={() => void setWatched(episodeMedia, !episodeWatched)}>{episodeWatched ? '✓' : '○'}</button>
              </div>
            {/each}
          </div>
        {:else if playback?.status === 'selecting'}
          <div class="mt-4 space-y-1 border-y border-base-300 py-2" aria-label="Loading episodes">
            {#each Array(4) as _}<div class="flex animate-pulse items-center gap-4 px-2 py-3"><span class="h-11 w-11 rounded-full bg-base-300"></span><span class="h-4 w-2/3 rounded bg-base-300"></span></div>{/each}
          </div>
        {/if}
      {/if}
      {#if releaseChoices.length}<div class="mt-8 border-t border-base-300 pt-5"><p class="text-xs font-semibold tracking-[0.14em] text-base-content/55">CHOOSE A RELEASE</p><div class="mt-3 divide-y divide-base-300 border-y border-base-300">{#each releaseChoices as release}<button class="flex w-full items-start justify-between gap-3 py-3 text-left hover:text-primary" onclick={() => void startPlayback({ ...pendingMedia, releaseId: release.id }, null, pendingResume)}><span class="min-w-0"><span class="block truncate text-sm font-medium">{release.title}</span><span class="mt-1 block text-xs text-base-content/55">{release.readiness.label} · {release.category}</span></span>{#if release.size}<span class="shrink-0 text-xs text-base-content/55">{release.size}</span>{/if}</button>{/each}</div></div>{/if}
    </aside>{/if}
  </div>
</section>

<style>
  .player-shell:fullscreen {
    width: 100vw;
    height: 100vh;
    aspect-ratio: auto;
  }
</style>
