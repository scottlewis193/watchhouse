const TMDB_IMAGE_ROOT = 'https://image.tmdb.org/t/p';

export function tmdbImage(path, size = 'w500') {
  return path ? `${TMDB_IMAGE_ROOT}/${size}${path}` : null;
}

export function mapTmdbRuntime(payload) {
  const minutes = Number(payload?.runtime);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
}

export function mapTmdbTitles(payload, forcedType) {
  return (payload.results || []).flatMap(item => {
    const type = forcedType || item.media_type;
    if (!['movie', 'tv'].includes(type)) return [];
    return [{
      id: item.id,
      type,
      title: item.title || item.name,
      year: String(item.release_date || item.first_air_date || '').slice(0, 4),
      overview: item.overview || '',
      poster: tmdbImage(item.poster_path)
    }];
  });
}

export function mapTmdbSeasons(payload) {
  return (payload.seasons || [])
    .filter(item => Number.isInteger(item.season_number) && item.season_number > 0)
    .map(item => ({ id: item.id, number: item.season_number, name: item.name || `Season ${item.season_number}`, episodeCount: item.episode_count || 0 }))
    .sort((a, b) => a.number - b.number);
}

export function mapTmdbEpisodes(payload) {
  return (payload.episodes || [])
    .filter(item => Number.isInteger(item.episode_number) && item.episode_number > 0)
    .map(item => ({
      id: item.id,
      number: item.episode_number,
      name: item.name || `Episode ${item.episode_number}`,
      airDate: item.air_date || '',
      overview: item.overview || '',
      runtime: item.runtime || 0,
      still: tmdbImage(item.still_path, 'w300')
    }))
    .sort((a, b) => a.number - b.number);
}

export function episodeTag(media) {
  if (!media.season || !media.episode) return '';
  return `S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
}

export function titleVariants(title) {
  const original = String(title || '').trim();
  const withoutApostrophes = original.replace(/['‘’`]/g, '').replace(/\s+/g, ' ').trim();
  return [...new Set([original, withoutApostrophes].filter(Boolean))];
}

export function releaseScore(release, media, preferences = {}) {
  const text = release.title.toLowerCase();
  let score = 0;
  const tag = episodeTag(media).toLowerCase();
  if (tag && text.includes(tag)) score += 120;
  else if (tag && text.includes(`${media.season}x${String(media.episode).padStart(2, '0')}`)) score += 100;
  if (media.year && text.includes(media.year)) score += 80;
  if (/2160p|4k|uhd/.test(text)) score += preferences.playbackQuality === 'quality' ? 65 : 30;
  else if (/1080p/.test(text)) score += 40;
  else if (/720p/.test(text)) score += 25;
  if (/web[- .]?dl|bluray|blu[- .]?ray/.test(text)) score += 12;
  if (/h[ .]?264|x264|avc/.test(text)) score += 15;
  if (/x265|hevc|h[ .]?265/.test(text)) score -= 45;
  if (/av1/.test(text)) score -= 30;
  if (preferences.playbackQuality === 'fast') {
    if (/\.mp4\b|web[- .]?dl.*h[ .]?264|x264/.test(text)) score += 60;
    if (/rar|7z|zip/.test(text)) score -= 80;
    if (/2160p|4k|uhd/.test(text)) score -= 35;
  }
  if (/cam|telesync|ts\b/.test(text)) score -= 100;
  return score;
}

export function englishAudioRelease(release) {
  const text = ` ${String(release?.title || '').toLowerCase().replace(/[._-]+/g, ' ')} `;
  if (/\b(?:eng|english)\b/.test(text)) return true;
  return !/\b(?:german|deutsch|french|truefrench|vff|vfq|italian|ita|spanish|castilian|latino|rus|russian|ukr|ukrainian|polish|pldub|dutch|nl|danish|swedish|norwegian|finnish|hindi|tamil|telugu|korean|japanese|jpn|chinese|mandarin|cantonese|turkish|arabic)\b/.test(text);
}

export function rankReleases(releases, media, preferences) {
  return releases.filter(englishAudioRelease).sort((a, b) => releaseScore(b, media, preferences) - releaseScore(a, media, preferences));
}

export function releaseReadiness(release) {
  const title = release.title.toLowerCase();
  if (/\.part\d+\.rar|\.rar\b|\.r\d\d\b|\.7z|\.zip\b/.test(title)) return { kind: 'download', label: 'Download first' };
  if (/\.mp4\b|\.m4v\b|\.mov\b|\.webm\b/.test(title) && !/hevc|x265|h[ .]?265|av1/.test(title)) return { kind: 'direct', label: 'Likely direct' };
  if (/\.mkv\b|hevc|x265|h[ .]?265|av1/.test(title)) return { kind: 'convert', label: 'Live conversion' };
  return { kind: 'check', label: 'Checking on start' };
}

export function playbackStrategy(subject, releaseTitle = '') {
  const extension = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  const description = `${subject} ${releaseTitle}`.toLowerCase();
  if (extension === 'webm') return 'raw';
  if (['mp4', 'm4v', 'mov'].includes(extension) && !/hevc|h[ .]?265|x265|av1/.test(description)) return 'raw';
  if (extension === 'mkv' && /h[ .]?264|x264|avc/.test(description)) return 'remux';
  return 'transcode';
}
