export function canUseFallback(playback) {
  return playback?.mode === 'direct' && playback.status === 'ready';
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

export function playbackTimeline(playbackMode, position, mediaDuration, streamDuration, streamOffset = 0) {
  const relativePosition = Number.isFinite(position) && position > 0 ? position : 0;
  const offset = Number.isFinite(streamOffset) && streamOffset > 0 ? streamOffset : 0;
  const videoDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0;
  if (!hasGrowingStreamDuration(playbackMode)) return { position: Math.min(relativePosition, videoDuration || relativePosition), duration: videoDuration };
  const positionOffset = playbackMode === 'direct' ? offset : 0;
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : positionOffset + videoDuration;
  return { position: Math.min(positionOffset + relativePosition, duration || positionOffset + relativePosition), duration };
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

export function nextEpisodeEndAction(autoPlayNext, nextMedia, nextJob) {
  if (!autoPlayNext) return 'none';
  if (!nextMedia) return 'resolve';
  if (nextJob?.status === 'ready') return 'play';
  if (nextJob?.status === 'error') return 'retry';
  return 'wait';
}

export function upNextCountdown(startedAt, now = Date.now(), delaySeconds = 30) {
  const remaining = Math.max(0, delaySeconds * 1000 - Math.max(0, now - startedAt));
  return { seconds: Math.ceil(remaining / 1000), elapsed: remaining === 0 };
}

export function shouldSampleForCredits(position, duration, maximumLead = 15 * 60) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return false;
  return position >= Math.max(duration * 0.65, duration - maximumLead) && position < duration;
}

export function creditFrameLooksLikely({ darkFraction, brightFraction, edgeDensity }) {
  return Number.isFinite(darkFraction) && Number.isFinite(brightFraction) && Number.isFinite(edgeDensity)
    && darkFraction >= 0.72 && brightFraction >= 0.012 && brightFraction <= 0.18
    && edgeDensity >= 0.025 && edgeDensity <= 0.3;
}

export function videoPlaybackStats(current, previous = null, minimumSampleMs = 250) {
  const total = Math.max(0, Number(current?.total) || 0);
  const dropped = Math.min(total, Math.max(0, Number(current?.dropped) || 0));
  const at = Number(current?.at) || 0;
  const sample = { at, total, dropped };
  const droppedPercent = total ? dropped / total * 100 : 0;
  if (!previous || at <= previous.at || total < previous.total || dropped < previous.dropped) return { fps: null, total, dropped, droppedPercent, sample };
  const elapsed = at - previous.at;
  if (elapsed < minimumSampleMs) return { fps: null, total, dropped, droppedPercent, sample: previous };
  const renderedFrames = Math.max(0, (total - dropped) - (previous.total - previous.dropped));
  return { fps: renderedFrames * 1000 / elapsed, total, dropped, droppedPercent, sample };
}

export function resumeStreamUrl(url, playbackMode, position) {
  if (!url || playbackMode !== 'direct' || !Number.isFinite(position) || position <= 0) return url;
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

export function shouldPrepareNextEpisode({ playing, mediaType, manualReleaseSelection, autoPlayNextEpisode = true, playbackMode, bufferedAhead = 0 }, minimumBuffer = 30) {
  if (!playing || mediaType !== 'tv' || manualReleaseSelection || !autoPlayNextEpisode) return false;
  return playbackMode !== 'direct' || bufferedAhead >= minimumBuffer;
}

export function createPlaybackRequestGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    cancel() { generation++; },
    isCurrent(token) { return token === generation; }
  };
}
