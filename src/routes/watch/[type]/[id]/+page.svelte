<script>
  import { onMount, tick } from 'svelte';
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api';
  import { canAttemptCreditFrameSample, canSavePlaybackProgress, canStartNextEpisode, canUseFallback, createNextEpisodePreparationController, createPlaybackRequestGuard, creditDetectionStatus, creditFrameLooksLikely, episodePlaybackMedia, firstUnwatchedEpisode, hasGrowingStreamDuration, nextEpisodeEndAction, playbackPollDelay, playbackTimeline, progressDuration, resumePosition, resumeStreamUrl, shouldContinuePlayback, shouldMarkWatched, shouldPrepareNextEpisode, shouldSampleForCredits, shouldShowUpNext, upNextCountdown, videoPlaybackStats } from '$lib/playback-controls.js';
  import PlaybackDiagnostics from '$lib/PlaybackDiagnostics.svelte';
  import PlaybackPreparation from '$lib/PlaybackPreparation.svelte';
  import { offlineAvailability, offlineEpisodeState, offlineMediaKey, offlineSeriesCatalogue } from '$lib/offline.js';

  const media = { id: Number(page.params.id), type: page.params.type, title: page.url.searchParams.get('title') || '', year: page.url.searchParams.get('year') || '', poster: page.url.searchParams.get('poster') || '' };
  const requestedSeason = page.url.searchParams.get('season') || '', requestedEpisode = page.url.searchParams.get('episode') || '', shouldResume = page.url.searchParams.get('resume') === '1', shouldStartImmediately = page.url.searchParams.get('play') === '1' || shouldResume;
  let seasons = $state([]), episodes = $state([]), episodesBySeason = $state({}), selectedSeason = $state(''), selectedEpisode = $state('');
  let playback = $state(null), player = $state(), playerShell = $state(), manualReleaseSelection = $state(false), detailedPlaybackProgress = $state(false), playbackDiagnostics = $state(false), releaseChoices = $state([]), pendingMedia = $state(null), pendingResume = $state(false);
  let releasePicker = $state(), guideOpen = $state(false), diagnosticsOpen = $state(false);
  let heroLaunching = $state(false), playerRevealing = $state(false);
  let titleDetails = $state({ backdrop: page.url.searchParams.get('backdrop') || '', overview: '' });
  let currentMedia = $state(null), nextMedia = $state(null), nextJob = $state(null), showUpNext = $state(false), autoPlayNextEpisode = $state(true), autoPlayNext = $state(true), smartAutoplay = $state(false), upNextSeconds = $state(30), upNextReason = $state('');
  let library = $state([]), progressEntries = $state([]);
  let offlineMode = $state(false), offlineDownloads = $state([]), offlineJobs = $state([]), downloadError = $state('');
  let resumeStreamOffset = $state(0), resumeStarting = $state(false), resumePlayback = $state(false), playbackSettled = $state(false), playbackNeedsAction = $state(false), playbackRecovery = $state(null), streamAttempt = $state(0), bulkUpdating = $state(false), bulkError = $state('');
  let playing = $state(false), playerPosition = $state(0), playerDuration = $state(0), seekPreview = $state(null), playerVolume = $state(1), playerMuted = $state(false), fullscreen = $state(false), controlsVisible = $state(true);
  let videoDiagnostics = $state(null), creditDiagnostics = $state(null);
  let pollTimer, nextPollTimer, diagnosticPollTimer, downloadPollTimer, startupStableTimer, startupFallbackTimer, interruptionTimer, controlHideTimer, upNextTimer, playerRevealTimer, lastProgressSave = 0, progressWritePending = false, restoredMediaKey = '', autoMarkedMediaKey = '', recoveryPosition = 0, currentPlaybackRequestToken = 0, continuePlaybackOnReady = false, videoFrameSample = null, measuredVideoFps = null, upNextStartedAt = 0, lastCreditSampleAt = 0, likelyCreditFrames = 0, lastCreditSample = null, creditSamplingError = '', creditCanvas = null;
  const playbackRequests = createPlaybackRequestGuard();
  const nextEpisodePreparation = createNextEpisodePreparationController();

  onMount(() => {
    offlineMode = !navigator.onLine;
    if (!media.title || !['movie', 'tv'].includes(media.type) || !Number.isInteger(media.id)) {
      playback = { status: 'error', message: 'This title link is invalid.', progress: 0 };
      return;
    }
    void initialise();
    return () => { playbackRequests.cancel(); void savePlaybackProgress(true); clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(diagnosticPollTimer); clearTimeout(downloadPollTimer); clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer); clearTimeout(interruptionTimer); clearTimeout(controlHideTimer); clearTimeout(upNextTimer); clearTimeout(playerRevealTimer); player?.pause(); };
  });

  async function initialise() {
    if (!offlineMode) void loadTitleDetails();
    try { const settings = await api.get('/api/settings'); manualReleaseSelection = Boolean(settings.manualReleaseSelection); autoPlayNextEpisode = settings.autoPlayNextEpisode !== false; autoPlayNext = autoPlayNextEpisode; smartAutoplay = Boolean(settings.smartAutoplay); detailedPlaybackProgress = Boolean(settings.detailedPlaybackProgress); playbackDiagnostics = Boolean(settings.playbackDiagnostics); } catch { manualReleaseSelection = false; autoPlayNextEpisode = true; autoPlayNext = true; smartAutoplay = false; detailedPlaybackProgress = false; playbackDiagnostics = false; }
    try { const state = await api.get('/api/state'); library = state.library; progressEntries = state.progress; } catch {}
    try { const state = await api.get('/api/offline'); offlineDownloads = state.downloads; offlineJobs = state.jobs; scheduleDownloadPoll(); } catch {}
    if (media.type === 'movie') {
      if (offlineMode && !offlineAvailability(media, offlineDownloads).available) { playback = { status: 'error', message: 'This movie has not been downloaded for offline viewing.', progress: 0 }; return; }
      const savedDuration = progressFor(media)?.duration;
      if (savedDuration) media.durationHint = savedDuration;
      else try { media.durationHint = (await api.get(`/api/catalog/movies/${media.id}/runtime`)).duration; } catch {}
      currentMedia = media;
      if (!shouldStartImmediately) { playback = null; return; }
      return startPlayback(media, null, shouldResume && Boolean(progressFor(media)?.position), true);
    }
    playback = { status: 'selecting', message: 'Loading seasons…', progress: 3 };
    try {
      if (offlineMode) return await initialiseOfflineSeries();
      seasons = (await api.get(`/api/catalog/shows/${media.id}/seasons`)).seasons;
      if (!seasons.length) throw new Error('No selectable seasons were found for this show.');
      selectedSeason = seasons.some(season => String(season.number) === requestedSeason) ? requestedSeason : String(seasons[0].number);
      await loadEpisodes(requestedEpisode);
      currentMedia = selectedMediaItem();
      if (!shouldStartImmediately) { playback = null; return; }
      if (requestedEpisode) playEpisode(shouldResume, true);
      else await playNextUnwatchedEpisode();
    } catch (e) {
      if (!offlineMode && offlineAvailability(media, offlineDownloads).available) {
        try { await initialiseOfflineSeries(); return; } catch {}
      }
      playback = { status: 'error', message: e.message, progress: 0 };
    }
  }

  async function loadTitleDetails() {
    try {
      const kind = media.type === 'movie' ? 'movies' : 'shows';
      titleDetails = (await api.get(`/api/catalog/${kind}/${media.id}/details`)).details || titleDetails;
    } catch {}
  }

  async function initialiseOfflineSeries() {
    const local = offlineSeriesCatalogue(offlineDownloads, media.id);
    if (!local.seasons.length) throw new Error('This series has no downloaded episodes.');
    seasons = local.seasons;
    episodesBySeason = local.episodesBySeason;
    selectedSeason = seasons.some(season => String(season.number) === requestedSeason) ? requestedSeason : String(seasons[0].number);
    await loadEpisodes(requestedEpisode);
    currentMedia = selectedMediaItem();
    if (!shouldStartImmediately) { playback = null; return; }
    if (requestedEpisode) playEpisode(shouldResume, true); else await playNextUnwatchedEpisode();
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

  function chooseSeasonFromSelect(event) {
    const season = seasons.find(item => String(item.number) === event.currentTarget.value);
    if (!season || String(season.number) === selectedSeason) return;
    selectedSeason = String(season.number);
    void loadEpisodes();
  }

  async function startPlayback(selectedMedia, preparedJob = null, resume = false, autoAdvance = false) {
    if (manualReleaseSelection && !offlineMode && !selectedMedia.releaseId && !preparedJob) return chooseRelease(selectedMedia, resume);
    guideOpen = false;
    const requestToken = playbackRequests.begin();
    currentPlaybackRequestToken = requestToken;
    try {
      void savePlaybackProgress(true);
      clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(diagnosticPollTimer); clearTimeout(upNextTimer); nextMedia = null; nextJob = null; nextEpisodePreparation.reset(); continuePlaybackOnReady = autoAdvance; showUpNext = false; autoPlayNext = autoPlayNextEpisode; upNextStartedAt = 0; upNextSeconds = 30; upNextReason = ''; likelyCreditFrames = 0; lastCreditSampleAt = 0; lastCreditSample = null; creditSamplingError = ''; creditDiagnostics = null; videoDiagnostics = null; videoFrameSample = null; measuredVideoFps = null;
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
      playback = job;
      if (shouldContinuePlayback(continuePlaybackOnReady, job)) {
        await tick();
        if (playbackRequests.isCurrent(requestToken)) void attemptAutomaticPlayback();
      }
      void poll(job.id, requestToken, 0);
    } catch (e) { if (playbackRequests.isCurrent(requestToken)) playback = { status: 'error', message: e.message, progress: 0 }; }
  }

  async function chooseRelease(selectedMedia, resume = false) {
    pendingMedia = selectedMedia; pendingResume = resume; releaseChoices = [];
    try {
      playback = { status: 'selecting', message: 'Finding available releases…', progress: 15 };
      releaseChoices = (await api.post('/api/releases', selectedMedia)).releases;
      if (!releaseChoices.length) throw new Error('No compatible releases were found for this title.');
      playback = null;
      guideOpen = true;
      await tick();
      releasePicker?.focus({ preventScroll: true });
      releasePicker?.scrollIntoView({ block: 'center' });
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
        resumeStreamOffset = resumePlayback && hasGrowingStreamDuration(job.mode) ? resumePosition(entry, duration) : 0;
        beginPlaybackWarmup();
        if (shouldContinuePlayback(continuePlaybackOnReady, job)) {
          await tick();
          if (playbackRequests.isCurrent(requestToken) && playback?.id === id) void attemptAutomaticPlayback();
        }
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
    if (nextEpisodePreparation.preparing || nextMedia || !shouldPrepareNextEpisode({ playing, mediaType: selectedMedia?.type, manualReleaseSelection, autoPlayNextEpisode })) return;
    const isCurrent = () => playbackRequests.isCurrent(requestToken) && itemKey(currentMedia) === itemKey(selectedMedia);
    const result = await nextEpisodePreparation.attempt({
      resolveCandidate: () => adjacentEpisodeMedia(selectedMedia, 1),
      prepareCandidate: candidate => api.post('/api/play', { ...candidate, prepareAhead: true }),
      isCurrent
    });
    if (!isCurrent()) return;
    if (result.status === 'prepared') { nextMedia = result.media; nextJob = result.job; void pollNextEpisode(result.job.id, requestToken); }
  }

  async function pollNextEpisode(id, requestToken) {
    try { const job = await api.get(`/api/play/${id}`); if (!playbackRequests.isCurrent(requestToken) || nextJob?.id !== id) return; nextJob = job; if (job.status !== 'ready' && job.status !== 'error') nextPollTimer = setTimeout(() => void pollNextEpisode(id, requestToken), 900); else if (job.status === 'ready' && upNextStartedAt && upNextCountdown(upNextStartedAt).elapsed) playNextEpisode(); }
    catch { if (playbackRequests.isCurrent(requestToken) && nextJob?.id === id) nextJob = { ...nextJob, status: 'error' }; }
  }

  function playEpisode(resume = true, autoplay = false) {
    const selectedMedia = episodePlaybackMedia(media, selectedSeason, selectedEpisode, episodes);
    if (!selectedMedia) { playback = { status: 'error', message: 'Choose a valid season and episode before starting playback.', progress: 0 }; return; }
    return startPlayback(selectedMedia, null, resume && Boolean(progressFor(selectedMedia)?.position), autoplay);
  }

  function pinHeroViewport() { window.scrollTo(0, 0); }

  async function playSelectedMedia(event) {
    if (heroLaunching) return;
    event?.currentTarget?.blur();
    pinHeroViewport();
    heroLaunching = true;
    await tick();
    pinHeroViewport();
    try {
      if (media.type === 'movie') await startPlayback(media, null, Boolean(progressFor(media)?.position), true);
      else await playEpisode(true, true);
    } finally { heroLaunching = false; }
  }

  function playEpisodeNumber(episodeNumber) {
    selectedEpisode = String(episodeNumber);
    guideOpen = false;
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
      await startPlayback(selectedMedia, null, Boolean(progressFor(selectedMedia)?.position), true);
      return;
    }
    selectedSeason = String(seasons[0].number); episodes = await episodesForSeason(selectedSeason); selectedEpisode = episodes.length ? String(episodes[0].number) : '';
    const selectedMedia = selectedMediaItem();
    if (selectedMedia) await startPlayback(selectedMedia, null, false, true);
    else playback = null;
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

  async function playAdjacentEpisode(direction, autoAdvance = false) {
    const selectedMedia = await adjacentEpisodeMedia(currentMedia, direction);
    if (selectedMedia) await startPlayback(selectedMedia, null, Boolean(progressFor(selectedMedia)?.position), autoAdvance);
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

  function currentPlaybackPosition() { return Math.max(0, Number(player?.currentTime) || 0) + (hasGrowingStreamDuration(playback?.mode) ? resumeStreamOffset : 0); }
  function playbackStreamUrl() { return resumeStreamUrl(playback?.streamUrl, playback?.mode, resumeStreamOffset); }

  function beginPlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer); clearTimeout(playerRevealTimer);
    playbackSettled = false; resumeStarting = true; playerRevealing = false; playbackNeedsAction = false; playbackRecovery = null;
  }
  function settlePlaybackWarmup() {
    clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer);
    playbackSettled = true; playerRevealing = true; resumeStarting = false;
    clearTimeout(playerRevealTimer);
    playerRevealTimer = setTimeout(() => { playerRevealing = false; }, 700);
  }
  function handleCanPlay() {
    captureVideoDiagnostics('can play');
    void attemptAutomaticPlayback();
    if (playbackSettled) return;
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = setTimeout(settlePlaybackWarmup, 6000);
  }
  function handlePlaying() {
    playing = true; continuePlaybackOnReady = false; playbackNeedsAction = false; playbackRecovery = null;
    captureVideoDiagnostics('playing');
    clearTimeout(interruptionTimer); showPlayerControls();
    if (!playbackSettled) settlePlaybackWarmup();
    void prepareNextEpisode(currentMedia, currentPlaybackRequestToken);
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
  function beginUpNextCountdown(reason) {
    if (!autoPlayNext || !nextMedia) return;
    showUpNext = true;
    upNextReason ||= reason;
    if (!upNextStartedAt) upNextStartedAt = Date.now();
    tickUpNextCountdown();
  }
  function tickUpNextCountdown() {
    clearTimeout(upNextTimer);
    if (!showUpNext || !autoPlayNext || !upNextStartedAt) return;
    const countdown = upNextCountdown(upNextStartedAt);
    upNextSeconds = countdown.seconds;
    if (countdown.elapsed && canStartNextEpisode(nextMedia, nextJob)) { playNextEpisode(); return; }
    upNextTimer = setTimeout(tickUpNextCountdown, countdown.elapsed ? 500 : 1000);
  }
  function cancelUpNext() {
    autoPlayNext = false; showUpNext = false; upNextStartedAt = 0; upNextReason = ''; clearTimeout(upNextTimer);
  }
  function playNextEpisode() {
    if (!canStartNextEpisode(nextMedia, nextJob)) { beginUpNextCountdown('Waiting for the next episode'); return; }
    const selectedMedia = nextMedia, job = nextJob;
    clearTimeout(upNextTimer); autoPlayNext = false;
    void setWatched(currentMedia, true);
    void startPlayback(selectedMedia, job, false, true);
  }
  function sampleForEndCredits(timeline) {
    const detectionInput = () => ({ enabled: smartAutoplay, autoPlayNext, playing, hasNextEpisode: Boolean(nextMedia), position: timeline.position, duration: timeline.duration, sample: lastCreditSample, consecutiveMatches: likelyCreditFrames, detected: showUpNext && upNextReason === 'End credits detected', error: creditSamplingError });
    creditDiagnostics = creditDetectionStatus(detectionInput());
    if (!creditDiagnostics.eligible || showUpNext) return;
    const now = performance.now();
    if (!canAttemptCreditFrameSample(player)) {
      creditSamplingError = 'Video player is not available for frame sampling';
      creditDiagnostics = creditDetectionStatus(detectionInput());
      return;
    }
    if (now - lastCreditSampleAt < 2000) return;
    lastCreditSampleAt = now;
    try {
      creditCanvas ||= document.createElement('canvas');
      const width = 160, height = 90, context = creditCanvas.getContext('2d', { willReadFrequently: true });
      creditCanvas.width = width; creditCanvas.height = height;
      context.drawImage(player, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      let dark = 0, bright = 0, edges = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const offset = pixel * 4, luminance = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
        if (luminance < 65) dark++;
        if (luminance > 170) bright++;
        if (pixel % width) {
          const previous = offset - 4, previousLuminance = (pixels[previous] * 3 + pixels[previous + 1] * 6 + pixels[previous + 2]) / 10;
          if (Math.abs(luminance - previousLuminance) > 55) edges++;
        }
      }
      const total = width * height;
      const metrics = { darkFraction: dark / total, brightFraction: bright / total, edgeDensity: edges / total };
      lastCreditSample = { ...metrics, likely: creditFrameLooksLikely(metrics), at: Date.now() };
      creditSamplingError = '';
      likelyCreditFrames = lastCreditSample.likely ? likelyCreditFrames + 1 : 0;
      if (likelyCreditFrames >= 2) beginUpNextCountdown('End credits detected');
      creditDiagnostics = creditDetectionStatus(detectionInput());
    } catch (error) {
      likelyCreditFrames = 0;
      creditSamplingError = error?.message || 'Video frame sampling failed';
      creditDiagnostics = creditDetectionStatus(detectionInput());
    }
  }
  function handleTimeUpdate() {
    clearTimeout(interruptionTimer);
    playerPosition = Number.isFinite(player?.currentTime) ? player.currentTime : 0;
    playerDuration = Number.isFinite(player?.duration) ? player.duration : 0;
    restorePlaybackProgress();
    const timeline = controlTimeline();
    if (shouldShowUpNext(autoPlayNext && Boolean(nextMedia), timeline.position, timeline.duration)) beginUpNextCountdown('Episode ending');
    sampleForEndCredits(timeline);
    void prepareNextEpisode(currentMedia, currentPlaybackRequestToken);
    void savePlaybackProgress();
    captureVideoDiagnostics('time update');
  }
  function handleEnded() {
    playing = false;
    captureVideoDiagnostics('ended');
    const timeline = controlTimeline();
    const endAction = currentMedia?.type === 'tv' ? nextEpisodeEndAction(autoPlayNext, nextMedia, nextJob) : 'none';
    if (endAction === 'play' || endAction === 'wait') { upNextStartedAt = Date.now() - 30000; beginUpNextCountdown('Episode finished'); }
    else if (endAction === 'retry') { void setWatched(currentMedia, true); void startPlayback(nextMedia, null, false, true); }
    else if (endAction === 'resolve') { void setWatched(currentMedia, true); void playAdjacentEpisode(1, true); }
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
    const quality = player.getVideoPlaybackQuality?.();
    const totalFrames = Number(quality?.totalVideoFrames ?? player.webkitDecodedFrameCount);
    const droppedFrames = Number(quality?.droppedVideoFrames ?? player.webkitDroppedFrameCount);
    let frameStats = {};
    if (Number.isFinite(totalFrames) && Number.isFinite(droppedFrames)) {
      const stats = videoPlaybackStats({ at: performance.now(), total: totalFrames, dropped: droppedFrames }, videoFrameSample);
      if (stats.sample !== videoFrameSample) { videoFrameSample = stats.sample; measuredVideoFps = stats.fps; }
      frameStats = { fps: measuredVideoFps, totalFrames: stats.total, droppedFrames: stats.dropped, droppedFramePercent: stats.droppedPercent };
    }
    videoDiagnostics = { event, readyState: player.readyState, networkState: player.networkState, paused: player.paused, currentTime: player.currentTime, duration: player.duration, videoWidth: player.videoWidth, videoHeight: player.videoHeight, buffered: ranges.join(', '), error: player.error ? `MediaError ${player.error.code}${player.error.message ? `: ${player.error.message}` : ''}` : '', ...frameStats };
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
    if (hasGrowingStreamDuration(playback?.mode)) {
      void savePlaybackProgress(true);
      resumeStreamOffset = target;
      playerPosition = 0;
      videoFrameSample = null; measuredVideoFps = null;
      beginPlaybackWarmup();
      setTimeout(() => player?.play().catch(() => {}), 0);
    } else player.currentTime = target;
  }
  function seekBy(seconds) { const timeline = controlTimeline(); if (timeline.duration) seekToPosition(timeline.position + seconds); }
  function setVolume(event) { if (!player) return; const volume = Number(event.currentTarget.value); if (!Number.isFinite(volume)) return; player.volume = volume; player.muted = volume === 0; }
  function toggleMute() { if (player) player.muted = !player.muted; }
  async function toggleFullscreen() { if (!playerShell) return; if (document.fullscreenElement) await document.exitFullscreen(); else await playerShell.requestFullscreen(); }
  async function toggleGuide(open = !guideOpen) {
    if (open && document.fullscreenElement) await document.exitFullscreen();
    if (open) diagnosticsOpen = false;
    guideOpen = open;
  }
  async function returnToHero() {
    if (document.fullscreenElement) await document.exitFullscreen();
    await savePlaybackProgress(true);
    player?.pause();
    playbackRequests.cancel();
    clearTimeout(pollTimer); clearTimeout(nextPollTimer); clearTimeout(diagnosticPollTimer); clearTimeout(startupStableTimer); clearTimeout(startupFallbackTimer); clearTimeout(interruptionTimer); clearTimeout(controlHideTimer); clearTimeout(upNextTimer);
    nextEpisodePreparation.reset();
    clearTimeout(playerRevealTimer); playerRevealing = false;
    playback = null; nextMedia = null; nextJob = null; showUpNext = false; playing = false; controlsVisible = true; guideOpen = false; diagnosticsOpen = false; playbackNeedsAction = false; playbackRecovery = null; resumeStarting = false; continuePlaybackOnReady = false; videoDiagnostics = null; creditDiagnostics = null;
    const heroUrl = new URL(page.url);
    heroUrl.searchParams.delete('play');
    heroUrl.searchParams.delete('resume');
    replaceState(`${heroUrl.pathname}${heroUrl.search}`, page.state);
  }
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
      if (diagnosticsOpen) diagnosticsOpen = false;
      else if (guideOpen) guideOpen = false;
      else if (document.fullscreenElement) void document.exitFullscreen();
      else if (playback?.status === 'ready') void returnToHero();
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

{#snippet watchToolbar(inPlayer)}
  <div class="player-toolbar watch-toolbar-bridge" class:hero-player-toolbar={!inPlayer} class:player-toolbar-hidden={inPlayer && playback?.status === 'ready' && !controlsVisible && !guideOpen && !diagnosticsOpen} aria-label="Watch actions">
    {#if inPlayer}
      <button class="player-toolbar-button player-toolbar-back" onclick={() => void returnToHero()} aria-label="Back to title" title="Back to title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></button>
    {:else}
      <a class="player-toolbar-button player-toolbar-back" href="/" aria-label="Back to discover" title="Back to discover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></a>
    {/if}
    <div class="player-toolbar-actions">
      <button class="player-toolbar-button" class:player-toolbar-button-active={isInLibrary()} onclick={toggleLibrary} aria-label={isInLibrary() ? 'Remove from library' : 'Add to library'} title={isInLibrary() ? 'Remove from library' : 'Add to library'}>
      {#if isInLibrary()}<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3.75A1.75 1.75 0 0 1 7.75 2h8.5A1.75 1.75 0 0 1 18 3.75v17.1a.75.75 0 0 1-1.17.62L12 18.17l-4.83 3.3A.75.75 0 0 1 6 20.85V3.75Z" /></svg>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6.75 3.5h10.5v16.75L12 16.7l-5.25 3.55V3.5Z" /><path d="M12 7v6M9 10h6" /></svg>{/if}
      </button>
      {#if !offlineMode}
      {#if activeDownload(media)}
        <a class="player-toolbar-button" href="/downloads" aria-label={`Download ${Math.round(activeDownload(media).progress || 0)} percent complete`} title={`Downloading · ${Math.round(activeDownload(media).progress || 0)}%`}><span class="loading loading-spinner loading-xs"></span></a>
      {:else if media.type === 'tv'}
        <button class="player-toolbar-button" onclick={() => void downloadForOffline(media)} aria-label="Download series" title="Download series"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14" /></svg>{#if downloaded(media).count}<span class="player-toolbar-badge">{downloaded(media).count}</span>{/if}</button>
      {:else if downloaded(media).available}
        <a class="player-toolbar-button player-toolbar-button-active" href="/downloads" aria-label="Open downloaded movie" title="Downloaded"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14" /><path d="m8.5 8 2 2 4-4" /></svg></a>
      {:else}
        <button class="player-toolbar-button" onclick={() => void downloadForOffline(media)} aria-label="Download movie" title="Download movie"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 19h14" /></svg></button>
      {/if}
      {/if}
      <button class="player-toolbar-button" class:player-toolbar-button-active={isWatched()} onclick={toggleWatched} disabled={media.type === 'tv' && !selectedEpisode} aria-label={isWatched() ? 'Mark unwatched' : 'Mark watched'} title={isWatched() ? 'Mark unwatched' : 'Mark watched'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5" />{#if isWatched()}<path d="m8.25 12.15 2.45 2.45 5.05-5.2" />{/if}</svg></button>
      {#if playbackDiagnostics && inPlayer}
        <button class="player-toolbar-button" class:player-toolbar-button-active={diagnosticsOpen} aria-expanded={diagnosticsOpen} aria-controls="player-diagnostics" onclick={() => { diagnosticsOpen = !diagnosticsOpen; if (diagnosticsOpen) guideOpen = false; showPlayerControls(); }} aria-label="Playback diagnostics" title="Playback diagnostics"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" /><path d="M2.5 19.5h19" /></svg></button>
      {/if}
      {#if media.type === 'tv'}
        <button class="player-toolbar-button" class:player-toolbar-button-active={guideOpen} aria-expanded={guideOpen} aria-controls="watch-guide" onclick={() => void toggleGuide()} aria-label="Episodes" title="Episodes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 6h10M9 12h10M9 18h10" /><path d="m4.5 4.75 2 1.25-2 1.25V4.75Zm0 6 2 1.25-2 1.25v-2.5Zm0 6 2 1.25-2 1.25v-2.5Z" /></svg></button>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet heroPreparation(message, progress = 0, status = '', indeterminate = false)}
  <div class="hero-preparation" class:hero-preparation-error={status === 'error'} aria-live="polite">
    <div class="hero-preparation-heading">
      <span class="hero-preparation-mark" aria-hidden="true">{status === 'error' ? '!' : '▶'}</span>
      <span class="hero-preparation-copy"><strong>{status === 'error' ? 'Playback unavailable' : heroLaunching && !playback ? 'Opening' : 'Preparing playback'}</strong><small>{message || `Opening ${currentMedia?.episodeTitle || media.title}…`}</small></span>
      {#if status !== 'error' && detailedPlaybackProgress}<span class="hero-preparation-percent">{Math.round(progress || 0)}%</span>{/if}
      {#if status === 'error' && playback?.id}<button class="hero-preparation-retry" onclick={retryPlayback}>Try again</button>{/if}
    </div>
    {#if status !== 'error'}
      <div class="hero-preparation-track" role="progressbar" aria-label="Preparing playback" aria-valuenow={Math.round(progress || 0)} aria-valuemin="0" aria-valuemax="100">
        <span class:hero-preparation-indeterminate={indeterminate} style={`width: ${Math.min(100, Math.max(3, progress || 3))}%`}></span>
      </div>
    {/if}
  </div>
{/snippet}

<section class="watch-page">
  <div class="watch-hero" class:watch-hero-playing={playback?.status === 'ready' && !resumeStarting} class:watch-hero-revealing={playerRevealing} style={`--watch-artwork: url("${titleDetails.backdrop || media.poster || ''}")`}>
    <div class="watch-hero-art" aria-hidden="true"></div>
    <div class="watch-hero-shade" aria-hidden="true"></div>
    {@render watchToolbar(playback?.status === 'ready' && !resumeStarting)}

    {#if downloadError || bulkError}<div class="watch-hero-alerts">{#if downloadError}<div class="alert alert-error"><span>{downloadError}</span><button class="btn btn-sm btn-ghost" onclick={() => { downloadError = ''; }}>Dismiss</button></div>{/if}{#if bulkError}<div class="alert alert-error"><span>{bulkError}</span><button class="btn btn-sm btn-ghost" aria-label="Dismiss bulk update error" onclick={() => { bulkError = ''; }}>Dismiss</button></div>{/if}</div>{/if}

    {#if playback?.status !== 'ready' || resumeStarting || playerRevealing}
      <div class="watch-identity" class:watch-identity-departing={playerRevealing}>
        <p class="page-eyebrow text-white/55">{media.type === 'tv' ? 'Series' : 'Film'}{media.year ? ` · ${media.year}` : ''}{#if media.type === 'tv' && selectedSeason && selectedEpisode} · S{String(selectedSeason).padStart(2, '0')}E{String(selectedEpisode).padStart(2, '0')}{/if}</p>
        <h1>{media.title || 'Watch'}</h1>
        {#if currentMedia?.episodeTitle}<p class="watch-episode-name">{currentMedia.episodeTitle}</p>{/if}
        {#if titleDetails.overview}<p class="watch-overview">{titleDetails.overview}</p>{/if}
        <div class="hero-action-slot">
          {#if playback || heroLaunching}
            {@render heroPreparation(resumeStarting ? (resumeStreamOffset > 0 ? `Opening the stream and restoring your position at ${formatPosition(resumeStreamOffset)}…` : 'Opening the video stream and preparing the first frames…') : playback?.message, playback?.progress, playback?.status, resumeStarting || heroLaunching && !playback || playback?.status === 'extracting' || playback?.status === 'optimizing')}
          {:else}
            <button class="hero-identity-play" onclick={playSelectedMedia} aria-label={`Play ${media.type === 'tv' ? episodes.find(episode => String(episode.number) === selectedEpisode)?.name || media.title : media.title}`}><span aria-hidden="true">▶</span><span>Play{currentMedia?.episodeTitle ? ` ${currentMedia.episodeTitle}` : ''}</span></button>
          {/if}
        </div>
      </div>
    {/if}
    {#if playback?.status === 'ready'}
      <div class="watch-stage" class:watch-stage-warming={resumeStarting} class:watch-stage-revealing={playerRevealing}>
      {#if currentMedia}
        <div class="player-shell cinema-player group/player relative aspect-video overflow-hidden bg-black" class:player-shell-warming={resumeStarting} bind:this={playerShell} role="group" aria-label="Video player" onpointermove={showPlayerControls} onpointerleave={schedulePlayerControlsHide} onfocusin={showPlayerControls} onfocusout={schedulePlayerControlsHide}>
          {#if playbackDiagnostics && diagnosticsOpen}
            <aside id="player-diagnostics" class="player-diagnostics-panel" aria-label="Playback diagnostics">
              <div class="player-diagnostics-header"><div><p class="player-eyebrow">Live technical data</p><h2>Playback diagnostics</h2></div><button class="player-diagnostics-close" onclick={() => { diagnosticsOpen = false; }} aria-label="Close playback diagnostics">×</button></div>
              <PlaybackDiagnostics {playback} {nextJob} video={videoDiagnostics} credits={creditDiagnostics} embedded />
            </aside>
          {/if}
          {#if playback?.status === 'ready'}
            {@const timeline = controlTimeline()}
            {#key streamAttempt}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="h-full w-full bg-black object-contain transition-opacity focus:outline-none" class:opacity-0={resumeStarting} class:cursor-none={playing && !controlsVisible} bind:this={player} tabindex={resumeStarting ? -1 : 0} aria-hidden={resumeStarting} aria-label={`${media.title} video player`} autoplay playsinline preload="auto" src={playbackStreamUrl()} onclick={togglePlayback} onerror={() => { captureVideoDiagnostics('error'); offerPlaybackRecovery('The direct stream encountered a playback error.'); }} onloadedmetadata={() => { restorePlaybackProgress(); playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; captureVideoDiagnostics('metadata loaded'); }} oncanplay={handleCanPlay} ondurationchange={() => { playerDuration = Number.isFinite(player?.duration) ? player.duration : 0; captureVideoDiagnostics('duration changed'); }} ontimeupdate={handleTimeUpdate} onplay={() => { playing = true; captureVideoDiagnostics('play'); }} onplaying={handlePlaying} onwaiting={handleStartupBuffering} onstalled={handleStartupBuffering} onpause={handlePause} onvolumechange={() => { playerVolume = player?.volume ?? 1; playerMuted = player?.muted ?? false; }} onended={handleEnded}></video>
            {/key}
            {#if playbackRecovery}
              <div class="player-modal absolute inset-0 z-30 text-white">
                <div class="player-modal-panel player-modal-panel-alert"><p class="player-eyebrow">Stream interrupted</p><h2>How would you like to continue?</h2><p>{playbackRecovery.message}</p><div class="player-modal-actions"><button class="player-popup-button player-popup-button-primary" onclick={retryDirectStream}>Retry stream</button><button class="player-popup-button" onclick={() => void fallback()}>Download &amp; resume</button></div></div>
              </div>
            {:else if playbackNeedsAction}
              <div class="player-modal absolute inset-0 z-30 text-white">
                <div class="player-modal-panel"><p class="player-eyebrow">Stream ready</p><h2>{currentMedia?.episodeTitle || media.title}</h2><p>The player is prepared and waiting for you.</p><div class="player-modal-actions"><button class="player-popup-button player-popup-button-primary" onclick={() => void playPreparedVideo()}><span aria-hidden="true">▶</span> Start watching</button></div></div>
              </div>
            {:else if resumeStarting}
              <div class="absolute inset-0" aria-hidden="true"></div>
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
            <div class="absolute inset-0 z-20"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} artwork={titleDetails.backdrop || media.poster} indeterminate={playback?.status === 'extracting' || playback?.status === 'optimizing'} /></div>
          {/if}
          {#if showUpNext && nextMedia}<div class="up-next-panel absolute inset-x-3 bottom-24 z-30 sm:left-auto sm:right-5 sm:w-[27rem]"><div class="up-next-countdown"><span>{upNextSeconds}</span><small>SEC</small></div><div class="min-w-0 flex-1"><p class="player-eyebrow">Up next · Episode {nextMedia.episode}</p><p class="up-next-title">{nextMedia.episodeTitle}</p><p class="up-next-detail">{nextJob?.status === 'ready' ? upNextReason : 'Preparing in the background…'}</p></div><div class="up-next-actions"><button class="player-popup-button player-popup-button-primary" onclick={playNextEpisode} disabled={nextJob?.status !== 'ready'} aria-label="Play next episode">▶</button><button class="player-popup-button" onclick={cancelUpNext}>Cancel</button></div></div>{/if}
        </div>
      {:else}
        <div class="aspect-video"><PlaybackPreparation title={preparationTitle()} message={playback?.message} progress={playback?.progress} download={playback?.download} detailed={detailedPlaybackProgress} error={playback?.status === 'error'} artwork={titleDetails.backdrop || media.poster} indeterminate={playback?.status === 'extracting' || playback?.status === 'optimizing'} /></div>
      {/if}
      {#if playback?.status === 'error'}<div class="alert alert-error mt-4"><span>{playback.message}</span>{#if playback.id}<button class="btn btn-sm" onclick={retryPlayback}>Resume</button>{/if}</div>{/if}
      </div>
    {/if}

    {#if guideOpen && (media.type === 'tv' || releaseChoices.length)}
      <button class="watch-drawer-scrim" aria-label="Close episodes" onclick={() => { guideOpen = false; }}></button>
      <div id="watch-guide" class="episode-panel watch-drawer" role="dialog" aria-modal="true" aria-label={releaseChoices.length ? 'Playback choices' : 'Episode guide'}>
      <div class="watch-drawer-handle" aria-hidden="true"></div>
      <button class="watch-drawer-close" aria-label="Close episodes" onclick={() => { guideOpen = false; }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      {#if media.type === 'tv'}
        <div class="episode-guide-header">
          <div><p class="page-eyebrow">Series guide</p><h2 class="episode-title mt-2">Episodes</h2><p class="mt-1 text-xs text-base-content/45">{episodes.length ? `${episodes.length} episodes` : 'Choose a season'}</p></div>
          <div class="episode-guide-controls">
            <label class="episode-season-control">
              <span class="sr-only">Choose season</span>
              <select class="episode-season-select" disabled={!seasons.length} aria-busy={!seasons.length && playback?.status !== 'error'} onchange={chooseSeasonFromSelect}>
                {#if !seasons.length}<option selected>{playback?.status === 'error' ? 'Seasons unavailable' : 'Loading seasons…'}</option>{/if}
                {#each seasons as season}<option value={season.number} selected={String(season.number) === selectedSeason}>{season.name} · {season.episodeCount} EP</option>{/each}
              </select>
            </label>
            <details class="dropdown dropdown-end episode-bulk-menu" class:pointer-events-none={!episodes.length || bulkUpdating}>
              <summary class="episode-guide-icon" class:opacity-50={!episodes.length || bulkUpdating} aria-label="Episode actions" title="Episode actions" aria-disabled={!episodes.length || bulkUpdating}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg></summary>
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
                <button class="episode-play flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 pr-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary" aria-current={String(episode.number) === selectedEpisode ? 'true' : undefined} aria-label={`Play episode ${episode.number}, ${episode.name}`} onclick={() => playEpisodeNumber(episode.number)}>
                  <span class="episode-marker grid h-9 w-9 shrink-0 place-items-center border border-base-300 text-xs font-semibold text-base-content/55 transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-content">
                    {#if currentMedia?.type === 'tv' && currentMedia.season === Number(selectedSeason) && currentMedia.episode === episode.number && playback?.status === 'ready'}<span class="episode-now">NOW</span>{:else}<span class="episode-number">{String(episode.number).padStart(2, '0')}</span><svg class="episode-play-icon h-3.5 w-3.5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5.5 3.9a1 1 0 0 1 1.52-.85l9.1 6.1a1 1 0 0 1 0 1.7l-9.1 6.1a1 1 0 0 1-1.52-.85V3.9Z" /></svg>{/if}
                  </span>
                  <span class="min-w-0 flex-1"><span class="truncate text-sm font-medium group-hover:text-primary">{episode.name}</span>{#if episode.airDate}<span class="mt-1 block text-[11px] text-base-content/45">{formatAirDate(episode.airDate)}</span>{/if}</span>
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
      {#if releaseChoices.length}<div class="release-picker mt-8 border-t border-base-300 pt-6" bind:this={releasePicker} tabindex="-1" aria-labelledby="release-picker-title"><p class="page-eyebrow" id="release-picker-title">Choose a release</p><div class="mt-4 divide-y divide-base-300 border-y border-base-300">{#each releaseChoices as release}<button class="release-option flex w-full items-start justify-between gap-3 py-4 text-left hover:text-primary" onclick={() => void startPlayback({ ...pendingMedia, releaseId: release.id }, null, pendingResume)}><span class="min-w-0"><span class="block truncate text-sm font-medium">{release.title}</span><span class="mt-1 block text-xs text-base-content/45">{release.readiness.label} · {release.category}</span></span>{#if release.size}<span class="shrink-0 text-xs text-base-content/45">{release.size}</span>{/if}</button>{/each}</div></div>{/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .player-shell:fullscreen {
    width: 100vw;
    height: 100vh;
    aspect-ratio: auto;
  }
</style>
