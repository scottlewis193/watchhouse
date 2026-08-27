<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import { canSavePlaybackProgress, canUseFallback, createPlaybackRequestGuard, episodePlaybackMedia, firstUnwatchedEpisode, hasGrowingStreamDuration, playbackPollDelay, playbackTimeline, progressDuration, resumePosition, resumeStreamUrl, shouldMarkWatched, shouldPrepareNextEpisode, shouldShowUpNext } from '$lib/playback-controls.js';
  import PlaybackDiagnostics from '$lib/PlaybackDiagnostics.svelte';
  import PlaybackPreparation from '$lib/PlaybackPreparation.svelte';
  import { offlineAvailability, offlineEpisodeState, offlineEpisodes, offlineMediaKey } from '$lib/offline.js';

  const media = { id: Number(page.params.id), type: page.params.type, title: page.url.searchParams.get('title') || '', year: page.url.searchParams.get('year') || '', poster: page.url.searchParams.get('poster') || '' };
  const requestedSeason = page.url.searchParams.get('season') || '', requestedEpisode = page.url.searchParams.get('episode') || '', shouldResume = page.url.searchParams.get('resume') === '1', shouldStartImmediately = page.url.searchParams.get('play') === '1' || shouldResume;
  let seasons = $state([]), episodes = $state([]), episodesBySeason = $state({}), selectedSeason = $state(''), selectedEpisode = $state('');
  let playback = $state(null), player = $state(), playerShell = $state(), manualReleaseSelection = $state(false), detailedPlaybackProgress = $state(false), playbackDiagnostics = $state(false), releaseChoices = $state([]), pendingMedia = $state(null), pendingResume = $state(false);
  let currentMedia = $state(null), nextMedia = $state(null), nextJob = $state(null), showUpNext = $state(false), autoPlayNext = $state(true);
  let library = $state([]), progressEntries = $state([]);
  let offlineMode = $state(false), offlineDownloads = $state([]), offlineJobs = $state([]), downloadError = $state('');
  let resumeStreamOffset = $state(0), resumeStarting = $state(false), resumePlayback = $state(false), playbackSettled = $state(false), playbackNeedsAction = $state(false), playbackRecovery = $state(null), streamAttempt = $state(0), bulkUpdating = $state(false), bulkError = $state('');
  let playing = $state(false), playerPosition = $state(0), playerDuration = $state(0), seekPreview = $state(null), playerVolume = $state(1), playerMuted = $state(false), fullscreen = $state(false), controlsVisible = $state(true);
  let videoDiagnostics = $state(null);
  let pollTimer, nextPollTimer, diagnosticPollTimer, downloadPollTimer, startupStableTimer, startupFallbackTimer, interruptionTimer, controlHideTimer, lastProgressSave = 0, progressWritePending = false, restoredMediaKey = '', autoMarkedMediaKey = '', recoveryPosition = 0, currentPlaybackRequestToken = 0, preparingNext = false;
  const playbackRequests = createPlaybackRequestGuard();

  onMount(() => {
    offlineMode = !navigator.onLine;
    if (!media.title || !['movie', 'tv'].includes(media.type) || !Number.isInteger(media.id)) {
      playback = { status: 'error', message: 'This title link is invalid.', progress: 0 };
      return;
    }
    void initialise();
    return () => { playbackRequests.cancel(); void savePlaybackProgress(true); clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(diagnosticPollTimer); clearTimeout(downloadPollTimer); clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer); clearTimeout(interruptionTimer); clearTimeout(controlHideTimer); player?.pause(); };
  });

  async function initialise() {
    try { const settings = await api.get('/api/settings'); manualReleaseSelection = Boolean(settings.manualReleaseSelection); detailedPlaybackProgress = Boolean(settings.detailedPlaybackProgress); playbackDiagnostics = Boolean(settings.playbackDiagnostics); } catch { manualReleaseSelection = false; detailedPlaybackProgress = false; playbackDiagnostics = false; }
    try { const state = await api.get('/api/state'); library = state.library; progressEntries = state.progress; } catch {}
    try { const state = await api.get('/api/offline'); offlineDownloads = state.downloads; offlineJobs = state.jobs; scheduleDownloadPoll(); } catch {}
    if (media.type === 'movie') {
      if (offlineMode && !offlineAvailability(media, offlineDownloads).available) { playback = { status: 'error', message: 'This movie has not been downloaded for offline viewing.', progress: 0 }; return; }
      const savedDuration = progressFor(media)?.duration;
      if (savedDuration) media.durationHint = savedDuration;
      else try { media.durationHint = (await api.get(`/api/catalog/movies/${media.id}/runtime`)).duration; } catch {}
      currentMedia = media;
      if (!shouldStartImmediately) { playback = null; return; }
      return startPlayback(media, null, shouldResume && Boolean(progressFor(media)?.position));
    }
    playback = { status: 'selecting', message: 'Loading seasons…', progress: 3 };
    try {
      if (offlineMode) {
        const local = offlineEpisodes(offlineDownloads, media.id);
        if (!local.length) throw new Error('This series has no downloaded episodes.');
        const numbers = [...new Set(local.map(item => item.season))];
        seasons = numbers.map(number => ({ number, name: `Season ${number}`, episodeCount: local.filter(item => item.season === number).length }));
        episodesBySeason = Object.fromEntries(numbers.map(number => [String(number), local.filter(item => item.season === number).map(item => ({ number: item.episode, name: item.episodeTitle || `Episode ${item.episode}`, runtime: Math.round((item.durationHint || 0) / 60) }))]));
        selectedSeason = numbers.includes(Number(requestedSeason)) ? requestedSeason : String(numbers[0]);
        await loadEpisodes(requestedEpisode);
        if (!shouldStartImmediately) { currentMedia = selectedMediaItem(); playback = null; return; }
        if (requestedEpisode) playEpisode(shouldResume); else await playNextUnwatchedEpisode(); return;
      }
      seasons = (await api.get(`/api/catalog/shows/${media.id}/seasons`)).seasons;
      if (!seasons.length) throw new Error('No selectable seasons were found for this show.');
      selectedSeason = seasons.some(season => String(season.number) === requestedSeason) ? requestedSeason : String(seasons[0].number);
      await loadEpisodes(requestedEpisode);
      if (!shouldStartImmediately) { currentMedia = selectedMediaItem(); playback = null; return; }
      if (requestedEpisode) playEpisode(shouldResume);
      else await playNextUnwatchedEpisode();
    } catch (e) { playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  function scheduleDownloadPoll() { clearTimeout(downloadPollTimer); if (offlineJobs.some(job => !['ready', 'error'].includes(job.status))) downloadPollTimer = setTimeout(() => void refreshOfflineDownloads(), 1000); }
  async function refreshOfflineDownloads() { try { const state = await api.get('/api/offline'); offlineDownloads = state.downloads; offlineJobs = state.jobs; } catch {} scheduleDownloadPoll(); }
  function activeDownload(item = media) { const key = offlineMediaKey(item); return offlineJobs.find(job => job.key === key && !['ready', 'error'].includes(job.status)); }
  function downloaded(item = media) { return offlineAvailability(item, offlineDownloads); }
  function episodeDownloadState(item) { return offlineEpisodeState(item, offlineDownloads, offlineJobs); }
  async function downloadForOffline(item) {
    downloadError = '';
    try { const job = await api.post('/api/offline', item); if (job?.id) offlineJobs = [...offlineJobs.filter(existing => existing.id !== job.id), job]; scheduleDownloadPoll(); }
    catch (error) { downloadError = error.message; }
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

  function chooseSeason(event, season) {
    event.currentTarget.closest('details')?.removeAttribute('open');
    if (String(season.number) === selectedSeason) return;
    selectedSeason = String(season.number);
    void loadEpisodes();
  }

  async function startPlayback(selectedMedia, preparedJob = null, resume = false) {
    if (manualReleaseSelection && !offlineMode && !selectedMedia.releaseId && !preparedJob) return chooseRelease(selectedMedia, resume);
    const requestToken = playbackRequests.begin();
    currentPlaybackRequestToken = requestToken;
    try {
      void savePlaybackProgress(true);
      clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(diagnosticPollTimer); nextMedia = null; nextJob = null; preparingNext = false; showUpNext = false; autoPlayNext = true; videoDiagnostics = null;
      if (selectedMedia.type === 'tv') {
        selectedSeason = String(selectedMedia.season);
        selectedEpisode = String(selectedMedia.episode);
        episodes = await episodesForSeason(selectedMedia.season);
        if (!playbackRequests.isCurrent(requestToken)) return;
      }
      currentMedia = selectedMedia;
      clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
      restoredMediaKey = ''; autoMarkedMediaKey = ''; recoveryPosition = 0; resumeStreamOffset = 0; resumeStarting = false; resumePlayback = resume; playbackSettled = false; playbackNeedsAction = false; playbackRecovery = null; streamAttempt = 0; playerPosition = 0; playerDuration = 0; seekPreview = null;
      clearTimeout(interruptionTimer); showPlayerControls();
      playback = preparedJob || { status: 'selecting', message: 'Finding the best available release…', progress: 3 };
      const job = preparedJob || await api.post('/api/play', selectedMedia);
      if (!playbackRequests.isCurrent(requestToken)) return;
      playback = job; void poll(job.id, requestToken, 0);
    } catch (e) { if (playbackRequests.isCurrent(requestToken)) playback = { status: 'error', message: e.message, progress: 0 }; }
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

  async function poll(id, requestToken, attempt = 0) {
    try {
      const job = await api.get(`/api/play/${id}`);
      if (!playbackRequests.isCurrent(requestToken)) return;
      playback = job;
      if (job.status === 'ready') {
        const entry = progressFor(currentMedia);
        const duration = progressDuration(job.mode, player?.duration) || currentMedia?.durationHint || entry?.duration || 0;
        resumeStreamOffset = resumePlayback && job.mode === 'direct' ? resumePosition(entry, duration) : 0;
        beginPlaybackWarmup();
        if (playbackDiagnostics) diagnosticPollTimer = setTimeout(() => void refreshDiagnostics(id, requestToken), 1000);
        return;
      }
      if (job.status !== 'error') pollTimer = setTimeout(() => void poll(id, requestToken, attempt + 1), playbackPollDelay(attempt));
    } catch (e) { if (playbackRequests.isCurrent(requestToken)) playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function refreshDiagnostics(id, requestToken) {
    try {
      const job = await api.get(`/api/play/${id}`);
      if (!playbackRequests.isCurrent(requestToken) || playback?.id !== id) return;
      playback = { ...playback, diagnostics: job.diagnostics };
      diagnosticPollTimer = setTimeout(() => void refreshDiagnostics(id, requestToken), 1500);
    } catch {}
  }

  async function prepareNextEpisode(selectedMedia, requestToken) {
    if (preparingNext || nextMedia || !shouldPrepareNextEpisode({ playing, mediaType: selectedMedia?.type, manualReleaseSelection, playbackMode: playback?.mode, bufferedAhead: bufferedPlaybackAhead() })) return;
    preparingNext = true;
    const candidate = await adjacentEpisodeMedia(selectedMedia, 1);
    if (!candidate || !playbackRequests.isCurrent(requestToken) || itemKey(currentMedia) !== itemKey(selectedMedia)) return;
    nextMedia = candidate;
    try { const job = await api.post('/api/play', { ...nextMedia, prepareAhead: true }); if (!playbackRequests.isCurrent(requestToken) || itemKey(currentMedia) !== itemKey(selectedMedia)) return; nextJob = job; void pollNextEpisode(job.id, requestToken); } catch { if (playbackRequests.isCurrent(requestToken)) nextJob = { status: 'error' }; }
  }

  async function pollNextEpisode(id, requestToken) {
    try { const job = await api.get(`/api/play/${id}`); if (!playbackRequests.isCurrent(requestToken) || nextJob?.id !== id) return; nextJob = job; if (job.status !== 'ready' && job.status !== 'error') nextPollTimer = setTimeout(() => void pollNextEpisode(id, requestToken), 900); }
    catch { if (playbackRequests.isCurrent(requestToken) && nextJob?.id === id) nextJob = { ...nextJob, status: 'error' }; }
  }

  function playEpisode(resume = true) {
    const selectedMedia = episodePlaybackMedia(media, selectedSeason, selectedEpisode, episodes);
    if (!selectedMedia) { playback = { status: 'error', message: 'Choose a valid season and episode before starting playback.', progress: 0 }; return; }
    void startPlayback(selectedMedia, null, resume && Boolean(progressFor(selectedMedia)?.position));
  }

  function playSelectedMedia() {
    if (media.type === 'movie') void startPlayback(media, null, Boolean(progressFor(media)?.position));
    else playEpisode(true);
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
    if (hasGrowingStreamDuration(playback?.mode)) { restoredMediaKey = key; return; }
    const duration = progressDuration(playback?.mode, player?.duration) || currentMedia?.durationHint || entry?.duration || 0;
    const position = recoveryPosition || (resumePlayback ? resumePosition(entry, duration) : 0);
    if (!position || restoredMediaKey === key) return;
    player.currentTime = Math.min(position, Math.max(0, duration - 31)); recoveryPosition = 0; restoredMediaKey = key;
  }

  function currentPlaybackPosition() { return Math.max(0, Number(player?.currentTime) || 0) + (playback?.mode === 'direct' ? resumeStreamOffset : 0); }
  function playbackStreamUrl() { return resumeStreamUrl(playback?.streamUrl, playback?.mode, resumeStreamOffset); }

  function beginPlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
    playbackSettled = false; resumeStarting = true; playbackNeedsAction = false; playbackRecovery = null;
  }
  function settlePlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
    playbackSettled = true; resumeStarting = false;
  }
  function handleCanPlay() {
    captureVideoDiagnostics('can play');
    void attemptAutomaticPlayback();
    if (playbackSettled) return;
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = setTimeout(settlePlaybackWarmup, 6000);
  }
  function handlePlaying() {
    playing = true; playbackNeedsAction = false; playbackRecovery = null;
    captureVideoDiagnostics('playing');
    clearTimeout(interruptionTimer); showPlayerControls();
    if (!playbackSettled) settlePlaybackWarmup();
    void prepareNextEpisode(currentMedia, currentPlaybackRequestToken);
  }
  function bufferedPlaybackAhead() {
    if (!player || !Number.isFinite(player.currentTime)) return 0;
    for (let index = 0; index < player.buffered.length; index++) {
      if (player.buffered.start(index) <= player.currentTime + 0.1 && player.buffered.end(index) >= player.currentTime) return Math.max(0, player.buffered.end(index) - player.currentTime);
    }
    return 0;
  }
  function handleStartupBuffering() {
    captureVideoDiagnostics('buffering');
    if (!playbackSettled) { clearTimeout(startupStableTimer); resumeStarting = true; return; }
    const timeline = controlTimeline(), stalledAt = timeline.position;
    if (playback?.mode !== 'direct') return;
    clearTimeout(interruptionTimer);
    interruptionTimer = setTimeout(() => {
      if (Math.abs(controlTimeline().position - stalledAt) < 0.5) offerPlaybackRecovery('The direct stream stopped making progress.');
    }, 10000);
  }
  function handlePause() {
    playing = false; clearTimeout(interruptionTimer); clearTimeout(controlHideTimer); controlsVisible = true;
    captureVideoDiagnostics('paused');
    if (!playbackSettled) clearTimeout(startupStableTimer);
    void savePlaybackProgress(true);
  }

  async function retryPlayback() {
    if (!playback?.id) return;
    const requestToken = playbackRequests.begin(), id = playback.id;
    currentPlaybackRequestToken = requestToken;
    try { const job = await api.post(`/api/play/${id}/retry`); if (!playbackRequests.isCurrent(requestToken)) return; playback = job; void poll(job.id, requestToken, 0); } catch (e) { if (playbackRequests.isCurrent(requestToken)) playback = { ...playback, status: 'error', message: e.message }; }
  }

  function formatPosition(seconds) { const value = Math.max(0, Math.round(seconds)); const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), remainder = value % 60; return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`; }
  function preparationTitle() { if (playback?.status === 'error') return 'Playback needs attention'; if (media.type === 'tv' && !currentMedia) return 'Choose an episode to begin'; return `Getting ${currentMedia?.episodeTitle || media.title || 'your title'} ready…`; }
  function formatAirDate(value) { if (!value) return ''; const [year, month, day] = value.split('-').map(Number); if (!year || !month || !day) return value; return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(year, month - 1, day)); }
  async function attemptAutomaticPlayback() {
    if (!player || !player.paused || playbackNeedsAction || playbackRecovery) return;
    try { await player.play(); }
    catch (error) {
      if (error?.name === 'NotAllowedError') { playbackNeedsAction = true; settlePlaybackWarmup(); }
    }
  }
  async function playPreparedVideo() {
    if (!player) return;
    playbackNeedsAction = false;
    try { await player.play(); }
    catch { playbackNeedsAction = true; }
  }
  function offerPlaybackRecovery(message) {
    if (!canUseFallback(playback)) { playback = { ...playback, status: 'error', message: 'The prepared video could not be played by this browser. Try a different release or check this browser’s codec support.' }; return; }
    clearTimeout(interruptionTimer); settlePlaybackWarmup(); playing = false;
    playbackRecovery = { message, position: currentPlaybackPosition() };
    void savePlaybackProgress(true);
  }
  function retryDirectStream() {
    if (!playbackRecovery) return;
    resumeStreamOffset = Math.max(0, playbackRecovery.position || 0);
    streamAttempt++;
    beginPlaybackWarmup();
  }
  async function fallback() { if (!canUseFallback(playback)) { playback = { ...playback, status: 'error', message: 'The prepared video could not be played by this browser. The download is complete; try a different release or check this browser’s codec support.' }; return; } const requestToken = playbackRequests.begin(), id = playback.id; currentPlaybackRequestToken = requestToken; clearTimeout(interruptionTimer); recoveryPosition = playbackRecovery?.position ?? currentPlaybackPosition(); playbackRecovery = null; playbackNeedsAction = false; resumePlayback = recoveryPosition >= 5; try { await savePlaybackProgress(true); const job = await api.post(`/api/play/${id}/fallback`); if (!playbackRequests.isCurrent(requestToken)) return; playback = job; void poll(job.id, requestToken, 0); } catch (e) { if (playbackRequests.isCurrent(requestToken)) playback = { status: 'error', message: e.message, progress: 0 }; } }
  function playNextEpisode() { if (!nextMedia || nextJob?.status === 'error') return; void setWatched(currentMedia, true); const selectedMedia = nextMedia, job = nextJob; void startPlayback(selectedMedia, job, false); setTimeout(() => player?.play().catch(() => {}), 0); }
  function handleTimeUpdate() {
    clearTimeout(interruptionTimer);
    playerPosition = Number.isFinite(player?.currentTime) ? player.currentTime : 0;
    playerDuration = Number.isFinite(player?.duration) ? player.duration : 0;
    restorePlaybackProgress();
    const timeline = controlTimeline();
    showUpNext = shouldShowUpNext(autoPlayNext && Boolean(nextMedia), timeline.position, timeline.duration);
    void prepareNextEpisode(currentMedia, currentPlaybackRequestToken);
    void savePlaybackProgress();
    captureVideoDiagnostics('time update');
  }
  function handleEnded() {
    playing = false;
    captureVideoDiagnostics('ended');
    const timeline = controlTimeline();
    if (autoPlayNext && nextMedia) playNextEpisode();
    else if (shouldMarkWatched(timeline.position, timeline.duration)) void setWatched(currentMedia, true);
    else if (player && playback?.mode === 'direct' && currentPlaybackPosition() >= 30) void setWatched(currentMedia, true);
    else void savePlaybackProgress(true);
  }

  function controlTimeline() {
    const entry = progressFor(currentMedia);
    const timeline = playbackTimeline(playback?.mode, playerPosition, currentMedia?.durationHint || entry?.duration || 0, playerDuration, resumeStreamOffset);
    return { ...timeline, position: seekPreview ?? timeline.position };
  }
  function captureVideoDiagnostics(event) {
    if (!playbackDiagnostics || !player) return;
    const ranges = [];
    for (let index = 0; index < player.buffered.length; index++) ranges.push(`${player.buffered.start(index).toFixed(1)}–${player.buffered.end(index).toFixed(1)}s`);
    videoDiagnostics = { event, readyState: player.readyState, networkState: player.networkState, paused: player.paused, currentTime: player.currentTime, duration: player.duration, buffered: ranges.join(', '), error: player.error ? `MediaError ${player.error.code}${player.error.message ? `: ${player.error.message}` : ''}` : '' };
  }
  function togglePlayback() { if (!player) return; if (player.paused) void player.play(); else player.pause(); }
  function hidePlayerControls() {
    const focused = document.activeElement;
    const keyboardFocusedControl = focused instanceof HTMLElement && focused !== player && Boolean(playerShell?.contains(focused)) && focused.matches(':focus-visible');
    if (playing && !keyboardFocusedControl) controlsVisible = false;
  }
  function schedulePlayerControlsHide() { clearTimeout(controlHideTimer); if (playing) controlHideTimer = setTimeout(hidePlayerControls, 2500); }
  function showPlayerControls() { controlsVisible = true; schedulePlayerControlsHide(); }
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
  function handleFullscreenChange() { fullscreen = Boolean(document.fullscreenElement); showPlayerControls(); }
  function handleWatchShortcut(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    const interactive = target instanceof HTMLElement && target.matches('button, a');
    if (editing) return;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (history.length > 1) history.back();
      else void goto('/');
    }
    else if ((event.key === ' ' || key === 'k') && !interactive) { event.preventDefault(); if (player) togglePlayback(); else if (!playback) playSelectedMedia(); }
    else if (event.key === 'ArrowLeft' && player) { event.preventDefault(); seekBy(-10); }
    else if (event.key === 'ArrowRight' && player) { event.preventDefault(); seekBy(10); }
    else if (key === 'm' && player) { event.preventDefault(); toggleMute(); }
    else if (key === 'f' && playerShell) { event.preventDefault(); void toggleFullscreen(); }
  }
</script>

<svelte:window onfullscreenchange={handleFullscreenChange} onkeydowncapture={handleWatchShortcut} />

<svelte:head><title>{media.title ? `${media.title} · Watchhouse` : 'Watch · Watchhouse'}</title></svelte:head>

<section class="watch-page py-2 sm:py-6">
  <a class="link link-hover text-sm text-base-content/60" href="/">← Back to discover</a>
  <div class="watch-heading mt-6 border-b border-base-300 pb-8 sm:flex sm:items-end sm:justify-between sm:gap-6"><div><p class="page-eyebrow">{media.type === 'tv' ? 'Series' : 'Film'}{media.year ? ` · ${media.year}` : ''}</p><h1 class="mt-3 text-4xl sm:text-6xl">{media.title || 'Watch'}</h1>{#if media.type === 'tv' && selectedSeason && selectedEpisode}<p class="mt-3 text-sm text-base-content/50">Season {selectedSeason}, episode {selectedEpisode}</p>{/if}</div><div class="watch-actions mt-5 flex flex-wrap gap-x-5 gap-y-2 sm:mt-0"><button class="btn btn-sm btn-ghost" onclick={toggleLibrary}>{isInLibrary() ? 'Remove from library' : '+ Add to library'}</button>{#if !offlineMode}{#if activeDownload(media)}<a class="btn btn-sm btn-ghost" href="/downloads"><span class="loading loading-spinner loading-xs"></span>{Math.round(activeDownload(media).progress || 0)}%</a>{:else if media.type === 'tv'}<button class="btn btn-sm btn-ghost" onclick={() => void downloadForOffline(media)}>Download series{downloaded(media).count ? ` (${downloaded(media).count} saved)` : ''}</button>{:else if downloaded(media).available}<a class="btn btn-sm btn-ghost" href="/downloads">Available offline</a>{:else}<button class="btn btn-sm btn-ghost" onclick={() => void downloadForOffline(media)}>Download movie</button>{/if}{/if}<button class="btn btn-sm btn-ghost" onclick={toggleWatched} disabled={media.type === 'tv' && !selectedEpisode}>{isWatched() ? `Mark ${media.type === 'tv' ? 'episode ' : ''}unwatched` : `Mark ${media.type === 'tv' ? 'episode ' : ''}watched`}</button></div></div>
  {#if downloadError}<div class="alert alert-error mt-4"><span>{downloadError}</span><button class="btn btn-sm btn-ghost" onclick={() => { downloadError = ''; }}>Dismiss</button></div>{/if}
  {#if bulkError}<div class="alert alert-error mt-4"><span>{bulkError}</span><button class="btn btn-sm btn-ghost" aria-label="Dismiss bulk update error" onclick={() => { bulkError = ''; }}>Dismiss</button></div>{/if}
  <div class="mt-8 grid gap-8 {media.type === 'tv' || releaseChoices.length ? 'xl:grid-cols-[minmax(0,1fr)_24rem]' : ''}">
    <div>
      {#if !playback}
        <div class="player-shell detail-player relative grid aspect-video place-items-center overflow-hidden bg-black text-center" style={media.poster ? `background-image: linear-gradient(rgb(0 0 0 / 52%), rgb(0 0 0 / 82%)), url(${media.poster})` : undefined}>
          <div class="player-modal-panel relative z-10"><p class="player-eyebrow">{media.type === 'tv' ? `Season ${selectedSeason} · Episode ${selectedEpisode}` : 'Feature presentation'}</p><h2>{media.type === 'tv' ? episodes.find(episode => String(episode.number) === selectedEpisode)?.name || media.title : media.title}</h2><button class="btn btn-lg btn-primary mt-7 min-w-44" onclick={playSelectedMedia}><span class="text-base" aria-hidden="true">▶</span> Play now</button></div>
        </div>
      {:else if currentMedia}
        <div class="player-shell cinema-player group/player relative aspect-video overflow-hidden bg-black" bind:this={playerShell} role="group" aria-label="Video player" onpointermove={showPlayerControls} onpointerleave={schedulePlayerControlsHide} onfocusin={showPlayerControls} onfocusout={schedulePlayerControlsHide}>
          {#if playback?.status === 'ready'}
            {@const timeline = controlTimeline()}
            {#key `${playback.id}:${resumeStreamOffset}:${streamAttempt}`}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="h-full w-full bg-black object-contain transition-opacity focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" class:opacity-0={resumeStarting} class:cursor-none={playing && !controlsVisible} bind:this={player} tabindex={resumeStarting ? -1 : 0} aria-hidden={resumeStarting} aria-label={`${media.title} video player`} autoplay playsinline preload="auto" src={playbackStreamUrl()} onclick={togglePlayback} onerror={() => { captureVideoDiagnostics('error'); offerPlaybackRecovery('The direct stream encountered a playback error.'); }} onloadedmetadata={() => { restorePlaybackProgress(); playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; captureVideoDiagnostics('metadata loaded'); }} oncanplay={handleCanPlay} ondurationchange={() => { playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; captureVideoDiagnostics('duration changed'); }} ontimeupdate={handleTimeUpdate} onplay={() => { playing = true; captureVideoDiagnostics('play'); }} onplaying={handlePlaying} onwaiting={handleStartupBuffering} onstalled={handleStartupBuffering} onpause={handlePause} onvolumechange={() => { playerVolume = player?.volume ?? 1; playerMuted = player?.muted ?? false; }} onended={handleEnded}></video>
            {/key}
            {#if playbackRecovery}
              <div class="player-modal absolute inset-0 z-30 grid place-items-center p-6 text-center text-white">
                <div class="player-modal-panel max-w-md"><p class="player-eyebrow">Playback interrupted</p><h2>Choose how to continue</h2><p>{playbackRecovery.message}</p><div class="mt-7 flex flex-col justify-center gap-3 sm:flex-row"><button class="btn btn-lg btn-primary" onclick={retryDirectStream}>Retry stream</button><button class="btn btn-lg btn-outline border-white/30 text-white hover:border-white hover:bg-white hover:text-black" onclick={() => void fallback()}>Download &amp; resume</button></div></div>
              </div>
            {:else if playbackNeedsAction}
              <div class="player-modal absolute inset-0 z-30 grid place-items-center p-6 text-center text-white">
                <div class="player-modal-panel"><p class="player-eyebrow">Ready to watch</p><h2>{currentMedia?.episodeTitle || media.title}</h2><button class="btn btn-lg btn-primary mt-7 min-w-44" onclick={() => void playPreparedVideo()}><span class="text-base" aria-hidden="true">▶</span> Play</button></div>
              </div>
            {:else if resumeStarting}
              <div class="absolute inset-0 z-20"><PlaybackPreparation title={preparationTitle()} message={resumeStreamOffset > 0 ? `Opening the stream and restoring your position at ${formatPosition(resumeStreamOffset)}…` : 'Opening the video stream and preparing the first frames…'} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} indeterminate /></div>
            {:else}<div class="player-controls absolute inset-x-0 bottom-0 px-3 pb-3 pt-12 text-white transition-opacity duration-200 sm:px-5 sm:pb-5" class:pointer-events-none={!controlsVisible} class:opacity-0={!controlsVisible}>
            <label class="sr-only" for="playback-position">Playback position</label>
            <input id="playback-position" class="range range-primary range-xs block w-full" type="range" min="0" max={timeline.duration || 0} step="0.1" value={timeline.position} disabled={!timeline.duration} oninput={previewSeek} onchange={commitSeek} aria-valuetext={`${formatPosition(timeline.position)} of ${formatPosition(timeline.duration)}`} />
            <div class="mt-3 flex items-center gap-2 sm:gap-3">
              {#if media.type === 'tv'}<button class="player-control grid size-9 place-items-center transition focus-visible:outline-2 focus-visible:outline-white disabled:opacity-35" onclick={() => void playAdjacentEpisode(-1)} disabled={!canNavigateEpisode(-1)} aria-label="Previous episode"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4 4h2v12H4zm12.2.3a1 1 0 0 1 1.55.83v9.74a1 1 0 0 1-1.55.83L9.4 10.83a1 1 0 0 1 0-1.66z" /></svg></button>{/if}
              <button class="player-control player-control-primary grid size-9 place-items-center transition focus-visible:outline-2 focus-visible:outline-white" onclick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>
                {#if playing}<svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4.5 3.5h4v13h-4zm7 0h4v13h-4z" /></svg>{:else}<svg class="size-5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 3.7a1 1 0 0 1 1.54-.84l9 6.3a1 1 0 0 1 0 1.68l-9 6.3A1 1 0 0 1 5 16.3z" /></svg>{/if}
              </button>
              {#if media.type === 'tv'}<button class="player-control grid size-9 place-items-center transition focus-visible:outline-2 focus-visible:outline-white disabled:opacity-35" onclick={() => void playAdjacentEpisode(1)} disabled={!canNavigateEpisode(1)} aria-label="Next episode"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M16 4h-2v12h2zM3.8 4.3a1 1 0 0 0-1.55.83v9.74a1 1 0 0 0 1.55.83l6.8-4.87a1 1 0 0 0 0-1.66z" /></svg></button>{/if}
              <button class="player-control grid size-9 place-items-center text-[10px] font-semibold transition focus-visible:outline-2 focus-visible:outline-white" onclick={() => seekBy(-10)} aria-label="Rewind 10 seconds">−10</button>
              <button class="player-control grid size-9 place-items-center text-[10px] font-semibold transition focus-visible:outline-2 focus-visible:outline-white" onclick={() => seekBy(10)} aria-label="Forward 10 seconds">+10</button>
              <span class="min-w-24 text-xs tabular-nums text-white/80">{formatPosition(timeline.position)} / {formatPosition(timeline.duration)}</span>
              <div class="ml-auto hidden items-center gap-2 sm:flex">
                <button class="player-control grid size-9 place-items-center transition focus-visible:outline-2 focus-visible:outline-white" onclick={toggleMute} aria-label={playerMuted ? 'Unmute' : 'Mute'}>
                  {#if playerMuted || playerVolume === 0}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3zM13 8l4 4m0-4-4 4" /></svg>{:else}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8h3l4-3v10l-4-3H3zM13 7a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10" /></svg>{/if}
                </button>
                <label class="sr-only" for="playback-volume">Volume</label><input id="playback-volume" class="range range-xs w-24" type="range" min="0" max="1" step="0.05" value={playerMuted ? 0 : playerVolume} oninput={setVolume} />
              </div>
              <button class="player-control grid size-9 place-items-center transition focus-visible:outline-2 focus-visible:outline-white" onclick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                {#if fullscreen}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3v5H3m9-5v5h5M8 17v-5H3m9 5v-5h5" /></svg>{:else}<svg class="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8V3h5m4 0h5v5M3 12v5h5m4 0h5v-5" /></svg>{/if}
              </button>
            </div>
            </div>{/if}
          {:else}
            <div class="absolute inset-0 z-20"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} indeterminate={playback?.status === 'extracting' || playback?.status === 'optimizing'} /></div>
          {/if}
          {#if showUpNext && nextMedia}<div class="up-next-panel absolute inset-x-3 bottom-24 z-30 flex flex-wrap items-center justify-between gap-4 p-5 text-base-content backdrop-blur-md sm:left-auto sm:right-5 sm:w-[26rem]"><div><p class="player-eyebrow">Up next</p><p class="mt-2 text-sm">{nextMedia.episode}. {nextMedia.episodeTitle}</p><p class="mt-1 text-[11px] text-base-content/45">{nextJob?.status === 'ready' ? 'Ready to play' : 'Preparing in the background'}</p></div><div class="flex gap-2"><button class="btn btn-sm btn-primary" onclick={playNextEpisode}>Play next</button><button class="btn btn-sm btn-ghost" onclick={() => { autoPlayNext = false; showUpNext = false; }}>Cancel</button></div></div>{/if}
        </div>
      {:else}
        <div class="aspect-video"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} indeterminate={playback?.status === 'extracting' || playback?.status === 'optimizing'} /></div>
      {/if}
      {#if playback?.status === 'error'}<div class="alert alert-error mt-4"><span>{playback.message}</span>{#if playback.id}<button class="btn btn-sm" onclick={retryPlayback}>Resume</button>{/if}</div>{/if}
      {#if playbackDiagnostics}<PlaybackDiagnostics {playback} {nextJob} video={videoDiagnostics} />{/if}
    </div>
    {#if media.type === 'tv' || releaseChoices.length}<aside class="episode-panel border-t border-base-300 pt-7 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
      {#if media.type === 'tv'}
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div><p class="page-eyebrow">Series guide</p><h2 class="episode-title mt-2">Episodes</h2><p class="mt-1 text-xs text-base-content/45">Select an episode to start watching</p></div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <details class="dropdown dropdown-end" class:pointer-events-none={!seasons.length}>
              <summary class="btn btn-sm btn-ghost min-w-40 justify-between" class:opacity-50={!seasons.length} aria-disabled={!seasons.length} aria-busy={!seasons.length && playback?.status !== 'error'}>
                <span>{seasons.find(season => String(season.number) === selectedSeason)?.name || (playback?.status === 'error' ? 'Seasons unavailable' : 'Loading seasons…')}</span><span aria-hidden="true">⌄</span>
              </summary>
              {#if seasons.length}<ul class="editorial-menu menu dropdown-content z-30 mt-2 max-h-72 w-56 overflow-y-auto border border-base-300 bg-base-100 p-1" aria-label="Choose season">{#each seasons as season}<li><button class:menu-active={String(season.number) === selectedSeason} aria-current={String(season.number) === selectedSeason ? 'true' : undefined} onclick={(event) => chooseSeason(event, season)}><span>{season.name}</span><span class="ml-auto text-[10px] text-base-content/40">{season.episodeCount} EP</span></button></li>{/each}</ul>{/if}
            </details>
            <details class="dropdown dropdown-end" class:pointer-events-none={!episodes.length || bulkUpdating}>
              <summary class="btn btn-sm btn-ghost" class:opacity-50={!episodes.length || bulkUpdating} aria-disabled={!episodes.length || bulkUpdating}>Bulk actions <span aria-hidden="true">⌄</span></summary>
              <ul class="editorial-menu menu dropdown-content z-30 mt-2 w-56 border border-base-300 bg-base-100 p-1" aria-label="Bulk episode actions">
                <li><button onclick={(event) => runBulkAction(event, toggleSeasonWatched)}>{isSeasonWatched() ? 'Mark season unwatched' : 'Mark season watched'}</button></li>
                <li><button onclick={(event) => runBulkAction(event, () => void toggleSeriesWatched())}>{isSeriesWatched() ? 'Mark series unwatched' : 'Mark series watched'}</button></li>
                {#if !offlineMode}<li><button onclick={(event) => runBulkAction(event, () => void downloadForOffline({ ...media, season: Number(selectedSeason) }))}>Download season {selectedSeason}</button></li>{/if}
              </ul>
            </details>
          </div>
        </div>
        {#if episodes.length}
          <div class="episode-list mt-5 max-h-[34rem] divide-y divide-base-300 overflow-y-auto border-y border-base-300">
            {#each episodes as episode}
              {@const episodeMedia = { ...media, season: Number(selectedSeason), episode: episode.number, episodeTitle: episode.name }}
              {@const episodeWatched = isWatched(episodeMedia)}
              {@const downloadState = episodeDownloadState(episodeMedia)}
              <div
                class="episode-row group flex w-full items-center text-left transition-colors hover:bg-base-200"
                class:bg-base-200={String(episode.number) === selectedEpisode}
              >
                <button class="flex min-w-0 flex-1 items-center gap-4 py-4 pl-4 pr-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" aria-current={String(episode.number) === selectedEpisode ? 'true' : undefined} aria-label={`Play episode ${episode.number}, ${episode.name}`} onclick={() => playEpisodeNumber(episode.number)}>
                  <span class="episode-marker grid h-10 w-10 shrink-0 place-items-center border border-base-300 text-sm font-semibold text-base-content/55 transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-content">
                    {#if currentMedia?.type === 'tv' && currentMedia.season === Number(selectedSeason) && currentMedia.episode === episode.number && playback?.status === 'ready'}<span class="text-xs tracking-wide">NOW</span>{:else}<svg class="h-4 w-4 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 3.9a1 1 0 0 1 1.52-.85l9.1 6.1a1 1 0 0 1 0 1.7l-9.1 6.1a1 1 0 0 1-1.52-.85V3.9Z" /></svg>{/if}
                  </span>
                  <span class="min-w-0 flex-1"><span class="flex items-baseline gap-2"><span class="text-xs font-semibold text-base-content/50">{episode.number}</span><span class="truncate text-sm font-medium group-hover:text-primary">{episode.name}</span></span>{#if episode.airDate}<span class="mt-1 block text-xs text-base-content/50">{formatAirDate(episode.airDate)}</span>{/if}</span>
                </button>
                {#if !offlineMode}
                  <button class="episode-watched grid size-9 shrink-0 place-items-center hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary" disabled={!['available', 'error'].includes(downloadState.status)} aria-label={downloadState.status === 'ready' ? `Episode ${episode.number} is downloaded` : downloadState.status === 'error' ? `Retry download for episode ${episode.number}` : `Download episode ${episode.number}`} title={downloadState.status === 'ready' ? 'Downloaded' : downloadState.status === 'error' ? 'Retry download' : 'Download episode'} onclick={() => void downloadForOffline(episodeMedia)}>
                    {#if ['selecting', 'downloading', 'extracting', 'optimizing'].includes(downloadState.status)}<span class="loading loading-spinner loading-xs"></span>{:else if downloadState.status === 'ready'}<svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 13.5v2h12v-2M10 3v9m-3-3 3 3 3-3" /></svg>{:else if downloadState.status === 'error'}<span aria-hidden="true">↻</span>{:else}<span aria-hidden="true">↓</span>{/if}
                  </button>
                {/if}
                <button class="episode-watched mr-2 grid size-9 shrink-0 place-items-center text-sm hover:bg-base-300 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary" class:text-primary={episodeWatched} aria-label={episodeWatched ? `Mark episode ${episode.number} unwatched` : `Mark episode ${episode.number} watched`} aria-pressed={episodeWatched} onclick={() => void setWatched(episodeMedia, !episodeWatched)}>{episodeWatched ? '✓' : '○'}</button>
              </div>
            {/each}
          </div>
        {:else if playback?.status === 'selecting'}
          <div class="mt-4 space-y-1 border-y border-base-300 py-2" aria-label="Loading episodes">
            {#each Array(4) as _}<div class="flex animate-pulse items-center gap-4 py-3 pl-4 pr-2"><span class="h-10 w-10 bg-base-300"></span><span class="h-4 w-2/3 bg-base-300"></span></div>{/each}
          </div>
        {/if}
      {/if}
      {#if releaseChoices.length}<div class="release-picker mt-8 border-t border-base-300 pt-6"><p class="page-eyebrow">Choose a release</p><div class="mt-4 divide-y divide-base-300 border-y border-base-300">{#each releaseChoices as release}<button class="release-option flex w-full items-start justify-between gap-3 py-4 text-left hover:text-primary" onclick={() => void startPlayback({ ...pendingMedia, releaseId: release.id }, null, pendingResume)}><span class="min-w-0"><span class="block truncate text-sm font-medium">{release.title}</span><span class="mt-1 block text-xs text-base-content/45">{release.readiness.label} · {release.category}</span></span>{#if release.size}<span class="shrink-0 text-xs text-base-content/45">{release.size}</span>{/if}</button>{/each}</div></div>{/if}
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
