import { readFile, mkdir, writeFile, rename, mkdtemp, rm, readdir, stat, utimes, open } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { dirname, join, basename, relative, resolve, isAbsolute } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import { o as offlineMediaKey } from "../../../../chunks/offline.js";
import { promisify } from "node:util";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { PassThrough } from "node:stream";
const TMDB_IMAGE_ROOT = "https://image.tmdb.org/t/p";
function tmdbImage(path, size = "w500") {
  return path ? `${TMDB_IMAGE_ROOT}/${size}${path}` : null;
}
function mapTmdbRuntime(payload) {
  const minutes = Number(payload?.runtime);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
}
function mapTmdbTitles(payload, forcedType) {
  return (payload.results || []).flatMap((item) => {
    const type = forcedType || item.media_type;
    if (!["movie", "tv"].includes(type)) return [];
    return [{
      id: item.id,
      type,
      title: item.title || item.name,
      year: String(item.release_date || item.first_air_date || "").slice(0, 4),
      overview: item.overview || "",
      poster: tmdbImage(item.poster_path),
      ...item.backdrop_path ? { backdrop: tmdbImage(item.backdrop_path, "w1280") } : {}
    }];
  });
}
function mapTmdbTitleDetails(payload, forcedType) {
  const type = forcedType || (payload?.title ? "movie" : "tv");
  return {
    id: payload?.id,
    type,
    title: payload?.title || payload?.name || "",
    year: String(payload?.release_date || payload?.first_air_date || "").slice(0, 4),
    overview: payload?.overview || "",
    poster: tmdbImage(payload?.poster_path),
    backdrop: tmdbImage(payload?.backdrop_path, "w1280")
  };
}
function mapTmdbSeasons(payload) {
  return (payload.seasons || []).filter((item) => Number.isInteger(item.season_number) && item.season_number > 0).map((item) => ({ id: item.id, number: item.season_number, name: item.name || `Season ${item.season_number}`, episodeCount: item.episode_count || 0 })).sort((a, b) => a.number - b.number);
}
function mapTmdbEpisodes(payload) {
  return (payload.episodes || []).filter((item) => Number.isInteger(item.episode_number) && item.episode_number > 0).map((item) => ({
    id: item.id,
    number: item.episode_number,
    name: item.name || `Episode ${item.episode_number}`,
    airDate: item.air_date || "",
    overview: item.overview || "",
    runtime: item.runtime || 0,
    still: tmdbImage(item.still_path, "w300")
  })).sort((a, b) => a.number - b.number);
}
function episodeTag(media) {
  if (!media.season || !media.episode) return "";
  return `S${String(media.season).padStart(2, "0")}E${String(media.episode).padStart(2, "0")}`;
}
function titleVariants(title) {
  const original = String(title || "").trim();
  const normalized = titleTokens(original).join(" ");
  const alternate = normalized === "harry potter and the philosophers stone" ? "Harry Potter and the Sorcerer's Stone" : normalized === "harry potter and the sorcerers stone" ? "Harry Potter and the Philosopher's Stone" : "";
  return [...new Set([original, alternate].flatMap((value) => [
    value,
    value.replace(/['‘’`]/g, "").replace(/\s+/g, " ").trim()
  ]).filter(Boolean))];
}
function titleTokens(value) {
  return String(value || "").toLowerCase().replace(/['‘’`]/g, "").replace(/&/g, " and ").match(/[a-z0-9]+/g) || [];
}
function releaseTitleMatches(release, media) {
  const expectedTitles = [media?.title, ...media?.alternativeTitles || []].flatMap(titleVariants).map(titleTokens);
  if (!expectedTitles.length) return true;
  const seriesTitle = media?.type === "tv" ? String(release?.title || "").split(/\b(?:s\d{1,2}[ ._-]*e\d{1,3}|\d{1,2}x\d{1,3})\b/i)[0] : release?.title;
  const actual = titleTokens(seriesTitle);
  return expectedTitles.some((expected) => actual.some((_, start) => expected.every((token, offset) => actual[start + offset] === token)));
}
function releaseScore(release, media, preferences = {}) {
  const text = release.title.toLowerCase();
  let score = releaseAudioConfidence(release) * (preferences.playbackQuality === "quality" ? 5 : 20);
  const tag = episodeTag(media).toLowerCase();
  if (tag && text.includes(tag)) score += 120;
  else if (tag && text.includes(`${media.season}x${String(media.episode).padStart(2, "0")}`)) score += 100;
  if (media.type !== "tv" && media.year && text.includes(media.year)) score += 80;
  if (/2160p|4k|uhd/.test(text)) score += preferences.playbackQuality === "quality" ? 65 : 30;
  else if (/1080p/.test(text)) score += 40;
  else if (/720p/.test(text)) score += 25;
  if (/web[- .]?dl|bluray|blu[- .]?ray/.test(text)) score += 12;
  const dynamicRange = releaseDynamicRange(release);
  if (dynamicRange === "dolby-vision") score -= 50;
  else if (dynamicRange === "hdr") score -= 5;
  if (preferences.playbackQuality !== "quality") {
    if (/h[ .]?264|x264|avc/.test(text)) score += 15;
    if (/x265|hevc|h[ .]?265/.test(text)) score -= 45;
    if (/av1/.test(text)) score -= 30;
  }
  if (preferences.playbackQuality === "fast") {
    if (/\.mp4\b|web[- .]?dl.*h[ .]?264|x264/.test(text)) score += 60;
    if (/rar|7z|zip/.test(text)) score -= 80;
    if (/2160p|4k|uhd/.test(text)) score -= 35;
  }
  if (/cam|telesync|ts\b/.test(text)) score -= 100;
  return score;
}
function releaseAudioConfidence(release) {
  const text = ` ${String(release?.title || "").toLowerCase().replace(/[._-]+/g, " ")} `;
  if (/\b(?:eng|english)\b/.test(text)) return 3;
  if (/\bsubbed\b/.test(text)) return 0;
  if (/\bdual(?: audio)?\b/.test(text)) return 2;
  if (/\b(?:german|deutsch|french|truefrench|vff|vfq|italian|ita|spanish|castilian|latino|rus|russian|ukr|ukrainian|polish|pldub|dutch|nl|danish|swedish|norwegian|finnish|hindi|tamil|telugu|korean|japanese|jpn|chinese|mandarin|cantonese|turkish|arabic)\b/.test(text)) return 0;
  if (/\b(?:multi(?: audio)?|dubbed|dub)\b/.test(text)) return 2;
  return 1;
}
function englishAudioRelease(release) {
  if (/anime/i.test(String(release?.category || ""))) {
    const text = String(release?.title || "").toLowerCase().replace(/[._-]+/g, " ");
    return /\b(?:eng|english|dual(?: audio)?)\b/.test(text);
  }
  return releaseAudioConfidence(release) > 0;
}
function rankReleases(releases, media, preferences) {
  return releases.filter((release) => releaseTitleMatches(release, media)).filter(englishAudioRelease).sort((a, b) => releaseScore(b, media, preferences) - releaseScore(a, media, preferences));
}
function releaseReadiness(release) {
  const title = release.title.toLowerCase();
  if (/\.part\d+\.rar|\.rar\b|\.r\d\d\b|\.7z|\.zip\b/.test(title)) return { kind: "download", label: "Download first" };
  if (/\.mp4\b|\.m4v\b|\.mov\b|\.webm\b/.test(title) && !/hevc|x265|h[ .]?265|av1/.test(title) && releaseDynamicRange(release) === "sdr") return { kind: "direct", label: "Likely direct" };
  if (releaseDynamicRange(release) !== "sdr" || /\.mkv\b|hevc|x265|h[ .]?265|av1/.test(title)) return { kind: "convert", label: "Live conversion" };
  return { kind: "check", label: "Checking on start" };
}
function releaseDynamicRange(release) {
  const text = ` ${String(typeof release === "string" ? release : release?.title || "").toLowerCase().replace(/[._-]+/g, " ")} `;
  if (/\b(?:dv|dovi|dolby vision)\b/.test(text)) return "dolby-vision";
  if (/\b(?:hdr(?:10(?:\+|plus)?)?|hlg)\b/.test(text)) return "hdr";
  return "sdr";
}
function playbackStrategy(subject, releaseTitle = "") {
  const extension = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  const description = `${subject} ${releaseTitle}`.toLowerCase();
  if (releaseDynamicRange(description) !== "sdr") return "transcode";
  if (extension === "webm") return "transcode";
  if (["mp4", "m4v", "mov"].includes(extension) && !/hevc|h[ .]?265|x265|av1/.test(description)) return "remux";
  if (extension === "mkv" && /h[ .]?264|x264|avc/.test(description)) return "remux";
  return "transcode";
}
class DownloadCancelledError extends Error {
  constructor() {
    super("Download cancelled.");
    this.name = "DownloadCancelledError";
    this.code = "DOWNLOAD_CANCELLED";
  }
}
function handlers(job) {
  if (!job.cancelHandlers) Object.defineProperty(job, "cancelHandlers", { value: /* @__PURE__ */ new Set(), configurable: true });
  return job.cancelHandlers;
}
function onDownloadCancel(job, release) {
  if (job.cancelled) {
    release();
    return () => {
    };
  }
  handlers(job).add(release);
  return () => job.cancelHandlers?.delete(release);
}
function cancelDownloadJob(job) {
  if (!job || job.cancelled || ["ready", "error", "cancelled"].includes(job.status)) return false;
  job.cancelled = true;
  job.status = "cancelling";
  job.message = "Cancelling download…";
  for (const release of [...handlers(job)]) {
    try {
      release();
    } catch {
    }
  }
  job.cancelHandlers.clear();
  return true;
}
function throwIfDownloadCancelled(job) {
  if (job?.cancelled) throw new DownloadCancelledError();
}
function isDownloadCancelled(job, error) {
  return Boolean(job?.cancelled || error?.code === "DOWNLOAD_CANCELLED");
}
function releaseIdentity(release) {
  if (!release?.nzbUrl) return release?.title || "";
  const url = new URL(release.nzbUrl);
  url.searchParams.delete("apikey");
  url.searchParams.sort();
  return `upload:${createHash("sha256").update(url.href).digest("hex")}`;
}
function createReleaseHealthStore(path, { now = Date.now, ttl = 24 * 60 * 60 * 1e3, maximum = 1e3 } = {}) {
  let entries, loading, saving = Promise.resolve();
  const key = (settings, media, release) => createHash("sha256").update(JSON.stringify([
    settings.usenetHost,
    settings.usenetPort || 563,
    settings.usenetUser,
    Boolean(settings.repairVideoTimeline),
    media.type,
    media.id || media.title,
    media.season,
    media.episode,
    release
  ])).digest("hex");
  async function load() {
    loading ||= readFile(path, "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }).then((value) => {
      entries = new Map(value);
    });
    await loading;
  }
  const expiry = (value) => typeof value === "number" ? value : value?.expires || 0;
  const save = () => {
    saving = saving.catch(() => {
    }).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify([...entries]), { mode: 384 });
      await rename(`${path}.tmp`, path);
    });
    return saving;
  };
  return {
    async has(settings, media, release) {
      await load();
      return expiry(entries.get(key(settings, media, release))) > now();
    },
    async reject(settings, media, release) {
      await load();
      const id = key(settings, media, release);
      entries.delete(id);
      entries.set(id, { expires: now() + ttl, media: offlineMediaKey(media) });
      for (const [entry, value] of entries) if (expiry(value) <= now()) entries.delete(entry);
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
      await save();
    },
    async delete(media) {
      await load();
      const mediaKey2 = offlineMediaKey(media);
      for (const [entry, value] of entries) if (value?.media === mediaKey2) entries.delete(entry);
      await save();
    }
  };
}
const EMPTY_STATE = { version: 1, library: {}, progress: {} };
function mediaKey(media) {
  const base = `${media.type}:${media.id}`;
  return media.type === "tv" && media.season && media.episode ? `${base}:s${media.season}:e${media.episode}` : base;
}
function normalizedMedia(media) {
  const id = Number(media?.id), type = media?.type;
  if (!Number.isInteger(id) || id < 1 || !["movie", "tv"].includes(type) || !String(media?.title || "").trim()) throw new Error("A valid movie or show is required.");
  const normalized = { id, type, title: String(media.title).trim(), year: String(media.year || "").slice(0, 4), poster: String(media.poster || "") };
  if (type === "tv" && media.season && media.episode) Object.assign(normalized, { season: Number(media.season), episode: Number(media.episode), episodeTitle: String(media.episodeTitle || "") });
  const durationHint = Number(media.durationHint);
  if (Number.isFinite(durationHint) && durationHint > 0) normalized.durationHint = durationHint;
  return normalized;
}
function titleMetadata(media) {
  return Object.fromEntries(["title", "year", "poster"].flatMap((key) => media[key] ? [[key, media[key]]] : []));
}
function publicState(state) {
  const library = Object.values(state.library).sort((a, b) => b.addedAt - a.addedAt);
  const progress = Object.values(state.progress).sort((a, b) => b.updatedAt - a.updatedAt);
  const continueWatching = progress.filter((item) => !item.watched && item.position >= 5 && (!item.duration || item.duration - item.position > 30)).map((item) => ({ ...item.media, position: item.position, duration: item.duration, ...item.duration ? { progressPercent: Math.min(100, Math.max(0, item.position / item.duration * 100)) } : {} }));
  return { library, progress, continueWatching };
}
function updateProgressEntry(state, value, update, updatedAt) {
  const key = mediaKey(value);
  const current = state.progress[key] || { position: 0, duration: 0, watched: false };
  const duration = Math.max(0, Number(update.duration ?? current.duration) || 0);
  const watched = update.watched === void 0 ? current.watched : Boolean(update.watched);
  let position = update.reset ? 0 : Math.max(0, Number(update.position ?? current.position) || 0);
  if (duration) position = Math.min(position, duration);
  if (watched && duration) position = duration;
  state.progress[key] = { media: value, position, duration, watched, updatedAt };
}
function createMediaStateStore(path, { now = () => Date.now() } = {}) {
  let writes = Promise.resolve();
  async function load() {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      return { ...EMPTY_STATE, ...value, library: value.library || {}, progress: value.progress || {} };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }
  async function save(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.pending`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 384 });
    await rename(temporary, path);
  }
  function mutate(change) {
    writes = writes.catch(() => {
    }).then(async () => {
      const state = await load();
      change(state);
      await save(state);
      return publicState(state);
    });
    return writes;
  }
  return {
    async read() {
      await writes;
      return publicState(await load());
    },
    setLibrary(media, inLibrary) {
      const value = normalizedMedia(media), key = `${value.type}:${value.id}`;
      delete value.season;
      delete value.episode;
      delete value.episodeTitle;
      return mutate((state) => {
        if (inLibrary) state.library[key] = { ...value, addedAt: now() };
        else delete state.library[key];
      });
    },
    setProgress(media, update = {}) {
      const value = normalizedMedia(media);
      return mutate((state) => updateProgressEntry(state, value, update, now()));
    },
    setProgressMany(media, update = {}) {
      if (!Array.isArray(media) || !media.length) throw new Error("At least one episode is required.");
      const values = media.map(normalizedMedia);
      return mutate((state) => {
        for (const value of values) updateProgressEntry(state, value, update, now());
      });
    },
    enrichMediaMany(media) {
      if (!Array.isArray(media) || !media.length) throw new Error("At least one title is required.");
      const values = media.map(normalizedMedia);
      return mutate((state) => {
        for (const value of values) {
          const patch = titleMetadata(value), libraryKey = `${value.type}:${value.id}`;
          if (state.library[libraryKey]) state.library[libraryKey] = { ...state.library[libraryKey], ...patch };
          for (const entry of Object.values(state.progress)) {
            if (entry.media.type === value.type && entry.media.id === value.id) entry.media = { ...entry.media, ...patch };
          }
        }
      });
    }
  };
}
function stopConversion(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 1e3);
  forceStop.unref();
  child.once("exit", () => clearTimeout(forceStop));
}
function waitForDrain(stream) {
  return new Promise((resolve2, reject) => {
    const cleanup = () => {
      stream.off("drain", drained);
      stream.off("close", closed);
      stream.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve2();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new Error("Playback response closed."));
    if (stream.destroyed) {
      closed();
      return;
    }
    stream.once("drain", drained);
    stream.once("close", closed);
    stream.once("error", failed);
  });
}
function createConversionAdmission({ limit = 4, maxQueued = 16 } = {}) {
  let active = 0;
  const queue = [];
  function pump() {
    while (active < limit && queue.length) {
      const index = queue.findIndex((item2) => item2.foreground), item = queue.splice(index < 0 ? 0 : index, 1)[0];
      item.signal?.removeEventListener("abort", item.abort);
      active++;
      let released = false;
      item.resolve(() => {
        if (!released) {
          released = true;
          active--;
          pump();
        }
      });
    }
  }
  return {
    acquire({ foreground = true, signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (queue.length >= maxQueued) return Promise.reject(Object.assign(new Error("Playback conversion queue is full. Try again shortly."), { code: "PLAYBACK_BUSY" }));
      return new Promise((resolve2, reject) => {
        const item = { foreground, signal, resolve: resolve2, reject };
        item.abort = () => {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          reject(signal.reason);
        };
        signal?.addEventListener("abort", item.abort, { once: true });
        queue.push(item);
        pump();
      });
    },
    stats: () => ({ active, queued: queue.length, limit })
  };
}
const conversionAdmission = createConversionAdmission();
const execute$2 = promisify(execFile);
async function validateOpeningVideoDecode(path, signal) {
  const release = await conversionAdmission.acquire({ signal: AbortSignal.timeout(1e4) });
  try {
    const { stderr } = await execute$2("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-threads", "2", "-i", path, "-t", "20", "-map", "0:v:0", "-an", "-f", "null", "-"], { signal, timeout: 3e4, maxBuffer: 1024 * 1024 });
    if (stderr.trim()) throw Object.assign(new Error(stderr), { code: 1 });
  } catch (cause) {
    if (typeof cause.code !== "number") throw cause;
    throw Object.assign(new Error("This saved video contains damaged data in its opening frames. Trying another release.", { cause }), { code: "INVALID_MEDIA_DECODE" });
  } finally {
    release();
  }
}
const seconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
const timestamp = (value) => {
  const ms = Math.max(0, Math.round(value * 1e3));
  return `${String(Math.floor(ms / 36e5)).padStart(2, "0")}:${String(Math.floor(ms / 6e4) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1e3) % 60).padStart(2, "0")}.${String(ms % 1e3).padStart(3, "0")}`;
};
function captionsAtOffset(text, offset = 0) {
  if (!/^WEBVTT(?:\s|$)/.test(text.replace(/^\uFEFF/, ""))) throw new Error("Choose a WebVTT (.vtt) caption file.");
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const match = block.match(/((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/);
    if (!match) return [block];
    if (seconds(match[2]) <= offset) return [];
    return [block.replace(match[0], `${timestamp(seconds(match[1]) - offset)} --> ${timestamp(seconds(match[2]) - offset)}`)];
  }).join("\n\n");
}
const execute$1 = promisify(execFile);
const textCodecs = /* @__PURE__ */ new Set(["subrip", "ass", "ssa", "webvtt", "mov_text", "text"]);
function playbackTracks(streams = []) {
  return streams.filter((stream) => ["audio", "subtitle"].includes(stream.codec_type) && Number.isInteger(stream.index)).map((stream) => ({
    index: stream.index,
    type: stream.codec_type === "audio" ? "audio" : "captions",
    language: stream.tags?.language || "und",
    label: stream.tags?.title || stream.tags?.language || `${stream.codec_type === "audio" ? "Audio" : "Captions"} ${stream.index + 1}`,
    supported: stream.codec_type === "audio" || textCodecs.has(stream.codec_name)
  }));
}
async function extractCaptions(path, index, start = 0, signal) {
  const release = await conversionAdmission.acquire({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1e4)]) : AbortSignal.timeout(1e4) });
  try {
    const { stdout } = await execute$1("ffmpeg", ["-nostdin", "-v", "error", "-copyts", "-i", path, "-map", `0:${index}`, "-c:s", "webvtt", "-f", "webvtt", "pipe:1"], { signal, timeout: 3e4, maxBuffer: 16 * 1024 * 1024 });
    return captionsAtOffset(stdout, start);
  } finally {
    release();
  }
}
function hlsOutputArgs(mp4Args, directory, segmentSeconds = 4) {
  if (![2, 4].includes(segmentSeconds)) throw new Error("Playback segment duration must be two or four seconds.");
  const outputOptions = mp4Args.indexOf("-movflags");
  if (outputOptions < 0) throw new Error("Missing conversion output options.");
  return [
    ...mp4Args.slice(0, outputOptions),
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_list_size",
    "0",
    "-hls_playlist_type",
    "event",
    "-hls_flags",
    "temp_file",
    "-hls_segment_filename",
    join(directory, "segment-%06d.m4s"),
    join(directory, "index.m3u8")
  ];
}
function playlistCoversExpectedDuration(bytes, expectedDuration) {
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return false;
  const playlist = bytes.toString();
  if (!/^#EXT-X-ENDLIST\s*$/m.test(playlist)) return false;
  const durations = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].map((match) => Number(match[1])).filter(Number.isFinite);
  if (!durations.length) return false;
  const targetDuration = Number(playlist.match(/^#EXT-X-TARGETDURATION:([\d.]+)/m)?.[1]) || 0;
  const tolerance = Math.max(0.5, Math.min(targetDuration, 5));
  return durations.reduce((total, duration) => total + duration, 0) >= expectedDuration - tolerance;
}
let activeSessions = 0;
async function createHlsSession({ root, produce, idleMs = 18e4, onClose = () => {
}, maxSessions = 4, maxBytes = 8 * 1024 ** 3, checkMs = 5e3 }) {
  if (activeSessions >= maxSessions) throw Object.assign(new Error("All playback conversion slots are in use. Try again shortly."), { code: "PLAYBACK_BUSY" });
  activeSessions++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeSessions--;
    }
  };
  let directory;
  try {
    let touch = function() {
      if (closed) throw new Error("Playback session has closed.");
      clearTimeout(timer);
      timer = setTimeout(() => {
        void close().catch(() => {
        });
      }, idleMs);
      timer.unref();
    }, close = function() {
      if (closing) return closing;
      closed = true;
      clearTimeout(timer);
      clearInterval(monitor);
      closing = (async () => {
        try {
          await producer.stop();
        } finally {
          try {
            await rm(directory, { recursive: true, force: true });
          } finally {
            release();
            onClose();
          }
        }
      })();
      return closing;
    }, playbackState = function(state = {}) {
      if (typeof state.paused === "boolean") paused = state.paused;
      if (Number.isFinite(state.position) && state.position >= 0) position = state.position;
      const ahead = Math.max(0, (producer.position?.() || 0) - position);
      producer.setPaused?.(paused || ahead >= 90);
    };
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, "hls-"));
    let producer;
    try {
      producer = await produce(directory);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    let failure = null, completed = false, closed = false, closing, timer, monitor, bytes = 0, paused = false, position = 0, checking = false;
    void producer.completion.then(() => {
      completed = true;
    }, (error) => {
      failure = error;
    });
    async function read(asset) {
      if (!/^(index\.m3u8|init\.mp4|segment-\d{6,}\.m4s)$/.test(asset)) throw new Error("Invalid playback asset.");
      touch();
      const bytes2 = await readFile(join(directory, asset));
      if (asset !== "index.m3u8") return bytes2;
      if (failure && !playlistCoversExpectedDuration(bytes2, producer.expectedDuration)) throw failure;
      return completed || failure ? bytes2 : Buffer.from(bytes2.toString().replace(/^#EXT-X-ENDLIST\r?\n?/gm, ""));
    }
    async function ready({ progress = () => 0, maxWaitMs = 45e3 } = {}) {
      const started = Date.now(), limit = started + Math.max(45e3, maxWaitMs);
      let deadline = started + 45e3, previousProgress = progress();
      while (Date.now() < limit) {
        const currentProgress = progress();
        if (currentProgress > previousProgress) {
          previousProgress = currentProgress;
          deadline = Date.now() + 45e3;
        }
        if (Date.now() >= deadline) break;
        if (closed) throw new Error("Playback session has closed.");
        try {
          const playlist = await read("index.m3u8");
          if (playlist.includes("#EXTINF:")) return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (failure) throw failure;
        }
        await setTimeout$1(100);
      }
      throw Object.assign(new Error("Timed out preparing playback segments."), { code: "PLAYBACK_SEGMENT_TIMEOUT" });
    }
    async function checkResources() {
      if (checking || closed) return;
      checking = true;
      try {
        playbackState();
        const names = await readdir(directory);
        const sizes = await Promise.all(names.map((name) => stat(join(directory, name)).then((info) => info.size, () => 0)));
        bytes = sizes.reduce((total, size) => total + size, 0);
        if (bytes > maxBytes) {
          failure = Object.assign(new Error("Playback temporary storage limit reached. Resume with a new session."), { code: "PLAYBACK_STORAGE_LIMIT" });
          await close();
        }
      } catch (error) {
        if (!closed) failure = error;
      } finally {
        checking = false;
      }
    }
    monitor = setInterval(() => void checkResources(), checkMs);
    monitor.unref();
    touch();
    return {
      directory,
      ready,
      read,
      touch,
      close,
      playbackState,
      health: () => ({ failed: Boolean(failure), closed, completed, bytes, paused, interpolated: Boolean(producer.interpolated), position: producer.position?.() || 0 })
    };
  } catch (error) {
    release();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
const execute = promisify(execFile);
function createHlsPacing(readHelp = async () => (await execute("ffmpeg", ["-hide_banner", "-h", "full"], { maxBuffer: 4 * 1024 * 1024 })).stdout) {
  let options;
  return async (discardSeconds = 0) => {
    options ||= Promise.resolve().then(readHelp).then((help) => [
      "-readrate",
      "1.5",
      .../-readrate_initial_burst\b/.test(help) ? ["-readrate_initial_burst", "8"] : []
    ]).catch(() => ["-readrate", "1.5"]);
    const pacing = [...await options];
    const burst = pacing.indexOf("-readrate_initial_burst");
    if (burst >= 0 && Number.isFinite(discardSeconds) && discardSeconds > 0) {
      pacing[burst + 1] = String(discardSeconds + 8);
    }
    return pacing;
  };
}
const SAMPLE_TTL_MS = 10 * 60 * 1e3;
const MIN_SAMPLE_BYTES = 512 * 1024;
function createProviderSpeedMeter({ now = Date.now } = {}) {
  const samples = /* @__PURE__ */ new Map();
  const key = (settings) => JSON.stringify([settings.usenetHost, settings.usenetPort || 563, settings.usenetUser, settings.maxConnections || 4]);
  return {
    record(settings, bytes, elapsedMs) {
      if (!settings.usenetHost || bytes < MIN_SAMPLE_BYTES || elapsedMs < 100) return;
      const id = key(settings), previous = samples.get(id);
      const rate = bytes * 1e3 / elapsedMs;
      const inWindow = previous && now() - previous.windowStart < SAMPLE_TTL_MS;
      samples.set(id, { rate: inWindow ? Math.min(previous.rate, rate) : rate, at: now(), windowStart: inWindow ? previous.windowStart : now() });
    },
    rate(settings) {
      const sample = samples.get(key(settings));
      return sample && now() - sample.at < SAMPLE_TTL_MS ? sample.rate : null;
    }
  };
}
function candidateNeedsMoreSpeed(file, durationSeconds, bytesPerSecond, safetyFactor = 1.5) {
  const bytes = file?.segments?.reduce((total, segment) => total + Number(segment.decodedBytes || segment.bytes || 0), 0);
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return false;
  return bytes / durationSeconds * safetyFactor > bytesPerSecond;
}
function createPosterPreparation({ budgetMs = 2e4, ttlMs = 30 * 60 * 1e3, maximum = 4 } = {}) {
  const records = /* @__PURE__ */ new Map();
  function remove(key, record) {
    if (records.get(key) !== record) return;
    records.delete(key);
    clearTimeout(record.budget);
    clearTimeout(record.expiry);
    record.controller.abort(new Error("Poster preparation cancelled."));
  }
  function cancel() {
    for (const [key, record] of records) remove(key, record);
  }
  return {
    start(key, job, prepare, warm) {
      const existing = records.get(key);
      if (existing && !existing.controller.signal.aborted) return existing.job;
      const record = { key, job, controller: new AbortController(), claimed: false };
      records.set(key, record);
      record.budget = setTimeout(() => remove(key, record), budgetMs);
      record.budget.unref();
      record.expiry = setTimeout(() => remove(key, record), ttlMs);
      record.expiry.unref();
      record.completion = (async () => {
        try {
          await prepare(record.controller.signal);
          if (job.status === "ready" && !record.claimed && !record.controller.signal.aborted) {
            await warm(record.controller.signal, () => record.claimed);
          }
        } catch {
        } finally {
          clearTimeout(record.budget);
        }
      })();
      while (records.size > maximum) {
        const oldest = records.entries().next().value;
        if (!oldest) break;
        remove(...oldest);
      }
      return job;
    },
    take(key) {
      const record = records.get(key);
      if (!record || record.controller.signal.aborted || ["error", "cancelled"].includes(record.job.status)) {
        if (record) remove(key, record);
        return null;
      }
      records.delete(key);
      record.claimed = true;
      clearTimeout(record.budget);
      clearTimeout(record.expiry);
      return record.job;
    },
    delete(key) {
      const record = records.get(key);
      if (record) remove(key, record);
    },
    cancel
  };
}
function validatedPreparation(inspect) {
  let resolveMetadata, rejectMetadata;
  const metadata = new Promise((resolve2, reject) => {
    resolveMetadata = resolve2;
    rejectMetadata = reject;
  });
  const validated = Promise.resolve().then(() => inspect(resolveMetadata)).catch((error) => {
    rejectMetadata(error);
    throw error;
  });
  void metadata.catch(() => {
  });
  void validated.catch(() => {
  });
  return { metadata, validated };
}
function createValidatedPreparationCache() {
  const sources = /* @__PURE__ */ new WeakMap();
  return {
    get(source, scope, inspect, signal) {
      let variants = sources.get(source);
      if (!variants) {
        variants = /* @__PURE__ */ new Map();
        sources.set(source, variants);
      }
      if (variants.get(scope)?.signal?.aborted) variants.delete(scope);
      if (!variants.has(scope)) {
        const entry = { ...validatedPreparation(inspect), signal };
        variants.set(scope, entry);
        void entry.validated.catch(() => {
          if (variants.get(scope) === entry) variants.delete(scope);
        });
      }
      return variants.get(scope);
    },
    delete(source) {
      sources.delete(source);
    }
  };
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const playbackScope = (settings) => digest(JSON.stringify([
  2,
  settings.usenetHost,
  Number(settings.usenetPort || 563),
  settings.usenetUser,
  settings.usenetPass,
  settings.indexerUrl,
  settings.indexerKey,
  `${settings.manualReleaseSelection ? "manual:" : ""}${settings.playbackQuality || "balanced"}`,
  Number(settings.untaggedAudioTrack) || 2,
  Boolean(settings.repairVideoTimeline),
  Boolean(settings.frameInterpolation)
]));
const playbackRetention = (settings) => Math.min(168, Math.max(1, Number(settings.cacheRetentionHours) || 24)) * 36e5;
const sourceIds = /* @__PURE__ */ new WeakMap();
function playbackSourceKey(file, settings) {
  const scope = playbackScope(settings);
  let entry = sourceIds.get(file);
  if (!entry || entry.scope !== scope) {
    entry = { scope, id: digest(JSON.stringify([scope, file.subject, file.segments.map((s) => [s.id, s.decodedBytes])])) };
    sourceIds.set(file, entry);
  }
  return entry.id;
}
const scopedPlaybackSourceKey = (file, scope) => digest(JSON.stringify([scope, file.subject, file.segments.map((s) => [s.id, s.decodedBytes])]));
function createPlaybackPersistence(root, { maximumBytes = 512 * 1024 * 1024, maximumRecords = 100, now = Date.now } = {}) {
  const recordsPath = join(root, "records.json"), bytesRoot = join(root, "articles");
  let records, initialized, bytesInitialized, recordWrites = Promise.resolve(), byteWrites = Promise.resolve(), queuedBytes = 0, size = 0;
  const articles = /* @__PURE__ */ new Map(), pending = /* @__PURE__ */ new Map();
  const initialize = () => initialized ||= (async () => {
    const data = await readFile(recordsPath, "utf8").then(JSON.parse).catch(() => ({}));
    records = new Map(data.version === 1 && Array.isArray(data.records) ? data.records : []);
    for (const [key, entry] of records) if (!entry?.expires || entry.expires <= now()) records.delete(key);
    while (records.size > maximumRecords) records.delete(records.keys().next().value);
  })();
  const flush = () => {
    recordWrites = recordWrites.catch(() => {
    }).then(async () => {
      await mkdir(root, { recursive: true });
      const temporary = `${recordsPath}.${randomUUID()}.pending`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, records: [...records] }), { mode: 384 });
        await rename(temporary, recordsPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => {
        });
      }
    });
    return recordWrites;
  };
  async function getRecord(key, ttl) {
    await initialize();
    const entry = records.get(key);
    if (!entry || entry.expires <= now() || entry.created + ttl <= now()) return null;
    records.delete(key);
    records.set(key, entry);
    return structuredClone(entry.value);
  }
  async function setRecord(key, value, ttl) {
    await initialize();
    records.delete(key);
    records.set(key, { value, created: now(), expires: now() + ttl });
    while (records.size > maximumRecords) records.delete(records.keys().next().value);
    await flush();
  }
  async function removeArticle(key) {
    const entry = articles.get(key);
    if (!entry) return;
    articles.delete(key);
    size -= entry.size;
    await rm(join(bytesRoot, key), { force: true });
  }
  async function trim(ttl) {
    for (const [key, entry] of articles) if (entry.at + ttl <= now()) await removeArticle(key);
    while (size > maximumBytes) {
      const oldest = [...articles].reduce((a, b) => a[1].at <= b[1].at ? a : b);
      await removeArticle(oldest[0]);
    }
  }
  const initializeBytes = () => bytesInitialized ||= (async () => {
    await mkdir(bytesRoot, { recursive: true });
    for (const name of await readdir(bytesRoot)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const info = await stat(join(bytesRoot, name)).catch(() => null);
      if (info?.isFile()) {
        articles.set(name, { size: info.size, at: info.mtimeMs });
        size += info.size;
      }
    }
    await trim(168 * 36e5);
  })();
  const articleKey = (file, index, settings) => digest(`${playbackSourceKey(file, settings)}:${index}`);
  return {
    getPlan: (media, settings) => getRecord(`plan:${offlineMediaKey(media)}:${playbackScope(settings)}`, playbackRetention(settings)),
    setPlan(media, settings, plan) {
      const { file, release, releaseKey, strategy } = plan;
      return setRecord(`plan:${offlineMediaKey(media)}:${playbackScope(settings)}`, { file, release, ...releaseKey ? { releaseKey } : {}, strategy }, playbackRetention(settings));
    },
    async deletePlan(media) {
      await initialize();
      const prefix = `plan:${offlineMediaKey(media)}:`;
      for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
      await flush();
    },
    async deleteMedia(media) {
      await initialize();
      await initializeBytes();
      await byteWrites.catch(() => {
      });
      const prefix = `plan:${offlineMediaKey(media)}:`;
      const sources = [];
      for (const [key, entry] of [...records]) {
        if (!key.startsWith(prefix)) continue;
        const file = entry?.value?.file;
        if (file?.segments?.length) sources.push({ file, id: scopedPlaybackSourceKey(file, key.slice(prefix.length)) });
        records.delete(key);
      }
      for (const source of sources) {
        records.delete(`probe:${source.id}`);
        for (let index = 0; index < source.file.segments.length; index++) await removeArticle(digest(`${source.id}:${index}`));
      }
      await flush();
      return { sources: sources.length };
    },
    getProbe: (file, settings) => getRecord(`probe:${playbackSourceKey(file, settings)}`, playbackRetention(settings)),
    setProbe: (file, settings, metadata) => setRecord(`probe:${playbackSourceKey(file, settings)}`, metadata, playbackRetention(settings)),
    async getSegment(file, index, settings) {
      const key = articleKey(file, index, settings);
      await initializeBytes();
      await pending.get(key);
      const entry = articles.get(key);
      if (!entry || entry.at + playbackRetention(settings) <= now()) return null;
      try {
        const data = await readFile(join(bytesRoot, key)), bytes = data.subarray(32);
        if (bytes.length !== file.segments[index].decodedBytes || !createHash("sha256").update(bytes).digest().equals(data.subarray(0, 32))) return null;
        entry.at = now();
        void utimes(join(bytesRoot, key), new Date(entry.at), new Date(entry.at)).catch(() => {
        });
        return bytes;
      } catch {
        return null;
      }
    },
    setSegment(file, index, settings, bytes) {
      if (bytes.length !== file.segments[index].decodedBytes || bytes.length + 32 > maximumBytes || queuedBytes + bytes.length > 16 * 1024 * 1024) return;
      const key = articleKey(file, index, settings);
      if (pending.has(key)) return;
      queuedBytes += bytes.length;
      const write = byteWrites.catch(() => {
      }).then(async () => {
        await initializeBytes();
        const temporary = join(bytesRoot, `${key}.${randomUUID()}.pending`);
        try {
          const data = Buffer.concat([createHash("sha256").update(bytes).digest(), bytes]);
          await writeFile(temporary, data, { mode: 384 });
          await rename(temporary, join(bytesRoot, key));
          size -= articles.get(key)?.size || 0;
          articles.set(key, { size: data.length, at: now() });
          size += data.length;
          await trim(playbackRetention(settings));
        } finally {
          await rm(temporary, { force: true }).catch(() => {
          });
        }
      }).finally(() => {
        pending.delete(key);
        queuedBytes -= bytes.length;
      });
      byteWrites = write;
      pending.set(key, write.catch(() => {
      }));
      void write.catch(() => {
      });
    },
    async flush() {
      await recordWrites;
      await byteWrites;
    },
    async prune(settings) {
      await initializeBytes();
      await byteWrites.catch(() => {
      });
      await trim(playbackRetention(settings));
    }
  };
}
function concurrencyLimit(width) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= width) await new Promise((resolve2) => waiting.push(resolve2));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
const listeners = /* @__PURE__ */ new WeakMap();
function notifyPlayback(job) {
  job.revision = (job.revision || 0) + 1;
  for (const listener of listeners.get(job) || []) listener();
}
function waitForPlayback(job, revision, { signal, timeout = 15e3 } = {}) {
  if (["ready", "error", "cancelled"].includes(job.status) || (job.revision || 0) !== revision || signal?.aborted) return Promise.resolve();
  return new Promise((resolve2) => {
    if (!listeners.has(job)) listeners.set(job, /* @__PURE__ */ new Set());
    const done = () => {
      clearTimeout(timer);
      listeners.get(job).delete(done);
      signal?.removeEventListener("abort", done);
      resolve2();
    };
    const timer = setTimeout(done, timeout);
    listeners.get(job).add(done);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}
function createNntpPool(connect, { acquire = async () => () => {
}, idleMs = 5e3 } = {}) {
  const accounts = /* @__PURE__ */ new Map();
  const key = (settings) => createHash("sha256").update(JSON.stringify([
    settings.usenetHost,
    Number(settings.usenetPort || 563),
    settings.usenetUser,
    settings.usenetPass
  ])).digest("hex");
  const usable = (client2) => !client2.error && !client2.socket?.destroyed;
  function discard(account, entry) {
    clearTimeout(entry.timer);
    if (!account.entries.delete(entry)) return;
    entry.client?.close();
    for (const wake of account.waiters) wake();
  }
  async function borrow(settings, signal) {
    const id = key(settings);
    for (const [other, account2] of accounts) if (other !== id) {
      for (const entry of account2.entries) if (!entry.busy) discard(account2, entry);
      if (!account2.entries.size) accounts.delete(other);
    }
    if (!accounts.has(id)) accounts.set(id, { entries: /* @__PURE__ */ new Set(), waiters: /* @__PURE__ */ new Set() });
    const account = accounts.get(id);
    while (true) {
      signal.throwIfAborted();
      for (const entry of account.entries) {
        if (entry.busy) continue;
        if (!usable(entry.client)) {
          discard(account, entry);
          continue;
        }
        clearTimeout(entry.timer);
        entry.busy = true;
        entry.client.socket?.ref?.();
        return { account, entry };
      }
      if (account.entries.size < Math.max(1, Number(settings.maxConnections) || 4)) {
        const entry = { busy: true };
        account.entries.add(entry);
        try {
          entry.client = await connect({ ...settings, signal });
          signal.throwIfAborted();
          return { account, entry };
        } catch (error) {
          discard(account, entry);
          throw error;
        }
      }
      await new Promise((resolve2, reject) => {
        const done = () => {
          account.waiters.delete(done);
          signal.removeEventListener("abort", abort);
          resolve2();
        };
        const abort = () => {
          done();
          reject(signal.reason);
        };
        account.waiters.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  function client(settings, idleTimeout = settings.downloadNextEpisode ? 1e3 : idleMs) {
    const controller = new AbortController();
    const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
    let active = null, previous;
    const operation = async (method, ...args) => {
      signal.throwIfAborted();
      const release = await acquire({ ...settings, signal });
      let lease, successful = false;
      const abort = () => active?.socket?.destroy();
      signal.addEventListener("abort", abort, { once: true });
      try {
        lease = await borrow(settings, signal);
        active = lease.entry.client;
        lease.entry.generation = (lease.entry.generation || 0) + 1;
        previous = { ...lease, generation: lease.entry.generation };
        signal.throwIfAborted();
        const result = method === "ready" ? void 0 : await active[method](...args);
        signal.throwIfAborted();
        successful = true;
        return result;
      } finally {
        signal.removeEventListener("abort", abort);
        active = null;
        if (lease) {
          const { account, entry } = lease;
          if (!successful || !usable(entry.client)) discard(account, entry);
          else {
            entry.busy = false;
            entry.client.socket?.unref?.();
            entry.timer = setTimeout(() => discard(account, entry), idleTimeout);
            entry.timer.unref();
            for (const wake of account.waiters) wake();
          }
        }
        release();
      }
    };
    return { ready: () => operation("ready"), body: (...args) => operation("body", ...args), has: (...args) => operation("has", ...args), discard() {
      if (active) active.socket?.destroy();
      else if (previous && !previous.entry.busy && previous.entry.generation === previous.generation) discard(previous.account, previous.entry);
    }, close() {
      controller.abort(new Error("Provider reader closed."));
    } };
  }
  return { client, async warm(settings) {
    const reader = client(settings, idleMs);
    try {
      await reader.ready();
    } finally {
      reader.close();
    }
  }, clearIdle() {
    for (const account of accounts.values()) for (const entry of account.entries) if (!entry.busy) discard(account, entry);
  } };
}
function createSegmentCache(maximumBytes = 64 * 1024 * 1024) {
  const sources = /* @__PURE__ */ new WeakMap(), inflight = /* @__PURE__ */ new WeakMap(), entries = /* @__PURE__ */ new Map();
  let size = 0;
  function remove(entry) {
    entries.delete(entry);
    entry.owner.delete(entry.index);
    size -= entry.bytes.length;
  }
  const cache = {
    get(source, index) {
      const entry = sources.get(source)?.get(index);
      if (!entry) return;
      entries.delete(entry);
      entries.set(entry, true);
      return entry.bytes;
    },
    load(source, index, produce) {
      const bytes = cache.get(source, index);
      if (bytes) return Promise.resolve(bytes);
      let pending = inflight.get(source);
      if (!pending) {
        pending = /* @__PURE__ */ new Map();
        inflight.set(source, pending);
      }
      if (pending.has(index)) return pending.get(index);
      const request = Promise.resolve().then(produce).then((bytes2) => {
        cache.set(source, index, bytes2);
        return bytes2;
      });
      pending.set(index, request);
      void request.finally(() => pending.delete(index)).catch(() => {
      });
      return request;
    },
    set(source, index, bytes) {
      let owner = sources.get(source);
      if (!owner) {
        owner = /* @__PURE__ */ new Map();
        sources.set(source, owner);
      }
      if (owner.has(index)) remove(owner.get(index));
      if (bytes.length > maximumBytes) return;
      const entry = { owner, index, bytes };
      owner.set(index, entry);
      entries.set(entry, true);
      size += bytes.length;
      while (size > maximumBytes) remove(entries.keys().next().value);
    },
    delete(source) {
      const owner = sources.get(source);
      if (!owner) return;
      for (const entry of [...owner.values()]) remove(entry);
      sources.delete(source);
      inflight.delete(source);
    }
  };
  return cache;
}
async function* prefetchReleaseDescriptions(releases, load, width = 3) {
  const controller = new AbortController();
  const count = Math.max(1, Math.min(releases.length, width));
  const start = (index) => Promise.resolve().then(() => load(releases[index], controller.signal)).then((value) => ({ value }), (error) => ({ error }));
  const pending = Array.from({ length: Math.min(count, releases.length) }, (_, index) => start(index));
  try {
    for (let index = 0; index < releases.length; index++) {
      yield { index, ...await pending.shift() };
      if (index + count < releases.length) pending.push(start(index + count));
    }
  } finally {
    controller.abort();
  }
}
function createTransferCoordinator({ now = Date.now, wait } = {}) {
  const waiting = /* @__PURE__ */ new Set();
  const wake = () => {
    for (const resolve2 of waiting) resolve2();
  };
  const waitForChange = (signal) => wait ? wait() : new Promise((resolve2) => {
    const done = () => {
      clearTimeout(timer);
      waiting.delete(done);
      signal?.removeEventListener("abort", done);
      resolve2();
    };
    const timer = setTimeout(done, 100);
    waiting.add(done);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
  const accounts = /* @__PURE__ */ new Map(), reports = /* @__PURE__ */ new Map();
  let backgroundActive = false, interruptBackground, suspended = false;
  const key = (settings) => JSON.stringify([settings.usenetHost, settings.usenetPort || 563, settings.usenetUser]);
  function report(id, sample) {
    for (const [key2, value] of reports) if (now() - value.at > 6e4) reports.delete(key2);
    reports.set(id, { at: now(), safe: sample.playing === true && sample.seeking !== true && sample.readyState >= 3 && sample.bufferedAhead >= 30 });
    if (!reports.get(id).safe) interruptBackground?.();
    wake();
  }
  function safe(id) {
    const current = reports.get(id);
    if (!current?.safe || now() - current.at > 1e4) return false;
    for (const sample of reports.values()) if (now() - sample.at <= 1e4 && !sample.safe) return false;
    return true;
  }
  async function acquire(settings, job, interrupt) {
    const id = key(settings);
    if (!accounts.has(id)) accounts.set(id, { active: 0, foregroundWaiting: 0 });
    const account = accounts.get(id), background = Boolean(job), previousMessage = job?.message;
    let pausedMessage;
    if (!background) {
      account.foregroundWaiting++;
      interruptBackground?.();
    }
    try {
      while (true) {
        throwIfDownloadCancelled(job);
        settings.signal?.throwIfAborted();
        const room = account.active < Math.max(1, Number(settings.maxConnections) || 4);
        const viewers = [...reports.values()].filter((sample) => now() - sample.at <= 1e4);
        const downloadSafe = !suspended && (viewers.length ? viewers.every((sample) => sample.safe) : account.active === 0);
        if (background ? room && !backgroundActive && !account.foregroundWaiting && downloadSafe : room && !backgroundActive) break;
        if (background) {
          pausedMessage = suspended ? "Paused background download · automatic downloads are disabled." : "Paused background download · current playback has priority.";
          job.message = pausedMessage;
        }
        await waitForChange(settings.signal);
      }
      account.active++;
      if (background && pausedMessage && job.message === pausedMessage) job.message = previousMessage;
      if (background) {
        backgroundActive = true;
        interruptBackground = interrupt;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        account.active--;
        if (background) {
          backgroundActive = false;
          interruptBackground = null;
        }
        wake();
      };
    } finally {
      if (!background) account.foregroundWaiting--;
    }
  }
  return { acquire, report, forget(id) {
    reports.delete(id);
    wake();
  }, pause() {
    suspended = true;
    reports.clear();
    interruptBackground?.();
    wake();
  }, resume() {
    suspended = false;
    wake();
  }, safe };
}
function createBackgroundNntpClient(settings, transfers2, connect) {
  let closed = false, active;
  const operation = async (method, ...args) => {
    while (true) {
      throwIfDownloadCancelled(settings.backgroundJob);
      if (closed) throw new Error("Background connection closed.");
      let interrupted = false;
      const release = await transfers2.acquire(settings, settings.backgroundJob, () => {
        interrupted = true;
        active?.socket.destroy();
      });
      try {
        throwIfDownloadCancelled(settings.backgroundJob);
        active = await connect(settings);
        if (interrupted) continue;
        if (method === "body") {
          const lines = [];
          await active.body(args[0], (line) => lines.push(line));
          if (interrupted) continue;
          for (const line of lines) await args[1](line);
          return;
        }
        const result = await active[method](...args);
        if (!interrupted) return result;
      } catch (error) {
        if (!interrupted) throw error;
      } finally {
        if (active && !active.socket.closed) {
          const ended = once(active.socket, "close").catch(() => {
          });
          active.close();
          await ended;
        }
        active = null;
        release();
      }
    }
  };
  return { body: (...args) => operation("body", ...args), has: (...args) => operation("has", ...args), close() {
    closed = true;
    active?.close();
  } };
}
async function assembleVolume(volume, signal) {
  const pending = `${volume.path}.assembling`;
  try {
    async function* parts() {
      for (let index = 0; index < volume.posted.segments.length; index++) {
        signal.throwIfAborted();
        yield* createReadStream(join(volume.parts, String(index).padStart(6, "0")));
      }
    }
    await pipeline(parts(), createWriteStream(pending), { signal });
    signal.throwIfAborted();
    await rename(pending, volume.path);
    await rm(volume.parts, { recursive: true, force: true });
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}
async function downloadPostedFiles(files, settings, job, state, {
  connect,
  decode,
  progress = () => {
  },
  assemble = assembleVolume,
  workerLimit = 12
}) {
  const controller = new AbortController();
  const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
  const clients = /* @__PURE__ */ new Set();
  let failure, assembly = Promise.resolve(), next = 0;
  const queue = [], destinations = /* @__PURE__ */ new Set();
  function stop(error) {
    failure ||= error;
    controller.abort(error);
    for (const client of clients) client.close();
  }
  const removeCancel = onDownloadCancel(job, () => stop(new DownloadCancelledError()));
  function scheduleAssembly(volume) {
    assembly = assembly.then(async () => {
      signal.throwIfAborted();
      await assemble(volume, signal);
    }).catch(stop);
  }
  try {
    for (const file of files) {
      throwIfDownloadCancelled(job);
      signal.throwIfAborted();
      if (destinations.has(file.path)) continue;
      destinations.add(file.path);
      try {
        const existing = await stat(file.path);
        state.bytes += existing.size;
        state.completed += file.posted.segments.length;
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const volume = { ...file, parts: `${file.path}.parts`, remaining: 0 };
      await mkdir(volume.parts, { recursive: true });
      const saved = new Set(await readdir(volume.parts));
      for (let index = 0; index < file.posted.segments.length; index++) {
        const name = String(index).padStart(6, "0"), part = join(volume.parts, name);
        if (saved.has(name)) {
          state.bytes += (await stat(part)).size;
          state.completed++;
        } else {
          volume.remaining++;
          queue.push({ volume, part, segment: file.posted.segments[index] });
        }
      }
      if (!volume.remaining) scheduleAssembly(volume);
    }
    progress();
    const width = Math.min(settings.backgroundJob ? 1 : Math.max(1, Number(settings.maxConnections) || 4), workerLimit, queue.length);
    await Promise.all(Array.from({ length: width }, async () => {
      let client;
      try {
        signal.throwIfAborted();
        client = await connect({ ...settings, signal });
        clients.add(client);
        signal.throwIfAborted();
        while (next < queue.length) {
          signal.throwIfAborted();
          const item = queue[next++], pending = `${item.part}.pending`;
          let writer, bytes = 0, chunks = [], buffered = 0;
          try {
            writer = await open(pending, "w");
            const flush = async () => {
              if (!buffered) return;
              const block = Buffer.concat(chunks, buffered);
              chunks = [];
              buffered = 0;
              let offset = 0;
              while (offset < block.length) {
                signal.throwIfAborted();
                const { bytesWritten } = await writer.write(block, offset, block.length - offset);
                if (!bytesWritten) throw new Error("Unable to write downloaded article.");
                offset += bytesWritten;
              }
            };
            await client.body(item.segment.id, async (line) => {
              signal.throwIfAborted();
              if (line.startsWith("=y")) return;
              const chunk = decode(line);
              chunks.push(chunk);
              buffered += chunk.length;
              bytes += chunk.length;
              if (buffered >= 64 * 1024) await flush();
            });
            await flush();
            await writer.close();
            writer = null;
            signal.throwIfAborted();
            await rename(pending, item.part);
            state.bytes += bytes;
            state.completed++;
            progress();
            if (--item.volume.remaining === 0) scheduleAssembly(item.volume);
          } catch (error) {
            await writer?.close();
            await rm(pending, { force: true });
            throw error;
          }
        }
      } catch (error) {
        stop(error);
      } finally {
        if (client) {
          clients.delete(client);
          client.close();
        }
      }
    }));
    await assembly;
    throwIfDownloadCancelled(job);
    if (failure) throw failure;
    signal.throwIfAborted();
  } catch (error) {
    stop(error);
    await assembly;
    throw error;
  } finally {
    removeCancel();
  }
}
function createArchiveResumeCache({ ttl = 0, maximum = Infinity, maximumBytes = Infinity, now = Date.now } = {}) {
  const entries = /* @__PURE__ */ new Map();
  const key = (media, scope) => `${offlineMediaKey(media)}:${scope}`;
  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    clearTimeout(entry.timer);
    entry.lease.close();
  }
  function touch(id, entry) {
    clearTimeout(entry.timer);
    entry.expires = ttl > 0 ? now() + ttl : Infinity;
    if (ttl > 0) {
      entry.timer = setTimeout(() => {
        if (entry.plan.archiveSource.consumers > 0 && !entry.plan.archiveSource.closed && !entry.plan.archiveSource.failure) touch(id, entry);
        else remove(id);
      }, ttl);
      entry.timer.unref();
    }
    entries.delete(id);
    entries.set(id, entry);
  }
  return {
    get(media, scope) {
      const id = key(media, scope), entry = entries.get(id);
      if (!entry) return;
      if (ttl > 0 && entry.expires <= now() && !(entry.plan.archiveSource.consumers > 0) || entry.plan.archiveSource.closed || entry.plan.archiveSource.failure) {
        remove(id);
        return;
      }
      touch(id, entry);
      return entry.plan;
    },
    set(media, scope, plan) {
      const source = plan.archiveSource, bytes = source?.metadata?.size;
      if (!source || source.closed || source.failure || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximumBytes) return;
      const id = key(media, scope);
      const lease = source.hold ? source.hold() : source.retain();
      remove(id);
      const entry = { plan, bytes, lease };
      touch(id, entry);
      while (entries.size > maximum || [...entries.values()].reduce((sum, e) => sum + e.bytes, 0) > maximumBytes) remove(entries.keys().next().value);
    },
    delete(media) {
      const prefix = `${offlineMediaKey(media)}:`;
      for (const id of [...entries.keys()]) if (id.startsWith(prefix)) remove(id);
    },
    clear() {
      for (const id of entries.keys()) remove(id);
    }
  };
}
function matroskaSeekHeadPatches(header) {
  function vint2(offset, id = false) {
    const first = header[offset];
    if (!first) return null;
    let width = 1;
    while (width <= 8 && !(first & 1 << 8 - width)) width++;
    if (width > (id ? 4 : 8) || offset + width > header.length) return null;
    let value = BigInt(id ? first : first & (1 << 8 - width) - 1);
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(header[offset + i]);
    return { width, value };
  }
  function element(offset) {
    const id = vint2(offset, true);
    if (!id) return null;
    const size = vint2(offset + id.width);
    if (!size) return null;
    return { id: Number(id.value), data: offset + id.width + size.width, size: Number(size.value) };
  }
  const ebml = element(0);
  if (!ebml || ebml.id !== 440786851) return [];
  const segment = element(ebml.data + ebml.size);
  if (!segment || segment.id !== 408125543) return [];
  const patches = [];
  for (let offset = segment.data; offset < header.length; ) {
    const child = element(offset);
    if (!child || child.id === 524531317 || !Number.isSafeInteger(child.size)) break;
    const end = child.data + child.size;
    if (end > header.length || end <= offset) break;
    if (child.id === 290298740) {
      const length = end - offset;
      let width = 1;
      while (length - 1 - width >= 2 ** (7 * width) - 1) width++;
      let size = length - 1 - width;
      const bytes = Buffer.alloc(length);
      bytes[0] = 236;
      for (let i = width; i > 0; i--) {
        bytes[i] = size % 256;
        size = Math.floor(size / 256);
      }
      bytes[1] |= 1 << 8 - width;
      patches.push({ offset, bytes });
    }
    offset = end;
  }
  return patches;
}
function archiveByteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end, partial: true } : null;
}
async function createProgressiveArchiveSource(input, {
  root,
  helper = join(process.cwd(), "scripts", "progressive-archive.py"),
  startupTimeoutMs = 3e4,
  idleMs = 3e4,
  archiveReadBytes = 16 * 1024 * 1024,
  onProgress = () => {
  }
}) {
  if (!Number.isSafeInteger(archiveReadBytes) || archiveReadBytes < 64 * 1024 || archiveReadBytes > 64 * 1024 * 1024) throw new Error("Invalid archive read window");
  const directory = await mkdtemp(join(root, "playback-progressive-"));
  const output = join(directory, "video");
  const token = randomUUID(), changes = new EventEmitter();
  let child, metadata, available = 0, complete = false, failure, closed = false, closing, idle, refs = 0, holds = 0, suspended = false;
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve2, reject) => {
    readyResolve = resolve2;
    readyReject = reject;
  });
  const completion = new Promise((resolve2, reject) => {
    doneResolve = resolve2;
    doneReject = reject;
  });
  void ready.catch(() => {
  });
  void completion.catch(() => {
  });
  function fail(error) {
    failure ||= error;
    readyReject(failure);
    doneReject(failure);
    changes.emit("change");
  }
  const wait = (signal) => new Promise((resolve2) => {
    const done = () => {
      changes.off("change", done);
      signal.removeEventListener("abort", done);
      resolve2();
    };
    changes.once("change", done);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted || failure || closed) done();
  });
  let seekPatches;
  function suspend() {
    if (suspended || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGSTOP");
    suspended = true;
  }
  function resume() {
    if (!suspended || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGCONT");
    suspended = false;
  }
  const forwardPatches = () => seekPatches ||= (async () => {
    const file = await open(output, "r");
    try {
      const header = Buffer.alloc(Math.min(available, 65536));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return matroskaSeekHeadPatches(header.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  })();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      controller.abort();
      changes.emit("change");
    });
    void (async () => {
      const archive = req.url === `/${token}/archive`, forwardSeek = req.url === `/${token}/video/forward-seek`, video = req.url === `/${token}/video` || forwardSeek;
      if (!archive && !video || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404);
        return res.end();
      }
      if (closed || failure) throw failure || new Error("Archive source closed");
      const size = archive ? input.size : metadata?.size;
      if (!size) {
        res.writeHead(503);
        return res.end();
      }
      const range = archiveByteRange(req.headers.range, size);
      if (!range) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      const { start, end, partial } = range;
      res.writeHead(partial ? 206 : 200, { "content-length": end - start + 1, "accept-ranges": "bytes", "content-type": "application/octet-stream", ...partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {} });
      if (req.method === "HEAD") return res.end();
      if (archive) {
        for (let offset = start; offset <= end && !controller.signal.aborted; offset += archiveReadBytes) {
          const stop = Math.min(end, offset + archiveReadBytes - 1);
          const bytes = await input.read(offset, stop, controller.signal);
          if (bytes.length !== stop - offset + 1) throw new Error("Incomplete archive range");
          if (!res.write(bytes)) await waitForDrain(res);
        }
      } else {
        let file;
        try {
          const patches = forwardSeek ? await forwardPatches() : [];
          let offset = start;
          while (offset <= end && !controller.signal.aborted) {
            if (failure || closed) throw failure || new Error("Archive source closed");
            if (offset >= available) {
              if (complete) throw new Error("Extracted video ended unexpectedly");
              await wait(controller.signal);
              continue;
            }
            file ||= await open(output, "r");
            const count = Math.min(256 * 1024, available - offset, end - offset + 1);
            const buffer = Buffer.allocUnsafe(count);
            const { bytesRead } = await file.read(buffer, 0, count, offset);
            if (!bytesRead) throw new Error("Extracted video could not be read");
            for (const patch of patches) {
              const from = Math.max(offset, patch.offset), to = Math.min(offset + bytesRead, patch.offset + patch.bytes.length);
              if (to > from) patch.bytes.copy(buffer, from - offset, from - patch.offset, to - patch.offset);
            }
            offset += bytesRead;
            if (!res.write(buffer.subarray(0, bytesRead))) await waitForDrain(res);
          }
        } finally {
          await file?.close();
        }
      }
      if (!controller.signal.aborted) res.end();
    })().catch((error) => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500);
        res.end();
      }
    });
  });
  let timeout;
  async function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(idle);
    clearTimeout(timeout);
    fail(new Error("Archive source closed"));
    closing = (async () => {
      const ended = child?.pid && child.exitCode === null && child.signalCode === null ? once(child, "close").catch(() => {
      }) : Promise.resolve();
      resume();
      child?.kill("SIGTERM");
      const force = setTimeout(() => child?.kill("SIGKILL"), 2e3);
      force.unref();
      server.closeAllConnections();
      await Promise.all([ended, input.close(), new Promise((resolve2) => server.close(resolve2))]);
      clearTimeout(force);
      await rm(directory, { recursive: true, force: true });
    })();
    return closing;
  }
  function expire(ttl = idleMs) {
    clearTimeout(idle);
    idle = setTimeout(() => void close().catch(() => {
    }), ttl);
    idle.unref();
  }
  try {
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve2);
    });
    const base = `http://127.0.0.1:${server.address().port}/${token}`;
    child = spawn("python3", [helper, `${base}/archive`, output, String(input.size), String(archiveReadBytes)], { stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-1e3);
    });
    child.on("error", fail);
    child.stdout.on("data", (data) => {
      pending += data;
      if (pending.length > 65536) {
        fail(new Error("Invalid archive helper output"));
        child.kill();
        return;
      }
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "metadata") {
            if (!Number.isSafeInteger(event.size) || event.size <= 0 || typeof event.name !== "string") throw new Error("Invalid archive video metadata");
            metadata = { name: event.name, size: event.size };
          } else if (event.type === "progress" || event.type === "complete") {
            if (!metadata || !Number.isSafeInteger(event.bytes) || event.bytes < available || event.bytes > metadata.size) throw new Error("Invalid archive extraction progress");
            available = event.bytes;
            if (event.type === "complete") {
              if (available !== metadata.size) throw new Error("Incomplete archive video");
              complete = true;
            }
            onProgress({ available, total: metadata.size, complete });
            if (available >= Math.min(metadata.size, 65536)) readyResolve();
          } else if (event.type === "error") throw new Error(event.message || "Archive extraction failed");
          changes.emit("change");
        } catch (error) {
          fail(error);
          child.kill();
        }
      }
    });
    child.on("close", (code) => {
      if (code !== 0 || !complete) fail(new Error(stderr || "Progressive archive extraction failed"));
      else doneResolve();
      void input.close().catch(() => {
      });
      changes.emit("change");
    });
    timeout = setTimeout(() => {
      fail(new Error("Progressive archive startup timed out"));
      child.kill();
    }, startupTimeoutMs);
    timeout.unref();
    await ready;
    clearTimeout(timeout);
    expire();
    return {
      metadata,
      completion,
      get consumers() {
        return refs;
      },
      get closed() {
        return closed;
      },
      get failure() {
        return failure;
      },
      get available() {
        return available;
      },
      get complete() {
        return complete;
      },
      retain({ forwardSeek = false } = {}) {
        if (closed || failure) throw failure || new Error("Archive source closed");
        refs++;
        clearTimeout(idle);
        resume();
        let released = false;
        return { url: `${base}/video${forwardSeek ? "/forward-seek" : ""}`, close() {
          if (released) return;
          released = true;
          if (--refs === 0) {
            suspend();
            if (!holds) expire(Math.min(idleMs, 5e3));
          }
        } };
      },
      hold() {
        if (closed || failure) throw failure || new Error("Archive source closed");
        holds++;
        clearTimeout(idle);
        if (refs === 0) suspend();
        let released = false;
        return { close() {
          if (released) return;
          released = true;
          if (--holds === 0 && refs === 0) expire(Math.min(idleMs, 5e3));
        } };
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
const RAR4 = Buffer.from("526172211a0700", "hex");
const RAR5 = Buffer.from("526172211a070100", "hex");
const VIDEO = /\.(mkv|mp4|m4v|mov|webm)$/i;
const SAMPLE = /(^|[._ -])(sample|trailer|preview|proof)([._ -]|$)/i;
function vint(bytes, at, end = bytes.length) {
  let value = 0, scale = 1;
  for (let i = 0; i < 10 && at < end; i++, scale *= 128) {
    const byte = bytes[at++];
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) return null;
    if (!(byte & 128)) return { value, at };
  }
  return null;
}
function rar4Part(bytes) {
  if (!bytes.subarray(0, 7).equals(RAR4)) return null;
  let at = 7, main = false;
  for (let i = 0; i < 8 && at + 7 <= bytes.length; i++) {
    const size = bytes.readUInt16LE(at + 5), type = bytes[at + 2], flags = bytes.readUInt16LE(at + 3);
    if (size < 7 || at + size > bytes.length || (crc32(bytes.subarray(at + 2, at + size)) & 65535) !== bytes.readUInt16LE(at)) return null;
    if (type === 115) {
      if (main || flags & 128) return null;
      main = true;
      at += size;
      continue;
    }
    if (!main || type !== 116 || size < 32 || !(flags & 32768) || flags & 4) return null;
    const data = at + 7, high = Boolean(flags & 256), nameAt = data + (high ? 33 : 25);
    if (nameAt > at + size) return null;
    const packed = bytes.readUInt32LE(data) + (high ? bytes.readUInt32LE(data + 25) * 2 ** 32 : 0);
    const unpacked = bytes.readUInt32LE(data + 4) + (high ? bytes.readUInt32LE(data + 29) * 2 ** 32 : 0);
    const nameLength = bytes.readUInt16LE(data + 19);
    if (nameAt + nameLength > at + size || !Number.isSafeInteger(packed) || !Number.isSafeInteger(unpacked) || bytes[data + 18] !== 48) return null;
    return { name: bytes.subarray(nameAt, nameAt + nameLength), packed, unpacked, start: at + size, before: Boolean(flags & 1), after: Boolean(flags & 2) };
  }
  return null;
}
function rar5Part(bytes) {
  if (!bytes.subarray(0, 8).equals(RAR5)) return null;
  let at = 8, main = false;
  for (let i = 0; i < 8 && at + 7 <= bytes.length; i++) {
    const sizeField = vint(bytes, at + 4);
    if (!sizeField || sizeField.at - at > 7 || sizeField.value > 2 * 1024 * 1024) return null;
    const end = sizeField.at + sizeField.value;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end)) !== bytes.readUInt32LE(at)) return null;
    at = sizeField.at;
    const type = vint(bytes, at, end);
    if (!type) return null;
    at = type.at;
    const flags = vint(bytes, at, end);
    if (!flags) return null;
    at = flags.at;
    const extra = flags.value & 1 ? vint(bytes, at, end) : { value: 0, at };
    if (!extra) return null;
    at = extra.at;
    const data = flags.value & 2 ? vint(bytes, at, end) : { value: 0, at };
    if (!data) return null;
    at = data.at;
    if (type.value === 1) {
      if (main) return null;
      main = true;
      at = end + data.value;
      continue;
    }
    if (!main || type.value !== 2 || !(flags.value & 2) || flags.value & 32) return null;
    const fileFlags = vint(bytes, at, end);
    if (!fileFlags || fileFlags.value & 1) return null;
    at = fileFlags.at;
    const unpacked = vint(bytes, at, end);
    if (!unpacked) return null;
    at = unpacked.at;
    const attributes = vint(bytes, at, end);
    if (!attributes) return null;
    at = attributes.at;
    if (fileFlags.value & 2) at += 4;
    if (fileFlags.value & 4) at += 4;
    const compression = vint(bytes, at, end);
    if (!compression || compression.value & 896) return null;
    at = compression.at;
    const host = vint(bytes, at, end);
    if (!host) return null;
    at = host.at;
    const nameLength = vint(bytes, at, end);
    if (!nameLength) return null;
    at = nameLength.at;
    if (nameLength.value > 4096 || at + nameLength.value > end - extra.value) return null;
    const name = bytes.subarray(at, at + nameLength.value);
    if (extra.value) {
      let recordAt = end - extra.value;
      while (recordAt < end) {
        const recordSize = vint(bytes, recordAt, end);
        if (!recordSize || recordSize.value < 1 || recordSize.at + recordSize.value > end) return null;
        const recordType = vint(bytes, recordSize.at, recordSize.at + recordSize.value);
        if (!recordType || recordType.value === 1) return null;
        recordAt = recordSize.at + recordSize.value;
      }
    }
    return {
      name,
      packed: data.value,
      unpacked: fileFlags.value & 8 ? 0 : unpacked.value,
      start: end,
      before: Boolean(flags.value & 8),
      after: Boolean(flags.value & 16)
    };
  }
  return null;
}
async function inspectStoredRar(input, { headerBytes = 65536 } = {}) {
  const offsets = input.volumeOffsets;
  if (!Array.isArray(offsets) || offsets.length < 2 || offsets[0] !== 0 || offsets.at(-1) !== input.size) return null;
  const parts = [];
  let format, name, declaredSize = 0;
  for (let index = 0; index < offsets.length - 1; index++) {
    const begin = offsets[index], end = offsets[index + 1];
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin) return null;
    const header = await input.read(begin, Math.min(end, begin + headerBytes) - 1);
    const kind = header.subarray(0, 8).equals(RAR5) ? 5 : header.subarray(0, 7).equals(RAR4) ? 4 : 0;
    if (!kind || format && kind !== format) return null;
    format = kind;
    const part = kind === 5 ? rar5Part(header) : rar4Part(header);
    if (!part || !part.packed || part.start + part.packed > end - begin || part.before !== index > 0 || part.after !== index < offsets.length - 2) return null;
    if (index === 0) {
      name = part.name;
      declaredSize = part.unpacked;
      const title = name.toString("utf8").split(/[\\/]/).at(-1);
      if (!VIDEO.test(title) || SAMPLE.test(title)) return null;
    } else if (!part.name.equals(name)) return null;
    parts.push({
      videoStart: parts.length ? parts.at(-1).videoEnd : 0,
      archiveStart: begin + part.start,
      length: part.packed,
      videoEnd: (parts.length ? parts.at(-1).videoEnd : 0) + part.packed
    });
  }
  const size = parts.at(-1)?.videoEnd;
  if (!Number.isSafeInteger(size) || size <= 0 || size < input.size / 2 || declaredSize && declaredSize !== size) return null;
  return { name: name.toString("utf8").split(/[\\/]/).at(-1), size, parts };
}
async function tryCreateStoredRarSource(input, { idleMs = 3e4, verify = null } = {}) {
  const mapping = await inspectStoredRar(input);
  if (!mapping) return null;
  const token = randomUUID();
  let closed = false, closing, idle, refs = 0, failure = null, verification;
  const verificationController = new AbortController();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    void (async () => {
      if (req.url !== `/${token}/video` || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404);
        return res.end();
      }
      if (closed || failure) throw failure || new Error("Archive source closed");
      const range = archiveByteRange(req.headers.range, mapping.size);
      if (!range) {
        res.writeHead(416, { "content-range": `bytes */${mapping.size}` });
        return res.end();
      }
      const { start, end, partial } = range;
      res.writeHead(partial ? 206 : 200, { "content-length": end - start + 1, "accept-ranges": "bytes", "content-type": "application/octet-stream", ...partial ? { "content-range": `bytes ${start}-${end}/${mapping.size}` } : {} });
      if (req.method === "HEAD") return res.end();
      for (const part of mapping.parts) {
        if (part.videoEnd <= start || part.videoStart > end || controller.signal.aborted) continue;
        const first = Math.max(start, part.videoStart), last = Math.min(end, part.videoEnd - 1);
        for (let at = first; at <= last && !controller.signal.aborted; at += 2 * 1024 * 1024) {
          const stop = Math.min(last, at + 2 * 1024 * 1024 - 1);
          const bytes = await input.read(part.archiveStart + at - part.videoStart, part.archiveStart + stop - part.videoStart, controller.signal);
          if (bytes.length !== stop - at + 1) throw new Error("Incomplete stored RAR video range");
          if (!res.write(bytes)) await waitForDrain(res);
        }
      }
      if (!controller.signal.aborted) res.end();
    })().catch((error) => {
      if (controller.signal.aborted) return;
      failure ||= error;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500);
        res.end();
      }
    });
  });
  try {
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve2);
    });
  } catch (error) {
    await input.close();
    throw error;
  }
  function expire(ttl = idleMs) {
    clearTimeout(idle);
    idle = setTimeout(() => void close().catch(() => {
    }), ttl);
    idle.unref();
  }
  function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(idle);
    verificationController.abort();
    server.closeAllConnections();
    closing = Promise.all([input.close(), new Promise((resolve2) => server.close(resolve2)), verification?.catch(() => {
    })]).then(() => {
    });
    return closing;
  }
  expire();
  const url = `http://127.0.0.1:${server.address().port}/${token}/video`;
  return {
    metadata: { name: mapping.name, size: mapping.size },
    completion: Promise.resolve(),
    get consumers() {
      return refs;
    },
    get closed() {
      return closed;
    },
    get failure() {
      return failure;
    },
    get available() {
      return mapping.size;
    },
    get complete() {
      return true;
    },
    randomAccess: true,
    verify() {
      if (!verify || closed) return;
      if (!verification) verification = Promise.resolve().then(() => verify(verificationController.signal)).catch((error) => {
        if (!verificationController.signal.aborted) {
          failure ||= error;
          server.closeAllConnections();
        }
      });
      return verification;
    },
    retain() {
      if (closed || failure) throw failure || new Error("Archive source closed");
      refs++;
      clearTimeout(idle);
      let released = false;
      return { url, close() {
        if (!released) {
          released = true;
          if (--refs === 0) expire(Math.min(idleMs, 5e3));
        }
      } };
    },
    close
  };
}
const ROOT = process.cwd();
const SETTINGS_PATH = join(ROOT, "data", "settings.json");
const MEDIA_STATE_PATH = join(ROOT, "data", "media-state.json");
const PLAYBACK_CACHE_ROOT = process.env.WATCHHOUSE_PLAYBACK_CACHE_ROOT || join(ROOT, "data", "cache");
const DISCOVERY_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, "tmdb-discovery-v4.json");
const RUNTIME_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, "tmdb-runtime-v1.json");
const OFFLINE_ROOT = join(ROOT, "data", "offline");
const OFFLINE_STATE_PATH = join(ROOT, "data", "offline-downloads.json");
const downloads = /* @__PURE__ */ new Map();
const playbackJobs = /* @__PURE__ */ new Map();
const hlsSessions = /* @__PURE__ */ new Map();
const hlsPacing = createHlsPacing();
const providerSpeed = createProviderSpeedMeter();
const manualReleases = /* @__PURE__ */ new Map();
const posterPreparation = createPosterPreparation();
const offlineJobs = /* @__PURE__ */ new Map();
const offlineSeriesJobs = /* @__PURE__ */ new Map();
const offlineFinalizations = /* @__PURE__ */ new Map();
const playbackPlans = createPlaybackPlanCache();
const archiveResumePlans = createArchiveResumeCache();
const playbackPersistence = createPlaybackPersistence(join(PLAYBACK_CACHE_ROOT, "resume-v1"));
const resumeSegments = createSegmentCache();
const transfers = createTransferCoordinator();
const nntpPool = createNntpPool(openNntp, { acquire: (settings) => transfers.acquire(settings) });
const releaseHealth = createReleaseHealthStore(join(ROOT, "data", "release-health.json"));
const mediaState = createMediaStateStore(MEDIA_STATE_PATH);
let discoveryCache = null;
let runtimeCache = null;
let offlineRecords = null;
const CACHE_SWEEP_MS = 60 * 60 * 1e3;
const DISCOVERY_CACHE_MS = 7 * 24 * 60 * 60 * 1e3;
function indexerEndpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Indexer URL must use http or https.");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/api";
  return url;
}
async function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
}
async function saveSettings(next) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), { mode: 384 });
}
async function readOfflineRecords() {
  if (offlineRecords) return offlineRecords;
  const stored = await readFile(OFFLINE_STATE_PATH, "utf8").then(JSON.parse).catch(() => ({ downloads: [] }));
  offlineRecords = new Map((stored.downloads || []).filter((download) => existsSync(download.path || download.sourcePath || "")).map((download) => [download.key, download]));
  return offlineRecords;
}
async function writeOfflineRecords() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(OFFLINE_STATE_PATH, JSON.stringify({ version: 1, downloads: [...offlineRecords.values()] }, null, 2), { mode: 384 });
}
function publicOfflineRecord(record) {
  const { path, sourcePath, directory, mime, strategy, ...safe } = record;
  return { ...safe, streamUrl: `/api/offline/${encodeURIComponent(record.key)}/stream` };
}
function publicOfflineJob(job) {
  return { id: job.id, key: job.offlineKey || offlineMediaKey(job.media), media: job.media, status: job.status, message: job.message, progress: job.progress, download: job.download || null, created: job.created, ...job.total ? { completed: job.completed || 0, total: job.total } : {}, ...job.currentMedia ? { currentMedia: job.currentMedia } : {} };
}
async function clearExpiredPlaybackCache() {
  const settings = await readSettings();
  await playbackPersistence.prune(settings).catch(() => {
  });
  const retentionHours = Math.min(168, Math.max(1, Number(settings.cacheRetentionHours) || 24));
  const activeDirectories = new Set([...playbackJobs.values()].map((job) => job.directory).filter(Boolean));
  for (const { session } of hlsSessions.values()) activeDirectories.add(session.directory);
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1e3;
  const entries = await readdir(PLAYBACK_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory() && (entry.name.startsWith("playback-") || entry.name.startsWith("hls-"))).map(async (entry) => {
    const directory = join(PLAYBACK_CACHE_ROOT, entry.name);
    if (activeDirectories.has(directory)) return;
    if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
  }));
}
function playbackCacheDirectory(directory, root) {
  if (!directory || !basename(directory).startsWith("playback-")) return false;
  const path = relative(resolve(root), resolve(directory));
  return path && !path.startsWith("..") && !isAbsolute(path);
}
async function clearPlaybackCacheForMedia(media, {
  plans = playbackPlans,
  archivePlans = archiveResumePlans,
  persistence = playbackPersistence,
  health = releaseHealth,
  jobs = playbackJobs,
  sessions = hlsSessions,
  inspections = playbackInspections,
  segments = resumeSegments,
  poster = posterPreparation,
  root = PLAYBACK_CACHE_ROOT,
  remove = rm
} = {}) {
  const key = offlineMediaKey(media);
  if (!key || media.type === "tv" && (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode)))) {
    throw new Error("Choose an individual movie or episode to clear.");
  }
  poster.cancel();
  plans.delete(media);
  archivePlans.delete(media);
  const matched = [...jobs].filter(([, job]) => offlineMediaKey(job.media) === key);
  const ids = new Set(matched.map(([id]) => id));
  let closedSessions = 0;
  for (const [id, entry] of [...sessions]) {
    if (!ids.has(entry.jobId)) continue;
    await entry.session.close();
    sessions.delete(id);
    closedSessions++;
  }
  const directories = /* @__PURE__ */ new Set();
  for (const [id, job] of matched) {
    cancelDownloadJob(job);
    await job.archiveSource?.close();
    if (job.file) {
      inspections.delete(job.file);
      segments.delete(job.file);
    }
    if (playbackCacheDirectory(job.directory, root)) directories.add(job.directory);
    jobs.delete(id);
  }
  const persisted = await persistence.deleteMedia(media);
  await health.delete(media);
  for (const directory of directories) await remove(directory, { recursive: true, force: true });
  return { jobs: matched.length, sessions: closedSessions, sources: persisted?.sources || 0, directories: directories.size };
}
function clearWatchedPlaybackWarmth(media, settings, {
  archivePlans = archiveResumePlans,
  poster = posterPreparation
} = {}) {
  archivePlans.delete(media);
  poster.delete?.(`${offlineMediaKey(media)}:${playbackScope(settings)}`);
}
function shouldClearPlaybackWarmth(update = {}) {
  return update.watched === true || update.reset === true;
}
const cacheSweep = setInterval(() => clearExpiredPlaybackCache().catch(() => {
}), CACHE_SWEEP_MS);
cacheSweep.unref();
function publicSettings(settings) {
  const { indexerKey, usenetPass, tmdbToken, omdbKey, watchmodeKey, ...safe } = settings;
  return { autoPlayNextEpisode: settings.autoPlayNextEpisode !== false, repairVideoTimeline: false, frameInterpolation: false, ...safe, hasIndexerKey: Boolean(indexerKey), hasUsenetPass: Boolean(usenetPass), hasTmdbToken: Boolean(tmdbToken) };
}
function connectionTestSettings(saved, entered = {}) {
  return { ...saved, ...Object.fromEntries(Object.entries(entered).filter(([, value]) => value !== "")) };
}
function json(res, status, body2) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body2));
}
function entityDecode(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function indexerError(xml) {
  return entityDecode((xml.match(/<error[^>]*\bdescription="([^"]*)"/i) || [, "The indexer returned a non-NZB response."])[1]);
}
function field(xml, name) {
  return entityDecode((xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")) || [, ""])[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
}
function searchResults(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([, item]) => ({
    title: field(item, "title") || "Untitled result",
    published: field(item, "pubDate"),
    category: field(item, "category") || "Media",
    size: (item.match(/<enclosure[^>]*\blength="(\d+)"/i) || [, ""])[1],
    nzbUrl: entityDecode((item.match(/<enclosure[^>]*\burl="([^"]+)"/i) || [, ""])[1])
  }));
}
function formatSize(bytes) {
  const n = Number(bytes);
  return n ? `${(n / 1024 ** 3).toFixed(n >= 1024 ** 3 ? 1 : 2)} GB` : "";
}
function playbackSetupByteSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}
function playbackSetupTime(seconds2) {
  const value = Math.max(0, Math.floor(Number(seconds2) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
function archivePlaybackSetupProgress(job, start, completed = 0) {
  const source = job?.archiveSource;
  if (!job?.progressiveArchive || !source || source.complete || completed >= 2) return null;
  const available = Math.max(0, Number(source.available) || 0);
  const total = Math.max(0, Number(source.metadata?.size) || 0);
  const duration = Math.max(0, Number(job.sourceDuration) || 0);
  if (start > 0) {
    const target = total && duration ? Math.min(total, Math.ceil(total * Math.min(1, start / duration))) : 0;
    return {
      message: `Restoring your saved position at ${playbackSetupTime(start)}`,
      detail: target ? `${playbackSetupByteSize(Math.min(available, target))} of about ${playbackSetupByteSize(target)} prepared` : `${playbackSetupByteSize(available)} prepared so far`,
      ...target ? { percent: 25 + Math.round(Math.min(1, available / target) * 24) } : {}
    };
  }
  return {
    message: completed ? "Preparing the first playable segment" : "Opening the archived episode",
    detail: `${playbackSetupByteSize(available)} unpacked and ready for playback`
  };
}
function addDownload(url, title, apiKey) {
  const id = randomUUID();
  const target = new URL(url);
  if (!target.searchParams.has("apikey")) target.searchParams.set("apikey", apiKey);
  downloads.set(id, { url: target.href, title, expires: Date.now() + 20 * 60 * 1e3 });
  return id;
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}
async function testNntp(settings) {
  if (!settings.usenetHost || !settings.usenetUser || !settings.usenetPass) throw new Error("Enter a provider host, username, and password first.");
  const client = await openNntp(settings);
  client.close();
}
class NntpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("end", () => this.fail(new Error("Provider server closed the connection.")));
    socket.on("close", () => this.fail(new Error("Provider server closed the connection.")));
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.waiters.length) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) break;
      const waiter = this.waiters.shift();
      const line = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 2);
      waiter.resolve(line);
    }
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    while (this.waiters.length) this.waiters.shift().reject(error);
  }
  line() {
    const end = this.buffer.indexOf("\r\n");
    if (end >= 0) {
      const line = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 2);
      return Promise.resolve(line);
    }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve2, reject) => this.waiters.push({ resolve: resolve2, reject }));
  }
  async command(value) {
    this.socket.write(`${value}\r
`);
    return this.line();
  }
  async has(messageId) {
    return /^223 /.test(await this.command(`STAT <${messageId.replace(/[<>]/g, "")}>`));
  }
  async body(messageId, onLine) {
    const status = await this.command(`BODY <${messageId.replace(/[<>]/g, "")}>`);
    if (!/^222 /.test(status)) throw Object.assign(new Error(`Provider server could not retrieve an article (${status}).`), /^430 /.test(status) ? { code: "USENET_ARTICLE_MISSING" } : {});
    for (; ; ) {
      const line = await this.line();
      if (line === ".") return;
      await onLine(line.startsWith("..") ? line.slice(1) : line);
    }
  }
  close() {
    this.socket.end("QUIT\r\n");
  }
}
async function connectNntp(settings) {
  if (settings.backgroundJob) return createBackgroundNntpClient(settings, transfers, async (next) => {
    nntpPool.clearIdle();
    return openNntp(next);
  });
  return nntpPool.client(settings);
}
async function openNntp(settings) {
  if (!settings.usenetHost || !settings.usenetUser || !settings.usenetPass) throw new Error("Provider connection settings are incomplete.");
  const port = Number(settings.usenetPort || 563), signal = settings.signal;
  signal?.throwIfAborted();
  let socket, detachAbort = () => {
  };
  try {
    socket = await new Promise((resolve2, reject) => {
      const next = port === 563 ? tls.connect({ host: settings.usenetHost, port, servername: settings.usenetHost }) : net.connect({ host: settings.usenetHost, port });
      const abort = () => {
        next.destroy();
        reject(signal.reason);
      };
      detachAbort = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      next.setTimeout(15e3, () => {
        next.destroy();
        reject(new Error("Provider server timed out."));
      });
      next.once("error", reject);
      next.once("connect", () => resolve2(next));
      if (signal?.aborted) abort();
    });
    const client = new NntpClient(socket);
    const greeting = await client.line();
    if (!/^20[01]/.test(greeting)) throw new Error(`Provider server rejected the connection (${greeting}).`);
    const user = await client.command(`AUTHINFO USER ${settings.usenetUser}`);
    if (!/^381/.test(user)) throw new Error("Provider server rejected the username.");
    const pass = await client.command(`AUTHINFO PASS ${settings.usenetPass}`);
    if (!/^281/.test(pass)) throw new Error("Provider server rejected the password.");
    signal?.throwIfAborted();
    return client;
  } catch (error) {
    socket?.destroy();
    throw error;
  } finally {
    detachAbort();
  }
}
async function postedFileAvailable(file, settings, connect = connectNntp) {
  const sampledAt = performance.now();
  const client = await connect(settings);
  let clientClosed = false;
  try {
    let header = Buffer.alloc(0), decodedSize = 0, partBegin = 0, partEnd = 0;
    const chunks = [];
    await client.body(file.segments[0].id, (line) => {
      if (line.startsWith("=ybegin")) decodedSize = Number((line.match(/\bsize=(\d+)/i) || [])[1]) || 0;
      if (line.startsWith("=ypart")) {
        partBegin = Number((line.match(/\bbegin=(\d+)/i) || [])[1]) || 0;
        partEnd = Number((line.match(/\bend=(\d+)/i) || [])[1]) || 0;
      }
      if (line.startsWith("=y")) return;
      const chunk = decodeYenc(line);
      chunks.push(chunk);
      if (header.length < 64) header = Buffer.concat([header, chunk]).subarray(0, 64);
    });
    if (!playableMediaHeader(file.subject, header)) return null;
    const first = Buffer.concat(chunks);
    if (partBegin && partBegin !== 1 || !applyYencByteLayout(file, { decodedSize, partBegin, partEnd, firstBytes: first.length }) || file.segments[0].decodedBytes !== first.length) return null;
    const indexes = [.../* @__PURE__ */ new Set([1, Math.floor(file.segments.length / 4), Math.floor(file.segments.length / 2), Math.floor(file.segments.length * 3 / 4), file.segments.length - 1])].filter((index) => index > 0 && index < file.segments.length);
    let headerClient = client;
    const loader = createPostedSegmentLoader(file, settings, /* @__PURE__ */ new Map([[0, first]]), async (nextSettings) => {
      if (headerClient) {
        const ready = headerClient;
        headerClient = null;
        return ready;
      }
      return connect(nextSettings);
    });
    clientClosed = true;
    try {
      const checks = await Promise.allSettled(indexes.map((index) => loader.load(file.segments[index], index)));
      const failed = checks.find((check) => check.status === "rejected");
      if (failed) throw failed.reason;
      resumeSegments.set(file, 0, first);
      if (settings.usenetHost) playbackPersistence.setSegment(file, 0, settings, first);
      checks.forEach((check, index) => {
        resumeSegments.set(file, indexes[index], check.value);
        if (settings.usenetHost) playbackPersistence.setSegment(file, indexes[index], settings, check.value);
      });
      settings.onProviderSpeedSample?.(first.length + checks.reduce((total, check) => total + check.value.length, 0), performance.now() - sampledAt);
    } finally {
      await loader.close();
      headerClient?.close();
    }
    return first;
  } finally {
    if (!clientClosed) client.close();
  }
}
function applyYencByteLayout(posted, { decodedSize, partBegin = 0, partEnd = 0, firstBytes = 0 }) {
  const total = Number(decodedSize), partSize = partEnd >= partBegin && partBegin > 0 ? partEnd - partBegin + 1 : Number(firstBytes);
  if (!posted?.segments?.length || !Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(partSize) || partSize <= 0) return false;
  posted.segments.forEach((segment, index) => {
    segment.decodedBytes = Math.min(partSize, Math.max(0, total - index * partSize));
  });
  return posted.segments.every((segment) => segment.decodedBytes > 0) && posted.segments.reduce((sum, segment) => sum + segment.decodedBytes, 0) === total;
}
function nzbFiles(xml) {
  return [...xml.matchAll(/<file\s+([^>]*)>([\s\S]*?)<\/file>/gi)].map(([, attrs, file]) => ({
    subject: entityDecode((attrs.match(/\bsubject="([^"]*)"/i) || [, ""])[1]),
    segments: [...file.matchAll(/<segment\b([^>]*)>([\s\S]*?)<\/segment>/gi)].map(([, segmentAttrs, id]) => {
      const bytes = Number((segmentAttrs.match(/\bbytes="(\d+)"/i) || [, ""])[1]);
      return { number: Number((segmentAttrs.match(/\bnumber="(\d+)"/i) || [, ""])[1]), ...bytes > 0 ? { bytes } : {}, id: entityDecode(id.trim()) };
    }).filter((segment) => segment.number > 0).sort((a, b) => a.number - b.number)
  }));
}
function videosFrom(files) {
  return files.filter((file) => /\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i.test(file.subject) && file.segments.length).sort((a, b) => b.segments.length - a.segments.length);
}
function videoFile(xml) {
  return videosFrom(nzbFiles(xml))[0];
}
function archivesFrom(files) {
  return files.filter((file) => /(?:\.part\d+\.rar|\.rar|\.r\d\d|\.7z(?:\.\d{3})?|\.zip(?:\.\d{3})?|\.z\d\d)(?:\"|\s|$)/i.test(file.subject) && file.segments.length);
}
function archiveFiles(xml) {
  return archivesFrom(nzbFiles(xml));
}
function decodeYenc(line) {
  const bytes = Buffer.allocUnsafe(line.length);
  let written = 0;
  for (let i = 0; i < line.length; i++) {
    let code = line.charCodeAt(i);
    if (code === 61 && i + 1 < line.length) code = line.charCodeAt(++i) - 64;
    bytes[written++] = code - 42 + 256 & 255;
  }
  return bytes.subarray(0, written);
}
function yencName(line) {
  return (line.match(/^=ybegin\s+.*\bname=(.+)$/i) || [])[1];
}
function videoType(subject) {
  const ext = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  return { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" }[ext] || "application/octet-stream";
}
function playableMediaHeader(subject, header) {
  const extension = (String(subject).match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  if (extension === "mkv" || extension === "webm") return header?.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) || false;
  if (["mp4", "m4v", "mov"].includes(extension)) {
    const marker = header?.indexOf(Buffer.from("ftyp")) ?? -1;
    return marker >= 4 && marker <= 32;
  }
  return false;
}
async function orderedPrefetch(items, concurrency, load, consume) {
  const width = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  const loadOnLane = (index, lane) => {
    const loading = Promise.resolve().then(() => load(items[index], index, lane));
    void loading.catch(() => {
    });
    return loading;
  };
  const pending = Array.from({ length: width }, (_, lane) => loadOnLane(lane, lane));
  for (let index = 0; index < items.length; index++) {
    const lane = index % width;
    const value = await pending[lane];
    const next = index + width;
    pending[lane] = next < items.length ? loadOnLane(next, lane) : null;
    await consume(value);
  }
}
async function streamPostedFile(posted, settings, consume, connect = connectNntp, prefetchedSegments = /* @__PURE__ */ new Map()) {
  const count = Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, posted.segments.length);
  const clients = [];
  try {
    const connections = await Promise.allSettled(Array.from({ length: count }, () => connect(settings)));
    for (const connection of connections) if (connection.status === "fulfilled") clients.push(connection.value);
    const failed = connections.find((connection) => connection.status === "rejected");
    if (failed) throw failed.reason;
    await orderedPrefetch(posted.segments, count, async (segment, index, lane) => {
      if (prefetchedSegments.has(index)) return prefetchedSegments.get(index);
      for (let attempt = 0; attempt < 2; attempt++) {
        const chunks = [];
        try {
          await clients[lane].body(segment.id, (line) => {
            if (!line.startsWith("=y")) chunks.push(decodeYenc(line));
          });
          return Buffer.concat(chunks);
        } catch (error) {
          clients[lane].close();
          if (attempt) throw error;
          clients[lane] = await connect(settings);
        }
      }
    }, consume);
  } finally {
    for (const client of clients) client.close();
  }
}
function postedFileByteLayout(posted) {
  if (!posted?.segments?.length || posted.segments.some((segment) => !Number.isInteger(Number(segment.decodedBytes)) || Number(segment.decodedBytes) <= 0)) return null;
  const offsets = [0];
  for (const segment of posted.segments) offsets.push(offsets.at(-1) + Number(segment.decodedBytes));
  return { total: offsets.at(-1), offsets };
}
async function writePostedFileRange(posted, start, end, load, consume, { shouldContinue = () => true, concurrency = 1 } = {}) {
  const layout = postedFileByteLayout(posted);
  if (!layout) throw new Error("This post does not include byte-range metadata.");
  const first = Math.max(0, Math.min(layout.total - 1, Number(start) || 0));
  const last = Math.max(first, Math.min(layout.total - 1, Number(end) || 0));
  const indexes = posted.segments.flatMap((segment, index) => layout.offsets[index] <= last && layout.offsets[index + 1] > first ? [index] : []);
  await orderedPrefetch(indexes, concurrency, async (index) => {
    if (!shouldContinue()) return null;
    return { index, chunk: await load(posted.segments[index], index) };
  }, async (loaded) => {
    if (!loaded || !shouldContinue()) return;
    const { index, chunk } = loaded;
    if (chunk.length !== posted.segments[index].decodedBytes) throw new Error("Usenet segment size did not match its yEnc byte metadata.");
    const from = Math.max(0, first - layout.offsets[index]);
    const to = Math.min(chunk.length, last - layout.offsets[index] + 1);
    if (to > from) await consume(chunk.subarray(from, to));
  });
}
function createPlaybackPlanCache({ ttl = 30 * 60 * 1e3, maximum = 50, now = Date.now } = {}) {
  const entries = /* @__PURE__ */ new Map();
  const mediaKey2 = (media) => offlineMediaKey(media);
  const key = (media, variant = "") => {
    const id = mediaKey2(media);
    return id ? `${id}\0${variant}` : "";
  };
  return {
    get(media, variant) {
      const id = key(media, variant), entry = entries.get(id);
      if (!id || !entry || entry.expires <= now()) {
        if (id) entries.delete(id);
        return null;
      }
      entries.delete(id);
      entries.set(id, entry);
      return entry.value;
    },
    set(media, value, variant) {
      const id = key(media, variant);
      if (!id) return;
      entries.delete(id);
      entries.set(id, { value, expires: now() + ttl });
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
    },
    delete(media) {
      const prefix = `${mediaKey2(media)}\0`;
      if (prefix.length > 1) {
        for (const id of entries.keys()) if (id.startsWith(prefix)) entries.delete(id);
      }
    }
  };
}
function filename(subject, fallback) {
  return (subject.match(/([^/\\\"]+\.(?:part\d+\.rar|rar|r\d\d|7z(?:\.\d{3})?|zip(?:\.\d{3})?|z\d\d|mkv|mp4|m4v|mov|webm))/i) || [, fallback])[1].replace(/[^a-z0-9._ -]/gi, "_");
}
function archiveFilenames(archives) {
  const names = archives.map((archive) => filename(archive.subject, "archive.rar"));
  const first = names.find((name) => /\.part0*1\.rar$/i.test(name)) || names.find((name) => /\.rar$/i.test(name));
  if (!first) return names;
  if (names.some((name) => /\.r\d\d$/i.test(name))) {
    const base2 = first.replace(/(?:\.part0*1)?\.rar$/i, "");
    return names.map((name) => {
      const continuation = name.match(/\.r(\d\d)$/i);
      return continuation ? `${base2}.r${continuation[1]}` : /\.rar$/i.test(name) ? `${base2}.rar` : name;
    });
  }
  const base = first.replace(/\.part0*1\.rar$/i, "");
  return names.map((name) => {
    const part = name.match(/\.part0*(\d+)\.rar$/i);
    return part ? `${base}.part${String(Number(part[1])).padStart(2, "0")}.rar` : name;
  });
}
async function run(command, args, cwd, job) {
  const controller = new AbortController();
  const removeQueuedCancel = job ? onDownloadCancel(job, () => controller.abort()) : () => {
  };
  let release = () => {
  };
  try {
    if (command === "ffmpeg") release = await conversionAdmission.acquire({ foreground: !job?.backgroundFor && !job?.prepareAhead, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3e4)]) });
    removeQueuedCancel();
    return await new Promise((resolve2, reject) => {
      throwIfDownloadCancelled(job);
      const child = spawn(command, args, { cwd });
      let stderr = "", settled = false;
      const removeCancelHandler = job ? onDownloadCancel(job, () => child.kill("SIGTERM")) : () => {
      };
      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        removeCancelHandler();
        callback(value);
      };
      child.stderr.on("data", (data) => stderr += data);
      child.on("error", finish(reject));
      child.on("close", finish((code) => {
        try {
          throwIfDownloadCancelled(job);
        } catch (error) {
          reject(error);
          return;
        }
        code === 0 ? resolve2() : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`));
      }));
    });
  } finally {
    removeQueuedCancel();
    release();
  }
}
function runOutput(command, args, cwd, signal) {
  return new Promise((resolve2, reject) => {
    const child = spawn(command, args, { cwd, signal });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve2(stdout) : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`)));
  });
}
const VAAPI_DEVICES = [
  ...Array.from({ length: 8 }, (_, index) => `/dev/dri/renderD${128 + index}`),
  ...Array.from({ length: 8 }, (_, index) => `/dev/dri/card${index}`)
];
let videoAccelerationDetection;
async function detectVideoAcceleration({ devices = VAAPI_DEVICES, exists = existsSync, execute: execute2 = runOutput, probeTimeoutMs = 5e3 } = {}) {
  if (exists("/dev/nvidia0")) {
    const controller = new AbortController();
    let timeout;
    try {
      const probe = Promise.resolve(execute2("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=320x240:rate=1", "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"], void 0, controller.signal));
      void probe.catch(() => {
      });
      await Promise.race([probe, new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("NVENC probe timed out"));
        }, probeTimeoutMs);
      })]);
      return { kind: "nvenc" };
    } catch {
    } finally {
      clearTimeout(timeout);
    }
  }
  for (const device of devices) {
    if (!exists(device)) continue;
    const controller = new AbortController();
    let timeout;
    try {
      const probe = Promise.resolve(execute2("ffmpeg", ["-hide_banner", "-loglevel", "error", "-vaapi_device", device, "-f", "lavfi", "-i", "color=size=128x128:rate=1", "-frames:v", "1", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-f", "null", "-"], void 0, controller.signal));
      void probe.catch(() => {
      });
      await Promise.race([probe, new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`VAAPI probe timed out for ${device}`));
        }, probeTimeoutMs);
      })]);
      return { kind: "vaapi", device };
    } catch {
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}
function availableVideoAcceleration() {
  videoAccelerationDetection ||= detectVideoAcceleration();
  return videoAccelerationDetection;
}
async function writeStreamToResponse(stream, res, { end = true } = {}) {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain();
  }
  if (end) res.end();
  return bytes;
}
function conversionSucceeded(code, stderr = "", bytes = 1, { httpReconnect = false } = {}) {
  let recoveredRead = false;
  const errors = String(stderr).split("\n").filter((line) => {
    if (httpReconnect && /^\[http @ 0x[\da-f]+\] Stream ends prematurely at \d+, should be \d+\s*$/i.test(line)) {
      recoveredRead = true;
      return false;
    }
    if (recoveredRead && /^\s*Last message repeated \d+ times?\s*$/.test(line)) return false;
    recoveredRead = false;
    return line.trim();
  });
  return code === 0 && errors.length === 0 && bytes > 0;
}
async function extractedVideo(directory) {
  const names = await readdir(directory, { recursive: true });
  return names.find((name) => /\.(mkv|mp4|m4v|mov|webm)$/i.test(name));
}
function seekPlaybackStrategy(strategy, start = 0) {
  return start > 0 ? "transcode" : strategy;
}
function playbackAccelerationLabel(strategy, toneMap = false, acceleration = null) {
  if (["raw", "remux"].includes(strategy)) return "Not needed · video stream copy";
  if (acceleration?.kind === "nvenc") return toneMap ? "GPU · NVENC encode + CPU HDR tone mapping" : "GPU · NVENC encode";
  if (acceleration?.kind === "vaapi") return toneMap ? "GPU encode · CPU HDR tone mapping" : "GPU · VAAPI decode + encode";
  return toneMap ? "CPU · HDR tone mapping" : "CPU · software transcode";
}
function playbackNeedsToneMapping(job) {
  const source = job.sourcePath || job.path || "";
  return releaseDynamicRange(job.release) !== "sdr" && !source.endsWith(".browser.mp4");
}
async function configurePlaybackAcceleration(job, strategy, toneMap = false, interpolate = false) {
  const acceleration = interpolate || ["raw", "remux"].includes(strategy) ? null : await availableVideoAcceleration();
  const label = interpolate ? "CPU · 60 FPS motion interpolation" : playbackAccelerationLabel(strategy, toneMap, acceleration);
  if (job.videoAcceleration !== label) {
    job.videoAcceleration = label;
    jobEvent(job, "acceleration", label);
  }
  return acceleration;
}
function ffmpegArgs(strategy, input, output, fragmented = false, start = 0, untaggedAudioTrack = 2, seekableInput = false, toneMap = false, acceleration = null, repairVideoFrameRate = null, frameInterpolation = false) {
  const fallbackIndex = Math.min(7, Math.max(0, (Number(untaggedAudioTrack) || 2) - 1));
  const englishMetadataMaps = [
    "0:a:m:language:eng:?",
    "0:a:m:language:en:?",
    "0:a:m:language:en-US:?",
    "0:a:m:language:en-GB:?",
    "0:a:m:title:English:?",
    "0:a:m:title:english:?",
    "0:a:m:title:ENG:?",
    "0:a:m:handler_name:English:?",
    "0:a:m:handler_name:english:?",
    "0:a:m:handler_name:ENG:?"
  ];
  const audioMaps = [...englishMetadataMaps, ...fallbackIndex ? [`0:a:${fallbackIndex}?`] : [], "0:a:0?"];
  const seek = start > 0 ? ["-ss", String(start)] : [];
  const reconnect = /^https?:\/\//i.test(input) ? ["-reconnect", "1", "-reconnect_delay_max", "2", "-rw_timeout", "15000000"] : [];
  const repairRate = Number(repairVideoFrameRate);
  const repairTimeline = Number.isFinite(repairRate) && repairRate > 0;
  const transcodeVideo = strategy !== "remux" || toneMap || repairTimeline || frameInterpolation;
  const vaapi = transcodeVideo && !frameInterpolation && acceleration?.kind === "vaapi";
  const nvenc = transcodeVideo && !frameInterpolation && acceleration?.kind === "nvenc";
  const hardwareInputArgs = vaapi ? toneMap ? ["-vaapi_device", acceleration.device] : ["-hwaccel", "vaapi", "-hwaccel_device", acceleration.device, "-hwaccel_output_format", "vaapi"] : [];
  const filters = [
    ...repairTimeline ? [`fps=${repairRate}:round=near`] : [],
    ...toneMap ? [`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=${vaapi ? "nv12,hwupload" : "yuv420p"}`] : vaapi ? ["scale_vaapi=format=nv12"] : [],
    ...frameInterpolation ? ["minterpolate=fps=60:mi_mode=mci"] : []
  ];
  const filter = filters.join(",");
  const filterArgs = filter ? ["-vf", filter] : [];
  const colorArgs = toneMap ? ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] : [];
  const videoCodecArgs = !transcodeVideo ? ["-c:v", "copy"] : vaapi ? ["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "22"] : nvenc ? ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-pix_fmt", "yuv420p"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"];
  return ["-y", "-loglevel", "error", ...hardwareInputArgs, ...reconnect, ...seekableInput ? seek : [], "-i", input, ...!seekableInput ? seek : [], "-map", "0:v:0", ...audioMaps.flatMap((map) => ["-map", map]), ...filterArgs, ...colorArgs, ...videoCodecArgs, "-c:a", "aac", "-b:a", "192k", "-disposition:a", "0", "-disposition:a:0", "default", "-movflags", fragmented ? "frag_keyframe+empty_moov+default_base_moof" : "+faststart", ...fragmented ? ["-f", "mp4"] : [], output];
}
function audioAwarePlaybackStrategy(suggested, streams = []) {
  return suggested === "raw" && streams.filter((stream) => stream.codec_type === "audio").length > 1 ? "remux" : suggested;
}
function shouldCacheDirectPlayback(job, settings = {}) {
  return Boolean(job.offlineDownload);
}
function shouldFinalizeCachedPlayback(job, strategy) {
  return Boolean((job.prepareAhead || job.offlineDownload) && strategy !== "raw");
}
function preparationDownloadSettings(job, settings) {
  if (!job.prepareAhead) return settings;
  return { ...settings, maxConnections: Math.min(2, Math.max(1, Number(settings.maxConnections) || 1)) };
}
async function cachedPlaybackStrategy(path, release) {
  const suggested = playbackStrategy(path, release);
  try {
    const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_tags=language", "-of", "json", path]));
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    if (video?.codec_name !== "h264" || video?.pix_fmt !== "yuv420p") return "transcode";
    return audioAwarePlaybackStrategy(suggested, probe.streams);
  } catch {
    return suggested;
  }
}
function assertCompleteEpisodeDuration(actualDuration, expectedDuration) {
  if (Number.isFinite(expectedDuration) && expectedDuration > 0 && Number.isFinite(actualDuration) && actualDuration > 0 && actualDuration < expectedDuration * 0.5) {
    throw Object.assign(new Error("This video is much shorter than the expected episode runtime. Trying another release."), { code: "INVALID_MEDIA_DURATION" });
  }
}
async function validatePreparedEpisode(job, path) {
  if (job.media?.type !== "tv" || !(job.media.durationHint > 0)) return;
  const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path]));
  assertCompleteEpisodeDuration(Number(probe.format?.duration), Number(job.media.durationHint));
}
async function optimizeCachedVideo(job, path, settings = {}) {
  await validatePreparedEpisode(job, path);
  const inspection = await inspectPlaybackSource(path, job.untaggedAudioTrack, { fullTimeline: true, repairVideoTimeline: Boolean(settings.repairVideoTimeline) });
  const repairVideoFrameRate = inspection.repairVideoFrameRate || null;
  if (repairVideoFrameRate) jobEvent(job, "timeline-repair", "A video timestamp hole was found. Rebuilding the missing interval against the audio clock.");
  const strategy = repairVideoFrameRate ? "transcode" : await cachedPlaybackStrategy(path, job.release);
  const toneMap = releaseDynamicRange(job.release) !== "sdr";
  const acceleration = repairVideoFrameRate ? null : await configurePlaybackAcceleration(job, strategy, toneMap);
  const selectedAcceleration = acceleration?.kind === "vaapi" && !["h264", "hevc"].includes(inspection.videoCodec) ? null : acceleration;
  if (selectedAcceleration !== acceleration) {
    job.videoAcceleration = playbackAccelerationLabel(strategy, toneMap, null);
    jobEvent(job, "acceleration", job.videoAcceleration);
  }
  if (repairVideoFrameRate) job.videoAcceleration = playbackAccelerationLabel(strategy, toneMap, null);
  if (strategy === "raw") return { path, mime: videoType(path), videoAcceleration: job.videoAcceleration, timelineValidated: true, decodeValidated: true };
  if (repairVideoFrameRate || shouldFinalizeCachedPlayback(job, strategy)) {
    const browserPath = `${path}.browser.mp4`;
    await run("ffmpeg", ffmpegArgs(strategy, path, browserPath, false, 0, job.untaggedAudioTrack, false, toneMap, selectedAcceleration, repairVideoFrameRate), job.directory || ROOT, job);
    await validatePreparedEpisode(job, browserPath);
    await inspectPlaybackSource(browserPath, job.untaggedAudioTrack, { fullTimeline: true });
    return { path: browserPath, mime: "video/mp4", strategy: "raw", videoAcceleration: job.videoAcceleration, timelineValidated: true, decodeValidated: true, timelineRepaired: Boolean(repairVideoFrameRate) };
  }
  return { sourcePath: path, mime: "video/mp4", mode: "cached-convert", strategy, videoAcceleration: job.videoAcceleration, timelineValidated: true, decodeValidated: true };
}
async function audioSafeOfflineRecord(record, inspectStrategy = cachedPlaybackStrategy) {
  if (record.mode !== "cached" || !record.path) return record;
  if (record.strategy === "raw" && record.mime === "video/mp4") return record;
  const strategy = await inspectStrategy(record.path, record.release);
  return strategy === "raw" ? record : { ...record, mode: "cached-convert", sourcePath: record.path, mime: "video/mp4", strategy };
}
function createPostedSegmentLoader(posted, settings, prefetchedSegments = /* @__PURE__ */ new Map(), connect = connectNntp, maximumCacheBytes = 16 * 1024 * 1024) {
  const layout = postedFileByteLayout(posted);
  const maxArticleAttempts = 6;
  const width = settings.backgroundJob ? 1 : Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, posted.segments.length);
  const lanes = Array.from({ length: width }, () => ({ client: null, tail: Promise.resolve(), pending: 0 }));
  const prefetched = new Map(prefetchedSegments);
  let cachedBytes = [...prefetched.values()].reduce((total, bytes) => total + bytes.length, 0);
  const remember = (index, bytes) => {
    if (bytes.length > maximumCacheBytes) return;
    prefetched.set(index, bytes);
    cachedBytes += bytes.length;
    while (cachedBytes > maximumCacheBytes && prefetched.size) {
      const oldest = prefetched.keys().next().value;
      cachedBytes -= prefetched.get(oldest).length;
      prefetched.delete(oldest);
    }
  };
  const inflight = /* @__PURE__ */ new Map();
  let nextLane = 0;
  const load = (segment, index) => {
    if (prefetched.has(index)) return Promise.resolve(prefetched.get(index));
    if (inflight.has(index)) return inflight.get(index);
    let selected = nextLane;
    for (let offset = 1; offset < lanes.length; offset++) {
      const candidate = (nextLane + offset) % lanes.length;
      if (lanes[candidate].pending < lanes[selected].pending) selected = candidate;
    }
    nextLane = (selected + 1) % lanes.length;
    const lane = lanes[selected];
    lane.pending++;
    const pending = lane.tail.then(async () => {
      clearTimeout(lane.idleTimer);
      for (let attempt = 0; attempt < maxArticleAttempts; attempt++) {
        const chunks = [];
        try {
          lane.client ||= await connect(settings);
          let fileSize = null, partBegin = null, partEnd = null, partSize = null;
          const number = (line, key) => Number(line.match(new RegExp(`\\b${key}=(\\d+)`))?.[1]);
          await lane.client.body(segment.id, (line) => {
            if (line.startsWith("=ybegin ")) fileSize = number(line, "size");
            else if (line.startsWith("=ypart ")) {
              partBegin = number(line, "begin");
              partEnd = number(line, "end");
            } else if (line.startsWith("=yend ")) partSize = number(line, "size");
            else chunks.push(decodeYenc(line));
          });
          const decoded = Buffer.concat(chunks);
          if (segment.decodedBytes != null && decoded.length !== segment.decodedBytes || partSize !== null && partSize !== decoded.length || layout && (fileSize !== null && fileSize !== layout.total || partBegin !== null && partBegin !== layout.offsets[index] + 1 || partEnd !== null && partEnd !== layout.offsets[index + 1])) {
            throw Object.assign(new Error("Usenet segment did not match its yEnc byte metadata."), { code: "INVALID_USENET_ARTICLE" });
          }
          remember(index, decoded);
          if (settings.downloadNextEpisode) {
            lane.idleTimer = setTimeout(() => {
              lane.client?.close();
              lane.client = null;
            }, 1e3);
            lane.idleTimer.unref();
          }
          return decoded;
        } catch (error) {
          lane.client?.discard?.();
          lane.client?.close();
          lane.client = null;
          if (attempt === maxArticleAttempts - 1 || error.code !== "INVALID_USENET_ARTICLE" && attempt >= 1) throw error;
        }
      }
    });
    lane.tail = pending.then(() => {
      lane.pending--;
    }, () => {
      lane.pending--;
    });
    inflight.set(index, pending);
    void pending.finally(() => {
      if (inflight.get(index) === pending) inflight.delete(index);
    }).catch(() => {
    });
    return pending;
  };
  return {
    load,
    concurrency: width,
    async close() {
      await Promise.all(lanes.map((lane) => lane.tail));
      for (const lane of lanes) {
        clearTimeout(lane.idleTimer);
        lane.client?.close();
      }
    }
  };
}
function progressiveArchiveVolumes(archives) {
  const names = archiveFilenames(archives);
  if (names.length === 1 && /\.(7z|zip|rar)$/i.test(names[0])) return archives;
  const volumes = names.map((name, index) => {
    let match = /^(.*\.7z)\.(\d{3,})$/i.exec(name);
    if (!match) match = /^(.*)\.part(\d+)\.rar$/i.exec(name);
    if (match) return { base: match[1], number: Number(match[2]), file: archives[index] };
    match = /^(.*)\.(rar|r\d{2})$/i.exec(name);
    return match ? { base: match[1], number: match[2].toLowerCase() === "rar" ? 1 : Number(match[2].slice(1)) + 2, file: archives[index] } : null;
  });
  if (!volumes.length || volumes.some((volume) => !volume || volume.base !== volumes[0].base)) return null;
  volumes.sort((a, b) => a.number - b.number);
  return volumes.every((volume, index) => volume.number === index + 1) ? volumes.map((volume) => volume.file) : null;
}
async function openArchiveByteInput(archives, settings, connect = connectNntp, onSourceError = () => {
}) {
  const ordered = progressiveArchiveVolumes(archives);
  if (!ordered) throw new Error("This archive layout requires full download and extraction.");
  const controller = new AbortController();
  const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
  const nextSettings = { ...settings, signal };
  const files = ordered.map((file) => ({ ...file, segments: file.segments.map((segment) => ({ ...segment })) }));
  const loaders = /* @__PURE__ */ new Map();
  let closing;
  async function inspect(file) {
    const client = await connect(nextSettings), chunks = [];
    let decodedSize = 0, partBegin = 0, partEnd = 0, declared = 0;
    const number = (line, key) => Number(line.match(new RegExp(`\\b${key}=(\\d+)`))?.[1]) || 0;
    try {
      await client.body(file.segments[0].id, (line) => {
        if (line.startsWith("=ybegin ")) decodedSize = number(line, "size");
        else if (line.startsWith("=ypart ")) {
          partBegin = number(line, "begin");
          partEnd = number(line, "end");
        } else if (line.startsWith("=yend ")) declared = number(line, "size");
        else chunks.push(decodeYenc(line));
      });
      const first = Buffer.concat(chunks);
      if (partBegin && partBegin !== 1 || declared && declared !== first.length || !applyYencByteLayout(file, { decodedSize, partBegin, partEnd, firstBytes: first.length }) || file.segments[0].decodedBytes !== first.length) throw new Error("Archive byte layout is not usable for progressive playback.");
      return first;
    } finally {
      client.close();
    }
  }
  async function close() {
    if (!closing) {
      controller.abort();
      closing = Promise.all([...loaders.values()].map((loader) => loader.close())).then(() => {
      });
    }
    return closing;
  }
  try {
    const first = await inspect(files[0]);
    const last = files.length > 1 ? await inspect(files.at(-1)) : first;
    const volumeSize = postedFileByteLayout(files[0]).total;
    for (let index = 1; index < files.length - 1; index++) {
      if (!applyYencByteLayout(files[index], { decodedSize: volumeSize, firstBytes: first.length })) throw new Error("Archive volume sizes require full download.");
    }
    const offsets = [0];
    for (const file of files) offsets.push(offsets.at(-1) + postedFileByteLayout(file).total);
    if (!Number.isSafeInteger(offsets.at(-1))) throw new Error("Archive size exceeds the supported range.");
    const headers = /* @__PURE__ */ new Map([[0, first], [files.length - 1, last]]);
    const getLoader = async (index) => {
      if (loaders.has(index)) {
        const loader2 = loaders.get(index);
        loaders.delete(index);
        loaders.set(index, loader2);
        return loader2;
      }
      while (loaders.size >= 3) {
        const oldest = loaders.keys().next().value;
        await loaders.get(oldest).close();
        loaders.delete(oldest);
      }
      const loader = createPostedSegmentLoader(files[index], nextSettings, headers.has(index) ? /* @__PURE__ */ new Map([[0, headers.get(index)]]) : /* @__PURE__ */ new Map(), connect, 8 * 1024 * 1024);
      loaders.set(index, loader);
      return loader;
    };
    let reads = Promise.resolve();
    return {
      size: offsets.at(-1),
      volumeOffsets: offsets,
      close,
      read(start, end, requestSignal) {
        const result = reads.then(async () => {
          signal.throwIfAborted();
          requestSignal?.throwIfAborted();
          const chunks = [];
          for (let index = 0; index < files.length && offsets[index] <= end; index++) {
            if (offsets[index + 1] <= start) continue;
            const loader = await getLoader(index);
            await writePostedFileRange(
              files[index],
              Math.max(0, start - offsets[index]),
              Math.min(end, offsets[index + 1] - 1) - offsets[index],
              loader.load,
              (chunk) => {
                chunks.push(chunk);
              },
              { concurrency: loader.concurrency, shouldContinue: () => !signal.aborted && !requestSignal?.aborted }
            );
          }
          signal.throwIfAborted();
          requestSignal?.throwIfAborted();
          return Buffer.concat(chunks);
        });
        reads = result.catch(() => {
        });
        return result.catch((error) => {
          onSourceError(error);
          throw error;
        });
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}
async function progressiveSource(job, settings) {
  if (job.archiveSource && !job.archiveSource.closed && !job.archiveSource.failure) return job.archiveSource;
  if (job.archiveSourcePromise) return job.archiveSourcePromise;
  job.archiveSourcePromise = (async () => {
    await job.archiveSource?.close();
    const release = job.release, releaseKey = job.releaseKey || release;
    const input = await openArchiveByteInput(job.archives, settings, connectNntp, (error) => rejectPlaybackSource(job, settings, release, releaseKey, error));
    try {
      await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
      const source = await tryCreateStoredRarSource(input, { verify: async (signal) => {
        const checkSettings = { ...settings, signal };
        const checkInput = await openArchiveByteInput(
          job.archives,
          checkSettings,
          connectNntp,
          (error) => rejectPlaybackSource(job, checkSettings, release, releaseKey, error)
        );
        let check;
        try {
          check = await createProgressiveArchiveSource(checkInput, { root: PLAYBACK_CACHE_ROOT, startupTimeoutMs: 12e4 });
          const lease = check.retain();
          try {
            await check.completion;
          } finally {
            lease.close();
          }
        } finally {
          if (check) await check.close();
          else await checkInput.close();
        }
      } }) || await createProgressiveArchiveSource(input, { root: PLAYBACK_CACHE_ROOT, startupTimeoutMs: 12e4 });
      job.archiveSource = source;
      return source;
    } catch (error) {
      await input.close();
      throw error;
    }
  })();
  try {
    return await job.archiveSourcePromise;
  } finally {
    delete job.archiveSourcePromise;
  }
}
async function openPostedRangeServer(job, settings, connect = connectNntp, options = {}) {
  if (job.progressiveArchive) return (await progressiveSource(job, settings)).retain(options);
  const posted = job.file, release = job.release, releaseKey = job.releaseKey || release;
  const layout = postedFileByteLayout(posted);
  if (!layout) return null;
  const loader = createPostedSegmentLoader(posted, settings, job.prefetchedSegments, connect);
  const load = (segment, index) => resumeSegments.load(posted, index, async () => {
    if (settings.usenetHost) {
      const cached = await playbackPersistence.getSegment(posted, index, settings).catch(() => null);
      if (cached) return cached;
    }
    const bytes = await loader.load(segment, index);
    if (settings.usenetHost) playbackPersistence.setSegment(posted, index, settings, bytes);
    return bytes;
  });
  const server = createServer((req, res) => {
    void (async () => {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405, { allow: "GET, HEAD" });
        return res.end();
      }
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      let start = range?.[1] ? Number(range[1]) : 0;
      let end = range?.[2] ? Number(range[2]) : layout.total - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= layout.total || end < start) {
        res.writeHead(416, { "content-range": `bytes */${layout.total}` });
        return res.end();
      }
      end = Math.min(end, layout.total - 1);
      const partial = Boolean(range);
      res.writeHead(partial ? 206 : 200, {
        "content-type": videoType(job.file.subject),
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        ...partial ? { "content-range": `bytes ${start}-${end}/${layout.total}` } : {}
      });
      if (req.method === "HEAD") return res.end();
      let aborted = false;
      res.on("close", () => {
        aborted = true;
      });
      await writePostedFileRange(posted, start, end, load, async (chunk) => {
        if (!res.write(chunk)) await waitForDrain(res);
      }, { shouldContinue: () => !aborted, concurrency: loader.concurrency });
      if (!aborted) res.end();
    })().catch((error) => {
      if (job.file === posted) rejectPlaybackSource(job, settings, release, releaseKey, error);
      if (res.headersSent) res.destroy(error);
      else {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve2);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/video`,
    async close() {
      await new Promise((resolve2) => server.close(resolve2));
      await loader.close();
    }
  };
}
function rejectPlaybackSource(job, settings, release, releaseKey, error) {
  if (!["INVALID_USENET_ARTICLE", "USENET_ARTICLE_MISSING"].includes(error.code) || (job.releaseKey || job.release) !== releaseKey) return;
  job.rejectedReleases ||= /* @__PURE__ */ new Set();
  if (job.rejectedReleases.has(releaseKey)) return;
  job.rejectedReleases.add(releaseKey);
  if (settings.usenetHost) void releaseHealth.reject(settings, job.media, releaseKey).catch(() => {
  });
  playbackPlans.delete(job.media);
  archiveResumePlans.delete(job.media);
  void playbackPersistence.deletePlan(job.media).catch(() => {
  });
  jobEvent(job, "source-rejected", "The provider could not supply a valid video article. Trying another release on recovery.", { release });
}
async function recoverPlaybackSource(job, settings, prepare = preparePlayback) {
  if (job.sourceRecovery) return job.sourceRecovery;
  const unavailable = (message) => Object.assign(new Error(message), { code: "SOURCE_UNAVAILABLE" });
  if (job.sourceRecoveryError) throw unavailable(job.sourceRecoveryError);
  if (!job.rejectedReleases?.has(job.releaseKey || job.release)) return;
  if (job.manualRelease || job.rejectedReleases.size >= 3) throw unavailable("This source is invalid. Try downloading another release.");
  job.sourceRecovery = (async () => {
    await prepare(job, settings);
    if (job.status !== "ready" || job.mode !== "direct" || job.rejectedReleases.has(job.releaseKey || job.release)) {
      throw unavailable("This release has missing or invalid video data, and no replacement streaming source is available. Try downloading another release.");
    }
  })();
  try {
    await job.sourceRecovery;
  } catch (error) {
    job.sourceRecoveryError = error.message;
    throw unavailable(error.message);
  } finally {
    delete job.sourceRecovery;
  }
}
function preferredAudioStream(streams, untaggedAudioTrack = 2) {
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  const english = audio.find((stream) => /^(eng|en|en-us|en-gb)$/i.test(stream.tags?.language || "")) || audio.find((stream) => /\b(english|eng)\b/i.test(`${stream.tags?.title || ""} ${stream.tags?.handler_name || ""}`));
  return (english || audio[Math.min(7, Math.max(0, (Number(untaggedAudioTrack) || 2) - 1))] || audio[0])?.index ?? null;
}
function playbackTimelineIssue(packets, videoIndex, audioIndex) {
  const timestamps = (index) => packets.filter((packet) => packet.stream_index === index).map((packet) => Number(packet.dts_time)).filter(Number.isFinite);
  const gaps = (times, minimum) => {
    const result = [];
    let end;
    for (const time of times) {
      if (end !== void 0 && time - end > minimum) result.push({ start: end, end: time });
      end = Math.max(end ?? time, time);
    }
    return result;
  };
  const videoTimes = timestamps(videoIndex);
  const audioTimes = timestamps(audioIndex);
  const videoGaps = gaps(videoTimes, 1);
  const videoOnly = videoGaps.find((video) => audioTimes.some((time) => time > video.start + 0.1 && time < video.end - 0.1));
  if (videoOnly) return { type: "video-only", ...videoOnly };
  const audioGaps = gaps(audioTimes, 3);
  const shared = videoGaps.find((video) => audioGaps.some((audio) => Math.min(video.end, audio.end) - Math.max(video.start, audio.start) > 3));
  return shared ? { type: "shared", ...shared } : null;
}
function frameRate(stream) {
  for (const value of [stream?.r_frame_rate, stream?.avg_frame_rate]) {
    const [numerator, denominator] = String(value || "").split("/").map(Number);
    const rate = denominator ? numerator / denominator : Number(value);
    if (Number.isFinite(rate) && rate > 0 && rate <= 240) return rate;
  }
  return 0;
}
async function inspectPlaybackSource(input, untaggedAudioTrack = 2, { fullTimeline = false, repairVideoTimeline = false, audioIndex: selectedAudioIndex } = {}) {
  const interval = fullTimeline ? [] : ["-read_intervals", "0%+20"];
  const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-rw_timeout", "15000000", ...interval, "-show_packets", "-show_entries", "packet=stream_index,dts_time:format=duration:stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate:stream_tags=language,title,handler_name", "-of", "json", input]));
  const audioIndex = selectedAudioIndex ?? preferredAudioStream(probe.streams || [], untaggedAudioTrack);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const issue = playbackTimelineIssue(probe.packets || [], video?.index, audioIndex);
  if (issue && !(issue.type === "video-only" && repairVideoTimeline && frameRate(video))) {
    throw Object.assign(new Error("This release has a gap in its audio and video timeline. Trying another release."), { code: "INVALID_MEDIA_TIMELINE" });
  }
  if (fullTimeline) await validateOpeningVideoDecode(input);
  const duration = Number(probe.format?.duration);
  return {
    audioIndex,
    videoCodec: video?.codec_name || null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    ...issue?.type === "video-only" ? { repairVideoFrameRate: frameRate(video), timelineIssue: issue } : {}
  };
}
async function validateOfflinePlaybackRecord(record, settings = {}, inspect = inspectPlaybackSource) {
  if (record.timelineValidated && record.decodeValidated) return record;
  const metadata = await inspect(record.sourcePath || record.path, Number(settings.untaggedAudioTrack) || 2, {
    fullTimeline: true,
    ...settings.repairVideoTimeline ? { repairVideoTimeline: true } : {}
  });
  if (metadata?.repairVideoFrameRate) return { ...record, timelineRepairRequired: true, repairVideoFrameRate: metadata.repairVideoFrameRate };
  return { ...record, timelineValidated: true, decodeValidated: true };
}
const playbackInspections = createValidatedPreparationCache();
function playbackInspection(job, settings, input) {
  const source = ["cached-convert", "cached"].includes(job.mode) ? job : job.file;
  const scope = playbackScope(settings);
  return playbackInspections.get(source, scope, async (publish) => {
    const persistent = job.mode !== "cached-convert" && !job.progressiveArchive && settings.usenetHost;
    const saved = persistent && await playbackPersistence.getProbe(source, settings).catch(() => null);
    if (saved && Array.isArray(saved.tracks) && (saved.audioIndex === null || Number.isInteger(saved.audioIndex) && saved.audioIndex >= 0) && Number.isFinite(saved.duration) && saved.duration >= 0) {
      publish(saved);
      return saved;
    }
    jobEvent(job, "metadata-start", "Reading source audio and duration metadata.");
    const inputOptions = job.progressiveArchive && !job.archiveSource?.complete ? ["-seekable", "0"] : [];
    const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-show_entries", "format=duration:stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate:stream_tags=language,title,handler_name", "-of", "json", ...inputOptions, input], void 0, settings.signal));
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const metadata = { tracks: playbackTracks(probe.streams), audioIndex: preferredAudioStream(probe.streams || [], settings.untaggedAudioTrack), duration: Number.isFinite(Number(probe.format?.duration)) ? Math.max(0, Number(probe.format.duration)) : 0, videoFrameRate: frameRate(video), videoCodec: video?.codec_name || null };
    const videoIndex = video?.index;
    publish(metadata);
    jobEvent(job, "metadata-ready", "Source audio and duration identified.");
    const timeline = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-read_intervals", "0%+20", "-show_packets", "-show_entries", "packet=stream_index,dts_time", "-of", "json", ...inputOptions, input], void 0, settings.signal));
    const issue = playbackTimelineIssue(timeline.packets || [], videoIndex, metadata.audioIndex);
    if (issue && !(issue.type === "video-only" && settings.repairVideoTimeline && metadata.videoFrameRate)) {
      throw Object.assign(new Error("This release has a gap in its opening audio and video timeline. Trying another release."), { code: "INVALID_MEDIA_TIMELINE" });
    }
    if (issue?.type === "video-only") metadata.repairVideoFrameRate = metadata.videoFrameRate;
    jobEvent(job, "timeline-validated", "Opening audio and video timeline validated.");
    if (persistent) await playbackPersistence.setProbe(source, settings, metadata).catch(() => {
    });
    return metadata;
  }, settings.signal);
}
async function startHlsConversion(job, settings, start, directory, onProgress = () => {
}, getPacing = hlsPacing, getInspection = playbackInspection, { audioTrack } = {}) {
  const cached = ["cached-convert", "cached"].includes(job.mode);
  let rangeSource;
  const requestedStrategy = seekPlaybackStrategy(job.strategy === "raw" ? "remux" : job.strategy, start);
  const toneMap = playbackNeedsToneMapping(job);
  let producer;
  try {
    const growing = job.progressiveArchive && !job.archiveSource?.complete;
    const forwardSeek = growing && start > 0 && videoType(job.file.subject) === "video/x-matroska";
    rangeSource = !cached ? await openPostedRangeServer(job, settings, void 0, { forwardSeek }) : null;
    if (!cached && !rangeSource) throw new Error("This release lacks the byte layout required for segmented playback. Try preparing a downloaded copy.");
    const input = cached ? job.sourcePath || job.path : rangeSource.url;
    const inspection = getInspection(job, settings, input);
    const [metadata, pacing] = await Promise.all([inspection.metadata, getPacing(growing && !forwardSeek ? start : 0)]);
    if (settings.repairVideoTimeline) await inspection.validated;
    let repairVideoFrameRate = settings.repairVideoTimeline ? metadata.repairVideoFrameRate || null : null;
    if (job.media?.type === "tv") assertCompleteEpisodeDuration(metadata.duration, Number(job.media.durationHint));
    let { audioIndex } = metadata;
    job.playbackTracks = metadata.tracks || [];
    job.selectedAudioTrack = audioIndex;
    if (audioTrack !== void 0 && audioTrack !== null) {
      if (!Number.isInteger(audioTrack) || !job.playbackTracks.some((track) => track.type === "audio" && track.index === audioTrack)) throw Object.assign(new Error("The selected audio track is unavailable."), { code: "INVALID_AUDIO_TRACK" });
      const selectedInspection = await inspectPlaybackSource(input, settings.untaggedAudioTrack, { audioIndex: audioTrack, repairVideoTimeline: settings.repairVideoTimeline });
      if (settings.repairVideoTimeline) repairVideoFrameRate = selectedInspection.repairVideoFrameRate || null;
      audioIndex = audioTrack;
      job.selectedAudioTrack = audioIndex;
    }
    const interpolate = Boolean(settings.frameInterpolation) && (!metadata.videoFrameRate || metadata.videoFrameRate < 60);
    const strategy = repairVideoFrameRate || interpolate ? "transcode" : requestedStrategy;
    const detectedAcceleration = repairVideoFrameRate ? null : await configurePlaybackAcceleration(job, strategy, toneMap, interpolate);
    const acceleration = detectedAcceleration?.kind === "vaapi" && !["h264", "hevc"].includes(metadata.videoCodec) ? null : detectedAcceleration;
    if (acceleration !== detectedAcceleration) {
      job.videoAcceleration = playbackAccelerationLabel(strategy, toneMap, null);
      jobEvent(job, "acceleration", job.videoAcceleration);
    }
    if (repairVideoFrameRate) {
      job.videoAcceleration = playbackAccelerationLabel(strategy, toneMap, null);
      jobEvent(job, "timeline-repair", "A video timestamp gap was detected. Repeating frames to preserve audio timing.");
    }
    job.sourceDuration = metadata.duration;
    const mapped = ffmpegArgs(strategy, input, "pipe:1", true, start, settings.untaggedAudioTrack, !growing || forwardSeek, toneMap, acceleration, repairVideoFrameRate, interpolate);
    if (interpolate) jobEvent(job, "frame-interpolation", "Generating motion-compensated intermediate frames at 60 FPS.");
    if (growing) {
      mapped.splice(mapped.indexOf("-i"), 0, ...forwardSeek ? ["-fflags", "+ignidx"] : ["-seekable", "0"]);
      const timeout = mapped.indexOf("-rw_timeout");
      if (timeout >= 0) mapped[timeout + 1] = "0";
    }
    for (let i = mapped.length - 2; i >= 0; i--) {
      if (mapped[i] === "-map" && mapped[i + 1] !== "0:v:0") mapped.splice(i, 2);
    }
    if (audioIndex !== null) mapped.splice(mapped.indexOf("-movflags"), 0, "-map", `0:${audioIndex}`);
    mapped.splice(mapped.indexOf("-movflags"), 0, "-ac", "2");
    const segmentSeconds = strategy === "remux" ? 4 : 2;
    const args = hlsOutputArgs(mapped, directory, segmentSeconds);
    args.splice(args.indexOf("-i"), 0, ...pacing);
    if (strategy !== "remux") args.splice(args.indexOf("-f"), 0, "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`);
    producer = await startHlsProducer(args, rangeSource, Math.max(0, metadata.duration - start), settings.signal);
    producer.interpolated = interpolate;
    jobEvent(job, "encoding-start", "Preparing the first playback segments.", { start });
    onProgress(1);
    await Promise.race([inspection.validated, producer.completion.then(() => inspection.validated)]);
    if (job.progressiveArchive) {
      const { archiveSource, archives, file, release, releaseKey, strategy: strategy2 } = job;
      archiveResumePlans.set(job.media, playbackScope(settings), { archiveSource, archives, file, release, releaseKey, strategy: strategy2, progressiveArchive: true });
    }
    return producer;
  } catch (error) {
    await producer?.stop();
    await rangeSource?.close();
    if (job.progressiveArchive && job.archives && !["INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DURATION", "INVALID_AUDIO_TRACK"].includes(error.code) && !settings.signal?.aborted) {
      job.progressiveArchiveDisabled = true;
      await prepareArchive(job, settings, job.archives);
      if (job.status !== "ready") throw new Error(job.message || "Archive fallback failed.");
      for (const name of await readdir(directory)) if (/^(index\.m3u8|init\.mp4|segment-\d+\.m4s)(\.tmp)?$/.test(name)) await rm(join(directory, name), { force: true });
      return startHlsConversion(job, settings, start, directory, onProgress, getPacing, getInspection, { audioTrack });
    }
    if (["INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DURATION"].includes(error.code) && !cached) {
      job.rejectedReleases ||= /* @__PURE__ */ new Set();
      job.rejectedReleases.add(job.releaseKey || job.release);
      await releaseHealth.reject(settings, job.media, job.releaseKey || job.release);
      playbackPlans.delete(job.media);
      await playbackPersistence.deletePlan(job.media).catch(() => {
      });
      jobEvent(job, "source-rejected", error.message, { release: job.release });
      await recoverPlaybackSource(job, settings);
      for (const name of await readdir(directory)) if (/^(index\.m3u8|init\.mp4|segment-\d+\.m4s)(\.tmp)?$/.test(name)) await rm(join(directory, name), { force: true });
      return startHlsConversion(job, settings, start, directory, onProgress, getPacing, getInspection, { audioTrack });
    }
    throw error;
  }
}
function assertPlayableHlsOpening(streams = []) {
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const videoStart = Number(video?.start_time), audioStart = Number(audio?.start_time);
  if (!video || !Number.isFinite(videoStart) || videoStart > 3 || videoStart < -0.5 || audio && (!Number.isFinite(audioStart) || audioStart > 3 || Math.abs(videoStart - audioStart) > 2)) {
    throw Object.assign(new Error("The first playback segment has a gap in its video or audio timeline."), { code: "INVALID_MEDIA_TIMELINE" });
  }
}
async function preflightLiveCandidate(job, settings, start = 0, { sessionFactory = createHlsSession, convert = startHlsConversion, inspect = async (directory, signal) => JSON.parse(await runOutput("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", join(directory, "index.m3u8")], void 0, AbortSignal.any([signal, AbortSignal.timeout(5e3)]))).streams, wait = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms)), sampleMs = 6e3 } = {}) {
  const id = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Playback speed check timed out.")), 3e4);
  const removeCancelHandler = onDownloadCancel(job, () => controller.abort(new Error("Playback check cancelled.")));
  const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
  let session;
  try {
    session = await sessionFactory({ root: PLAYBACK_CACHE_ROOT, produce: (directory) => convert(job, { ...settings, signal }, start, directory), onClose: () => hlsSessions.delete(id) });
    const deadline = performance.now() + 15e3;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      try {
        if ((await session.read("index.m3u8")).includes("#EXTINF:")) break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await wait(200);
    }
    if (performance.now() >= deadline) throw new Error("No playable segment arrived during the playback speed check.");
    assertPlayableHlsOpening(await inspect(session.directory, signal));
    const first = session.health().position;
    await wait(sampleMs);
    signal.throwIfAborted();
    const health = session.health(), last = health.position;
    if (health.failed || health.closed) throw new Error("The playback converter stopped during its speed check.");
    if (!health.completed && last - first < sampleMs / 1e3 * 1.1) {
      throw Object.assign(new Error("This release cannot produce playback segments faster than viewing speed."), { code: "PLAYBACK_TOO_SLOW" });
    }
    clearTimeout(timeout);
    hlsSessions.set(id, { jobId: job.id, session });
    return { playlistUrl: `/api/play/${job.id}/hls/${id}/index.m3u8`, sessionUrl: `/api/play/${job.id}/hls/${id}`, duration: job.sourceDuration || 0, tracks: job.playbackTracks || [], selectedAudioTrack: job.selectedAudioTrack, captionsAvailable: false, start };
  } catch (error) {
    await session?.close();
    throw error;
  } finally {
    clearTimeout(timeout);
    removeCancelHandler();
  }
}
async function startHlsProducer(args, rangeSource, expectedDuration = 0, signal) {
  const release = await conversionAdmission.acquire({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3e4)]) : AbortSignal.timeout(3e4) });
  const child = spawn("ffmpeg", ["-progress", "pipe:3", ...args], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let stderr = "", closed = false, paused = false, outputPosition = 0, progress = "";
  child.stdio[3].on("data", (chunk) => {
    progress += chunk;
    let newline;
    while ((newline = progress.indexOf("\n")) >= 0) {
      const line = progress.slice(0, newline);
      progress = progress.slice(newline + 1);
      if (line.startsWith("out_time_us=")) outputPosition = Math.max(outputPosition, Number(line.slice(12)) / 1e6 || 0);
    }
    progress = progress.slice(-1024);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8e3);
  });
  child.stdin.on("error", () => {
  });
  const exited = once(child, "close");
  void exited.catch(() => {
  });
  const completion = (async () => {
    try {
      const [code] = await exited;
      if (!closed && !conversionSucceeded(code, stderr, 1, { httpReconnect: Boolean(rangeSource) })) throw new Error(`Video conversion failed: ${stderr.trim() || `ffmpeg exited ${code}`}`);
    } finally {
      release();
      stopConversion(child);
      await rangeSource?.close();
    }
  })();
  void completion.catch(() => {
  });
  return { completion, expectedDuration, position: () => outputPosition, setPaused(value) {
    if (closed || process.platform === "win32" || paused === value || child.exitCode !== null) return;
    if (child.kill(value ? "SIGSTOP" : "SIGCONT")) paused = value;
  }, async stop() {
    closed = true;
    if (paused) child.kill("SIGCONT");
    stopConversion(child);
    await completion.catch(() => {
    });
  } };
}
async function streamConverted(req, res, job, settings, start = 0, strategyOverride = "") {
  const rangeSource = start > 0 || job.progressiveArchive ? await openPostedRangeServer(job, settings) : null;
  const strategy = settings.frameInterpolation ? "transcode" : seekPlaybackStrategy(strategyOverride || playbackStrategy(job.file.subject, job.release), start);
  const toneMap = playbackNeedsToneMapping(job);
  const acceleration = await configurePlaybackAcceleration(job, strategy, toneMap, Boolean(settings.frameInterpolation));
  const growing = job.progressiveArchive && !job.archiveSource?.complete;
  const args = ffmpegArgs(strategy, rangeSource?.url || "pipe:0", "pipe:1", true, start, settings.untaggedAudioTrack, Boolean(rangeSource) && !growing, toneMap, acceleration, null, Boolean(settings.frameInterpolation));
  if (growing) args.splice(args.indexOf("-i"), 0, "-seekable", "0");
  const child = spawn("ffmpeg", args);
  let stderr = "";
  const exited = once(child, "close");
  void exited.catch(() => {
  });
  let closed = false;
  child.stderr.on("data", (chunk) => stderr += chunk);
  child.stdin.on("error", () => {
  });
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  const output = writeStreamToResponse(child.stdout, res, { end: false });
  void output.catch(() => {
  });
  req.on("close", () => {
    closed = true;
    stopConversion(child);
  });
  try {
    if (!rangeSource) {
      await streamPostedFile(job.file, settings, async (chunk) => {
        if (closed) throw new Error("Playback connection closed.");
        if (!child.stdin.write(chunk)) await waitForDrain(child.stdin);
      }, connectNntp, job.prefetchedSegments);
      child.stdin.end();
    }
    const [code] = await exited;
    const bytes = await output;
    if (!closed && !conversionSucceeded(code, stderr, bytes, { httpReconnect: Boolean(rangeSource) })) throw new Error(`Video conversion failed: ${stderr.trim() || (bytes ? `ffmpeg exited ${code}` : "ffmpeg produced no video")}`);
    if (!closed) res.end();
  } catch (error) {
    stopConversion(child);
    await output.catch(() => {
    });
    if (!closed) throw error;
  } finally {
    await rangeSource?.close();
  }
}
async function streamCachedConversion(req, res, job, settings, start = 0) {
  const toneMap = playbackNeedsToneMapping(job);
  const acceleration = await configurePlaybackAcceleration(job, settings.frameInterpolation ? "transcode" : job.strategy, toneMap, Boolean(settings.frameInterpolation));
  const child = spawn("ffmpeg", ffmpegArgs(job.strategy, job.sourcePath || job.path, "pipe:1", true, start, settings.untaggedAudioTrack, true, toneMap, acceleration, null, Boolean(settings.frameInterpolation)));
  let stderr = "";
  const exited = once(child, "close");
  void exited.catch(() => {
  });
  let closed = false;
  child.stderr.on("data", (chunk) => stderr += chunk);
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  const output = writeStreamToResponse(child.stdout, res, { end: false });
  void output.catch(() => {
  });
  req.on("close", () => {
    closed = true;
    stopConversion(child);
  });
  const [code] = await exited;
  const bytes = await output;
  if (closed) return;
  if (!conversionSucceeded(code, stderr, bytes)) throw new Error(`Video conversion failed: ${stderr.trim() || (bytes ? `ffmpeg exited ${code}` : "ffmpeg produced no video")}`);
  res.end();
}
function firstArchive(archives) {
  return archives.find((item) => /\.part0*1\.rar/i.test(item.subject)) || archives.find((item) => /\.rar/i.test(item.subject)) || archives.find((item) => /\.(?:7z|zip)\.0*1/i.test(item.subject)) || archives.find((item) => /\.(?:7z|zip)/i.test(item.subject));
}
async function extractPostedArchive(directory, archives, names = archiveFilenames(archives), job) {
  const first = firstArchive(archives);
  if (!first) throw new Error("No supported archive entry point was found.");
  const name = names[archives.indexOf(first)];
  if (/\.(?:rar|r\d\d)$/i.test(name)) await run("unrar", ["x", "-o+", "-idq", "-p-", name], directory, job);
  else await run("7z", ["x", "-y", "-p-", name, `-o${directory}`], directory, job);
}
async function tmdbRequest(settings, path, params = {}) {
  if (!settings.tmdbToken) throw new Error("Add a TMDB read access token in settings before browsing.");
  const endpoint = new URL(path, "https://api.themoviedb.org/3/");
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
  const reply = await fetch(endpoint, { headers: { Authorization: `Bearer ${settings.tmdbToken}`, accept: "application/json" }, signal: AbortSignal.timeout(12e3) });
  if (!reply.ok) {
    const payload = await reply.json().catch(() => ({}));
    if (reply.status === 429) {
      const retryAfter = reply.headers.get("retry-after");
      const message = `TMDB's short-term rate limit was reached.${retryAfter ? ` Try again in ${retryAfter} seconds.` : " Try again shortly."}`;
      throw Object.assign(new Error(message), { status: 429 });
    }
    throw new Error(payload.status_message || payload.message || `TMDB returned HTTP ${reply.status}.`);
  }
  return reply.json();
}
async function catalogueSearch(settings, query) {
  return mapTmdbTitles(await tmdbRequest(settings, "search/multi", { query, include_adult: false, language: "en-GB" }));
}
async function fetchDiscoveryShelves(request) {
  const movieGenres = (await request("genre/movie/list", { language: "en-GB" })).genres || [];
  const tvGenres = (await request("genre/tv/list", { language: "en-GB" })).genres || [];
  const genreId = (genres, name) => genres.find((genre) => genre.name.toLowerCase() === name.toLowerCase())?.id;
  const shelves = [
    { id: "popular-movies", title: "Popular movies", path: "movie/popular", type: "movie" },
    { id: "popular-shows", title: "Popular shows", path: "tv/popular", type: "tv" },
    { id: "netflix-shows", title: "Popular on Netflix", path: "discover/tv", type: "tv", network: 213 },
    { id: "prime-video-shows", title: "Popular on Prime Video", path: "discover/tv", type: "tv", network: 1024 },
    { id: "disney-plus-shows", title: "Popular on Disney+", path: "discover/tv", type: "tv", network: 2739 },
    { id: "apple-tv-shows", title: "Popular on Apple TV+", path: "discover/tv", type: "tv", network: 2552 },
    { id: "hbo-shows", title: "Popular on HBO", path: "discover/tv", type: "tv", network: 49 },
    { id: "bbc-one-shows", title: "Popular on BBC One", path: "discover/tv", type: "tv", network: 4 },
    { id: "itv1-shows", title: "Popular on ITV1", path: "discover/tv", type: "tv", network: 9 },
    { id: "channel-4-shows", title: "Popular on Channel 4", path: "discover/tv", type: "tv", network: 26 },
    { id: "sky-atlantic-shows", title: "Popular on Sky Atlantic", path: "discover/tv", type: "tv", network: 1063 },
    { id: "action-movies", title: "Action movies", path: "discover/movie", type: "movie", genre: genreId(movieGenres, "Action") },
    { id: "comedy-movies", title: "Comedy movies", path: "discover/movie", type: "movie", genre: genreId(movieGenres, "Comedy") },
    { id: "crime-movies", title: "Crime movies", path: "discover/movie", type: "movie", genre: genreId(movieGenres, "Crime") },
    { id: "science-fiction-movies", title: "Science fiction movies", path: "discover/movie", type: "movie", genre: genreId(movieGenres, "Science Fiction") },
    { id: "action-shows", title: "Action & adventure shows", path: "discover/tv", type: "tv", genre: genreId(tvGenres, "Action & Adventure") },
    { id: "comedy-shows", title: "Comedy shows", path: "discover/tv", type: "tv", genre: genreId(tvGenres, "Comedy") },
    { id: "crime-shows", title: "Crime shows", path: "discover/tv", type: "tv", genre: genreId(tvGenres, "Crime") },
    { id: "science-fiction-shows", title: "Sci-fi & fantasy shows", path: "discover/tv", type: "tv", genre: genreId(tvGenres, "Sci-Fi & Fantasy") }
  ].filter((shelf) => shelf.id.startsWith("popular-") || shelf.genre || shelf.network);
  const listed = [];
  for (const shelf of shelves) {
    const filtered = shelf.genre || shelf.network;
    const payload = await request(shelf.path, { language: "en-GB", page: 1, ...filtered ? { ...shelf.genre ? { with_genres: shelf.genre } : {}, ...shelf.network ? { with_networks: shelf.network } : {}, include_adult: false, sort_by: "popularity.desc", ...shelf.type === "movie" ? { include_video: false } : { include_null_first_air_dates: false } } : {} });
    listed.push({ id: shelf.id, title: shelf.title, items: mapTmdbTitles(payload, shelf.type).slice(0, 12) });
  }
  return listed;
}
async function catalogueDiscovery(settings) {
  if (discoveryCache?.expires > Date.now()) return discoveryCache.value;
  const stored = await readFile(DISCOVERY_CACHE_PATH, "utf8").then(JSON.parse).catch(() => null);
  if (stored?.value?.length && stored.expires > Date.now()) {
    discoveryCache = stored;
    return stored.value;
  }
  try {
    const value = await fetchDiscoveryShelves((path, params) => tmdbRequest(settings, path, params));
    discoveryCache = { value, expires: Date.now() + DISCOVERY_CACHE_MS };
    await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
    await writeFile(DISCOVERY_CACHE_PATH, JSON.stringify(discoveryCache), { mode: 384 });
    return value;
  } catch (error) {
    if (stored?.value?.length) {
      discoveryCache = { value: stored.value, expires: Date.now() + 6 * 60 * 60 * 1e3 };
      return stored.value;
    }
    throw error;
  }
}
async function catalogueSeasons(settings, titleId) {
  return mapTmdbSeasons(await tmdbRequest(settings, `tv/${titleId}`, { language: "en-GB" }));
}
async function catalogueEpisodes(settings, titleId, season) {
  return mapTmdbEpisodes(await tmdbRequest(settings, `tv/${titleId}/season/${season}`, { language: "en-GB" }));
}
async function catalogueMovieRuntime(settings, titleId) {
  if (!runtimeCache) runtimeCache = await readFile(RUNTIME_CACHE_PATH, "utf8").then(JSON.parse).catch(() => ({}));
  const cached = runtimeCache[titleId];
  if (cached?.expires > Date.now()) return cached.duration;
  const duration = mapTmdbRuntime(await tmdbRequest(settings, `movie/${titleId}`, { language: "en-GB" }));
  runtimeCache[titleId] = { duration, expires: Date.now() + 7 * 24 * 60 * 60 * 1e3 };
  await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
  await writeFile(RUNTIME_CACHE_PATH, JSON.stringify(runtimeCache), { mode: 384 });
  return duration;
}
async function catalogueTitleDetails(settings, type, titleId) {
  return mapTmdbTitleDetails(await tmdbRequest(settings, `${type}/${titleId}`, { language: "en-GB" }), type);
}
async function catalogueAlternativeTitles(settings, media, { request = tmdbRequest } = {}) {
  if (!settings.tmdbToken || !Number.isInteger(Number(media.id)) || Number(media.id) <= 0 || !["movie", "tv"].includes(media.type)) return [];
  const payload = await request(settings, `${media.type}/${media.id}/alternative_titles`);
  const entries = media.type === "movie" ? payload.titles : payload.results;
  if (!Array.isArray(entries)) return [];
  const priority = { GB: 0, US: 1, CA: 2, AU: 3, NZ: 4, IE: 5 };
  return [...entries].sort((a, b) => (priority[a.iso_3166_1] ?? 6) - (priority[b.iso_3166_1] ?? 6)).map((entry) => String(entry.title || "").trim()).filter((title) => title.length >= 4 && /[a-z]/i.test(title)).filter((title, index, titles) => titles.findIndex((other) => other.toLowerCase() === title.toLowerCase()) === index).slice(0, 8);
}
async function findReleases(settings, media, includeYear = true, { request = fetch, alternativeTitles = catalogueAlternativeTitles } = {}) {
  const episodic = media.type === "tv" && media.season && media.episode;
  const searchTitle = async (title, mode2) => {
    const endpoint = indexerEndpoint(settings.indexerUrl);
    endpoint.searchParams.set("t", mode2);
    endpoint.searchParams.set("q", episodic && !includeYear ? `${title} ${episodeTag(media)}` : `${title} ${media.type === "movie" && includeYear ? media.year || "" : ""}`.trim());
    if (episodic && includeYear) {
      endpoint.searchParams.set("season", media.season);
      endpoint.searchParams.set("ep", media.episode);
    }
    endpoint.searchParams.set("apikey", settings.indexerKey);
    endpoint.searchParams.set("limit", "100");
    const releases = /* @__PURE__ */ new Map();
    for (let offset = 0; offset < 500; ) {
      settings.signal?.throwIfAborted();
      endpoint.searchParams.set("offset", String(offset));
      let xml;
      try {
        const reply = await request(new URL(endpoint), { signal: settings.signal ? AbortSignal.any([settings.signal, AbortSignal.timeout(12e3)]) : AbortSignal.timeout(12e3) });
        if (!reply.ok) throw new Error(`Indexer returned HTTP ${reply.status}.`);
        xml = await reply.text();
      } catch (error) {
        settings.signal?.throwIfAborted();
        if (!releases.size) throw error;
        break;
      }
      const page = searchResults(xml), before = releases.size;
      for (const release of page) releases.set(release.nzbUrl || release.title, release);
      if (!page.length || releases.size === before) break;
      offset += page.length;
      const total = Number(xml.match(/<(?:\w+:)?response\b[^>]*\btotal=["'](\d+)["']/i)?.[1]);
      if (Number.isFinite(total) ? offset >= total : page.length < 100) break;
    }
    return [...releases.values()];
  };
  const search = async (titles, mode2) => {
    const attempts = await Promise.allSettled(titles.map((title) => searchTitle(title, mode2)));
    const successful = attempts.filter((attempt) => attempt.status === "fulfilled");
    if (!successful.length) throw attempts[0].reason;
    return successful.flatMap((attempt) => attempt.value);
  };
  const fallbackSearch = async (titles, mode2) => search(titles, mode2).catch(() => {
    settings.signal?.throwIfAborted();
    return [];
  });
  const mode = episodic && !includeYear ? "search" : media.type === "movie" ? "movie" : "tvsearch";
  const primaryTitles = titleVariants(media.title);
  const primary = await search(primaryTitles, mode);
  const unique = (releases) => [...new Map(releases.map((release) => [release.nzbUrl || release.title, release])).values()];
  const rank = (releases, selection2 = media) => rankReleases(unique(releases), selection2, { playbackQuality: settings.playbackQuality });
  let candidates = primary;
  let ranked = rank(candidates);
  if (!ranked.length && media.type === "movie") {
    candidates = [...candidates, ...await fallbackSearch(primaryTitles, "search")];
    ranked = rank(candidates);
  }
  if (ranked.length || !settings.tmdbToken || !media.id) return ranked;
  const aliases = await alternativeTitles(settings, media).catch(() => {
    settings.signal?.throwIfAborted();
    return [];
  });
  settings.signal?.throwIfAborted();
  const extraTitles = [...new Set(aliases.flatMap(titleVariants))].filter((title) => !primaryTitles.includes(title)).slice(0, 8);
  const selection = { ...media, alternativeTitles: aliases };
  if (!extraTitles.length) return rank(candidates, selection);
  candidates = [...candidates, ...await fallbackSearch(extraTitles, mode)];
  ranked = rank(candidates, selection);
  if (!ranked.length && media.type === "movie") ranked = rank([...candidates, ...await fallbackSearch(extraTitles, "search")], selection);
  return ranked;
}
async function loadNzb(release, settings, signal) {
  const target = new URL(release.nzbUrl);
  if (!target.searchParams.has("apikey")) target.searchParams.set("apikey", settings.indexerKey);
  const reply = await fetch(target, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2e4)]) : AbortSignal.timeout(2e4) });
  if (!reply.ok) throw new Error(`Indexer returned HTTP ${reply.status} while loading an NZB.`);
  const nzb = await reply.text();
  if (!/<nzb[\s>]/i.test(nzb)) throw new Error(indexerError(nzb));
  return nzb;
}
async function probeObfuscatedNzb(nzb, settings) {
  const files = nzbFiles(nzb).filter((file) => file.segments.length), resolved = /* @__PURE__ */ new Map(), client = await connectNntp(settings);
  const probe = async (file) => {
    let detected;
    await client.body(file.segments[0].id, (line) => {
      if (!detected) detected = yencName(line);
    });
    const next = detected ? { ...file, subject: detected } : file;
    resolved.set(file, next);
    return next;
  };
  try {
    const likely = [...files].sort((a, b) => b.segments.length - a.segments.length).slice(0, 3);
    const firstPass = [];
    for (const file of likely) firstPass.push(await probe(file));
    const direct = videosFrom(firstPass)[0];
    if (direct) {
      client.close();
      return { direct, archives: [] };
    }
    if (archivesFrom(firstPass).length) {
      for (const file of files) if (!resolved.has(file)) await probe(file);
      const archives = archivesFrom([...resolved.values()]);
      client.close();
      return { direct: void 0, archives };
    }
    client.close();
    return { direct: void 0, archives: [] };
  } catch (error) {
    client.close();
    throw error;
  }
}
function jobEvent(job, activity, message, details = {}) {
  notifyPlayback(job);
  if (!job.diagnosticsEnabled) return;
  job.events ||= [];
  job.events.push({ at: Date.now(), activity, message, ...details });
  if (job.events.length > 80) job.events.splice(0, job.events.length - 80);
}
function setJob(job, status, message, progress = job.progress) {
  const changed = job.status !== status || job.message !== message;
  Object.assign(job, { status, message, progress });
  if (changed) jobEvent(job, status, message, { progress });
}
function updateDownload(job, state, maximum = 85) {
  const elapsed = Math.max((Date.now() - state.started) / 1e3, 0.1);
  const speed = state.bytes / elapsed;
  const remainingSeconds = state.completed ? Math.round(elapsed / state.completed * (state.total - state.completed)) : null;
  Object.assign(job, {
    progress: Math.min(maximum, Math.round(state.completed / state.total * maximum)),
    download: { completedSegments: state.completed, totalSegments: state.total, bytes: state.bytes, bytesPerSecond: speed, remainingSeconds },
    message: `Downloading · ${state.completed}/${state.total} segments${remainingSeconds ? ` · about ${remainingSeconds}s remaining` : ""}`
  });
}
async function writePostedFile(posted, path, settings, job, state, maximum) {
  return writePostedFiles([{ posted, path }], settings, job, state, maximum);
}
async function cacheDirect(job, settings) {
  setJob(job, "downloading", job.prepareAhead ? "Downloading the next episode in the background…" : "Direct playback was unavailable. Downloading the video first…", 0);
  await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
  const directory = job.directory || await mkdtemp(join(PLAYBACK_CACHE_ROOT, "playback-"));
  job.directory = directory;
  try {
    const path = join(directory, filename(job.file.subject, "video")), state = { completed: 0, total: job.file.segments.length, bytes: 0, started: Date.now() };
    await writePostedFile(job.file, path, preparationDownloadSettings(job, settings), job, state, 90);
    throwIfDownloadCancelled(job);
    setJob(job, "optimizing", job.prepareAhead ? "Download complete. Preparing a browser-ready copy…" : "Download complete. Checking browser compatibility…", 95);
    const optimized = await optimizeCachedVideo(job, path, settings);
    throwIfDownloadCancelled(job);
    Object.assign(job, { status: "ready", message: job.prepareAhead ? "Next episode is ready to play." : optimized.mode === "cached-convert" ? "Video prepared. Opening the browser stream…" : "Video prepared. Opening playback…", progress: 100, mode: "cached", ...optimized });
    jobEvent(job, "ready", job.message, { release: job.release || null, strategy: job.strategy || null, mode: job.mode });
  } catch (error) {
    throw error;
  }
}
async function writePostedFiles(files, settings, job, state, maximum = 85, connect = connectNntp) {
  return downloadPostedFiles(files, settings, job, state, { connect, decode: decodeYenc, progress: () => updateDownload(job, state, maximum) });
}
async function tryProgressiveArchive(job, settings, archives) {
  if (!job.progressiveArchiveDisabled && !job.offlineDownload && !job.prepareAhead && !job.backgroundFor && !job.downloadReplacement && progressiveArchiveVolumes(archives)) {
    setJob(job, "selecting", "Opening the archive for progressive playback…", 45);
    try {
      job.archives = archives;
      const source = await progressiveSource(job, settings);
      const suggested = playbackStrategy(source.metadata.name, job.release);
      Object.assign(job, { progressiveArchive: true, file: { subject: source.metadata.name }, strategy: suggested === "raw" ? "remux" : suggested, mode: "direct", status: "ready", progress: 100, message: "Archive video is ready for progressive playback." });
      jobEvent(job, "archive-progressive-ready", job.message, source.randomAccess ? { randomAccess: true, totalBytes: source.metadata.size } : { extractedBytes: source.available, totalBytes: source.metadata.size });
      return true;
    } catch (error) {
      if (error.code === "USENET_ARTICLE_MISSING" || /encrypt/i.test(error.message)) {
        throw Object.assign(new Error(error.code === "USENET_ARTICLE_MISSING" ? "Required archive articles are missing from the provider." : "This archive is encrypted and no archive password is available."), { code: "ARCHIVE_UNAVAILABLE" });
      }
      jobEvent(job, "archive-progressive-fallback", "Progressive extraction is unavailable. Preparing the full archive.", { reason: error.message });
    }
  }
  return false;
}
async function prepareArchive(job, settings, archives) {
  if (await tryProgressiveArchive(job, settings, archives)) return;
  await job.archiveSource?.close();
  delete job.archiveSource;
  if (job.progressiveArchive) delete job.file;
  delete job.progressiveArchive;
  setJob(job, "downloading", "This release cannot stream directly. Downloading the archive first…", 0);
  const previousDirectory = job.directory;
  const root = job.offlineDownload && previousDirectory ? previousDirectory : PLAYBACK_CACHE_ROOT;
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, job.offlineDownload ? "candidate-" : "playback-"));
  job.directory = directory;
  const names = archiveFilenames(archives);
  const total = archives.reduce((sum, file) => sum + file.segments.length, 0), state = { completed: 0, total, bytes: 0, started: Date.now() };
  try {
    const downloadSettings = preparationDownloadSettings(job, settings);
    await writePostedFiles(archives.map((posted, index) => ({ posted, path: join(directory, names[index]) })), downloadSettings, job, state, 85);
    throwIfDownloadCancelled(job);
    setJob(job, "extracting", "Download complete. Extracting the video…", 90);
    await extractPostedArchive(directory, archives, names, job);
    throwIfDownloadCancelled(job);
    const extracted = await extractedVideo(directory);
    if (!extracted) throw new Error("The archive did not contain a supported video file.");
    setJob(job, "optimizing", job.prepareAhead ? "Video extracted. Preparing a browser-ready copy…" : "Video extracted. Checking browser compatibility…", 95);
    const optimized = await optimizeCachedVideo(job, join(directory, extracted), settings);
    throwIfDownloadCancelled(job);
    Object.assign(job, { status: "ready", message: job.prepareAhead ? "Next episode is ready to play." : optimized.mode === "cached-convert" ? "Video prepared. Opening the browser stream…" : "Video prepared. Opening playback…", progress: 100, mode: "cached", ...optimized });
    jobEvent(job, "ready", job.message, { release: job.release || null, strategy: job.strategy || null, mode: job.mode });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    job.directory = previousDirectory;
    throw error;
  }
}
async function savedPlanAvailable(plan, settings) {
  const client = await connectNntp(settings);
  try {
    return await client.has(plan.file.segments[0].id) && await client.has(plan.file.segments.at(-1).id);
  } catch {
    return false;
  } finally {
    client.close();
  }
}
async function preparePlayback(job, settings, { search = findReleases, load = loadNzb, check = postedFileAvailable, archive = prepareArchive, cache = cacheDirect, progressive = archive === prepareArchive ? tryProgressiveArchive : null, health = releaseHealth, plans = playbackPlans, archivePlans = archiveResumePlans, persistence = plans === playbackPlans && settings.usenetHost ? playbackPersistence : null, verify = savedPlanAvailable, connectAhead = search === findReleases && load === loadNzb && check === postedFileAvailable ? (settings2) => nntpPool.warm(settings2) : null, preflight = check === postedFileAvailable ? preflightLiveCandidate : null, speedMeter = providerSpeed } = {}) {
  job.frameInterpolation = Boolean(settings.frameInterpolation);
  let failedPlanRelease = null;
  let savedDownloadChoice = null;
  try {
    if (job.progressiveArchive && job.rejectedReleases?.has(job.releaseKey || job.release)) {
      await job.archiveSource?.close();
      delete job.archiveSource;
      delete job.progressiveArchive;
      delete job.file;
    }
    throwIfDownloadCancelled(job);
    settings.signal?.throwIfAborted();
    if (!job.manualRelease) {
      let plan = plans.get(job.media, playbackScope(settings));
      if (!plan && persistence) {
        const saved = await persistence.getPlan(job.media, settings).catch(() => null);
        if (saved?.file?.segments?.length && postedFileByteLayout(saved.file) && !job.rejectedReleases?.has(saved.releaseKey || saved.release) && !await health.has(settings, job.media, saved.releaseKey || saved.release)) {
          if (await verify(saved, settings)) {
            plan = { ...saved, prefetchedSegments: /* @__PURE__ */ new Map() };
            plans.set(job.media, plan, playbackScope(settings));
            jobEvent(job, "persistent-plan-hit", "Reusing the validated source saved on disk.");
          }
        }
      }
      if (plan && !job.rejectedReleases?.has(plan.releaseKey || plan.release) && !await health.has(settings, job.media, plan.releaseKey || plan.release)) {
        Object.assign(job, { ...plan, prefetchedSegments: new Map(plan.prefetchedSegments) });
        try {
          if (preflight && !job.offlineDownload && !job.backgroundFor && !job.prepareAhead && !job.speculative && plan.strategy !== "raw") {
            job.preparedSession = await preflight(job, settings, job.selectionStart || 0);
          }
          Object.assign(job, { status: "ready", message: plan.strategy === "raw" ? "Reusing the direct stream selected earlier." : "Reusing the browser-compatible stream selected earlier.", progress: 100, mode: "direct" });
          jobEvent(job, "plan-cache-hit", job.message, { release: plan.release, strategy: plan.strategy, mode: "direct" });
          if (job.offlineDownload) await cache(job, settings);
          return;
        } catch (error) {
          if (isDownloadCancelled(job, error)) throw error;
          failedPlanRelease = plan.releaseKey || plan.release;
          if (!["INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DURATION"].includes(error.code)) savedDownloadChoice = { ...plan, firstSegment: plan.prefetchedSegments?.get(0) };
          jobEvent(job, "release-rejected", `Saved stream failed its playback check: ${error.message}`, { release: plan.release });
          plans.delete(job.media);
          if (persistence) await persistence.deletePlan(job.media).catch(() => {
          });
        }
      }
    }
    if (connectAhead && settings.usenetHost && !job.backgroundFor && !job.prepareAhead && !job.speculative && !job.offlineDownload) {
      void connectAhead(settings).then(() => jobEvent(job, "provider-connected", "Provider connection ready for source checks.")).catch(() => {
      });
    }
    if (!job.manualRelease && !job.offlineDownload && !job.prepareAhead && !job.backgroundFor && !job.downloadReplacement && !job.progressiveArchiveDisabled) {
      const saved = archivePlans.get(job.media, playbackScope(settings));
      if (saved && !job.rejectedReleases?.has(saved.releaseKey || saved.release) && !await health.has(settings, job.media, saved.releaseKey || saved.release)) {
        Object.assign(job, saved, { archiveResume: true, status: "ready", mode: "direct", progress: 100, message: "Reusing the archive video prepared earlier." });
        jobEvent(job, "archive-resume-hit", job.message, saved.archiveSource.randomAccess ? { randomAccess: true, totalBytes: saved.archiveSource.metadata.size } : { extractedBytes: saved.archiveSource.available, totalBytes: saved.archiveSource.metadata.size });
        return;
      }
    }
    setJob(job, "selecting", "Finding the best available release…", 5);
    let releases = job.manualRelease ? [job.manualRelease] : await search(settings, job.media);
    if (!job.manualRelease && !releases.length && (job.media.year || job.media.episode)) releases = await search(settings, job.media, false);
    if (!releases.length) throw new Error("No compatible English-audio releases were found for this title.");
    jobEvent(job, "search", `Found ${releases.length} English-audio candidate${releases.length === 1 ? "" : "s"}.`);
    const archiveChoices = [];
    let obfuscatedProbes = 0;
    const rejected = await Promise.all(releases.map((release) => health.has(settings, job.media, releaseIdentity(release))));
    releases = releases.filter((release, index) => releaseIdentity(release) !== failedPlanRelease && !job.rejectedReleases?.has(releaseIdentity(release)) && !rejected[index]);
    const descriptionLimit = concurrencyLimit(job.backgroundFor ? 1 : 3);
    const checkLimit = concurrencyLimit(job.backgroundFor || Number(settings.maxConnections) === 1 ? 1 : 2);
    const sampleSettings = (signal) => ({ ...settings, signal, onProviderSpeedSample: (bytes, elapsedMs) => speedMeter.record(settings, bytes, elapsedMs) });
    const describe = async (release, signal) => {
      const combined = settings.signal ? AbortSignal.any([signal, settings.signal]) : signal;
      const nzb = await descriptionLimit(() => {
        combined.throwIfAborted();
        return load(release, settings, combined);
      });
      const direct = videoFile(nzb);
      const firstSegment = direct ? await checkLimit(async () => {
        combined.throwIfAborted();
        return check(direct, sampleSettings(combined));
      }) : null;
      return { nzb, direct, firstSegment };
    };
    let downloadChoice = savedDownloadChoice;
    for await (const description of prefetchReleaseDescriptions(releases, describe, job.backgroundFor ? 1 : 6)) {
      const i = description.index;
      throwIfDownloadCancelled(job);
      settings.signal?.throwIfAborted();
      const release = releases[i];
      setJob(job, "selecting", `Checking release ${i + 1} of ${releases.length}…`, 5 + Math.floor(i / releases.length * 36));
      jobEvent(job, "release-check", release.title, { candidate: i + 1 });
      try {
        if (description.error) throw description.error;
        const { nzb, direct: checkedDirect, firstSegment: checkedFirst } = description.value;
        throwIfDownloadCancelled(job);
        let direct = checkedDirect, archives = archiveFiles(nzb);
        if (!direct && !archives.length && obfuscatedProbes < 2) {
          obfuscatedProbes++;
          setJob(job, "selecting", "Inspecting an obfuscated release…", 12 + i * 4);
          ({ direct, archives } = await probeObfuscatedNzb(nzb, settings));
        }
        if (direct) {
          setJob(job, "selecting", "Checking media availability…", 45);
          const firstSegment = direct === checkedDirect ? checkedFirst : await check(direct, sampleSettings(settings.signal));
          if (!firstSegment) {
            jobEvent(job, "release-rejected", "Required articles are unavailable or the video data is invalid.", { release: release.title });
            continue;
          }
          const strategy = playbackStrategy(direct.subject, release.title);
          Object.assign(job, { file: direct, release: release.title, releaseKey: releaseIdentity(release), strategy, prefetchedSegments: /* @__PURE__ */ new Map([[0, firstSegment]]) });
          if (!job.backgroundFor) await configurePlaybackAcceleration(job, strategy, releaseDynamicRange(release) !== "sdr");
          if (shouldCacheDirectPlayback(job, settings) || job.downloadReplacement) {
            await cache(job, settings);
            return;
          }
          const duration = Number(job.media.durationHint);
          const rate = speedMeter.rate(settings);
          const tooLarge = candidateNeedsMoreSpeed(direct, duration, rate);
          if (tooLarge) {
            downloadChoice ||= { file: direct, release: release.title, releaseKey: releaseIdentity(release), strategy, firstSegment };
            jobEvent(job, "release-rejected", "Recent provider speed is below this release’s estimated playback demand.", { release: release.title });
            continue;
          }
          if (preflight && !job.backgroundFor && !job.prepareAhead && !job.speculative && strategy !== "raw") {
            try {
              job.preparedSession = await preflight(job, settings, job.selectionStart || 0);
            } catch (error) {
              if (isDownloadCancelled(job, error)) throw error;
              if (error.code === "INVALID_MEDIA_TIMELINE" || error.code === "INVALID_MEDIA_DURATION") {
                await health.reject(settings, job.media, releaseIdentity(release));
              } else downloadChoice ||= { file: direct, release: release.title, releaseKey: releaseIdentity(release), strategy, firstSegment };
              jobEvent(job, "release-rejected", `Playback speed check failed: ${error.message}`, { release: release.title });
              continue;
            }
          }
          throwIfDownloadCancelled(job);
          plans.set(job.media, { file: direct, release: release.title, releaseKey: releaseIdentity(release), strategy, videoAcceleration: job.videoAcceleration, prefetchedSegments: /* @__PURE__ */ new Map([[0, firstSegment]]) }, playbackScope(settings));
          if (persistence) await persistence.setPlan(job.media, settings, { file: direct, release: release.title, releaseKey: releaseIdentity(release), strategy }).catch(() => {
          });
          Object.assign(job, { status: "ready", message: strategy === "raw" ? "Direct stream selected." : strategy === "remux" ? "Live browser-compatible stream selected." : "Live converted stream selected.", progress: 100, mode: "direct" });
          jobEvent(job, "ready", job.message, { release: release.title, strategy, mode: "direct" });
          return;
        }
        if (archives.length && (!job.rejectedReleases?.size || job.downloadReplacement || progressive)) {
          const choice = { archives, release: release.title, releaseKey: releaseIdentity(release) };
          archiveChoices.push(choice);
          jobEvent(job, "archive-candidate", "Release requires download and extraction.", { release: release.title });
          if (progressive && !job.speculative) {
            job.release = choice.release;
            job.releaseKey = choice.releaseKey;
            job.archives = choice.archives;
            try {
              if (await progressive(job, settings, choice.archives)) return;
            } catch (error) {
              if (error.code !== "ARCHIVE_UNAVAILABLE") throw error;
              choice.unavailable = error;
              jobEvent(job, "release-rejected", error.message, { release: choice.release });
            }
          }
        } else jobEvent(job, "release-rejected", "No supported video or archive was found.", { release: release.title });
      } catch (error) {
        if (isDownloadCancelled(job, error)) throw error;
        if (["INVALID_USENET_ARTICLE", "USENET_ARTICLE_MISSING", "INVALID_MEDIA_DURATION", "INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DECODE"].includes(error.code)) await health.reject(settings, job.media, releaseIdentity(release));
        jobEvent(job, "release-rejected", error.message || "Release inspection failed.", { release: release.title });
      }
    }
    if (downloadChoice && !job.speculative && !job.rejectedReleases?.size) {
      Object.assign(job, { ...downloadChoice, prefetchedSegments: downloadChoice.firstSegment ? /* @__PURE__ */ new Map([[0, downloadChoice.firstSegment]]) : /* @__PURE__ */ new Map() });
      jobEvent(job, "download-fallback", "No candidate sustained the playback speed check. Preparing the best direct release before playback.");
      await cache(job, settings);
      return;
    }
    if (!archiveChoices.length) throw new Error("No compatible video release was found.");
    if (job.speculative) throw new Error("This archive will start preparing when playback is requested.");
    if (progressive) job.progressiveArchiveDisabled = true;
    if (job.rejectedReleases?.size && !job.downloadReplacement) throw new Error("No replacement streaming archive is available. Try preparing a downloaded copy.");
    let lastError;
    for (const choice of archiveChoices) {
      if (choice.unavailable) {
        lastError = choice.unavailable;
        continue;
      }
      try {
        throwIfDownloadCancelled(job);
        job.release = choice.release;
        job.releaseKey = choice.releaseKey;
        job.archives = choice.archives;
        await archive(job, settings, choice.archives);
        return;
      } catch (error) {
        if (isDownloadCancelled(job, error)) throw error;
        lastError = error;
        if (["INVALID_USENET_ARTICLE", "USENET_ARTICLE_MISSING", "INVALID_MEDIA_DURATION", "INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DECODE"].includes(error.code)) await health.reject(settings, job.media, choice.releaseKey);
        jobEvent(job, "release-rejected", error.message || "Archive preparation failed.", { release: choice.release });
        setJob(job, "selecting", "That release failed. Trying another…", 5);
      }
    }
    throw lastError || new Error("No release could be prepared.");
  } catch (error) {
    if (isDownloadCancelled(job, error)) {
      job.status = "cancelled";
      job.message = "Download cancelled.";
      return;
    }
    setJob(job, "error", error.message || "Playback preparation failed.", 0);
  }
}
async function startOfflineMediaDownload(media, settings, backgroundFor = null) {
  const key = offlineMediaKey(media), records = await readOfflineRecords();
  if (!key || media.type === "tv" && (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode)))) throw new Error("Choose an individual episode or the whole series.");
  if (records.get(key)?.status === "ready") return null;
  const existing = [...offlineJobs.values()].find((job2) => job2.offlineKey === key && job2.status !== "error");
  if (existing) {
    if (backgroundFor && existing.backgroundFor) existing.backgroundFor = backgroundFor;
    return existing;
  }
  for (const [jobId, previous] of offlineJobs) if (previous.offlineKey === key && previous.status === "error") offlineJobs.delete(jobId);
  const id = randomUUID(), directory = join(OFFLINE_ROOT, id);
  const job = { id, offlineKey: key, offlineDownload: true, directory, rootDirectory: directory, media: { ...media }, status: "selecting", message: "Queued for offline download…", progress: 0, created: Date.now(), diagnosticsEnabled: Boolean(settings.playbackDiagnostics), untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2, events: [] };
  if (backgroundFor) job.backgroundFor = backgroundFor;
  offlineJobs.set(id, job);
  job.completion = (async () => {
    try {
      await preparePlayback(job, backgroundFor ? { ...settings, backgroundJob: job } : settings);
      if (job.status === "ready" && !job.cancelled) {
        records.set(key, { key, media: job.media, status: "ready", mode: job.mode, path: job.path, sourcePath: job.sourcePath, directory: job.directory, mime: job.mime, strategy: job.strategy, release: job.release || "", backgroundDownload: Boolean(job.backgroundFor), timelineValidated: Boolean(job.timelineValidated), decodeValidated: Boolean(job.decodeValidated), timelineRepaired: Boolean(job.timelineRepaired), downloadedAt: Date.now() });
        await writeOfflineRecords();
      }
      return job;
    } finally {
      if (job.cancelled) {
        job.status = "cancelled";
        job.message = "Download cancelled.";
        await rm(job.rootDirectory, { recursive: true, force: true });
        offlineJobs.delete(job.id);
      }
    }
  })();
  return job;
}
async function startSeriesDownload(media, settings) {
  const requestedSeason = Number.isInteger(Number(media.season)) ? Number(media.season) : null;
  const batchKey = requestedSeason ? `tv:${media.id}:s${requestedSeason}` : `tv:${media.id}`;
  const existing = [...offlineSeriesJobs.values()].find((job2) => job2.offlineKey === batchKey && !["ready", "error"].includes(job2.status));
  if (existing) return existing;
  for (const [jobId, previous] of offlineSeriesJobs) if (previous.offlineKey === batchKey && previous.status === "error") offlineSeriesJobs.delete(jobId);
  const job = { id: randomUUID(), offlineKey: batchKey, media: { ...media, ...requestedSeason ? { season: requestedSeason } : {} }, status: "selecting", message: requestedSeason ? `Loading season ${requestedSeason} episodes…` : "Loading series episodes…", progress: 0, created: Date.now(), completed: 0, total: 0 };
  offlineSeriesJobs.set(job.id, job);
  job.completion = (async () => {
    try {
      throwIfDownloadCancelled(job);
      const items = [];
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const seasons = await catalogueSeasons(settings, media.id);
      for (const season of seasons.filter((item) => requestedSeason === null || item.number === requestedSeason)) {
        throwIfDownloadCancelled(job);
        for (const episode of await catalogueEpisodes(settings, media.id, season.number)) if (!episode.airDate || episode.airDate <= today) items.push({ ...media, season: season.number, episode: episode.number, episodeTitle: episode.name, ...episode.runtime ? { durationHint: episode.runtime * 60 } : {} });
      }
      job.total = items.length;
      if (!items.length) throw new Error("No episodes were found for this series.");
      let failures = 0, lastFailure = "";
      for (const item of items) {
        throwIfDownloadCancelled(job);
        job.currentMedia = item;
        job.status = "downloading";
        job.message = `Downloading S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")} · ${job.completed + 1}/${job.total}`;
        const child = await startOfflineMediaDownload(item, settings);
        job.currentJobId = child?.id || null;
        if (child) {
          await child.completion;
          throwIfDownloadCancelled(job);
          if (child.status === "error") {
            failures++;
            lastFailure = `${item.episodeTitle || `Episode ${item.episode}`}: ${child.message}`;
          }
        }
        job.currentJobId = null;
        job.completed++;
        job.progress = Math.round(job.completed / job.total * 100);
      }
      job.currentMedia = null;
      job.status = failures ? "error" : "ready";
      job.message = failures ? `${job.total - failures} episodes downloaded; ${failures} failed. ${lastFailure}` : `${job.total} episodes available offline.`;
    } catch (error) {
      if (isDownloadCancelled(job, error)) {
        job.status = "cancelled";
        job.message = "Series download cancelled.";
      } else {
        job.status = "error";
        job.message = error.message || "Series download failed.";
      }
    } finally {
      job.currentMedia = null;
      job.currentJobId = null;
      if (job.cancelled) offlineSeriesJobs.delete(job.id);
    }
    return job;
  })();
  return job;
}
async function finalizeExistingOfflineRecord(record, job, settings) {
  try {
    const source = record.sourcePath || record.path;
    setJob(job, "optimizing", "Preparing the downloaded copy for reliable offline playback…", 95);
    const optimized = await optimizeCachedVideo({ ...job, offlineDownload: true, release: record.release, directory: record.directory }, source, settings);
    const updated = { ...record, ...optimized, mode: "cached", timelineValidated: true, decodeValidated: true };
    delete updated.sourcePath;
    delete updated.timelineRepairRequired;
    delete updated.repairVideoFrameRate;
    const records = await readOfflineRecords();
    records.set(record.key, updated);
    await writeOfflineRecords();
    Object.assign(job, { ...updated, status: "ready", message: "Downloaded copy is ready to play.", progress: 100 });
  } catch (error) {
    setJob(job, "error", error.message || "The downloaded copy could not be prepared for playback.", 0);
  }
}
function scheduleOfflineFinalization(record, media, settings) {
  if (offlineFinalizations.has(record.key)) return offlineFinalizations.get(record.key);
  const job = {
    id: randomUUID(),
    offlineKey: record.key,
    media: { ...media },
    status: "optimizing",
    message: "Preparing a permanent browser-ready offline copy…",
    progress: 95,
    created: Date.now(),
    mode: "cached-convert",
    sourcePath: record.sourcePath || record.path,
    strategy: record.strategy,
    release: record.release || "",
    prepareAhead: true,
    untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2
  };
  job.completion = finalizeExistingOfflineRecord(record, job, settings).finally(() => {
    if (offlineFinalizations.get(record.key) === job) offlineFinalizations.delete(record.key);
  });
  offlineFinalizations.set(record.key, job);
  return job;
}
function createOfflinePlaybackJob(local, media, settings = {}, startOfflineFinalization) {
  return {
    id: randomUUID(),
    offlineKey: local.key,
    media: { ...media },
    status: "ready",
    frameInterpolation: Boolean(settings.frameInterpolation),
    message: "Playing downloaded copy.",
    progress: 100,
    created: Date.now(),
    mode: "cached-convert",
    sourcePath: local.sourcePath || local.path,
    mime: "video/mp4",
    strategy: local.strategy,
    release: local.release || "",
    untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2,
    startOfflineFinalization
  };
}
function beginOfflineFinalization(job) {
  const start = job.startOfflineFinalization;
  delete job.startOfflineFinalization;
  start?.();
}
function publicJob(job) {
  const { archiveResume, archiveSource, archiveSourcePromise, progressiveArchive, progressiveArchiveDisabled, speculative, file, path, sourcePath, directory, media, release, releaseKey, archives, manualRelease, diagnosticsEnabled, events, completion, offlineDownload, offlineKey, prepareAhead, prefetchedSegments, rejectedReleases, sourceRecovery, sourceRecoveryError, downloadReplacement, startOfflineFinalization, ...safe } = job;
  return { ...safe, mode: job.frameInterpolation && job.mode === "cached" ? "cached-convert" : job.mode, title: media.title, hlsUrl: job.status === "ready" && (["direct", "cached-convert"].includes(job.mode) || job.frameInterpolation && job.mode === "cached") ? `/api/play/${job.id}/hls` : null, streamUrl: job.status === "ready" ? `/api/play/${job.id}/stream` : null, ...diagnosticsEnabled ? { diagnostics: { media: media.type === "tv" ? `${media.title} S${String(media.season).padStart(2, "0")}E${String(media.episode).padStart(2, "0")}` : media.title, release: release || null, mode: job.mode || null, strategy: job.strategy || null, acceleration: job.videoAcceleration || null, created: job.created, events: events || [] } } : {} };
}
function parseByteRange(range, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!range) return { start: 0, end: size - 1, partial: false };
  const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1), partial: true };
}
async function serveHlsAsset(req, res, session, asset) {
  let data;
  try {
    data = await session.read(asset);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Segment not found." });
    throw error;
  }
  const playlist = asset === "index.m3u8";
  if (playlist) data = Buffer.from(data.toString().replace("#EXTM3U", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"));
  const selected = parseByteRange(req.headers.range, data.length);
  if (!selected) {
    res.writeHead(416, { "content-range": `bytes */${data.length}` });
    return res.end();
  }
  const { start, end, partial } = selected;
  res.writeHead(partial ? 206 : 200, { "content-type": playlist ? "application/vnd.apple.mpegurl" : "video/mp4", "content-length": end - start + 1, "accept-ranges": "bytes", "cache-control": playlist ? "no-store" : "private, max-age=3600, immutable", ...partial ? { "content-range": `bytes ${start}-${end}/${data.length}` } : {} });
  return res.end(req.method === "HEAD" ? void 0 : data.subarray(start, end + 1));
}
async function serveLocalVideo(req, res, job) {
  const info = await stat(job.path), selected = parseByteRange(req.headers.range, info.size);
  if (!selected) {
    res.writeHead(416, { "content-range": `bytes */${info.size}`, "accept-ranges": "bytes" });
    return res.end();
  }
  const { start, end, partial } = selected;
  res.writeHead(partial ? 206 : 200, { "content-type": job.mime, "content-length": end - start + 1, "accept-ranges": "bytes", ...partial ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {} });
  if (req.method === "HEAD") return res.end();
  return writeStreamToResponse(createReadStream(job.path, { start, end }), res);
}
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, publicSettings(await readSettings()));
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      const current = await readSettings(), incoming = await body(req);
      const next = connectionTestSettings(current, incoming);
      delete next.watchmodeKey;
      delete next.omdbKey;
      posterPreparation.cancel();
      nntpPool.clearIdle();
      if (playbackScope(current) !== playbackScope(next)) archiveResumePlans.clear();
      if (!next.downloadNextEpisode) transfers.pause();
      else transfers.resume();
      await saveSettings(next);
      return json(res, 200, publicSettings(next));
    }
    if (req.method === "DELETE" && url.pathname === "/api/settings") {
      posterPreparation.cancel();
      archiveResumePlans.clear();
      nntpPool.clearIdle();
      transfers.pause();
      await saveSettings({});
      return json(res, 204, {});
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await mediaState.read());
    if (req.method === "PUT" && url.pathname === "/api/state/library") {
      const input = await body(req);
      return json(res, 200, await mediaState.setLibrary(input.media, input.inLibrary));
    }
    if (req.method === "PUT" && url.pathname === "/api/state/media") {
      const input = await body(req);
      return json(res, 200, await mediaState.enrichMediaMany(input.media));
    }
    if (req.method === "PUT" && url.pathname === "/api/state/progress/bulk") {
      const input = await body(req), state = await mediaState.setProgressMany(input.media, input);
      if (shouldClearPlaybackWarmth(input)) {
        const settings = await readSettings();
        for (const media of input.media) clearWatchedPlaybackWarmth(media, settings);
      }
      return json(res, 200, state);
    }
    if (req.method === "PUT" && url.pathname === "/api/state/progress") {
      const input = await body(req), state = await mediaState.setProgress(input.media, input);
      if (shouldClearPlaybackWarmth(input)) clearWatchedPlaybackWarmth(input.media, await readSettings());
      return json(res, 200, state);
    }
    if (req.method === "DELETE" && url.pathname === "/api/cache") {
      const media = await body(req);
      if (!media.title || !["movie", "tv"].includes(media.type) || !Number.isInteger(Number(media.id))) return json(res, 400, { error: "A valid movie or episode is required." });
      if (media.type === "tv" && (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode)))) return json(res, 400, { error: "Select an individual episode first." });
      return json(res, 200, { cleared: await clearPlaybackCacheForMedia(media) });
    }
    if (req.method === "GET" && url.pathname === "/api/offline") {
      const records = await readOfflineRecords();
      return json(res, 200, { downloads: [...records.values()].map(publicOfflineRecord), jobs: [...offlineSeriesJobs.values()].filter((job) => job.status !== "ready").map(publicOfflineJob).concat([...offlineJobs.values()].filter((job) => job.status !== "ready").map(publicOfflineJob)) });
    }
    if (req.method === "POST" && url.pathname === "/api/offline") {
      const media = await body(req);
      if (!media.title || !["movie", "tv"].includes(media.type) || !Number.isInteger(Number(media.id))) return json(res, 400, { error: "A valid movie or series is required." });
      const settings = await readSettings();
      if (!settings.indexerUrl || !settings.indexerKey || !settings.usenetHost) return json(res, 400, { error: "Complete the indexer and provider settings first." });
      await mediaState.setLibrary(media, true);
      const wholeSeries = media.type === "tv" && (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode)));
      const job = wholeSeries ? await startSeriesDownload(media, settings) : await startOfflineMediaDownload({ ...media, id: Number(media.id), season: media.season ? Number(media.season) : void 0, episode: media.episode ? Number(media.episode) : void 0 }, settings);
      if (!job) return json(res, 200, { alreadyDownloaded: true });
      return json(res, 202, publicOfflineJob(job));
    }
    const offlineJobCancelMatch = url.pathname.match(/^\/api\/offline\/job\/([\w-]+)$/);
    if (req.method === "DELETE" && offlineJobCancelMatch) {
      const id = offlineJobCancelMatch[1];
      const job = offlineSeriesJobs.get(id) || offlineJobs.get(id);
      if (!job) return json(res, 404, { error: "Active download not found." });
      if (!cancelDownloadJob(job)) return json(res, 409, { error: "This download can no longer be cancelled." });
      if (job.currentJobId) {
        const child = offlineJobs.get(job.currentJobId);
        if (child) cancelDownloadJob(child);
      }
      return json(res, 202, publicOfflineJob(job));
    }
    const offlineDeleteMatch = url.pathname.match(/^\/api\/offline\/(movie|tv)\/(\d+)$/);
    if (req.method === "DELETE" && offlineDeleteMatch) {
      const records = await readOfflineRecords(), [type, id] = offlineDeleteMatch.slice(1);
      let removed = 0;
      for (const [key, record] of [...records]) if (record.media.type === type && Number(record.media.id) === Number(id)) {
        records.delete(key);
        removed++;
        if (record.directory) await rm(record.directory, { recursive: true, force: true });
      }
      await writeOfflineRecords();
      return json(res, 200, { removed });
    }
    const offlineItemDeleteMatch = url.pathname.match(/^\/api\/offline\/item\/(.+)$/);
    if (req.method === "DELETE" && offlineItemDeleteMatch) {
      const records = await readOfflineRecords(), key = decodeURIComponent(offlineItemDeleteMatch[1]);
      const record = records.get(key);
      if (!record) return json(res, 404, { error: "That offline download was not found." });
      records.delete(key);
      if (record.directory) await rm(record.directory, { recursive: true, force: true });
      await writeOfflineRecords();
      return json(res, 200, { removed: 1 });
    }
    const offlineStreamMatch = url.pathname.match(/^\/api\/offline\/(.+)\/stream$/);
    if (req.method === "GET" && offlineStreamMatch) {
      const record = (await readOfflineRecords()).get(decodeURIComponent(offlineStreamMatch[1]));
      if (!record || record.status !== "ready") return json(res, 404, { error: "This title is not available offline." });
      const local = await audioSafeOfflineRecord(record);
      const settings = await readSettings();
      if (local.mode === "cached-convert" || settings.frameInterpolation) return await streamCachedConversion(req, res, local, settings);
      return await serveLocalVideo(req, res, local);
    }
    if (req.method === "POST" && url.pathname === "/api/usenet/test") {
      const saved = await readSettings(), entered = await body(req);
      await testNntp(connectionTestSettings(saved, entered));
      return json(res, 200, { message: "Provider credentials accepted." });
    }
    if (req.method === "GET" && url.pathname === "/api/catalog/search") {
      const query = url.searchParams.get("q")?.trim(), settings = await readSettings();
      if (!query) return json(res, 400, { error: "A search query is required." });
      if (!settings.tmdbToken) return json(res, 400, { error: "Add a TMDB read access token in settings before searching." });
      return json(res, 200, { results: await catalogueSearch(settings, query) });
    }
    if (req.method === "GET" && url.pathname === "/api/catalog/discover") {
      const settings = await readSettings();
      if (!settings.tmdbToken) return json(res, 400, { error: "Add a TMDB read access token in settings before browsing." });
      return json(res, 200, { shelves: await catalogueDiscovery(settings) });
    }
    const titleDetailsMatch = url.pathname.match(/^\/api\/catalog\/(movies|shows)\/(\d+)\/details$/);
    if (req.method === "GET" && titleDetailsMatch) {
      const settings = await readSettings();
      return json(res, 200, { details: await catalogueTitleDetails(settings, titleDetailsMatch[1] === "movies" ? "movie" : "tv", titleDetailsMatch[2]) });
    }
    const movieRuntimeMatch = url.pathname.match(/^\/api\/catalog\/movies\/(\d+)\/runtime$/);
    if (req.method === "GET" && movieRuntimeMatch) {
      const settings = await readSettings();
      return json(res, 200, { duration: await catalogueMovieRuntime(settings, movieRuntimeMatch[1]) });
    }
    const showMatch = url.pathname.match(/^\/api\/catalog\/shows\/(\d+)\/(seasons|episodes)$/);
    if (req.method === "GET" && showMatch) {
      const settings = await readSettings();
      if (showMatch[2] === "seasons") return json(res, 200, { seasons: await catalogueSeasons(settings, showMatch[1]) });
      const season = Number(url.searchParams.get("season"));
      if (!Number.isInteger(season) || season < 1) return json(res, 400, { error: "A valid season is required." });
      return json(res, 200, { episodes: await catalogueEpisodes(settings, showMatch[1], season) });
    }
    if (req.method === "POST" && url.pathname === "/api/releases") {
      const media = await body(req);
      if (!media.title || !["movie", "tv"].includes(media.type)) return json(res, 400, { error: "A valid movie or show is required." });
      if (media.type === "tv" && (!Number.isInteger(media.season) || !Number.isInteger(media.episode))) return json(res, 400, { error: "Select a season and episode first." });
      const settings = await readSettings();
      if (!settings.indexerUrl || !settings.indexerKey) return json(res, 400, { error: "Complete the indexer settings first." });
      let releases = await findReleases(settings, media);
      if (!releases.length && (media.year || media.episode)) releases = await findReleases(settings, media, false);
      const expires = Date.now() + 20 * 60 * 1e3;
      const choices = releases.slice(0, 20).map((release) => {
        const id = randomUUID();
        manualReleases.set(id, { release, media, expires });
        return { id, title: release.title, size: formatSize(release.size), category: release.category, published: release.published, readiness: releaseReadiness(release) };
      });
      return json(res, 200, { releases: choices });
    }
    if (req.method === "POST" && url.pathname === "/api/play/prewarm") {
      const input = await body(req), settings = await readSettings();
      if (settings.manualReleaseSelection || !settings.indexerKey || !settings.usenetHost || hlsSessions.size || [...playbackJobs.values()].some((job2) => !["ready", "error", "cancelled"].includes(job2.status))) return json(res, 200, { prepared: false });
      const item = (await mediaState.read()).continueWatching.find((item2) => offlineMediaKey(item2) === offlineMediaKey(input));
      if (!item || (await readOfflineRecords()).get(offlineMediaKey(item))?.status === "ready") return json(res, 200, { prepared: false });
      const media = { ...item, durationHint: item.duration || item.durationHint || 0 };
      const job = { id: randomUUID(), media, speculative: true, status: "selecting", message: "Preparing resume…", progress: 0, created: Date.now(), diagnosticsEnabled: Boolean(settings.playbackDiagnostics), untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2, events: [] };
      posterPreparation.start(
        `${offlineMediaKey(media)}:${playbackScope(settings)}`,
        job,
        (signal) => preparePlayback(job, { ...settings, signal }),
        async (signal, claimed) => {
          const source = await openPostedRangeServer(job, { ...settings, signal });
          if (!source) return;
          try {
            await playbackInspection(job, { ...settings, signal }, source.url).validated;
            if (!claimed()) await runOutput("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-read_intervals", `${Math.max(0, item.position)}%+8`, "-show_entries", "packet=stream_index", "-of", "json", source.url], void 0, signal);
          } finally {
            await source.close();
          }
        }
      );
      return json(res, 202, { prepared: true });
    }
    if (req.method === "POST" && url.pathname === "/api/play") {
      const media = await body(req);
      if (!media.title || !["movie", "tv"].includes(media.type)) return json(res, 400, { error: "A valid movie or show is required." });
      if (media.type === "tv" && (!Number.isInteger(media.season) || media.season < 1 || !Number.isInteger(media.episode) || media.episode < 1)) return json(res, 400, { error: "Select a season and episode first." });
      const records = await readOfflineRecords();
      let offline = records.get(offlineMediaKey(media));
      let playbackSettings;
      if (offline?.status === "ready") {
        playbackSettings = await readSettings();
        try {
          const validated = await validateOfflinePlaybackRecord(offline, playbackSettings);
          if (validated !== offline) {
            offline = validated;
            records.set(offline.key, offline);
            await writeOfflineRecords();
          }
        } catch (error) {
          if (!["INVALID_MEDIA_TIMELINE", "INVALID_MEDIA_DECODE"].includes(error.code)) throw error;
          records.set(offline.key, { ...offline, status: "error", message: error.message });
          await writeOfflineRecords();
          if (offline.release) await releaseHealth.reject(playbackSettings, media, offline.release);
          offline = null;
        }
      }
      if (offline?.status === "ready") {
        posterPreparation.cancel();
        const local = await audioSafeOfflineRecord(offline);
        playbackSettings ||= await readSettings();
        if (local.timelineRepairRequired) {
          const existing = [...playbackJobs.values()].find((candidate) => candidate.offlineKey === offline.key && !["ready", "error"].includes(candidate.status));
          if (existing) return json(res, 202, publicJob(existing));
          const job3 = { id: randomUUID(), offlineKey: offline.key, media: { ...media }, status: "optimizing", frameInterpolation: Boolean(playbackSettings.frameInterpolation), message: "Repairing a video timeline gap against the audio clock…", progress: 95, created: Date.now(), mode: "cached-convert", sourcePath: local.sourcePath || local.path, mime: "video/mp4", strategy: "transcode", release: local.release || "", untaggedAudioTrack: Number(playbackSettings.untaggedAudioTrack) || 2 };
          playbackJobs.set(job3.id, job3);
          void finalizeExistingOfflineRecord(offline, job3, playbackSettings);
          return json(res, 202, publicJob(job3));
        }
        if (local.mode === "cached-convert") {
          const job3 = createOfflinePlaybackJob(
            local,
            media,
            playbackSettings,
            () => scheduleOfflineFinalization(offline, media, playbackSettings)
          );
          playbackJobs.set(job3.id, job3);
          return json(res, 200, publicJob(job3));
        }
        const job2 = { id: randomUUID(), media: { ...media }, status: "ready", frameInterpolation: Boolean(playbackSettings.frameInterpolation), message: "Playing downloaded copy.", progress: 100, created: Date.now(), mode: local.mode, path: local.path, sourcePath: local.sourcePath, mime: local.mime, strategy: local.strategy, release: local.release || "", untaggedAudioTrack: Number(playbackSettings.untaggedAudioTrack) || 2 };
        playbackJobs.set(job2.id, job2);
        return json(res, 200, publicJob(job2));
      }
      const settings = playbackSettings || await readSettings();
      if (!settings.indexerUrl || !settings.indexerKey || !settings.usenetHost) return json(res, 400, { error: "Complete the indexer and provider settings first." });
      const prepared = !media.releaseId && !media.prepareAhead && !settings.manualReleaseSelection ? posterPreparation.take(`${offlineMediaKey(media)}:${playbackScope(settings)}`) : null;
      if (prepared) {
        delete prepared.speculative;
        playbackJobs.set(prepared.id, prepared);
        const cleanup2 = setTimeout(() => playbackJobs.delete(prepared.id), 6 * 36e5);
        cleanup2.unref();
        jobEvent(prepared, "poster-preparation-hit", "Continuing preparation started from the poster.");
        return json(res, prepared.status === "ready" ? 200 : 202, publicJob(prepared));
      }
      posterPreparation.cancel();
      const choice = media.releaseId ? manualReleases.get(media.releaseId) : void 0;
      if (media.releaseId && (!choice || choice.expires < Date.now())) return json(res, 404, { error: "That release selection expired. Search again." });
      const backgroundFor = media.prepareAhead && settings.downloadNextEpisode && playbackJobs.has(media.backgroundFor) ? media.backgroundFor : null;
      const job = { id: randomUUID(), media: { id: Number(media.id), type: media.type, title: media.title, year: media.year || "", poster: media.poster || "", season: media.season, episode: media.episode, episodeTitle: media.episodeTitle || "", durationHint: media.durationHint || 0 }, selectionStart: Number.isFinite(Number(media.selectionStart)) ? Math.max(0, Number(media.selectionStart)) : 0, prepareAhead: Boolean(media.prepareAhead), ...backgroundFor ? { backgroundFor } : {}, ...choice ? { manualRelease: choice.release } : {}, status: "selecting", message: "Starting…", progress: 0, created: Date.now(), diagnosticsEnabled: Boolean(settings.playbackDiagnostics), untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2, events: [] };
      jobEvent(job, "created", "Playback job created.");
      playbackJobs.set(job.id, job);
      const cleanup = setTimeout(() => {
        playbackJobs.delete(job.id);
        clearExpiredPlaybackCache().catch(() => {
        });
      }, 6 * 60 * 60 * 1e3);
      cleanup.unref();
      preparePlayback(job, backgroundFor ? { ...settings, backgroundJob: job } : settings);
      return json(res, 202, publicJob(job));
    }
    const backgroundMatch = url.pathname.match(/^\/api\/play\/([\w-]+)\/background$/);
    if (req.method === "POST" && backgroundMatch) {
      const parent = playbackJobs.get(backgroundMatch[1]);
      if (!parent) return json(res, 404, { error: "Playback session not found." });
      const input = await body(req), settings = await readSettings();
      transfers.report(parent.id, settings.downloadNextEpisode ? input : {});
      const next = input.next;
      const adjacent = next?.type === "tv" && parent.media.type === "tv" && Number(next.id) === Number(parent.media.id) && (Number(next.season) === Number(parent.media.season) && Number(next.episode) === Number(parent.media.episode) + 1 || Number(next.season) === Number(parent.media.season) + 1 && Number(next.episode) === 1);
      if (!settings.downloadNextEpisode || settings.manualReleaseSelection || !adjacent || !transfers.safe(parent.id)) return json(res, 200, {});
      const job = await startOfflineMediaDownload({ ...next, title: parent.media.title }, settings, parent.id);
      return json(res, 200, { job: job ? publicOfflineJob(job) : null });
    }
    const cancelMatch = url.pathname.match(/^\/api\/play\/([\w-]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const job = playbackJobs.get(cancelMatch[1]);
      if (!job || job.offlineDownload || job.prepareAhead) return json(res, 404, { error: "Playback preparation not found." });
      cancelDownloadJob(job);
      for (const entry of hlsSessions.values()) if (entry.jobId === job.id) await entry.session.close();
      return json(res, 200, { cancelled: Boolean(job.cancelled) });
    }
    const trackMatch = url.pathname.match(/^\/api\/play\/([\w-]+)\/tracks$/);
    if (req.method === "GET" && trackMatch) {
      const job = playbackJobs.get(trackMatch[1]);
      if (!job || job.status !== "ready") return json(res, 404, { error: "Playback is unavailable." });
      if (!job.playbackTracks && (job.sourcePath || job.path)) {
        const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name:stream_tags=language,title", "-of", "json", job.sourcePath || job.path], void 0, AbortSignal.timeout(1e4)));
        job.playbackTracks = playbackTracks(probe.streams);
        job.selectedAudioTrack = preferredAudioStream(probe.streams);
      }
      return json(res, 200, { tracks: job.playbackTracks || [], selectedAudioTrack: job.selectedAudioTrack, captionsAvailable: Boolean(job.sourcePath || job.path || job.archiveSource?.complete) });
    }
    const captionMatch = url.pathname.match(/^\/api\/play\/([\w-]+)\/captions\/(\d+)\.vtt$/);
    if (req.method === "GET" && captionMatch) {
      const job = playbackJobs.get(captionMatch[1]), index = Number(captionMatch[2]);
      if (!job || !job.playbackTracks?.some((track) => track.type === "captions" && track.supported && track.index === index)) return json(res, 404, { error: "Caption track unavailable." });
      let source, retained;
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      try {
        if (job.sourcePath || job.path) source = job.sourcePath || job.path;
        else if (job.archiveSource?.complete) {
          retained = job.archiveSource.retain();
          source = retained.url;
        } else return json(res, 409, { error: "Embedded captions are available once this video finishes downloading. You can open a local WebVTT file now." });
        const start = Number(url.searchParams.get("start") || 0);
        if (!Number.isFinite(start) || start < 0) return json(res, 400, { error: "Invalid caption position." });
        const text = await extractCaptions(source, index, start, controller.signal);
        res.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "private, max-age=3600" });
        return res.end(text);
      } finally {
        retained?.close();
      }
    }
    const hlsMatch = url.pathname.match(/^\/api\/play\/([\w-]+)\/hls(?:\/([\w-]+)\/(index\.m3u8|init\.mp4|segment-\d{6,}\.m4s|stop|heartbeat|status))?$/);
    if (hlsMatch) {
      const [, jobId, sessionId, asset] = hlsMatch;
      const job = playbackJobs.get(jobId);
      if (!job) return json(res, 404, { error: "Playback session not found." });
      if (req.method === "POST" && !sessionId) {
        await recoverPlaybackSource(job, await readSettings());
        if (job.status !== "ready" || !["direct", "cached-convert", "cached"].includes(job.mode)) return json(res, 409, { error: "Conversion is not ready." });
        const input = await body(req), start = Number(input.start || 0);
        if (!Number.isFinite(start) || start < 0) return json(res, 400, { error: "Invalid playback position." });
        const id = randomUUID(), settings = await readSettings();
        if (input.frameInterpolation === false) settings.frameInterpolation = false;
        const preparationController = new AbortController();
        settings.signal = preparationController.signal;
        let session, cancelled = false, delivered = false, progressTimer, reportedCompleted = 0, lastProgress = "";
        const streaming = req.headers.accept?.includes("application/x-ndjson");
        const report = (completed, details = {}) => {
          reportedCompleted = Math.max(reportedCompleted, Number(completed) || 0);
          if (!streaming || cancelled) return;
          const archive = archivePlaybackSetupProgress(job, start, reportedCompleted) || {};
          const event = { type: "progress", completed: reportedCompleted, ...archive, ...details };
          const serialized = JSON.stringify(event);
          if (serialized !== lastProgress) {
            lastProgress = serialized;
            res.write(serialized + "\n");
          }
        };
        req.on("close", () => {
          if (!delivered) {
            cancelled = true;
            preparationController.abort();
            void session?.close().catch(() => {
            });
          }
        });
        if (streaming) {
          res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
          report(0);
          progressTimer = setInterval(() => report(reportedCompleted), 1e3);
          progressTimer.unref();
        }
        try {
          session = await createHlsSession({ root: PLAYBACK_CACHE_ROOT, produce: (directory) => startHlsConversion(job, settings, start, directory, report, void 0, void 0, { audioTrack: input.audioTrack }), onClose: () => hlsSessions.delete(id) });
          hlsSessions.set(id, { jobId, session });
          if (cancelled) {
            await session.close();
            return;
          }
          await session.ready(session.health().interpolated ? { maxWaitMs: 15e3 } : job.progressiveArchive ? {
            progress: () => job.archiveSource?.available || 0,
            maxWaitMs: 3e5
          } : void 0);
          jobEvent(job, "segments-ready", "First playback segment is ready.");
          beginOfflineFinalization(job);
          if (cancelled) return;
          if (job.archiveSource?.verify) {
            const source = job.archiveSource;
            const timer = setTimeout(() => void source.verify(), 5e3);
            timer.unref();
          }
          delivered = true;
          const result = { playlistUrl: `/api/play/${jobId}/hls/${id}/index.m3u8`, sessionUrl: `/api/play/${jobId}/hls/${id}`, duration: job.sourceDuration || 0, tracks: job.playbackTracks || [], selectedAudioTrack: job.selectedAudioTrack, captionsAvailable: Boolean(job.sourcePath || job.path || job.archiveSource?.complete) };
          if (streaming) {
            report(2);
            return res.end(JSON.stringify({ type: "ready", session: result }) + "\n");
          }
          return json(res, 200, result);
        } catch (error) {
          const interpolated = session?.health().interpolated;
          await session?.close();
          if (interpolated && error.code === "PLAYBACK_SEGMENT_TIMEOUT") {
            error.code = "INTERPOLATION_TOO_SLOW";
            error.message = "Frame interpolation could not prepare segments fast enough.";
          }
          if (streaming) {
            if (!cancelled) res.end(JSON.stringify({ type: "error", error: error.message, code: error.code }) + "\n");
            return;
          }
          throw error;
        } finally {
          clearInterval(progressTimer);
        }
      }
      const entry = hlsSessions.get(sessionId);
      if (!entry || entry.jobId !== jobId) return json(res, 404, { error: "Playback segments have expired." });
      if (req.method === "POST" && asset === "stop") {
        await entry.session.close();
        return json(res, 200, { stopped: true });
      }
      if (req.method === "POST" && asset === "heartbeat") {
        entry.session.touch();
        entry.session.playbackState(await body(req));
        return json(res, 200, {});
      }
      if (req.method === "GET" && asset === "status") {
        entry.session.touch();
        return json(res, 200, { ...entry.session.health(), sourceRejected: Boolean(job.rejectedReleases?.has(job.releaseKey || job.release)) });
      }
      if (["GET", "HEAD"].includes(req.method) && /\.(m3u8|mp4|m4s)$/.test(asset)) {
        return await serveHlsAsset(req, res, entry.session, asset);
      }
      return json(res, 405, { error: "Method not allowed." });
    }
    const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)(?:\/(stream|fallback|retry))?$/);
    if (playMatch) {
      const job = playbackJobs.get(playMatch[1]);
      if (!job) return json(res, 404, { error: "Playback session not found." });
      if (req.method === "GET" && !playMatch[2]) {
        if (url.searchParams.has("after")) {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          req.on("close", cancel);
          await waitForPlayback(job, Number(url.searchParams.get("after")), { signal: controller.signal });
          if (controller.signal.aborted) return;
        }
        return json(res, 200, publicJob(job));
      }
      if (req.method === "POST" && playMatch[2] === "fallback") {
        if (job.mode !== "direct" || job.status === "downloading") return json(res, 409, { error: "Fallback download is not available." });
        const settings = await readSettings();
        if (job.rejectedReleases?.has(job.releaseKey || job.release)) {
          job.downloadReplacement = true;
          delete job.file;
          delete job.prefetchedSegments;
          delete job.manualRelease;
          delete job.sourceRecoveryError;
          void preparePlayback(job, settings);
        } else if (job.progressiveArchive) {
          job.progressiveArchiveDisabled = true;
          void prepareArchive(job, settings, job.archives).catch((error) => setJob(job, "error", error.message, 0));
        } else cacheDirect(job, settings).catch((error) => setJob(job, "error", error.message, 0));
        return json(res, 202, publicJob(job));
      }
      if (req.method === "POST" && playMatch[2] === "retry") {
        if (job.status !== "error") return json(res, 409, { error: "This playback job cannot be retried yet." });
        const settings = await readSettings();
        if (job.progressiveArchive) {
          job.progressiveArchiveDisabled = true;
          void prepareArchive(job, settings, job.archives).catch((error) => setJob(job, "error", error.message, 0));
        } else if (job.file) cacheDirect(job, settings).catch((error) => setJob(job, "error", error.message, 0));
        else if (job.archives) prepareArchive(job, settings, job.archives).catch((error) => setJob(job, "error", error.message, 0));
        else return json(res, 409, { error: "This release cannot be resumed." });
        return json(res, 202, publicJob(job));
      }
      if (["GET", "HEAD"].includes(req.method) && playMatch[2] === "stream") {
        const start = Math.min(24 * 60 * 60, Math.max(0, Number(url.searchParams.get("start")) || 0));
        jobEvent(job, "stream-request", start ? `Browser requested playback from ${Math.round(start)}s.` : "Browser requested the video stream.");
        if (job.status !== "ready") return json(res, 409, { error: "Video is not ready yet." });
        const settings = await readSettings();
        if (job.mode === "cached" && !settings.frameInterpolation) return await serveLocalVideo(req, res, job);
        if (req.method === "HEAD") {
          res.writeHead(200, { "content-type": settings.frameInterpolation || job.mode === "cached-convert" || job.strategy !== "raw" || start ? "video/mp4" : videoType(job.file.subject), "cache-control": "no-store" });
          return res.end();
        }
        if (["cached", "cached-convert"].includes(job.mode)) return await streamCachedConversion(req, res, job, settings, start);
        if (settings.frameInterpolation || job.strategy !== "raw" || start) return await streamConverted(req, res, job, settings, start, start && job.strategy === "raw" ? "remux" : "");
        let closed = false;
        req.on("close", () => {
          closed = true;
        });
        res.writeHead(200, { "content-type": videoType(job.file.subject), "content-disposition": `inline; filename="${filename(job.file.subject, "video")}"`, "cache-control": "no-store" });
        try {
          await streamPostedFile(job.file, await readSettings(), async (chunk) => {
            if (closed) throw new Error("Playback connection closed.");
            if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain();
          }, connectNntp, job.prefetchedSegments);
        } catch (error) {
          if (!closed) throw error;
        }
        if (!closed) return res.end();
        return;
      }
    }
    const streamMatch = url.pathname.match(/^\/api\/stream\/([\w-]+)$/);
    if (req.method === "GET" && streamMatch) {
      const download = downloads.get(streamMatch[1]);
      if (!download || download.expires < Date.now()) return json(res, 404, { error: "This stream has expired. Search again." });
      const nzbReply = await fetch(download.url, { signal: AbortSignal.timeout(2e4) });
      if (!nzbReply.ok) return json(res, 502, { error: `Indexer returned HTTP ${nzbReply.status} while loading the NZB.` });
      const nzb = await nzbReply.text();
      if (!/<nzb[\s>]/i.test(nzb)) return json(res, 502, { error: `Indexer could not provide this NZB: ${indexerError(nzb)}` });
      const file = videoFile(nzb);
      const archives = archiveFiles(nzb);
      if (!file && !archives.length) return json(res, 422, { error: "No video or RAR archive was found in this NZB." });
      const client = await connectNntp(await readSettings());
      if (file) {
        res.writeHead(200, { "content-type": videoType(file.subject), "content-disposition": `inline; filename="${filename(file.subject, "video")}"`, "cache-control": "no-store" });
        req.on("close", () => client.close());
        for (const segment of file.segments) await client.body(segment.id, (line) => {
          if (!line.startsWith("=y")) res.write(decodeYenc(line));
        });
        client.close();
        return res.end();
      }
      await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
      const directory = await mkdtemp(join(PLAYBACK_CACHE_ROOT, "playback-"));
      try {
        for (const archive of archives) {
          const chunks = [];
          for (const segment of archive.segments) await client.body(segment.id, (line) => {
            if (!line.startsWith("=y")) chunks.push(decodeYenc(line));
          });
          await writeFile(join(directory, filename(archive.subject, `${chunks.length}.rar`)), Buffer.concat(chunks));
        }
        client.close();
        const first = archives.find((item) => /\.part0*1\.rar/i.test(item.subject)) || archives.find((item) => /\.rar/i.test(item.subject));
        await run("unrar", ["x", "-o+", "-idq", filename(first.subject, "archive.rar")], directory);
        const extracted = await extractedVideo(directory);
        if (!extracted) throw new Error("Archive did not contain a supported video file.");
        res.writeHead(200, { "content-type": videoType(extracted), "cache-control": "no-store" });
        const stream = createReadStream(join(directory, extracted));
        req.on("close", () => stream.destroy());
        try {
          return await writeStreamToResponse(stream, res);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      } catch (error) {
        client.close();
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    const inspectMatch = url.pathname.match(/^\/api\/inspect\/([\w-]+)$/);
    if (req.method === "GET" && inspectMatch) {
      const download = downloads.get(inspectMatch[1]);
      if (!download || download.expires < Date.now()) return json(res, 404, { error: "This result has expired. Search again." });
      const reply = await fetch(download.url, { signal: AbortSignal.timeout(2e4) });
      if (!reply.ok) return json(res, 502, { error: `Indexer returned HTTP ${reply.status} while loading the NZB.` });
      const nzb = await reply.text();
      if (!/<nzb[\s>]/i.test(nzb)) return json(res, 502, { error: indexerError(nzb), contentType: reply.headers.get("content-type") || "unknown" });
      const direct = videoFile(nzb), archives = archiveFiles(nzb);
      const all = nzbFiles(nzb);
      return json(res, 200, { title: download.title, playable: Boolean(direct || archives.length), layout: direct ? "direct-video" : archives.length ? "rar-archive" : "unsupported", fileCount: all.length, files: [...direct ? [direct] : archives].map((file) => ({ subject: file.subject, segments: file.segments.length })), sample: all.slice(0, 3).map((file) => file.subject) });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const settings = await readSettings(), query = url.searchParams.get("q")?.trim();
      if (!query) return json(res, 400, { error: "A search query is required." });
      if (!settings.indexerUrl || !settings.indexerKey) return json(res, 400, { error: "Save an NZB indexer URL and API key before searching." });
      const indexer = indexerEndpoint(settings.indexerUrl);
      const kind = url.searchParams.get("kind");
      if (!["movie", "tvsearch"].includes(kind)) return json(res, 400, { error: "Choose Movies or Shows." });
      indexer.searchParams.set("t", kind);
      indexer.searchParams.set("q", query);
      indexer.searchParams.set("apikey", settings.indexerKey);
      indexer.searchParams.set("limit", "24");
      const reply = await fetch(indexer, { signal: AbortSignal.timeout(12e3) });
      if (!reply.ok) return json(res, 502, { error: `Indexer returned HTTP ${reply.status}.` });
      const results = searchResults(await reply.text()).slice(0, 24).map(({ nzbUrl, ...item }) => ({ ...item, size: formatSize(item.size), downloadId: nzbUrl ? addDownload(nzbUrl, item.title, settings.indexerKey) : null }));
      return json(res, 200, { results });
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(res, error.status === 429 ? 429 : 500, { error: error.message || "Unexpected server error.", ...error.code ? { code: error.code } : {} });
  }
}
function requestBody(request) {
  return (async function* () {
    if (!request.body) return;
    const reader = request.body.getReader();
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
}
function webResponseBody(output) {
  let settled = false;
  let detach;
  return new ReadableStream({
    start(controller) {
      const finish = (error2) => {
        if (settled) return;
        settled = true;
        detach();
        if (error2) controller.error(error2);
        else controller.close();
      };
      const data = (chunk) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) output.pause();
      };
      const end = () => finish();
      const close = () => finish(new DOMException("Playback response closed.", "AbortError"));
      const error = (cause) => finish(cause);
      detach = () => {
        output.pause();
        output.off("data", data);
        output.off("end", end);
        output.off("close", close);
        output.off("error", error);
      };
      output.on("data", data);
      output.once("end", end);
      output.once("close", close);
      output.once("error", error);
      output.pause();
    },
    pull() {
      if (!settled) output.resume();
    },
    cancel() {
      if (settled) return;
      settled = true;
      detach();
      output.destroy();
    }
  }, new ByteLengthQueuingStrategy({ highWaterMark: output.readableHighWaterMark }));
}
async function respond(request, url, handleRequest2) {
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  let status = 200;
  let headers = {};
  let headersReady, headersFailed;
  const ready = new Promise((resolve2, reject) => {
    headersReady = resolve2;
    headersFailed = reject;
  });
  output.on("error", headersFailed);
  const responseBody = webResponseBody(output);
  let closed = false;
  const closeListeners = /* @__PURE__ */ new Set();
  const abort = () => output.destroy();
  output.once("close", () => {
    closed = true;
    headersFailed(new DOMException("Playback response closed.", "AbortError"));
    request.signal.removeEventListener("abort", abort);
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  });
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const nodeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    on(event, listener) {
      if (event === "close") {
        if (closed) queueMicrotask(listener);
        else closeListeners.add(listener);
      }
      return nodeRequest;
    },
    [Symbol.asyncIterator]: () => requestBody(request)
  };
  const nodeResponse = {
    headersSent: false,
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
      this.headersSent = true;
      headersReady();
      return this;
    },
    write: (chunk) => output.write(chunk),
    waitForDrain: () => waitForDrain(output),
    end: (chunk) => output.end(chunk),
    destroy: (error) => output.destroy(error),
    get destroyed() {
      return output.destroyed;
    }
  };
  try {
    void Promise.resolve(handleRequest2(nodeRequest, nodeResponse)).catch((error) => output.destroy(error));
  } catch (error) {
    output.destroy(error);
  }
  await ready;
  const responseHeaders = new Headers(headers);
  if ([204, 205, 304].includes(status) || request.method === "HEAD") {
    await responseBody.cancel().catch(() => {
    });
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(responseBody, { status, headers: responseHeaders });
}
const GET = ({ request, url }) => respond(request, url, handleRequest);
const POST = ({ request, url }) => respond(request, url, handleRequest);
const PUT = ({ request, url }) => respond(request, url, handleRequest);
const DELETE = ({ request, url }) => respond(request, url, handleRequest);
export {
  DELETE,
  GET,
  POST,
  PUT
};
