export function offlineMediaKey(media) {
  if (!media || !['movie', 'tv'].includes(media.type) || !Number.isInteger(Number(media.id))) return '';
  if (media.type === 'tv') {
    if (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode))) return `tv:${media.id}`;
    return `tv:${media.id}:s${media.season}:e${media.episode}`;
  }
  return `movie:${media.id}`;
}

export function offlineAvailability(item, downloads) {
  const matches = downloads.filter(download => download.status === 'ready' && download.media?.type === item.type && Number(download.media?.id) === Number(item.id));
  return { available: matches.length > 0, count: matches.length };
}

export function offlineEpisodes(downloads, showId) {
  return downloads
    .filter(download => download.status === 'ready' && download.media?.type === 'tv' && Number(download.media.id) === Number(showId))
    .map(download => download.media)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}
