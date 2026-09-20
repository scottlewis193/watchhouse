export function canUseFallback(playback) {
  return playback?.mode === 'direct' && playback.status === 'ready';
}

export function streamInterruptionAction(playback, automaticRetries = 0, retryLimit = 3, reason = '') {
  if (playback?.mode === 'cached' && playback.status === 'ready' && reason === 'buffering-timeout') return automaticRetries < retryLimit ? 'retry' : 'error';
  if (playback?.mode === 'cached-convert' && playback.status === 'ready') return automaticRetries < retryLimit ? 'retry' : 'error';
  if (!canUseFallback(playback)) return 'error';
  return Math.max(0, Number(automaticRetries) || 0) < Math.max(0, Number(retryLimit) || 0) ? 'retry' : 'offer';
}

export function bufferedRecoveryTarget(ranges, currentTime, offset = 0, overlap = 1) {
  if (!ranges || !Number.isFinite(currentTime)) return null;
  for (let index = 0; index < ranges.length; index++) {
    const start = ranges.start(index), end = ranges.end(index);
    if (currentTime < start - 0.25 || currentTime >= end || end - currentTime < 2) continue;
    return offset + Math.max(currentTime, end - overlap);
  }
  return null;
}

export function episodePlaybackMedia(show, season, episodeNumber, episodes) {
  const episode = episodes.find((item) => String(item.number) === String(episodeNumber));
  const selectedSeason = Number(season);
  const selectedEpisode = Number(episodeNumber);

  if (!show || !episode || !Number.isInteger(selectedSeason) || selectedSeason < 1 || !Number.isInteger(selectedEpisode) || selectedEpisode < 1) {
    return null;
  }

  return {
    ...show,
    season: selectedSeason,
    episode: selectedEpisode,
    episodeTitle: episode.name,
    ...(episode.runtime ? { durationHint: episode.runtime * 60 } : {})
  };
}

export function firstUnwatchedEpisode(episodes, watchedEpisodeNumbers) {
  return episodes.find(episode => !watchedEpisodeNumbers.has(Number(episode.number))) || null;
}

export function shouldMarkWatched(position, duration, threshold = 30) {
  return Number.isFinite(position) && Number.isFinite(duration) && duration > threshold && position >= threshold && duration - position <= threshold;
}

export function canSavePlaybackProgress(mediaKey, completedMediaKey) {
  return Boolean(mediaKey) && mediaKey !== completedMediaKey;
}

export function hasGrowingStreamDuration(playbackMode) {
  return playbackMode === 'direct' || playbackMode === 'cached-convert';
}

export function progressDuration(playbackMode, duration) {
  return !hasGrowingStreamDuration(playbackMode) && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function resolvedMediaDuration(sourceDuration, catalogueDuration, savedDuration = 0) {
  const positive = value => Number.isFinite(value) && value > 0 ? value : 0;
  const source = positive(sourceDuration), catalogue = positive(catalogueDuration);
  // Source metadata is normally more precise than a catalogue runtime. But a
  // short fragment must not override the runtime of the episode it belongs to.
  if (catalogue && source < catalogue * 0.5) return catalogue;
  return source || catalogue || positive(savedDuration);
}

export function playbackTimeline(playbackMode, position, mediaDuration, streamDuration, streamOffset = 0) {
  const relativePosition = Number.isFinite(position) && position > 0 ? position : 0;
  const offset = Number.isFinite(streamOffset) && streamOffset > 0 ? streamOffset : 0;
  const videoDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0;
  if (!hasGrowingStreamDuration(playbackMode)) return { position: Math.min(relativePosition, videoDuration || relativePosition), duration: videoDuration };
  const positionOffset = offset;
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : positionOffset + videoDuration;
  return { position: Math.min(positionOffset + relativePosition, duration || positionOffset + relativePosition), duration };
}

export function bufferedPlaybackRanges(mode, ranges, duration, streamOffset = 0) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const offset = hasGrowingStreamDuration(mode) && Number.isFinite(streamOffset) ? Math.max(0, streamOffset) : 0;
  return ranges.flatMap(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const from = Math.max(0, Math.min(duration, start + offset));
    const to = Math.max(0, Math.min(duration, end + offset));
    return to > from ? [{ left: from / duration * 100, width: (to - from) / duration * 100 }] : [];
  });
}

export function shouldShowUpNext(eligible, position, duration, threshold = 30) {
  return Boolean(eligible) && Number.isFinite(position) && position >= 0 && Number.isFinite(duration) && duration > threshold && duration - position <= threshold;
}

export function canStartNextEpisode(nextMedia, nextJob) {
  return Boolean(nextMedia) && nextJob?.status === 'ready';
}

export function shouldContinuePlayback(autoAdvance, playback) {
  return Boolean(autoAdvance) && playback?.status === 'ready';
}

export function playbackPresentation({ ready, warming, restarting, revealing }) {
  const initialWarmup = Boolean(ready && warming && !restarting);
  const inPlayer = Boolean(ready && !initialWarmup);
  return {
    inPlayer,
    showIdentity: !ready || initialWarmup || Boolean(revealing),
    warming: initialWarmup,
    hideVideo: initialWarmup,
    showControls: Boolean(ready && (!warming || restarting)),
    showSeekStatus: Boolean(ready && warming && restarting)
  };
}

export function nextEpisodeEndAction(autoPlayNext, nextMedia, nextJob) {
  if (!autoPlayNext) return 'none';
  if (!nextMedia) return 'resolve';
  if (nextJob?.status === 'ready') return 'play';
  if (nextJob?.status === 'error' || nextJob?.status === 'cancelled') return 'retry';
  return 'wait';
}

export function upNextCountdown(startedAt, now = Date.now(), delaySeconds = 30) {
  const remaining = Math.max(0, delaySeconds * 1000 - Math.max(0, now - startedAt));
  return { seconds: Math.ceil(remaining / 1000), elapsed: remaining === 0 };
}

const CREDIT_MAXIMUM_LEAD = 5 * 60;

function creditSamplingStart(duration, maximumLead = CREDIT_MAXIMUM_LEAD) {
  return Math.max(duration * 0.65, duration - maximumLead);
}

export function shouldSampleForCredits(position, duration, maximumLead = CREDIT_MAXIMUM_LEAD) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return false;
  return position >= creditSamplingStart(duration, maximumLead) && position < duration;
}

export function canAttemptCreditFrameSample(video) {
  return Boolean(video);
}

export function creditDetectionStatus({ enabled, autoPlayNext, playing, hasNextEpisode, position, duration, sample = null, consecutiveMatches = 0, sampleCount = 0, detected = false, error = '' }) {
  const sampleFrom = Number.isFinite(duration) && duration > 0 ? creditSamplingStart(duration) : 0;
  const result = { sample, consecutiveMatches, sampleCount, detected, sampleFrom, eligible: false };
  if (!enabled) return { ...result, state: 'disabled', label: 'Disabled in settings' };
  if (!autoPlayNext) return { ...result, state: 'autoplay-off', label: 'Auto-play next episode is off' };
  if (!playing) return { ...result, state: 'paused', label: 'Waiting for playback' };
  if (!hasNextEpisode) return { ...result, state: 'waiting-next', label: 'Waiting for the next episode to be prepared' };
  if (!shouldSampleForCredits(position, duration)) return { ...result, state: 'waiting-window', label: sampleFrom ? `Waiting until ${Math.round(sampleFrom)}s` : 'Waiting for a reliable duration' };
  if (error) return { ...result, eligible: true, state: 'unavailable', label: error };
  if (detected) return { ...result, eligible: true, state: 'detected', label: 'Credits detected — countdown triggered' };
  if (sample?.likely || consecutiveMatches) return { ...result, eligible: true, state: 'matching', label: `Credit evidence (${consecutiveMatches}/${sampleCount || 3} recent frames)` };
  if (sample) return { ...result, eligible: true, state: 'rejected', label: 'Latest frame did not look like credits' };
  return { ...result, eligible: true, state: 'eligible', label: 'Sampling frames for credits' };
}

export function videoPlaybackStats(current, previous = null, minimumSampleMs = 5000) {
  const total = Math.max(0, Number(current?.total) || 0);
  const dropped = Math.min(total, Math.max(0, Number(current?.dropped) || 0));
  const at = Number(current?.at) || 0;
  const sample = { at, total, dropped };
  const droppedPercent = total ? dropped / total * 100 : 0;
  if (!previous || at <= previous.at || total < previous.total || dropped < previous.dropped) return { fps: null, total, dropped, droppedPercent, sample };
  const elapsed = at - previous.at;
  if (elapsed < minimumSampleMs) return { fps: null, total, dropped, droppedPercent, sample: previous };
  const renderedFrames = Math.max(0, (total - dropped) - (previous.total - previous.dropped));
  const recentTotal = total - previous.total;
  const recentDropped = dropped - previous.dropped;
  return { fps: renderedFrames * 1000 / elapsed, total, dropped, droppedPercent, recentDropped, recentDroppedPercent: recentTotal ? recentDropped / recentTotal * 100 : 0, sampleMs: elapsed, sample };
}

export function audioPlaybackHealth(current, previous = null, minimumSampleMs = 8000) {
  const at = Number(current?.at) || 0;
  const position = Math.max(0, Number(current?.position) || 0);
  const audioBytes = Number.isFinite(current?.audioBytes) ? Math.max(0, current.audioBytes) : null;
  const videoFrames = Number.isFinite(current?.videoFrames) ? Math.max(0, current.videoFrames) : null;
  const sample = { at, position, audioBytes, videoFrames };
  if (!current?.playing || current?.muted || !(Number(current?.volume) > 0) || audioBytes === null) return { stalled: false, sample };
  if (!previous || previous.audioBytes === null || previous.audioBytes <= 0 || at <= previous.at || position < previous.position) return { stalled: false, sample };
  if (at - previous.at < minimumSampleMs) return { stalled: false, sample: previous };
  const videoAdvanced = position - previous.position >= 4 && (videoFrames === null || previous.videoFrames === null || videoFrames > previous.videoFrames);
  return { stalled: videoAdvanced && audioBytes <= previous.audioBytes, sample };
}

export function resumeStreamUrl(url, playbackMode, position) {
  if (!url || !hasGrowingStreamDuration(playbackMode) || !Number.isFinite(position) || position <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}start=${encodeURIComponent(position)}`;
}

export function resumePosition(entry, duration, threshold = 30) {
  if (!entry || entry.watched || !Number.isFinite(duration) || duration <= 0 || entry.position < 5 || duration - entry.position <= threshold) return 0;
  return Math.min(entry.position, Math.max(0, duration - threshold - 1));
}

export function playbackPollDelay(attempt) {
  if (attempt < 5) return 200;
  if (attempt < 15) return 500;
  return 900;
}

export function createNextEpisodePreparationController() {
  let state = 'idle';
  let generation = 0;
  return {
    get preparing() { return state === 'preparing'; },
    reset() { generation++; state = 'idle'; },
    async attempt({ resolveCandidate, prepareCandidate, isCurrent = () => true }) {
      if (state !== 'idle') return { status: 'skipped' };
      const token = ++generation;
      let media = null;
      state = 'preparing';
      try {
        media = await resolveCandidate();
        if (token !== generation || !isCurrent()) return { status: 'stale' };
        if (!media) { state = 'unavailable'; return { status: 'unavailable' }; }
        const job = await prepareCandidate(media);
        if (token !== generation || !isCurrent()) return { status: 'stale' };
        state = 'prepared';
        return { status: 'prepared', media, job };
      } catch (error) {
        if (token === generation) state = 'idle';
        return { status: 'error', media, error };
      } finally {
        if (token === generation && state === 'preparing') state = 'idle';
      }
    }
  };
}

export function shouldPrepareNextEpisode({ playing, mediaType, manualReleaseSelection, autoPlayNextEpisode = true }) {
  if (!playing || mediaType !== 'tv' || manualReleaseSelection || !autoPlayNextEpisode) return false;
  return true;
}

export function createPlaybackRequestGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    cancel() { generation++; },
    isCurrent(token) { return token === generation; }
  };
}
