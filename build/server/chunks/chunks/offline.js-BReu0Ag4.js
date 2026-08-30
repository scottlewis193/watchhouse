function offlineMediaKey(media) {
  if (!media || !["movie", "tv"].includes(media.type) || !Number.isInteger(Number(media.id))) return "";
  if (media.type === "tv") {
    if (!Number.isInteger(Number(media.season))) return `tv:${media.id}`;
    if (!Number.isInteger(Number(media.episode))) return `tv:${media.id}:s${media.season}`;
    return `tv:${media.id}:s${media.season}:e${media.episode}`;
  }
  return `movie:${media.id}`;
}
function offlineMediaMatches(left, right) {
  const leftKey = offlineMediaKey(left), rightKey = offlineMediaKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}
function offlineEpisodeState(media, downloads, jobs) {
  const ready = downloads.find((download) => download.status === "ready" && offlineMediaMatches(download.media, media));
  if (ready) return { status: "ready", item: ready };
  const job = [...jobs].reverse().find((candidate) => offlineMediaMatches(candidate.media, media));
  return job ? { status: job.status, item: job } : { status: "available", item: null };
}
function offlineAvailability(item, downloads) {
  const matches = downloads.filter((download) => download.status === "ready" && download.media?.type === item.type && Number(download.media?.id) === Number(item.id));
  return { available: matches.length > 0, count: matches.length };
}

export { offlineAvailability as a, offlineEpisodeState as b, offlineMediaKey as o };
//# sourceMappingURL=offline.js-BReu0Ag4.js.map
