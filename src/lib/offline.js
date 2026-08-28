export function offlineMediaKey(media) {
  if (!media || !['movie', 'tv'].includes(media.type) || !Number.isInteger(Number(media.id))) return '';
  if (media.type === 'tv') {
    if (!Number.isInteger(Number(media.season))) return `tv:${media.id}`;
    if (!Number.isInteger(Number(media.episode))) return `tv:${media.id}:s${media.season}`;
    return `tv:${media.id}:s${media.season}:e${media.episode}`;
  }
  return `movie:${media.id}`;
}

export function offlineMediaMatches(left, right) {
  const leftKey = offlineMediaKey(left), rightKey = offlineMediaKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

export function offlineEpisodeState(media, downloads, jobs) {
  const ready = downloads.find(download => download.status === 'ready' && offlineMediaMatches(download.media, media));
  if (ready) return { status: 'ready', item: ready };
  const job = [...jobs].reverse().find(candidate => offlineMediaMatches(candidate.media, media));
  return job ? { status: job.status, item: job } : { status: 'available', item: null };
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

export function offlineSeriesCatalogue(downloads, showId) {
  const local = offlineEpisodes(downloads, showId);
  const numbers = [...new Set(local.map(item => item.season))];
  return {
    seasons: numbers.map(number => ({ number, name: `Season ${number}`, episodeCount: local.filter(item => item.season === number).length })),
    episodesBySeason: Object.fromEntries(numbers.map(number => [String(number), local
      .filter(item => item.season === number)
      .map(item => ({ number: item.episode, name: item.episodeTitle || `Episode ${item.episode}`, runtime: Math.round((item.durationHint || 0) / 60) }))]))
  };
}
