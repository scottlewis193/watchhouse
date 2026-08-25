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

export function progressDuration(playbackMode, duration) {
  return playbackMode !== 'direct' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function playbackTimeline(playbackMode, position, mediaDuration, streamDuration, streamOffset = 0) {
  const relativePosition = Number.isFinite(position) && position > 0 ? position : 0;
  const offset = Number.isFinite(streamOffset) && streamOffset > 0 ? streamOffset : 0;
  const videoDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0;
  if (playbackMode !== 'direct') return { position: Math.min(relativePosition, videoDuration || relativePosition), duration: videoDuration };
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : offset + videoDuration;
  return { position: Math.min(offset + relativePosition, duration || offset + relativePosition), duration };
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
