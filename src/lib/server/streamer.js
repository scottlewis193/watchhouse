import { readFile, mkdir, writeFile, mkdtemp, readdir, rm, rename, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { episodeTag, mapTmdbEpisodes, mapTmdbRuntime, mapTmdbSeasons, mapTmdbTitles, playbackStrategy, rankReleases, releaseReadiness, titleVariants } from '../../../media.js';
import { offlineMediaKey } from '../offline.js';
import { createMediaStateStore } from './media-state.js';

const ROOT = process.cwd();
const SETTINGS_PATH = join(ROOT, 'data', 'settings.json');
const MEDIA_STATE_PATH = join(ROOT, 'data', 'media-state.json');
const PLAYBACK_CACHE_ROOT = join(ROOT, 'data', 'cache');
const DISCOVERY_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, 'tmdb-discovery-v3.json');
const RUNTIME_CACHE_PATH = join(PLAYBACK_CACHE_ROOT, 'tmdb-runtime-v1.json');
const OFFLINE_ROOT = join(ROOT, 'data', 'offline');
const OFFLINE_STATE_PATH = join(ROOT, 'data', 'offline-downloads.json');
const downloads = new Map();
const playbackJobs = new Map();
const manualReleases = new Map();
const offlineJobs = new Map();
const offlineSeriesJobs = new Map();
const mediaState = createMediaStateStore(MEDIA_STATE_PATH);
let discoveryCache = null;
let runtimeCache = null;
let offlineRecords = null;
const CACHE_SWEEP_MS = 60 * 60 * 1000;
const DISCOVERY_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export function indexerEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Indexer URL must use http or https.');
  // Newznab indexers expose their search API at /api. Accepting a provider's
  // bare host is friendlier than requiring every user to know that detail.
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/api';
  return url;
}

async function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
}
async function saveSettings(next) {
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}
async function readOfflineRecords() {
  if (offlineRecords) return offlineRecords;
  const stored = await readFile(OFFLINE_STATE_PATH, 'utf8').then(JSON.parse).catch(() => ({ downloads: [] }));
  offlineRecords = new Map((stored.downloads || []).filter(download => existsSync(download.path || download.sourcePath || '')).map(download => [download.key, download]));
  return offlineRecords;
}
async function writeOfflineRecords() {
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(OFFLINE_STATE_PATH, JSON.stringify({ version: 1, downloads: [...offlineRecords.values()] }, null, 2), { mode: 0o600 });
}
function publicOfflineRecord(record) {
  const { path, sourcePath, directory, mime, strategy, ...safe } = record;
  return { ...safe, streamUrl: `/api/offline/${encodeURIComponent(record.key)}/stream` };
}
function publicOfflineJob(job) {
  return { id: job.id, key: job.offlineKey || offlineMediaKey(job.media), media: job.media, status: job.status, message: job.message, progress: job.progress, download: job.download || null, created: job.created };
}
async function clearExpiredPlaybackCache() {
  const settings = await readSettings(), retentionHours = Math.min(168, Math.max(1, Number(settings.cacheRetentionHours) || 24));
  const activeDirectories = new Set([...playbackJobs.values()].map(job => job.directory).filter(Boolean));
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const entries = await readdir(PLAYBACK_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('playback-')).map(async entry => {
    const directory = join(PLAYBACK_CACHE_ROOT, entry.name);
    if (activeDirectories.has(directory)) return;
    if ((await stat(directory)).mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
  }));
}
const cacheSweep = setInterval(() => clearExpiredPlaybackCache().catch(() => {}), CACHE_SWEEP_MS);
cacheSweep.unref();
function publicSettings(settings) {
  const { indexerKey, usenetPass, tmdbToken, omdbKey, watchmodeKey, ...safe } = settings;
  return { ...safe, hasIndexerKey: Boolean(indexerKey), hasUsenetPass: Boolean(usenetPass), hasTmdbToken: Boolean(tmdbToken) };
}
export function connectionTestSettings(saved, entered = {}) {
  return { ...saved, ...Object.fromEntries(Object.entries(entered).filter(([, value]) => value !== '')) };
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function entityDecode(value = '') { return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function indexerError(xml) { return entityDecode((xml.match(/<error[^>]*\bdescription="([^"]*)"/i) || [, 'The indexer returned a non-NZB response.'])[1]); }
function field(xml, name) { return entityDecode((xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')) || [, ''])[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()); }
export function searchResults(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 24).map(([, item]) => ({
    title: field(item, 'title') || 'Untitled result',
    published: field(item, 'pubDate'),
    category: field(item, 'category') || 'Media',
    size: (item.match(/<enclosure[^>]*\blength="(\d+)"/i) || [, ''])[1],
    nzbUrl: entityDecode((item.match(/<enclosure[^>]*\burl="([^"]+)"/i) || [, ''])[1])
  }));
}
function formatSize(bytes) { const n = Number(bytes); return n ? `${(n / 1024 ** 3).toFixed(n >= 1024 ** 3 ? 1 : 2)} GB` : ''; }
function addDownload(url, title, apiKey) {
  const id = randomUUID();
  const target = new URL(url); if (!target.searchParams.has('apikey')) target.searchParams.set('apikey', apiKey);
  downloads.set(id, { url: target.href, title, expires: Date.now() + 20 * 60 * 1000 });
  return id;
}
async function body(req) {
  let raw = ''; for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Request body must be valid JSON.'); }
}
export async function testNntp(settings) {
  if (!settings.usenetHost || !settings.usenetUser || !settings.usenetPass) throw new Error('Enter a provider host, username, and password first.');
  const client = await connectNntp(settings);
  client.close();
}
export class NntpClient {
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.waiters = []; this.error = null; socket.on('data', chunk => this.push(chunk)); socket.on('error', error => this.fail(error)); socket.on('end', () => this.fail(new Error('Provider server closed the connection.'))); socket.on('close', () => this.fail(new Error('Provider server closed the connection.'))); }
  push(chunk) { this.buffer = Buffer.concat([this.buffer, chunk]); while (this.waiters.length) { const end = this.buffer.indexOf('\r\n'); if (end < 0) break; const waiter = this.waiters.shift(); const line = this.buffer.subarray(0, end).toString('latin1'); this.buffer = this.buffer.subarray(end + 2); waiter.resolve(line); } }
  fail(error) { if (this.error) return; this.error = error; while (this.waiters.length) this.waiters.shift().reject(error); }
  line() { const end = this.buffer.indexOf('\r\n'); if (end >= 0) { const line = this.buffer.subarray(0, end).toString('latin1'); this.buffer = this.buffer.subarray(end + 2); return Promise.resolve(line); } if (this.error) return Promise.reject(this.error); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
  async command(value) { this.socket.write(`${value}\r\n`); return this.line(); }
  async has(messageId) { return /^223 /.test(await this.command(`STAT <${messageId.replace(/[<>]/g, '')}>`)); }
  async body(messageId, onLine) { const status = await this.command(`BODY <${messageId.replace(/[<>]/g, '')}>`); if (!/^222 /.test(status)) throw new Error(`Provider server could not retrieve an article (${status}).`); for (;;) { const line = await this.line(); if (line === '.') return; await onLine(line.startsWith('..') ? line.slice(1) : line); } }
  close() { this.socket.end('QUIT\r\n'); }
}
async function connectNntp(settings) {
  if (!settings.usenetHost || !settings.usenetUser || !settings.usenetPass) throw new Error('Provider connection settings are incomplete.');
  const port = Number(settings.usenetPort || 563);
  const socket = await new Promise((resolve, reject) => {
    const next = port === 563 ? tls.connect({ host: settings.usenetHost, port, servername: settings.usenetHost }) : net.connect({ host: settings.usenetHost, port });
    next.setTimeout(15000, () => { next.destroy(); reject(new Error('Provider server timed out.')); }); next.once('error', reject); next.once('connect', () => resolve(next));
  });
  const client = new NntpClient(socket); const greeting = await client.line();
  if (!/^20[01]/.test(greeting)) throw new Error(`Provider server rejected the connection (${greeting}).`);
  const user = await client.command(`AUTHINFO USER ${settings.usenetUser}`); if (!/^381/.test(user)) throw new Error('Provider server rejected the username.');
  const pass = await client.command(`AUTHINFO PASS ${settings.usenetPass}`); if (!/^281/.test(pass)) throw new Error('Provider server rejected the password.');
  return client;
}
async function postedFileAvailable(file, settings) { const client = await connectNntp(settings); try { const indexes = [...new Set([0, Math.floor(file.segments.length / 2), file.segments.length - 1])]; for (const index of indexes) if (!await client.has(file.segments[index].id)) return false; return true; } finally { client.close(); } }
function nzbFiles(xml) {
  return [...xml.matchAll(/<file\s+([^>]*)>([\s\S]*?)<\/file>/gi)].map(([, attrs, file]) => ({
    subject: entityDecode((attrs.match(/\bsubject="([^"]*)"/i) || [, ''])[1]),
    segments: [...file.matchAll(/<segment[^>]*\bnumber="(\d+)"[^>]*>([\s\S]*?)<\/segment>/gi)].map(([, number, id]) => ({ number: Number(number), id: entityDecode(id.trim()) })).sort((a, b) => a.number - b.number)
  }));
}
function videosFrom(files) { return files.filter(file => /\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i.test(file.subject) && file.segments.length).sort((a, b) => b.segments.length - a.segments.length); }
export function videoFile(xml) { return videosFrom(nzbFiles(xml))[0]; }
function archivesFrom(files) { return files.filter(file => /(?:\.part\d+\.rar|\.rar|\.r\d\d|\.7z(?:\.\d{3})?|\.zip(?:\.\d{3})?|\.z\d\d)(?:\"|\s|$)/i.test(file.subject) && file.segments.length); }
export function archiveFiles(xml) { return archivesFrom(nzbFiles(xml)); }
export function decodeYenc(line) { const bytes = []; for (let i = 0; i < line.length; i++) { let code = line.charCodeAt(i); if (code === 61 && i + 1 < line.length) code = line.charCodeAt(++i) - 64; bytes.push((code - 42 + 256) & 255); } return Buffer.from(bytes); }
export function yencName(line) { return (line.match(/^=ybegin\s+.*\bname=(.+)$/i) || [])[1]; }
export function videoType(subject) { const ext = (subject.match(/\.(mkv|mp4|m4v|mov|webm)(?:\"|\s|$)/i) || [])[1]?.toLowerCase(); return ({ mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' })[ext] || 'application/octet-stream'; }
export async function orderedPrefetch(items, concurrency, load, consume) {
  const width = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  let next = 0;
  const loadBatch = () => {
    const start = next, batch = items.slice(start, start + width); next += batch.length;
    if (!batch.length) return null;
    const loading = Promise.all(batch.map((item, lane) => load(item, start + lane, lane)));
    void loading.catch(() => {});
    return loading;
  };
  let pending = loadBatch();
  while (pending) {
    const values = await pending;
    pending = loadBatch();
    for (const value of values) await consume(value);
  }
}
export async function streamPostedFile(posted, settings, consume, connect = connectNntp) {
  const count = Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, posted.segments.length);
  const clients = [];
  try {
    const connections = await Promise.allSettled(Array.from({ length: count }, () => connect(settings)));
    for (const connection of connections) if (connection.status === 'fulfilled') clients.push(connection.value);
    const failed = connections.find(connection => connection.status === 'rejected');
    if (failed) throw failed.reason;
    await orderedPrefetch(posted.segments, count, async (segment, _index, lane) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const chunks = [];
        try {
          await clients[lane].body(segment.id, line => { if (!line.startsWith('=y')) chunks.push(decodeYenc(line)); });
          return Buffer.concat(chunks);
        } catch (error) {
          clients[lane].close();
          if (attempt) throw error;
          clients[lane] = await connect(settings);
        }
      }
    }, consume);
  } finally { for (const client of clients) client.close(); }
}
function filename(subject, fallback) { return (subject.match(/([^/\\\"]+\.(?:part\d+\.rar|rar|r\d\d|7z(?:\.\d{3})?|zip(?:\.\d{3})?|z\d\d|mkv|mp4|m4v|mov|webm))/i) || [, fallback])[1].replace(/[^a-z0-9._ -]/gi, '_'); }
function run(command, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd }); let stderr = ''; child.stderr.on('data', data => stderr += data); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`))); }); }
function runOutput(command, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd }); let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data); child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed: ${stderr.trim() || `exited ${code}`}`))); }); }
export async function writeStreamToResponse(stream, res, { end = true } = {}) {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain();
  }
  if (end) res.end();
  return bytes;
}
export function conversionSucceeded(code, stderr = '', bytes = 1) { return code === 0 && !String(stderr).trim() && bytes > 0; }
async function extractedVideo(directory) { const names = await readdir(directory, { recursive: true }); return names.find(name => /\.(mkv|mp4|m4v|mov|webm)$/i.test(name)); }
export function ffmpegArgs(strategy, input, output, fragmented = false, start = 0, untaggedAudioTrack = 2) {
  const fallbackIndex = Math.min(7, Math.max(0, (Number(untaggedAudioTrack) || 2) - 1));
  const englishMetadataMaps = [
    '0:a:m:language:eng:?', '0:a:m:language:en:?', '0:a:m:language:en-US:?', '0:a:m:language:en-GB:?',
    '0:a:m:title:English:?', '0:a:m:title:english:?', '0:a:m:title:ENG:?',
    '0:a:m:handler_name:English:?', '0:a:m:handler_name:english:?', '0:a:m:handler_name:ENG:?'
  ];
  const audioMaps = [...englishMetadataMaps, ...(fallbackIndex ? [`0:a:${fallbackIndex}?`] : []), '0:a:0?'];
  return ['-y', '-loglevel', 'error', '-i', input, ...(start > 0 ? ['-ss', String(start)] : []), '-map', '0:v:0', ...audioMaps.flatMap(map => ['-map', map]), '-c:v', strategy === 'remux' ? 'copy' : 'libx264', ...(strategy === 'remux' ? [] : ['-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-b:a', '192k', '-disposition:a', '0', '-disposition:a:0', 'default', '-movflags', fragmented ? 'frag_keyframe+empty_moov+default_base_moof' : '+faststart', ...(fragmented ? ['-f', 'mp4'] : []), output];
}
export function audioAwarePlaybackStrategy(suggested, streams = []) {
  return suggested === 'raw' && streams.filter(stream => stream.codec_type === 'audio').length > 1 ? 'remux' : suggested;
}
async function cachedPlaybackStrategy(path, release) {
  const suggested = playbackStrategy(path, release);
  try {
    const probe = JSON.parse(await runOutput('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt:stream_tags=language', '-of', 'json', path]));
    const video = probe.streams?.find(stream => stream.codec_type === 'video');
    if (video?.codec_name !== 'h264' || video?.pix_fmt !== 'yuv420p') return 'transcode';
    return audioAwarePlaybackStrategy(suggested, probe.streams);
  } catch { return suggested; }
}
async function optimizeCachedVideo(job, path) {
  const strategy = await cachedPlaybackStrategy(path, job.release); if (strategy === 'raw') return { path, mime: videoType(path) };
  return { sourcePath: path, mime: 'video/mp4', mode: 'cached-convert', strategy };
}
async function audioSafeOfflineRecord(record) {
  if (record.mode !== 'cached' || !record.path) return record;
  const strategy = await cachedPlaybackStrategy(record.path, record.release);
  return strategy === 'raw' ? record : { ...record, mode: 'cached-convert', sourcePath: record.path, mime: 'video/mp4', strategy };
}
async function streamConverted(req, res, job, settings, start = 0, strategyOverride = '') {
  const strategy = strategyOverride || playbackStrategy(job.file.subject, job.release), child = spawn('ffmpeg', ffmpegArgs(strategy, 'pipe:0', 'pipe:1', true, start, settings.untaggedAudioTrack)); let stderr = '';
  let closed = false;
  child.stderr.on('data', chunk => stderr += chunk); child.stdin.on('error', () => {}); res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' }); const output = writeStreamToResponse(child.stdout, res, { end: false }); void output.catch(() => {}); req.on('close', () => { closed = true; child.stdin.destroy(); child.kill(); });
  try { await streamPostedFile(job.file, settings, async chunk => { if (closed) throw new Error('Playback connection closed.'); if (!child.stdin.write(chunk)) await once(child.stdin, 'drain'); }); child.stdin.end(); const [code] = await once(child, 'close'); const bytes = await output; if (!closed && !conversionSucceeded(code, stderr, bytes)) throw new Error(`Video conversion failed: ${stderr.trim() || (bytes ? `ffmpeg exited ${code}` : 'ffmpeg produced no video')}`); if (!closed) res.end(); }
  catch (error) { child.kill(); await output.catch(() => {}); if (!closed) throw error; }
}
async function streamCachedConversion(req, res, job, settings) {
  const child = spawn('ffmpeg', ffmpegArgs(job.strategy, job.sourcePath, 'pipe:1', true, 0, settings.untaggedAudioTrack)); let stderr = '';
  let closed = false;
  child.stderr.on('data', chunk => stderr += chunk); res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' }); const output = writeStreamToResponse(child.stdout, res, { end: false }); void output.catch(() => {});
  req.on('close', () => { closed = true; child.kill(); });
  const [code] = await once(child, 'close');
  const bytes = await output;
  if (closed) return;
  if (!conversionSucceeded(code, stderr, bytes)) throw new Error(`Video conversion failed: ${stderr.trim() || (bytes ? `ffmpeg exited ${code}` : 'ffmpeg produced no video')}`);
  res.end();
}
function firstArchive(archives) { return archives.find(item => /\.part0*1\.rar/i.test(item.subject)) || archives.find(item => /\.rar/i.test(item.subject)) || archives.find(item => /\.(?:7z|zip)\.0*1/i.test(item.subject)) || archives.find(item => /\.(?:7z|zip)/i.test(item.subject)); }
async function extractPostedArchive(directory, archives) { const first = firstArchive(archives); if (!first) throw new Error('No supported archive entry point was found.'); const name = filename(first.subject, 'archive'); if (/\.(?:rar|r\d\d)$/i.test(name)) await run('unrar', ['x', '-o+', '-idq', name], directory); else await run('7z', ['x', '-y', name, `-o${directory}`], directory); }

async function tmdbRequest(settings, path, params = {}) {
  if (!settings.tmdbToken) throw new Error('Add a TMDB read access token in settings before browsing.');
  const endpoint = new URL(path, 'https://api.themoviedb.org/3/'); for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, value);
  const reply = await fetch(endpoint, { headers: { Authorization: `Bearer ${settings.tmdbToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!reply.ok) {
    const payload = await reply.json().catch(() => ({}));
    if (reply.status === 429) {
      const retryAfter = reply.headers.get('retry-after');
      const message = `TMDB's short-term rate limit was reached.${retryAfter ? ` Try again in ${retryAfter} seconds.` : ' Try again shortly.'}`;
      throw Object.assign(new Error(message), { status: 429 });
    }
    throw new Error(payload.status_message || payload.message || `TMDB returned HTTP ${reply.status}.`);
  }
  return reply.json();
}
async function catalogueSearch(settings, query) {
  return mapTmdbTitles(await tmdbRequest(settings, 'search/multi', { query, include_adult: false, language: 'en-GB' }));
}
export async function fetchDiscoveryShelves(request) {
  const movieGenres = (await request('genre/movie/list', { language: 'en-GB' })).genres || [];
  const tvGenres = (await request('genre/tv/list', { language: 'en-GB' })).genres || [];
  const genreId = (genres, name) => genres.find(genre => genre.name.toLowerCase() === name.toLowerCase())?.id;
  const shelves = [
    { id: 'popular-movies', title: 'Popular movies', path: 'movie/popular', type: 'movie' },
    { id: 'popular-shows', title: 'Popular shows', path: 'tv/popular', type: 'tv' },
    { id: 'netflix-shows', title: 'Popular on Netflix', path: 'discover/tv', type: 'tv', network: 213 },
    { id: 'prime-video-shows', title: 'Popular on Prime Video', path: 'discover/tv', type: 'tv', network: 1024 },
    { id: 'disney-plus-shows', title: 'Popular on Disney+', path: 'discover/tv', type: 'tv', network: 2739 },
    { id: 'apple-tv-shows', title: 'Popular on Apple TV+', path: 'discover/tv', type: 'tv', network: 2552 },
    { id: 'hbo-shows', title: 'Popular on HBO', path: 'discover/tv', type: 'tv', network: 49 },
    { id: 'bbc-one-shows', title: 'Popular on BBC One', path: 'discover/tv', type: 'tv', network: 4 },
    { id: 'itv1-shows', title: 'Popular on ITV1', path: 'discover/tv', type: 'tv', network: 9 },
    { id: 'channel-4-shows', title: 'Popular on Channel 4', path: 'discover/tv', type: 'tv', network: 26 },
    { id: 'sky-atlantic-shows', title: 'Popular on Sky Atlantic', path: 'discover/tv', type: 'tv', network: 1063 },
    { id: 'action-movies', title: 'Action movies', path: 'discover/movie', type: 'movie', genre: genreId(movieGenres, 'Action') },
    { id: 'comedy-movies', title: 'Comedy movies', path: 'discover/movie', type: 'movie', genre: genreId(movieGenres, 'Comedy') },
    { id: 'crime-movies', title: 'Crime movies', path: 'discover/movie', type: 'movie', genre: genreId(movieGenres, 'Crime') },
    { id: 'science-fiction-movies', title: 'Science fiction movies', path: 'discover/movie', type: 'movie', genre: genreId(movieGenres, 'Science Fiction') },
    { id: 'action-shows', title: 'Action & adventure shows', path: 'discover/tv', type: 'tv', genre: genreId(tvGenres, 'Action & Adventure') },
    { id: 'comedy-shows', title: 'Comedy shows', path: 'discover/tv', type: 'tv', genre: genreId(tvGenres, 'Comedy') },
    { id: 'crime-shows', title: 'Crime shows', path: 'discover/tv', type: 'tv', genre: genreId(tvGenres, 'Crime') },
    { id: 'science-fiction-shows', title: 'Sci-fi & fantasy shows', path: 'discover/tv', type: 'tv', genre: genreId(tvGenres, 'Sci-Fi & Fantasy') }
  ].filter(shelf => shelf.id.startsWith('popular-') || shelf.genre || shelf.network);
  const listed = [];
  for (const shelf of shelves) {
    const filtered = shelf.genre || shelf.network;
    const payload = await request(shelf.path, { language: 'en-GB', page: 1, ...(filtered ? { ...(shelf.genre ? { with_genres: shelf.genre } : {}), ...(shelf.network ? { with_networks: shelf.network } : {}), include_adult: false, sort_by: 'popularity.desc', ...(shelf.type === 'movie' ? { include_video: false } : { include_null_first_air_dates: false }) } : {}) });
    listed.push({ id: shelf.id, title: shelf.title, items: mapTmdbTitles(payload, shelf.type).slice(0, 12) });
  }
  return listed;
}
async function catalogueDiscovery(settings) {
  if (discoveryCache?.expires > Date.now()) return discoveryCache.value;
  const stored = await readFile(DISCOVERY_CACHE_PATH, 'utf8').then(JSON.parse).catch(() => null);
  if (stored?.value?.length && stored.expires > Date.now()) { discoveryCache = stored; return stored.value; }
  try {
    const value = await fetchDiscoveryShelves((path, params) => tmdbRequest(settings, path, params));
    discoveryCache = { value, expires: Date.now() + DISCOVERY_CACHE_MS };
    await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
    await writeFile(DISCOVERY_CACHE_PATH, JSON.stringify(discoveryCache), { mode: 0o600 });
    return value;
  } catch (error) {
    if (stored?.value?.length) { discoveryCache = { value: stored.value, expires: Date.now() + 6 * 60 * 60 * 1000 }; return stored.value; }
    throw error;
  }
}
async function catalogueSeasons(settings, titleId) {
  return mapTmdbSeasons(await tmdbRequest(settings, `tv/${titleId}`, { language: 'en-GB' }));
}
async function catalogueEpisodes(settings, titleId, season) {
  return mapTmdbEpisodes(await tmdbRequest(settings, `tv/${titleId}/season/${season}`, { language: 'en-GB' }));
}
async function catalogueMovieRuntime(settings, titleId) {
  if (!runtimeCache) runtimeCache = await readFile(RUNTIME_CACHE_PATH, 'utf8').then(JSON.parse).catch(() => ({}));
  const cached = runtimeCache[titleId];
  if (cached?.expires > Date.now()) return cached.duration;
  const duration = mapTmdbRuntime(await tmdbRequest(settings, `movie/${titleId}`, { language: 'en-GB' }));
  runtimeCache[titleId] = { duration, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true });
  await writeFile(RUNTIME_CACHE_PATH, JSON.stringify(runtimeCache), { mode: 0o600 });
  return duration;
}
async function findReleases(settings, media, includeYear = true) {
  const episodic = media.type === 'tv' && media.season && media.episode;
  const searches = titleVariants(media.title).map(async title => {
    const endpoint = indexerEndpoint(settings.indexerUrl);
    endpoint.searchParams.set('t', episodic && !includeYear ? 'search' : media.type === 'movie' ? 'movie' : 'tvsearch');
    endpoint.searchParams.set('q', episodic && !includeYear ? `${title} ${episodeTag(media)}` : `${title} ${media.type === 'movie' && includeYear ? media.year || '' : ''}`.trim());
    if (episodic && includeYear) { endpoint.searchParams.set('season', media.season); endpoint.searchParams.set('ep', media.episode); }
    endpoint.searchParams.set('apikey', settings.indexerKey); endpoint.searchParams.set('limit', '30');
    const reply = await fetch(endpoint, { signal: AbortSignal.timeout(12000) }); if (!reply.ok) throw new Error(`Indexer returned HTTP ${reply.status}.`);
    return searchResults(await reply.text());
  });
  const attempts = await Promise.allSettled(searches), successful = attempts.filter(attempt => attempt.status === 'fulfilled');
  if (!successful.length) throw attempts[0].reason;
  const releases = successful.flatMap(attempt => attempt.value);
  return rankReleases([...new Map(releases.map(release => [release.nzbUrl || release.title, release])).values()], media, { playbackQuality: settings.playbackQuality });
}
async function loadNzb(release, settings) {
  const target = new URL(release.nzbUrl); if (!target.searchParams.has('apikey')) target.searchParams.set('apikey', settings.indexerKey);
  const reply = await fetch(target, { signal: AbortSignal.timeout(20000) }); if (!reply.ok) throw new Error(`Indexer returned HTTP ${reply.status} while loading an NZB.`);
  const nzb = await reply.text(); if (!/<nzb[\s>]/i.test(nzb)) throw new Error(indexerError(nzb)); return nzb;
}
async function probeObfuscatedNzb(nzb, settings) {
  const files = nzbFiles(nzb).filter(file => file.segments.length), resolved = new Map(), client = await connectNntp(settings);
  const probe = async file => { let detected; await client.body(file.segments[0].id, line => { if (!detected) detected = yencName(line); }); const next = detected ? { ...file, subject: detected } : file; resolved.set(file, next); return next; };
  try {
    const likely = [...files].sort((a, b) => b.segments.length - a.segments.length).slice(0, 3); const firstPass = []; for (const file of likely) firstPass.push(await probe(file)); const direct = videosFrom(firstPass)[0]; if (direct) { client.close(); return { direct, archives: [] }; }
    if (archivesFrom(firstPass).length) { for (const file of files) if (!resolved.has(file)) await probe(file); const archives = archivesFrom([...resolved.values()]); client.close(); return { direct: undefined, archives }; }
    client.close(); return { direct: undefined, archives: [] };
  } catch (error) { client.close(); throw error; }
}
function jobEvent(job, activity, message, details = {}) {
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
  const elapsed = Math.max((Date.now() - state.started) / 1000, 0.1);
  const speed = state.bytes / elapsed;
  const remainingSeconds = state.completed ? Math.round(elapsed / state.completed * (state.total - state.completed)) : null;
  Object.assign(job, {
    progress: Math.min(maximum, Math.round(state.completed / state.total * maximum)),
    download: { completedSegments: state.completed, totalSegments: state.total, bytes: state.bytes, bytesPerSecond: speed, remainingSeconds },
    message: `Downloading · ${state.completed}/${state.total} segments${remainingSeconds ? ` · about ${remainingSeconds}s remaining` : ''}`
  });
}
async function mergeParts(parts, target, count) {
  const writer = createWriteStream(target, { flags: 'w' });
  try {
    for (let index = 0; index < count; index++) {
      const source = createReadStream(join(parts, String(index).padStart(6, '0')));
      source.pipe(writer, { end: false }); await once(source, 'end');
    }
    writer.end(); await once(writer, 'finish');
  } catch (error) { writer.destroy(); throw error; }
}
async function writePostedFile(posted, path, settings, job, state, maximum) {
  if (existsSync(path)) return;
  const parts = `${path}.parts`; await mkdir(parts, { recursive: true });
  const queue = [];
  for (let index = 0; index < posted.segments.length; index++) {
    const part = join(parts, String(index).padStart(6, '0'));
    try { state.bytes += (await stat(part)).size; state.completed++; } catch { queue.push({ segment: posted.segments[index], part }); }
  }
  updateDownload(job, state, maximum);
  const workers = Array.from({ length: Math.min(Math.max(1, Number(settings.maxConnections) || 4), 12, queue.length) }, async () => {
    const client = await connectNntp(settings);
    try {
      while (queue.length) {
        const next = queue.shift(); if (!next) return;
        const pending = `${next.part}.pending`, writer = createWriteStream(pending); let bytes = 0;
        try {
          await client.body(next.segment.id, async line => {
            if (line.startsWith('=y')) return;
            const chunk = decodeYenc(line); bytes += chunk.length;
            if (!writer.write(chunk)) await once(writer, 'drain');
          });
          writer.end(); await once(writer, 'finish'); await rename(pending, next.part);
          state.bytes += bytes; state.completed++; updateDownload(job, state, maximum);
        } catch (error) { writer.destroy(); await rm(pending, { force: true }); throw error; }
      }
    } finally { client.close(); }
  });
  await Promise.all(workers); await mergeParts(parts, path, posted.segments.length); await rm(parts, { recursive: true, force: true });
}
async function cacheDirect(job, settings) {
  setJob(job, 'downloading', 'Direct playback was unavailable. Downloading the video first…', 0); await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true }); const directory = job.directory || await mkdtemp(join(PLAYBACK_CACHE_ROOT, 'playback-')); job.directory = directory;
  try { const path = join(directory, filename(job.file.subject, 'video')), state = { completed: 0, total: job.file.segments.length, bytes: 0, started: Date.now() }; await writePostedFile(job.file, path, settings, job, state, 90); const optimized = await optimizeCachedVideo(job, path); Object.assign(job, { status: 'ready', message: optimized.mode === 'cached-convert' ? 'Download complete. Starting the browser stream…' : 'Download complete. Starting playback…', progress: 100, mode: 'cached', ...optimized }); jobEvent(job, 'ready', job.message, { release: job.release || null, strategy: job.strategy || null, mode: job.mode }); }
  catch (error) { throw error; }
}
async function prepareArchive(job, settings, archives) {
  setJob(job, 'downloading', 'This release cannot stream directly. Downloading the archive first…', 0); await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true }); const directory = job.directory || await mkdtemp(join(PLAYBACK_CACHE_ROOT, 'playback-')); job.directory = directory; const total = archives.reduce((sum, file) => sum + file.segments.length, 0), state = { completed: 0, total, bytes: 0, started: Date.now() };
  try {
    for (const archive of archives) await writePostedFile(archive, join(directory, filename(archive.subject, 'archive.rar')), settings, job, state, 85);
    setJob(job, 'extracting', 'Download complete. Extracting the video…', 90); await extractPostedArchive(directory, archives); const extracted = await extractedVideo(directory); if (!extracted) throw new Error('The archive did not contain a supported video file.'); const optimized = await optimizeCachedVideo(job, join(directory, extracted)); Object.assign(job, { status: 'ready', message: optimized.mode === 'cached-convert' ? 'Extraction complete. Starting the browser stream…' : 'Ready to play.', progress: 100, mode: 'cached', ...optimized }); jobEvent(job, 'ready', job.message, { release: job.release || null, strategy: job.strategy || null, mode: job.mode });
  } catch (error) { throw error; }
}
async function preparePlayback(job, settings) {
  try {
    setJob(job, 'selecting', 'Finding the best available release…', 5); let releases = job.manualRelease ? [job.manualRelease] : await findReleases(settings, job.media); if (!job.manualRelease && !releases.length && (job.media.year || job.media.episode)) releases = await findReleases(settings, job.media, false); if (!releases.length) throw new Error('No compatible English-audio releases were found for this title.'); jobEvent(job, 'search', `Found ${releases.length} English-audio candidate${releases.length === 1 ? '' : 's'}.`); const archiveChoices = [];
    let obfuscatedProbes = 0; for (let i = 0; i < Math.min(releases.length, 10); i++) { const release = releases[i]; setJob(job, 'selecting', `Checking release ${i + 1} of ${Math.min(releases.length, 10)}…`, 5 + i * 4); jobEvent(job, 'release-check', release.title, { candidate: i + 1 }); try { const nzb = await loadNzb(release, settings); let direct = videoFile(nzb), archives = archiveFiles(nzb); if (!direct && !archives.length && obfuscatedProbes < 2) { obfuscatedProbes++; setJob(job, 'selecting', 'Inspecting an obfuscated release…', 12 + i * 4); ({ direct, archives } = await probeObfuscatedNzb(nzb, settings)); } if (direct) { setJob(job, 'selecting', 'Checking article availability…', 45); if (!await postedFileAvailable(direct, settings)) { jobEvent(job, 'release-rejected', 'Required articles are unavailable.', { release: release.title }); continue; } const strategy = playbackStrategy(direct.subject, release.title); Object.assign(job, { file: direct, release: release.title, strategy }); if (job.offlineDownload) { await cacheDirect(job, settings); return; } Object.assign(job, { status: 'ready', message: strategy === 'raw' ? 'Direct stream selected.' : strategy === 'remux' ? 'Live browser-compatible stream selected.' : 'Live converted stream selected.', progress: 100, mode: 'direct' }); jobEvent(job, 'ready', job.message, { release: release.title, strategy, mode: 'direct' }); return; } if (archives.length) { archiveChoices.push({ archives, release: release.title }); jobEvent(job, 'archive-candidate', 'Release requires download and extraction.', { release: release.title }); } else jobEvent(job, 'release-rejected', 'No supported video or archive was found.', { release: release.title }); } catch (error) { jobEvent(job, 'release-rejected', error.message || 'Release inspection failed.', { release: release.title }); } }
    if (!archiveChoices.length) throw new Error('No compatible video release was found.'); let lastError; for (const choice of archiveChoices) { try { job.release = choice.release; job.archives = choice.archives; await prepareArchive(job, settings, choice.archives); return; } catch (error) { lastError = error; setJob(job, 'selecting', 'That release failed. Trying another…', 5); } } throw lastError || new Error('No release could be prepared.');
  } catch (error) { setJob(job, 'error', error.message || 'Playback preparation failed.', 0); }
}
async function startOfflineMediaDownload(media, settings) {
  const key = offlineMediaKey(media), records = await readOfflineRecords();
  if (!key || key === `tv:${media.id}`) throw new Error('Choose an individual episode or the whole series.');
  if (records.get(key)?.status === 'ready') return null;
  const existing = [...offlineJobs.values()].find(job => job.offlineKey === key && job.status !== 'error');
  if (existing) return existing;
  const id = randomUUID(), directory = join(OFFLINE_ROOT, id);
  const job = { id, offlineKey: key, offlineDownload: true, directory, media: { ...media }, status: 'selecting', message: 'Queued for offline download…', progress: 0, created: Date.now(), diagnosticsEnabled: Boolean(settings.playbackDiagnostics), events: [] };
  offlineJobs.set(id, job);
  job.completion = (async () => {
    await preparePlayback(job, settings);
    if (job.status === 'ready') {
      records.set(key, { key, media: job.media, status: 'ready', mode: job.mode, path: job.path, sourcePath: job.sourcePath, directory: job.directory, mime: job.mime, strategy: job.strategy, release: job.release || '', downloadedAt: Date.now() });
      await writeOfflineRecords();
    }
    return job;
  })();
  return job;
}
async function startSeriesDownload(media, settings) {
  const existing = [...offlineSeriesJobs.values()].find(job => job.media.id === media.id && !['ready', 'error'].includes(job.status));
  if (existing) return existing;
  const job = { id: randomUUID(), media: { ...media }, status: 'selecting', message: 'Loading series episodes…', progress: 0, created: Date.now(), completed: 0, total: 0 };
  offlineSeriesJobs.set(job.id, job);
  void (async () => {
    try {
      const items = [];
      const today = new Date().toISOString().slice(0, 10);
      for (const season of await catalogueSeasons(settings, media.id)) {
        for (const episode of await catalogueEpisodes(settings, media.id, season.number)) if (!episode.airDate || episode.airDate <= today) items.push({ ...media, season: season.number, episode: episode.number, episodeTitle: episode.name, ...(episode.runtime ? { durationHint: episode.runtime * 60 } : {}) });
      }
      job.total = items.length;
      if (!items.length) throw new Error('No episodes were found for this series.');
      let failures = 0, lastFailure = '';
      for (const item of items) {
        job.status = 'downloading'; job.message = `Downloading S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')} · ${job.completed + 1}/${job.total}`;
        const child = await startOfflineMediaDownload(item, settings);
        if (child) { await child.completion; if (child.status === 'error') { failures++; lastFailure = `${item.episodeTitle || `Episode ${item.episode}`}: ${child.message}`; } }
        job.completed++; job.progress = Math.round(job.completed / job.total * 100);
      }
      job.status = failures ? 'error' : 'ready'; job.message = failures ? `${job.total - failures} episodes downloaded; ${failures} failed. ${lastFailure}` : `${job.total} episodes available offline.`;
    } catch (error) { job.status = 'error'; job.message = error.message || 'Series download failed.'; }
  })();
  return job;
}
function publicJob(job) { const { file, path, sourcePath, directory, media, release, archives, manualRelease, diagnosticsEnabled, events, completion, offlineDownload, offlineKey, ...safe } = job; return { ...safe, title: media.title, streamUrl: job.status === 'ready' ? `/api/play/${job.id}/stream` : null, ...(diagnosticsEnabled ? { diagnostics: { media: media.type === 'tv' ? `${media.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}` : media.title, release: release || null, mode: job.mode || null, strategy: job.strategy || null, created: job.created, events: events || [] } } : {}) }; }
async function serveLocalVideo(req, res, job) {
  const info = await stat(job.path), range = req.headers.range; let start = 0, end = info.size - 1, status = 200;
  if (range) { const match = range.match(/bytes=(\d*)-(\d*)/); if (match) { start = Number(match[1] || 0); end = Math.min(Number(match[2] || end), end); status = 206; } }
  res.writeHead(status, { 'content-type': job.mime, 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}) }); return writeStreamToResponse(createReadStream(job.path, { start, end }), res);
}

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, publicSettings(await readSettings()));
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const current = await readSettings(), incoming = await body(req);
      const next = connectionTestSettings(current, incoming);
      delete next.watchmodeKey; delete next.omdbKey;
      await saveSettings(next); return json(res, 200, publicSettings(next));
    }
    if (req.method === 'DELETE' && url.pathname === '/api/settings') { await saveSettings({}); return json(res, 204, {}); }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await mediaState.read());
    if (req.method === 'PUT' && url.pathname === '/api/state/library') { const input = await body(req); return json(res, 200, await mediaState.setLibrary(input.media, input.inLibrary)); }
    if (req.method === 'PUT' && url.pathname === '/api/state/progress/bulk') { const input = await body(req); return json(res, 200, await mediaState.setProgressMany(input.media, input)); }
    if (req.method === 'PUT' && url.pathname === '/api/state/progress') { const input = await body(req); return json(res, 200, await mediaState.setProgress(input.media, input)); }
    if (req.method === 'GET' && url.pathname === '/api/offline') {
      const records = await readOfflineRecords();
      return json(res, 200, { downloads: [...records.values()].map(publicOfflineRecord), jobs: [...offlineSeriesJobs.values()].filter(job => job.status !== 'ready').map(publicOfflineJob).concat([...offlineJobs.values()].filter(job => job.status !== 'ready').map(publicOfflineJob)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/offline') {
      const media = await body(req);
      if (!media.title || !['movie', 'tv'].includes(media.type) || !Number.isInteger(Number(media.id))) return json(res, 400, { error: 'A valid movie or series is required.' });
      const settings = await readSettings();
      if (!settings.indexerUrl || !settings.indexerKey || !settings.usenetHost) return json(res, 400, { error: 'Complete the indexer and provider settings first.' });
      await mediaState.setLibrary(media, true);
      const wholeSeries = media.type === 'tv' && (!Number.isInteger(Number(media.season)) || !Number.isInteger(Number(media.episode)));
      const job = wholeSeries ? await startSeriesDownload(media, settings) : await startOfflineMediaDownload({ ...media, id: Number(media.id), season: media.season ? Number(media.season) : undefined, episode: media.episode ? Number(media.episode) : undefined }, settings);
      if (!job) return json(res, 200, { alreadyDownloaded: true });
      return json(res, 202, publicOfflineJob(job));
    }
    const offlineDeleteMatch = url.pathname.match(/^\/api\/offline\/(movie|tv)\/(\d+)$/);
    if (req.method === 'DELETE' && offlineDeleteMatch) {
      const records = await readOfflineRecords(), [type, id] = offlineDeleteMatch.slice(1); let removed = 0;
      for (const [key, record] of [...records]) if (record.media.type === type && Number(record.media.id) === Number(id)) { records.delete(key); removed++; if (record.directory) await rm(record.directory, { recursive: true, force: true }); }
      await writeOfflineRecords(); return json(res, 200, { removed });
    }
    const offlineStreamMatch = url.pathname.match(/^\/api\/offline\/(.+)\/stream$/);
    if (req.method === 'GET' && offlineStreamMatch) {
      const record = (await readOfflineRecords()).get(decodeURIComponent(offlineStreamMatch[1]));
      if (!record || record.status !== 'ready') return json(res, 404, { error: 'This title is not available offline.' });
      const local = await audioSafeOfflineRecord(record);
      if (local.mode === 'cached-convert') return await streamCachedConversion(req, res, local, await readSettings());
      return await serveLocalVideo(req, res, local);
    }
    if (req.method === 'POST' && url.pathname === '/api/usenet/test') {
      const saved = await readSettings(), entered = await body(req);
      await testNntp(connectionTestSettings(saved, entered));
      return json(res, 200, { message: 'Provider credentials accepted.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog/search') { const query = url.searchParams.get('q')?.trim(), settings = await readSettings(); if (!query) return json(res, 400, { error: 'A search query is required.' }); if (!settings.tmdbToken) return json(res, 400, { error: 'Add a TMDB read access token in settings before searching.' }); return json(res, 200, { results: await catalogueSearch(settings, query) }); }
    if (req.method === 'GET' && url.pathname === '/api/catalog/discover') { const settings = await readSettings(); if (!settings.tmdbToken) return json(res, 400, { error: 'Add a TMDB read access token in settings before browsing.' }); return json(res, 200, { shelves: await catalogueDiscovery(settings) }); }
    const movieRuntimeMatch = url.pathname.match(/^\/api\/catalog\/movies\/(\d+)\/runtime$/);
    if (req.method === 'GET' && movieRuntimeMatch) { const settings = await readSettings(); return json(res, 200, { duration: await catalogueMovieRuntime(settings, movieRuntimeMatch[1]) }); }
    const showMatch = url.pathname.match(/^\/api\/catalog\/shows\/(\d+)\/(seasons|episodes)$/);
    if (req.method === 'GET' && showMatch) {
      const settings = await readSettings();
      if (showMatch[2] === 'seasons') return json(res, 200, { seasons: await catalogueSeasons(settings, showMatch[1]) });
      const season = Number(url.searchParams.get('season')); if (!Number.isInteger(season) || season < 1) return json(res, 400, { error: 'A valid season is required.' });
      return json(res, 200, { episodes: await catalogueEpisodes(settings, showMatch[1], season) });
    }
    if (req.method === 'POST' && url.pathname === '/api/releases') {
      const media = await body(req);
      if (!media.title || !['movie', 'tv'].includes(media.type)) return json(res, 400, { error: 'A valid movie or show is required.' });
      if (media.type === 'tv' && (!Number.isInteger(media.season) || !Number.isInteger(media.episode))) return json(res, 400, { error: 'Select a season and episode first.' });
      const settings = await readSettings(); if (!settings.indexerUrl || !settings.indexerKey) return json(res, 400, { error: 'Complete the indexer settings first.' });
      let releases = await findReleases(settings, media); if (!releases.length && (media.year || media.episode)) releases = await findReleases(settings, media, false);
      const expires = Date.now() + 20 * 60 * 1000;
      const choices = releases.slice(0, 20).map(release => { const id = randomUUID(); manualReleases.set(id, { release, media, expires }); return { id, title: release.title, size: formatSize(release.size), category: release.category, published: release.published, readiness: releaseReadiness(release) }; });
      return json(res, 200, { releases: choices });
    }
    if (req.method === 'POST' && url.pathname === '/api/play') {
      const media = await body(req); if (!media.title || !['movie', 'tv'].includes(media.type)) return json(res, 400, { error: 'A valid movie or show is required.' });
      if (media.type === 'tv' && (!Number.isInteger(media.season) || media.season < 1 || !Number.isInteger(media.episode) || media.episode < 1)) return json(res, 400, { error: 'Select a season and episode first.' });
      const offline = (await readOfflineRecords()).get(offlineMediaKey(media));
      if (offline?.status === 'ready') {
        const local = await audioSafeOfflineRecord(offline);
        const playbackSettings = await readSettings();
        const job = { id: randomUUID(), media: { ...media }, status: 'ready', message: 'Playing downloaded copy.', progress: 100, created: Date.now(), mode: local.mode, path: local.path, sourcePath: local.sourcePath, mime: local.mime, strategy: local.strategy, release: local.release || '', untaggedAudioTrack: Number(playbackSettings.untaggedAudioTrack) || 2 };
        playbackJobs.set(job.id, job); return json(res, 200, publicJob(job));
      }
      const settings = await readSettings(); if (!settings.indexerUrl || !settings.indexerKey || !settings.usenetHost) return json(res, 400, { error: 'Complete the indexer and provider settings first.' });
      const choice = media.releaseId ? manualReleases.get(media.releaseId) : undefined;
      if (media.releaseId && (!choice || choice.expires < Date.now())) return json(res, 404, { error: 'That release selection expired. Search again.' });
      const job = { id: randomUUID(), media: { id: Number(media.id), type: media.type, title: media.title, year: media.year || '', poster: media.poster || '', season: media.season, episode: media.episode, episodeTitle: media.episodeTitle || '', durationHint: media.durationHint || 0 }, ...(choice ? { manualRelease: choice.release } : {}), status: 'selecting', message: 'Starting…', progress: 0, created: Date.now(), diagnosticsEnabled: Boolean(settings.playbackDiagnostics), untaggedAudioTrack: Number(settings.untaggedAudioTrack) || 2, events: [] }; jobEvent(job, 'created', 'Playback job created.'); playbackJobs.set(job.id, job); const cleanup = setTimeout(() => { playbackJobs.delete(job.id); clearExpiredPlaybackCache().catch(() => {}); }, 6 * 60 * 60 * 1000); cleanup.unref(); preparePlayback(job, settings); return json(res, 202, publicJob(job));
    }
    const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)(?:\/(stream|fallback|retry))?$/);
    if (playMatch) {
      const job = playbackJobs.get(playMatch[1]); if (!job) return json(res, 404, { error: 'Playback session not found.' });
      if (req.method === 'GET' && !playMatch[2]) return json(res, 200, publicJob(job));
      if (req.method === 'POST' && playMatch[2] === 'fallback') { if (job.mode !== 'direct' || job.status === 'downloading') return json(res, 409, { error: 'Fallback download is not available.' }); cacheDirect(job, await readSettings()).catch(error => setJob(job, 'error', error.message, 0)); return json(res, 202, publicJob(job)); }
      if (req.method === 'POST' && playMatch[2] === 'retry') { if (job.status !== 'error') return json(res, 409, { error: 'This playback job cannot be retried yet.' }); const settings = await readSettings(); if (job.file) cacheDirect(job, settings).catch(error => setJob(job, 'error', error.message, 0)); else if (job.archives) prepareArchive(job, settings, job.archives).catch(error => setJob(job, 'error', error.message, 0)); else return json(res, 409, { error: 'This release cannot be resumed.' }); return json(res, 202, publicJob(job)); }
      if (req.method === 'GET' && playMatch[2] === 'stream') {
        const start = Math.min(24 * 60 * 60, Math.max(0, Number(url.searchParams.get('start')) || 0));
        jobEvent(job, 'stream-request', start ? `Browser requested playback from ${Math.round(start)}s.` : 'Browser requested the video stream.');
        if (job.status !== 'ready') return json(res, 409, { error: 'Video is not ready yet.' }); if (job.mode === 'cached-convert') return await streamCachedConversion(req, res, job, await readSettings()); if (job.mode === 'cached') return await serveLocalVideo(req, res, job); if (job.strategy !== 'raw' || start) return await streamConverted(req, res, job, await readSettings(), start, start && job.strategy === 'raw' ? 'remux' : '');
        let closed = false; req.on('close', () => { closed = true; });
        res.writeHead(200, { 'content-type': videoType(job.file.subject), 'content-disposition': `inline; filename="${filename(job.file.subject, 'video')}"`, 'cache-control': 'no-store' });
        try { await streamPostedFile(job.file, await readSettings(), async chunk => { if (closed) throw new Error('Playback connection closed.'); if (res.write(chunk) === false && res.waitForDrain) await res.waitForDrain(); }); }
        catch (error) { if (!closed) throw error; }
        if (!closed) return res.end();
        return;
      }
    }
    const streamMatch = url.pathname.match(/^\/api\/stream\/([\w-]+)$/);
    if (req.method === 'GET' && streamMatch) {
      const download = downloads.get(streamMatch[1]);
      if (!download || download.expires < Date.now()) return json(res, 404, { error: 'This stream has expired. Search again.' });
      const nzbReply = await fetch(download.url, { signal: AbortSignal.timeout(20000) });
      if (!nzbReply.ok) return json(res, 502, { error: `Indexer returned HTTP ${nzbReply.status} while loading the NZB.` });
      const nzb = await nzbReply.text();
      if (!/<nzb[\s>]/i.test(nzb)) return json(res, 502, { error: `Indexer could not provide this NZB: ${indexerError(nzb)}` });
      const file = videoFile(nzb); const archives = archiveFiles(nzb);
      if (!file && !archives.length) return json(res, 422, { error: 'No video or RAR archive was found in this NZB.' });
      const client = await connectNntp(await readSettings());
      if (file) {
        res.writeHead(200, { 'content-type': videoType(file.subject), 'content-disposition': `inline; filename="${filename(file.subject, 'video')}"`, 'cache-control': 'no-store' });
        req.on('close', () => client.close()); for (const segment of file.segments) await client.body(segment.id, line => { if (!line.startsWith('=y')) res.write(decodeYenc(line)); }); client.close(); return res.end();
      }
      await mkdir(PLAYBACK_CACHE_ROOT, { recursive: true }); const directory = await mkdtemp(join(PLAYBACK_CACHE_ROOT, 'playback-'));
      try {
        for (const archive of archives) { const chunks = []; for (const segment of archive.segments) await client.body(segment.id, line => { if (!line.startsWith('=y')) chunks.push(decodeYenc(line)); }); await writeFile(join(directory, filename(archive.subject, `${chunks.length}.rar`)), Buffer.concat(chunks)); }
        client.close(); const first = archives.find(item => /\.part0*1\.rar/i.test(item.subject)) || archives.find(item => /\.rar/i.test(item.subject));
        await run('unrar', ['x', '-o+', '-idq', filename(first.subject, 'archive.rar')], directory);
        const extracted = await extractedVideo(directory); if (!extracted) throw new Error('Archive did not contain a supported video file.');
        res.writeHead(200, { 'content-type': videoType(extracted), 'cache-control': 'no-store' });
        const stream = createReadStream(join(directory, extracted)); req.on('close', () => stream.destroy());
        try { return await writeStreamToResponse(stream, res); }
        finally { await rm(directory, { recursive: true, force: true }); }
      } catch (error) { client.close(); await rm(directory, { recursive: true, force: true }); throw error; }
    }
    const inspectMatch = url.pathname.match(/^\/api\/inspect\/([\w-]+)$/);
    if (req.method === 'GET' && inspectMatch) {
      const download = downloads.get(inspectMatch[1]);
      if (!download || download.expires < Date.now()) return json(res, 404, { error: 'This result has expired. Search again.' });
      const reply = await fetch(download.url, { signal: AbortSignal.timeout(20000) });
      if (!reply.ok) return json(res, 502, { error: `Indexer returned HTTP ${reply.status} while loading the NZB.` });
      const nzb = await reply.text();
      if (!/<nzb[\s>]/i.test(nzb)) return json(res, 502, { error: indexerError(nzb), contentType: reply.headers.get('content-type') || 'unknown' });
      const direct = videoFile(nzb), archives = archiveFiles(nzb);
      const all = nzbFiles(nzb);
      return json(res, 200, { title: download.title, playable: Boolean(direct || archives.length), layout: direct ? 'direct-video' : archives.length ? 'rar-archive' : 'unsupported', fileCount: all.length, files: [...(direct ? [direct] : archives)].map(file => ({ subject: file.subject, segments: file.segments.length })), sample: all.slice(0, 3).map(file => file.subject) });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const settings = await readSettings(), query = url.searchParams.get('q')?.trim();
      if (!query) return json(res, 400, { error: 'A search query is required.' });
      if (!settings.indexerUrl || !settings.indexerKey) return json(res, 400, { error: 'Save an NZB indexer URL and API key before searching.' });
      const indexer = indexerEndpoint(settings.indexerUrl);
      const kind = url.searchParams.get('kind');
      if (!['movie', 'tvsearch'].includes(kind)) return json(res, 400, { error: 'Choose Movies or Shows.' });
      indexer.searchParams.set('t', kind); indexer.searchParams.set('q', query); indexer.searchParams.set('apikey', settings.indexerKey); indexer.searchParams.set('limit', '24');
      const reply = await fetch(indexer, { signal: AbortSignal.timeout(12000) });
      if (!reply.ok) return json(res, 502, { error: `Indexer returned HTTP ${reply.status}.` });
      const results = searchResults(await reply.text()).map(({ nzbUrl, ...item }) => ({ ...item, size: formatSize(item.size), downloadId: nzbUrl ? addDownload(nzbUrl, item.title, settings.indexerKey) : null }));
      return json(res, 200, { results });
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(res, error.status === 429 ? 429 : 500, { error: error.message || 'Unexpected server error.' });
  }
}
