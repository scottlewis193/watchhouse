import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm, readFile, readdir, stat, rename } from 'node:fs/promises';
import { createReadStream, existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

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
      poster: tmdbImage(item.poster_path)
    }];
  });
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
  const withoutApostrophes = original.replace(/['‘’`]/g, "").replace(/\s+/g, " ").trim();
  return [...new Set([original, withoutApostrophes].filter(Boolean))];
}
function releaseScore(release, media, preferences = {}) {
  const text = release.title.toLowerCase();
  let score = 0;
  const tag = episodeTag(media).toLowerCase();
  if (tag && text.includes(tag)) score += 120;
  else if (tag && text.includes(`${media.season}x${String(media.episode).padStart(2, "0")}`)) score += 100;
  if (media.year && text.includes(media.year)) score += 80;
  if (/2160p|4k|uhd/.test(text)) score += preferences.playbackQuality === "quality" ? 65 : 30;
  else if (/1080p/.test(text)) score += 40;
  else if (/720p/.test(text)) score += 25;
  if (/web[- .]?dl|bluray|blu[- .]?ray/.test(text)) score += 12;
  if (/h[ .]?264|x264|avc/.test(text)) score += 15;
  if (/x265|hevc|h[ .]?265/.test(text)) score -= 45;
  if (/av1/.test(text)) score -= 30;
  if (preferences.playbackQuality === "fast") {
    if (/\.mp4\b|web[- .]?dl.*h[ .]?264|x264/.test(text)) score += 60;
    if (/rar|7z|zip/.test(text)) score -= 80;
    if (/2160p|4k|uhd/.test(text)) score -= 35;
  }
  if (/cam|telesync|ts\b/.test(text)) score -= 100;
  return score;
}
function rankReleases(releases, media, preferences) {
  return [...releases].sort((a, b) => releaseScore(b, media, preferences) - releaseScore(a, media, preferences));
}
function releaseReadiness(release) {
  const title = release.title.toLowerCase();
  if (/\.part\d+\.rar|\.rar\b|\.r\d\d\b|\.7z|\.zip\b/.test(title)) return { kind: "download", label: "Download first" };
  if (/\.mp4\b|\.m4v\b|\.mov\b|\.webm\b/.test(title) && !/hevc|x265|h[ .]?265|av1/.test(title)) return { kind: "direct", label: "Likely direct" };
  if (/\.mkv\b|hevc|x265|h[ .]?265|av1/.test(title)) return { kind: "convert", label: "Live conversion" };
  return { kind: "check", label: "Checking on start" };
}
function playbackStrategy(subject, releaseTitle = "") {
  const extension = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  const description = `${subject} ${releaseTitle}`.toLowerCase();
  if (extension === "webm") return "raw";
  if (["mp4", "m4v", "mov"].includes(extension) && !/hevc|h[ .]?265|x265|av1/.test(description)) return "raw";
  if (extension === "mkv" && /h[ .]?264|x264|avc/.test(description)) return "remux";
  return "transcode";
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
    writes = writes.then(async () => {
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
    }
  };
}
const ROOT = process.cwd();
const SETTINGS_PATH = join(ROOT, "data", "settings.json");
const MEDIA_STATE_PATH = join(ROOT, "data", "media-state.json");
const PLAYBACK_CACHE_ROOT = join(ROOT, "data", "cache");
const DISCOVERY_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, "tmdb-discovery-v3.json");
const RUNTIME_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, "tmdb-runtime-v1.json");
const downloads = /* @__PURE__ */ new Map();
const playbackJobs = /* @__PURE__ */ new Map();
const manualReleases = /* @__PURE__ */ new Map();
const mediaState = createMediaStateStore(MEDIA_STATE_PATH);
let discoveryCache = null;
let runtimeCache = null;
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
async function clearExpiredPlaybackCache() {
  const settings = await readSettings(), retentionHours = Math.min(168, Math.max(1, Number(settings.cacheRetentionHours) || 24));
  const activeDirectories = new Set([...playbackJobs.values()].map((job) => job.directory).filter(Boolean));
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1e3;
  const entries = await readdir(PLAYBACK_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("playback-")).map(async (entry) => {
    const directory = join(PLAYBACK_CACHE_ROOT, entry.name);
    if (activeDirectories.has(directory)) return;
    if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
  }));
}
const cacheSweep = setInterval(() => clearExpiredPlaybackCache().catch(() => {
}), CACHE_SWEEP_MS);
cacheSweep.unref();
function publicSettings(settings) {
  const { indexerKey, usenetPass, tmdbToken, omdbKey, watchmodeKey, ...safe } = settings;
  return { ...safe, hasIndexerKey: Boolean(indexerKey), hasUsenetPass: Boolean(usenetPass), hasTmdbToken: Boolean(tmdbToken) };
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
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 24).map(([, item]) => ({
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
  const client = await connectNntp(settings);
  client.close();
}
class NntpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("end", () => this.fail(new Error("Provider server closed the connection.")));
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
    while (this.waiters.length) this.waiters.shift().reject(error);
  }
  line() {
    const end = this.buffer.indexOf("\r\n");
    if (end >= 0) {
      const line = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 2);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
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
    if (!/^222 /.test(status)) throw new Error(`Provider server could not retrieve an article (${status}).`);
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
  if (!settings.usenetHost || !settings.usenetUser || !settings.usenetPass) throw new Error("Provider connection settings are incomplete.");
  const port = Number(settings.usenetPort || 563);
  const socket = await new Promise((resolve, reject) => {
    const next = port === 563 ? tls.connect({ host: settings.usenetHost, port, servername: settings.usenetHost }) : net.connect({ host: settings.usenetHost, port });
    next.setTimeout(15e3, () => {
      next.destroy();
      reject(new Error("Provider server timed out."));
    });
    next.once("error", reject);
    next.once("connect", () => resolve(next));
  });
  const client = new NntpClient(socket);
  const greeting = await client.line();
  if (!/^20[01]/.test(greeting)) throw new Error(`Provider server rejected the connection (${greeting}).`);
  const user = await client.command(`AUTHINFO USER ${settings.usenetUser}`);
  if (!/^381/.test(user)) throw new Error("Provider server rejected the username.");
  const pass = await client.command(`AUTHINFO PASS ${settings.usenetPass}`);
  if (!/^281/.test(pass)) throw new Error("Provider server rejected the password.");
  return client;
}
async function postedFileAvailable(file, settings) {
  const client = await connectNntp(settings);
  try {
    const indexes = [.../* @__PURE__ */ new Set([0, Math.floor(file.segments.length / 2), file.segments.length - 1])];
    for (const index of indexes) if (!await client.has(file.segments[index].id)) return false;
    return true;
  } finally {
    client.close();
  }
}
function nzbFiles(xml) {
  return [...xml.matchAll(/<file\s+([^>]*)>([\s\S]*?)<\/file>/gi)].map(([, attrs, file]) => ({
    subject: entityDecode((attrs.match(/\bsubject="([^"]*)"/i) || [, ""])[1]),
    segments: [...file.matchAll(/<segment[^>]*\bnumber="(\d+)"[^>]*>([\s\S]*?)<\/segment>/gi)].map(([, number, id]) => ({ number: Number(number), id: entityDecode(id.trim()) })).sort((a, b) => a.number - b.number)
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
  const bytes = [];
  for (let i = 0; i < line.length; i++) {
    let code = line.charCodeAt(i);
    if (code === 61 && i + 1 < line.length) code = line.charCodeAt(++i) - 64;
    bytes.push(code - 42 + 256 & 255);
  }
  return Buffer.from(bytes);
}
function yencName(line) {
  return (line.match(/^=ybegin\s+.*\bname=(.+)$/i) || [])[1];
}
function videoType(subject) {
  const ext = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase();
  return { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" }[ext] || "application/octet-stream";
}
async function orderedPrefetch(items, concurrency, load, consume) {
  const width = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  let next = 0;
  const loadBatch = () => {
    const start = next, batch = items.slice(start, start + width);
    next += batch.length;
    if (!batch.length) return null;
    const loading = Promise.all(batch.map((item, lane) => load(item, start + lane, lane)));
    void loading.catch(() => {
    });
    return loading;
  };
  let pending = loadBatch();
  while (pending) {
    const values = await pending;
    pending = loadBatch();
    for (const value of values) await consume(value);
  }
}
async function streamPostedFile(posted, settings, consume) {
  const count = Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, posted.segments.length);
  const clients = [];
  try {
    const connections = await Promise.allSettled(Array.from({ length: count }, () => connectNntp(settings)));
    for (const connection of connections) if (connection.status === "fulfilled") clients.push(connection.value);
    const failed = connections.find((connection) => connection.status === "rejected");
    if (failed) throw failed.reason;
    await orderedPrefetch(posted.segments, count, async (segment, _index, lane) => {
      const chunks = [];
      await clients[lane].body(segment.id, (line) => {
        if (!line.startsWith("=y")) chunks.push(decodeYenc(line));
      });
      return Buffer.concat(chunks);
    }, consume);
  } finally {
    for (const client of clients) client.close();
  }
}
function filename(subject, fallback) {
  return (subject.match(/([^/\\\"]+\.(?:part\d+\.rar|rar|r\d\d|7z(?:\.\d{3})?|zip(?:\.\d{3})?|z\d\d|mkv|mp4|m4v|mov|webm))/i) || [, fallback])[1].replace(/[^a-z0-9._ -]/gi, "_");
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stderr = "";
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`)));
  });
}
function runOutput(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`)));
  });
}
async function writeStreamToResponse(stream, res) {
  for await (const chunk of stream) if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain();
  res.end();
}
async function extractedVideo(directory) {
  const names = await readdir(directory, { recursive: true });
  return names.find((name) => /\.(mkv|mp4|m4v|mov|webm)$/i.test(name));
}
function ffmpegArgs(strategy, input, output, fragmented = false, start = 0) {
  return ["-y", "-loglevel", "error", "-i", input, ...start > 0 ? ["-ss", String(start)] : [], "-map", "0:v:0", "-map", "0:a:0?", "-c:v", strategy === "remux" ? "copy" : "libx264", ...strategy === "remux" ? [] : ["-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"], "-c:a", "aac", "-b:a", "192k", "-movflags", fragmented ? "frag_keyframe+empty_moov+default_base_moof" : "+faststart", ...fragmented ? ["-f", "mp4"] : [], output];
}
async function cachedPlaybackStrategy(path, release) {
  const suggested = playbackStrategy(path, release);
  try {
    const probe = JSON.parse(await runOutput("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "json", path]));
    const video = probe.streams?.[0];
    if (video?.codec_name !== "h264" || video?.pix_fmt !== "yuv420p") return "transcode";
    return suggested;
  } catch {
    return suggested;
  }
}
async function optimizeCachedVideo(job, path) {
  const strategy = await cachedPlaybackStrategy(path, job.release);
  if (strategy === "raw") return { path, mime: videoType(path) };
  return { sourcePath: path, mime: "video/mp4", mode: "cached-convert", strategy };
}
async function streamConverted(req, res, job, settings, start = 0, strategyOverride = "") {
  const strategy = strategyOverride || playbackStrategy(job.file.subject, job.release), child = spawn("ffmpeg", ffmpegArgs(strategy, "pipe:0", "pipe:1", true, start));
  let stderr = "";
  let closed = false;
  child.stderr.on("data", (chunk) => stderr += chunk);
  child.stdin.on("error", () => {
  });
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  const output = writeStreamToResponse(child.stdout, res);
  void output.catch(() => {
  });
  req.on("close", () => {
    closed = true;
    child.stdin.destroy();
    child.kill();
  });
  try {
    await streamPostedFile(job.file, settings, async (chunk) => {
      if (closed) throw new Error("Playback connection closed.");
      if (!child.stdin.write(chunk)) await once(child.stdin, "drain");
    });
    child.stdin.end();
    const [code] = await once(child, "close");
    await output;
    if (code !== 0 && !res.destroyed) throw new Error(`Video conversion failed: ${stderr.trim() || `ffmpeg exited ${code}`}`);
  } catch (error) {
    child.kill();
    await output.catch(() => {
    });
    if (!closed) throw error;
  }
}
async function streamCachedConversion(req, res, job) {
  const child = spawn("ffmpeg", ffmpegArgs(job.strategy, job.sourcePath, "pipe:1", true));
  let stderr = "";
  child.stderr.on("data", (chunk) => stderr += chunk);
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  const output = writeStreamToResponse(child.stdout, res);
  void output.catch(() => {
  });
  req.on("close", () => child.kill());
  const [code] = await once(child, "close");
  await output;
  if (code !== 0 && !res.destroyed) throw new Error(`Video conversion failed: ${stderr.trim() || `ffmpeg exited ${code}`}`);
}
function firstArchive(archives) {
  return archives.find((item) => /\.part0*1\.rar/i.test(item.subject)) || archives.find((item) => /\.rar/i.test(item.subject)) || archives.find((item) => /\.(?:7z|zip)\.0*1/i.test(item.subject)) || archives.find((item) => /\.(?:7z|zip)/i.test(item.subject));
}
async function extractPostedArchive(directory, archives) {
  const first = firstArchive(archives);
  if (!first) throw new Error("No supported archive entry point was found.");
  const name = filename(first.subject, "archive");
  if (/\.(?:rar|r\d\d)$/i.test(name)) await run("unrar", ["x", "-o+", "-idq", name], directory);
  else await run("7z", ["x", "-y", name, `-o${directory}`], directory);
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
async function findReleases(settings, media, includeYear = true) {
  const episodic = media.type === "tv" && media.season && media.episode;
  const searches = titleVariants(media.title).map(async (title) => {
    const endpoint = indexerEndpoint(settings.indexerUrl);
    endpoint.searchParams.set("t", episodic && !includeYear ? "search" : media.type === "movie" ? "movie" : "tvsearch");
    endpoint.searchParams.set("q", episodic && !includeYear ? `${title} ${episodeTag(media)}` : `${title} ${media.type === "movie" && includeYear ? media.year || "" : ""}`.trim());
    if (episodic && includeYear) {
      endpoint.searchParams.set("season", media.season);
      endpoint.searchParams.set("ep", media.episode);
    }
    endpoint.searchParams.set("apikey", settings.indexerKey);
    endpoint.searchParams.set("limit", "30");
    const reply = await fetch(endpoint, { signal: AbortSignal.timeout(12e3) });
    if (!reply.ok) throw new Error(`Indexer returned HTTP ${reply.status}.`);
    return searchResults(await reply.text());
  });
  const attempts = await Promise.allSettled(searches), successful = attempts.filter((attempt) => attempt.status === "fulfilled");
  if (!successful.length) throw attempts[0].reason;
  const releases = successful.flatMap((attempt) => attempt.value);
  return rankReleases([...new Map(releases.map((release) => [release.nzbUrl || release.title, release])).values()], media, { playbackQuality: settings.playbackQuality });
}
async function loadNzb(release, settings) {
  const target = new URL(release.nzbUrl);
  if (!target.searchParams.has("apikey")) target.searchParams.set("apikey", settings.indexerKey);
  const reply = await fetch(target, { signal: AbortSignal.timeout(2e4) });
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
function setJob(job, status, message, progress = job.progress) {
  Object.assign(job, { status, message, progress });
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
async function mergeParts(parts, target, count) {
  const writer = createWriteStream(target, { flags: "w" });
  try {
    for (let index = 0; index < count; index++) {
      const source = createReadStream(join(parts, String(index).padStart(6, "0")));
      source.pipe(writer, { end: false });
      await once(source, "end");
    }
    writer.end();
    await once(writer, "finish");
  } catch (error) {
    writer.destroy();
    throw error;
  }
}
async function writePostedFile(posted, path, settings, job, state, maximum) {
  if (existsSync(path)) return;
  const parts = `${path}.parts`;
  await mkdir(parts, { recursive: true });
  const queue = [];
  for (let index = 0; index < posted.segments.length; index++) {
    const part = join(parts, String(index).padStart(6, "0"));
    try {
      state.bytes += (await stat(part)).size;
      state.completed++;
    } catch {
      queue.push({ segment: posted.segments[index], part });
    }
  }
  updateDownload(job, state, maximum);
  const workers = Array.from({ length: Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, queue.length) }, async () => {
    const client = await connectNntp(settings);
    try {
      while (queue.length) {
        const next = queue.shift();
        if (!next) return;
        const pending = `${next.part}.pending`, writer = createWriteStream(pending);
        let bytes = 0;
        try {
          await client.body(next.segment.id, async (line) => {
            if (line.startsWith("=y")) return;
            const chunk = decodeYenc(line);
            bytes += chunk.length;
            if (!writer.write(chunk)) await once(writer, "drain");
          });
          writer.end();
          await once(writer, "finish");
          await rename(pending, next.part);
          state.bytes += bytes;
          state.completed++;
          updateDownload(job, state, maximum);
        } catch (error) {
          writer.destroy();
          await rm(pending, { force: true });
          throw error;
        }
      }
    } finally {
      client.close();
    }
  });
  await Promise.all(workers);
  await mergeParts(parts, path, posted.segments.length);
  await rm(parts, { recursive: true, force: true });
}
async function cacheDirect(job, settings) {
  setJob(job, "downloading", "Direct playback was unavailable. Downloading the video first…", 0);
  await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
  const directory = job.directory || await mkdtemp(join(PLAYBACK_CACHE_ROOT, "playback-"));
  job.directory = directory;
  try {
    const path = join(directory, filename(job.file.subject, "video")), state = { completed: 0, total: job.file.segments.length, bytes: 0, started: Date.now() };
    await writePostedFile(job.file, path, settings, job, state, 90);
    const optimized = await optimizeCachedVideo(job, path);
    Object.assign(job, { status: "ready", message: optimized.mode === "cached-convert" ? "Download complete. Starting the browser stream…" : "Download complete. Starting playback…", progress: 100, mode: "cached", ...optimized });
  } catch (error) {
    throw error;
  }
}
async function prepareArchive(job, settings, archives) {
  setJob(job, "downloading", "This release cannot stream directly. Downloading the archive first…", 0);
  await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
  const directory = job.directory || await mkdtemp(join(PLAYBACK_CACHE_ROOT, "playback-"));
  job.directory = directory;
  const total = archives.reduce((sum, file) => sum + file.segments.length, 0), state = { completed: 0, total, bytes: 0, started: Date.now() };
  try {
    for (const archive of archives) await writePostedFile(archive, join(directory, filename(archive.subject, "archive.rar")), settings, job, state, 85);
    setJob(job, "extracting", "Download complete. Extracting the video…", 90);
    await extractPostedArchive(directory, archives);
    const extracted = await extractedVideo(directory);
    if (!extracted) throw new Error("The archive did not contain a supported video file.");
    const optimized = await optimizeCachedVideo(job, join(directory, extracted));
    Object.assign(job, { status: "ready", message: optimized.mode === "cached-convert" ? "Extraction complete. Starting the browser stream…" : "Ready to play.", progress: 100, mode: "cached", ...optimized });
  } catch (error) {
    throw error;
  }
}
async function preparePlayback(job, settings) {
  try {
    setJob(job, "selecting", "Finding the best available release…", 5);
    let releases = job.manualRelease ? [job.manualRelease] : await findReleases(settings, job.media);
    if (!job.manualRelease && !releases.length && (job.media.year || job.media.episode)) releases = await findReleases(settings, job.media, false);
    if (!releases.length) throw new Error("No compatible releases were found for this title.");
    const archiveChoices = [];
    let obfuscatedProbes = 0;
    for (let i = 0; i < Math.min(releases.length, 10); i++) {
      setJob(job, "selecting", `Checking release ${i + 1} of ${Math.min(releases.length, 10)}…`, 5 + i * 4);
      try {
        const nzb = await loadNzb(releases[i], settings);
        let direct = videoFile(nzb), archives = archiveFiles(nzb);
        if (!direct && !archives.length && obfuscatedProbes < 2) {
          obfuscatedProbes++;
          setJob(job, "selecting", "Inspecting an obfuscated release…", 12 + i * 4);
          ({ direct, archives } = await probeObfuscatedNzb(nzb, settings));
        }
        if (direct) {
          setJob(job, "selecting", "Checking article availability…", 45);
          if (!await postedFileAvailable(direct, settings)) continue;
          const strategy = playbackStrategy(direct.subject, releases[i].title);
          Object.assign(job, { status: "ready", message: strategy === "raw" ? "Direct stream selected." : strategy === "remux" ? "Live browser-compatible stream selected." : "Live converted stream selected.", progress: 100, mode: "direct", strategy, file: direct, release: releases[i].title });
          return;
        }
        if (archives.length) archiveChoices.push({ archives, release: releases[i].title });
      } catch {
      }
    }
    if (!archiveChoices.length) throw new Error("No compatible video release was found.");
    let lastError;
    for (const choice of archiveChoices) {
      try {
        job.release = choice.release;
        job.archives = choice.archives;
        await prepareArchive(job, settings, choice.archives);
        return;
      } catch (error) {
        lastError = error;
        setJob(job, "selecting", "That release failed. Trying another…", 5);
      }
    }
    throw lastError || new Error("No release could be prepared.");
  } catch (error) {
    setJob(job, "error", error.message || "Playback preparation failed.", 0);
  }
}
function publicJob(job) {
  const { file, path, sourcePath, directory, media, release, archives, manualRelease, ...safe } = job;
  return { ...safe, title: media.title, streamUrl: job.status === "ready" ? `/api/play/${job.id}/stream` : null };
}
async function serveLocalVideo(req, res, job) {
  const info = await stat(job.path), range = req.headers.range;
  let start = 0, end = info.size - 1, status = 200;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      start = Number(match[1] || 0);
      end = Math.min(Number(match[2] || end), end);
      status = 206;
    }
  }
  res.writeHead(status, { "content-type": job.mime, "content-length": end - start + 1, "accept-ranges": "bytes", ...status === 206 ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {} });
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
      await saveSettings(next);
      return json(res, 200, publicSettings(next));
    }
    if (req.method === "DELETE" && url.pathname === "/api/settings") {
      await saveSettings({});
      return json(res, 204, {});
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await mediaState.read());
    if (req.method === "PUT" && url.pathname === "/api/state/library") {
      const input = await body(req);
      return json(res, 200, await mediaState.setLibrary(input.media, input.inLibrary));
    }
    if (req.method === "PUT" && url.pathname === "/api/state/progress/bulk") {
      const input = await body(req);
      return json(res, 200, await mediaState.setProgressMany(input.media, input));
    }
    if (req.method === "PUT" && url.pathname === "/api/state/progress") {
      const input = await body(req);
      return json(res, 200, await mediaState.setProgress(input.media, input));
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
    if (req.method === "POST" && url.pathname === "/api/play") {
      const media = await body(req);
      if (!media.title || !["movie", "tv"].includes(media.type)) return json(res, 400, { error: "A valid movie or show is required." });
      if (media.type === "tv" && (!Number.isInteger(media.season) || media.season < 1 || !Number.isInteger(media.episode) || media.episode < 1)) return json(res, 400, { error: "Select a season and episode first." });
      const settings = await readSettings();
      if (!settings.indexerUrl || !settings.indexerKey || !settings.usenetHost) return json(res, 400, { error: "Complete the indexer and provider settings first." });
      const choice = media.releaseId ? manualReleases.get(media.releaseId) : void 0;
      if (media.releaseId && (!choice || choice.expires < Date.now())) return json(res, 404, { error: "That release selection expired. Search again." });
      const job = { id: randomUUID(), media: { type: media.type, title: media.title, year: media.year || "", season: media.season, episode: media.episode, episodeTitle: media.episodeTitle || "" }, ...choice ? { manualRelease: choice.release } : {}, status: "selecting", message: "Starting…", progress: 0, created: Date.now() };
      playbackJobs.set(job.id, job);
      const cleanup = setTimeout(() => {
        playbackJobs.delete(job.id);
        clearExpiredPlaybackCache().catch(() => {
        });
      }, 6 * 60 * 60 * 1e3);
      cleanup.unref();
      preparePlayback(job, settings);
      return json(res, 202, publicJob(job));
    }
    const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)(?:\/(stream|fallback|retry))?$/);
    if (playMatch) {
      const job = playbackJobs.get(playMatch[1]);
      if (!job) return json(res, 404, { error: "Playback session not found." });
      if (req.method === "GET" && !playMatch[2]) return json(res, 200, publicJob(job));
      if (req.method === "POST" && playMatch[2] === "fallback") {
        if (job.mode !== "direct" || job.status === "downloading") return json(res, 409, { error: "Fallback download is not available." });
        cacheDirect(job, await readSettings()).catch((error) => setJob(job, "error", error.message, 0));
        return json(res, 202, publicJob(job));
      }
      if (req.method === "POST" && playMatch[2] === "retry") {
        if (job.status !== "error") return json(res, 409, { error: "This playback job cannot be retried yet." });
        const settings = await readSettings();
        if (job.file) cacheDirect(job, settings).catch((error) => setJob(job, "error", error.message, 0));
        else if (job.archives) prepareArchive(job, settings, job.archives).catch((error) => setJob(job, "error", error.message, 0));
        else return json(res, 409, { error: "This release cannot be resumed." });
        return json(res, 202, publicJob(job));
      }
      if (req.method === "GET" && playMatch[2] === "stream") {
        const start = Math.min(24 * 60 * 60, Math.max(0, Number(url.searchParams.get("start")) || 0));
        if (job.status !== "ready") return json(res, 409, { error: "Video is not ready yet." });
        if (job.mode === "cached-convert") return await streamCachedConversion(req, res, job);
        if (job.mode === "cached") return await serveLocalVideo(req, res, job);
        if (job.strategy !== "raw" || start) return await streamConverted(req, res, job, await readSettings(), start, start && job.strategy === "raw" ? "remux" : "");
        let closed = false;
        req.on("close", () => {
          closed = true;
        });
        res.writeHead(200, { "content-type": videoType(job.file.subject), "content-disposition": `inline; filename="${filename(job.file.subject, "video")}"`, "cache-control": "no-store" });
        try {
          await streamPostedFile(job.file, await readSettings(), async (chunk) => {
            if (closed) throw new Error("Playback connection closed.");
            if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain();
          });
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
      const results = searchResults(await reply.text()).map(({ nzbUrl, ...item }) => ({ ...item, size: formatSize(item.size), downloadId: nzbUrl ? addDownload(nzbUrl, item.title, settings.indexerKey) : null }));
      return json(res, 200, { results });
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(res, error.status === 429 ? 429 : 500, { error: error.message || "Unexpected server error." });
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
async function respond(request, url) {
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  let status = 200;
  let headers = {};
  let headersReady;
  const ready = new Promise((resolve) => {
    headersReady = resolve;
  });
  const nodeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    on(event, listener) {
      if (event === "close") request.signal.addEventListener("abort", listener, { once: true });
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
    waitForDrain: () => once(output, "drain"),
    end: (chunk) => output.end(chunk),
    destroy: (error) => output.destroy(error),
    get destroyed() {
      return output.destroyed;
    }
  };
  void handleRequest(nodeRequest, nodeResponse).catch((error) => output.destroy(error));
  await ready;
  const responseHeaders = new Headers(headers);
  return new Response(status === 204 ? null : Readable.toWeb(output), { status, headers: responseHeaders });
}
const GET = ({ request, url }) => respond(request, url);
const POST = ({ request, url }) => respond(request, url);
const PUT = ({ request, url }) => respond(request, url);
const DELETE = ({ request, url }) => respond(request, url);

export { DELETE, GET, POST, PUT };
//# sourceMappingURL=_server.js-Ds3dNqHT.js.map
