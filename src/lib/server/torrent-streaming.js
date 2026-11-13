import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { englishAudioRelease, episodeTag, playbackStrategy, rankReleases, releaseResolution, releaseSizeTier, releaseTitleMatches, titleVariants } from '../../../media.js';
import { createConversionAdmission } from './conversion-admission.js';
import { createSegmentCache } from './segment-cache.js';

const METADATA_LIMIT = 4 * 1024 ** 2;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' };
const abortError = () => Object.assign(new Error('Torrent operation cancelled.'), { name: 'AbortError' });
function check(signal) { if (signal?.aborted) throw signal.reason || abortError(); }
function decode(value = '') {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:amp|quot|apos|lt|gt|#39|#\d+|#x[\da-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'" };
    if (named[entity]) return named[entity];
    const value = entity.slice(2, -1);
    const code = value[0]?.toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function attribute(xml, name) { return decode(xml.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] || ''); }
function field(xml, name) { return decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '').trim(); }

export function torrentSearchResults(xml) {
  const error = xml.match(/<(?:\w+:)?error\b([^>]*)>/i);
  if (error) throw new Error(`Torrent indexer error: ${attribute(error[1], 'description') || 'Search was rejected.'}`);
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].flatMap(([, item]) => {
    const attrs = Object.fromEntries([...item.matchAll(/<(?:torznab|newznab):attr\b([^>]*)\/?>/gi)].map(([, value]) => [attribute(value, 'name'), attribute(value, 'value')]));
    const enclosure = item.match(/<enclosure\b([^>]*)\/?>/i)?.[1] || '';
    const torrentUrl = attrs.magneturl || field(item, 'magneturl') || attribute(enclosure, 'url') || field(item, 'link');
    if (!/^(?:magnet:\?|https?:\/\/)/i.test(torrentUrl)) return [];
    return [{ kind: 'torrent', title: field(item, 'title'), torrentUrl, size: Number(attrs.size || attribute(enclosure, 'length')) || 0, seeders: attrs.seeders === undefined ? null : Number(attrs.seeders), published: field(item, 'pubDate'), category: field(item, 'category') || 'Media' }];
  });
}

export function torrentFileSelection(parsed, media, release = {}) {
  if (!Number.isSafeInteger(parsed.pieceLength) || parsed.pieceLength <= 0 || !Array.isArray(parsed.files) || parsed.files.length > 10000) throw new Error('Unsupported torrent metadata.');
  let candidates = parsed.files.map((file, index) => ({ ...file, index })).filter(file => {
    const path = String(file.path || file.name || '');
    if (!Number.isSafeInteger(file.length) || file.length <= 0 || !Number.isSafeInteger(file.offset) || file.offset < 0) return false;
    if (path.split(/[\\/]/).some(part => part === '..') || /^(?:[\\/]|[a-z]:)/i.test(path) || /\0/.test(path)) return false;
    if (!VIDEO_TYPES[path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()] || /(?:^|[. _/\\-])(?:sample|trailer|preview)(?:[. _/\\-]|$)/i.test(path)) return false;
    if (media.type !== 'tv') return true;
    const tags = [...path.replace(/_/g, '.').matchAll(/\bs(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)|\b(\d{1,2})x(\d{1,3})(?!\d)/gi)];
    if (tags.length) return !/e\d{1,3}[ ._-]*e\d|e\d{1,3}-\d/i.test(path) && tags.every(tag => Number(tag[1] || tag[3]) === Number(media.season) && Number(tag[2] || tag[4]) === Number(media.episode));
    // A single-file episode release may omit its tag from the actual filename.
    return parsed.files.filter(entry => /\.(?:mp4|m4v|mov|mkv|webm)$/i.test(entry.path || entry.name)).length === 1 && episodeMatches(release.title, media);
  });
  if (media.type !== 'tv' && candidates.length === 1 && !releaseTitleMatches(release, media)) throw new Error('Torrent does not match the requested movie.');
  if (media.type !== 'tv' && candidates.length > 1) {
    // Collection names need not name one movie. Require its actual filename.
    candidates = candidates.filter(file => {
      const name = String(file.path || file.name).split(/[\\/]/).at(-1);
      const years = name.replace(/_/g, '.').match(/\b(?:19|20)\d{2}\b/g) || [];
      return releaseTitleMatches({ title: name }, media) && (!media.year || !years.length || years.includes(String(media.year)));
    });
    if (!candidates.length) throw new Error('Movie collection has no unambiguous filename matching the requested movie.');
  }
  candidates.sort((a, b) => b.length - a.length);
  if (!candidates.length) throw new Error('Torrent has no unarchived video matching the requested movie or episode.');
  if (candidates.length > 1 && candidates[1].length >= candidates[0].length * 0.5) throw new Error('Torrent contains ambiguous matching videos.');
  const file = candidates[0];
  const extension = (file.path || file.name).match(/\.([a-z0-9]+)$/i)[1].toLowerCase();
  return { index: file.index, path: file.path || file.name, size: file.length, offset: file.offset, mime: VIDEO_TYPES[extension], strategy: playbackStrategy(file.path || file.name, release.title || '') };
}
function episodeMatches(title = '', media) {
  return [...title.replace(/_/g, '.').matchAll(/\bs(\d{1,2})[ ._-]*e(\d{1,3})(?!\d)|\b(\d{1,2})x(\d{1,3})(?!\d)/gi)].some(tag => Number(tag[1] || tag[3]) === Number(media.season) && Number(tag[2] || tag[4]) === Number(media.episode));
}
function magnetInfoHash(url) {
  for (const topic of url.searchParams.getAll('xt')) {
    const hash = /^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.exec(topic)?.[1];
    if (!hash) continue;
    if (hash.length === 40) return hash.toLowerCase();
    const bytes = Buffer.alloc(20);
    let value = 0; let bits = 0; let index = 0;
    for (const character of hash.toUpperCase()) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
      bits += 5;
      if (bits >= 8) { bits -= 8; bytes[index++] = (value >>> bits) & 255; }
    }
    return bytes.toString('hex');
  }
  return null;
}
function rankTorrentReleases(releases, media, settings) {
  const ranked = rankReleases(releases, media, settings);
  const fastest = settings.playbackQuality === 'fast' && (!settings.targetResolution || settings.targetResolution === 'auto');
  const groups = new Map();
  for (const [index, release] of ranked.entries()) {
    // Indexer titles often omit the container. H264 can still remux in an MKV;
    // actual metadata and playback validation remain authoritative.
    const subject = /\.(?:mkv|mp4|m4v|mov|webm)(?:"|\s|$)/i.test(release.title) ? release.title : 'candidate.mkv';
    const key = `${releaseSizeTier(release, media, settings)}:${fastest ? 'auto' : releaseResolution(release)}:${playbackStrategy(subject, release.title)}:${settings.allowUnverifiedAnimeAudio ? englishAudioRelease(release) : true}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  // Preserve explicit quality/compatibility tiers. Availability comes before
  // transfer size: tiny, poorly seeded swarms must not hide healthy releases
  // behind repeated metadata timeouts. The live playback gate remains decisive.
  for (const indices of groups.values()) {
    const candidates = indices.map(index => ranked[index]).sort((a, b) =>
      (b.seeders || 0) - (a.seeders || 0)
      || (fastest ? (a.size > 0 ? a.size : Infinity) - (b.size > 0 ? b.size : Infinity) : 0));
    indices.forEach((slot, index) => { ranked[slot] = candidates[index]; });
  }
  return ranked;
}

// The store never evicts on its own. Window rotation must invalidate the
// corresponding WebTorrent piece state before releasing cached bytes.
export class BoundedTorrentStore {
  constructor(chunkLength, { maxBytes = 64 * 1024 ** 2, onRead } = {}) { this.chunkLength = chunkLength; this.maxBytes = maxBytes; this.onRead = onRead; this.bytes = 0; this.chunks = new Map(); this.closed = false; }
  put(index, chunk, callback) {
    if (this.closed) return queueMicrotask(() => callback(new Error('Torrent store is closed.')));
    const bytes = this.bytes - (this.chunks.get(index)?.byteLength || 0) + chunk.byteLength;
    if (bytes > this.maxBytes) return queueMicrotask(() => callback(new Error('Torrent piece cache limit exceeded.')));
    this.chunks.set(index, chunk); this.bytes = bytes;
    queueMicrotask(() => callback(null));
  }
  get(index, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const chunk = this.chunks.get(index);
    if (this.closed || !chunk) return queueMicrotask(() => callback(new Error('Torrent piece is not cached.')));
    this.onRead?.(index, chunk);
    const offset = options?.offset || 0;
    const result = chunk.subarray(offset, options?.length === undefined ? undefined : offset + options.length);
    queueMicrotask(() => callback(null, result));
  }
  close(callback = () => {}) { this.closed = true; this.chunks.clear(); this.bytes = 0; queueMicrotask(() => callback(null)); }
  destroy(callback) { this.close(callback); }
}

export function torrentByteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end, status: 206 };
}

async function boundedBody(response, limit) {
  if (!response.ok) throw new Error(`Torrent indexer returned HTTP ${response.status}.`);
  if (Number(response.headers?.get('content-length')) > limit) throw new Error('Torrent metadata response is too large.');
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('Torrent metadata response is too large.');
    return buffer;
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) { await response.body.cancel?.().catch(() => {}); throw new Error('Torrent metadata response is too large.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}
function linkedController(signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason || abortError());
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('Torrent source timed out.')), timeoutMs) : null; timer?.unref?.();
  return { controller, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}
const destroyingClients = new WeakMap();
async function destroyClient(client) {
  if (!client) return;
  if (destroyingClients.has(client)) return destroyingClients.get(client);
  if (client.destroyed) return;
  const completion = new Promise(resolve => client.destroy(() => resolve()));
  destroyingClients.set(client, completion);
  return completion;
}
function drain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.removeListener('drain', ready); response.removeListener('error', fail); signal.removeEventListener('abort', abort); };
    const ready = () => { cleanup(); resolve(); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason || abortError());
    response.once('drain', ready); response.once('error', fail); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
// WebTorrent's iterator can leave next() pending when its torrent is destroyed.
// Race reads against cancellation and connection failure, not a stream wrapper.
function abortable(work, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason || abortError()); };
    const fail = error => { cleanup(); reject(error); };
    signal.addEventListener('abort', abort, { once: true });
    try { Promise.resolve(work()).then(result => { cleanup(); resolve(result); }, fail); }
    catch (error) { fail(error); }
  });
}
function nextPiece(iterator, signal) { return abortable(() => iterator.next(), signal); }

export function createTorrentStreaming({
  request = globalThis.fetch,
  createClient = async options => { const { default: WebTorrent } = await import('webtorrent'); return new WebTorrent(options); },
  parse = async value => { const { default: parseTorrent } = await import('parse-torrent'); return parseTorrent(value); },
  cacheBytes = 64 * 1024 ** 2, maxConcurrentStreams = 2, maxSources = 4,
  idleMs = 2 * 60 * 1000, timeoutMs = 90 * 1000, metadataTimeoutMs = 20 * 1000
} = {}) {
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 1024 ** 2 || !Number.isInteger(maxConcurrentStreams) || maxConcurrentStreams < 1) throw new Error('Invalid torrent streaming limits.');
  // Retain consumed, verified pieces across player sessions without increasing
  // the old total piece budget. Keep headers/indexes separate from the moving
  // playhead so a long episode cannot evict its own resume metadata.
  const windowBytes = Math.floor(cacheBytes * 3 / 4);
  const retainedBytes = Math.floor((cacheBytes - windowBytes) * maxConcurrentStreams / 2);
  const metadataPieces = createSegmentCache(retainedBytes);
  const resumePieces = createSegmentCache(retainedBytes);
  const cacheSources = new Map();
  function forgetCachedSource(hash) {
    const owner = cacheSources.get(hash);
    if (!owner) return;
    owner.active = false;
    metadataPieces.delete(owner); resumePieces.delete(owner);
    cacheSources.delete(hash);
  }
  function cachedSource(descriptor, media) {
    const key = `${descriptor.infoHash}:${descriptor.file.index}`;
    let owner = cacheSources.get(key);
    if (!owner) {
      if (cacheSources.size >= 256) forgetCachedSource(cacheSources.keys().next().value);
      owner = { active: true, media };
    }
    else if (media.id) owner.media = media;
    cacheSources.delete(key); cacheSources.set(key, owner);
    return owner;
  }
  function retainedPiece(source, index) {
    if (!source.cache.active) return;
    return metadataPieces.get(source.cache, index) || resumePieces.get(source.cache, index);
  }
  function clear(media) {
    for (const [hash, owner] of cacheSources) {
      const sameMedia = owner.media.id && media?.id ? Number(owner.media.id) === Number(media.id)
        : owner.media.title?.toLowerCase() === media?.title?.toLowerCase();
      if (!media || owner.media.type === media.type && sameMedia
        && (media.type !== 'tv' || Number(owner.media.season) === Number(media.season) && Number(owner.media.episode) === Number(media.episode))
        && (media.type !== 'movie' || !media.year || !owner.media.year || String(owner.media.year) === String(media.year))) forgetCachedSource(hash);
    }
  }
  const sources = new Map(); const operations = new Set();
  const windows = new Set();
  const liveClients = new Set(); const dhtNodes = new Map();
  const metadataPeers = new WeakMap();
  const maxQueuedReaders = 16;
  const admission = createConversionAdmission({ limit: maxConcurrentStreams, maxQueued: maxQueuedReaders });
  let metadataActive = 0; let server; let starting; let closed = false;
  const metadataConnections = new WeakMap();
  function ensureOpen() { if (closed) throw new Error('Torrent streaming service is closed.'); }
  function rememberDht(client) {
    if (closed || client.destroyed || !client.dht || client.dht.destroyed || typeof client.dht.toJSON !== 'function') return;
    const nodes = client.dht.toJSON().nodes;
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node.host !== 'string' || !isIP(node.host) || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) continue;
      const key = `${node.host}:${node.port}`;
      dhtNodes.delete(key); dhtNodes.set(key, { host: node.host, port: node.port });
      if (dhtNodes.size > 64) dhtNodes.delete(dhtNodes.keys().next().value);
    }
  }
  async function closeClient(client) {
    rememberDht(client); liveClients.delete(client);
    await destroyClient(client);
  }
  async function clientTorrent(id, signal, metadataOnly = false, parsed, peers) {
    check(signal);
    // New windows need fresh stores, not a cold DHT routing table. Retain only
    // bounded contact addresses; each client still owns its DHT and sockets.
    for (const live of liveClients) rememberDht(live);
    const client = await createClient({ maxConns: 8, webSeeds: false, utp: false, lsd: false, natUpnp: false, natPmp: false });
    liveClients.add(client);
    const failure = new AbortController();
    const onAbort = () => { void closeClient(client); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let abort; let store; let cacheContext;
    try {
      check(signal);
      if (client.dht && typeof client.dht.addNode === 'function') {
        for (const node of dhtNodes.values()) client.dht.addNode({ ...node });
      }
      const torrent = await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason || abortError());
        const fail = error => { failure.abort(error); reject(error); };
        client.on('error', fail);
        signal?.addEventListener('abort', abort, { once: true });
        const torrent = client.add(id, { deselect: true, uploads: false, store: function (length, options) {
          return store = new BoundedTorrentStore(length, { ...options, onRead: (index, bytes) => {
            // WebTorrent's iterator reads the store only after hash verification.
            if (!cacheContext?.owner.active) return;
            const cache = index <= cacheContext.first + 1 || index >= cacheContext.last - 1 ? metadataPieces : resumePieces;
            cache.set(cacheContext.owner, index, bytes);
          } });
        }, storeOpts: { maxBytes: metadataOnly ? 0 : windowBytes }, storeCacheSlots: 0, destroyStoreOnDestroy: true, ...(parsed ? { bitfield: new Uint8Array(Math.ceil(parsed.pieces.length / 8)) } : {}) }, ready => {
          signal?.removeEventListener('abort', abort); resolve(ready);
        });
        torrent.on('error', fail);
        torrent.once('close', () => fail(new Error('Torrent connection closed before playback completed.')));
        torrent.on('wire', wire => {
          // WebTorrent schedules BEP6 grants outside file selections, which
          // can overflow a bounded store. Keep fast-protocol support, but
          // ignore these optional grants and use normal unchoked requests.
          const ignoreFastGrants = () => { wire.peerAllowedFastSet.length = 0; };
          ignoreFastGrants();
          wire.prependListener('allowed-fast', ignoreFastGrants);
        });
        if (peers) {
          torrent.once('infoHash', () => { for (const address of peers) torrent.addPeer(address); });
          torrent.on('wire', (_wire, address) => {
            if (typeof address !== 'string') return;
            peers.delete(address); peers.add(address);
            if (peers.size > 64) peers.delete(peers.values().next().value);
          });
        }
      });
      check(signal);
      check(failure.signal);
      torrent.files.forEach(file => file.deselect());
      return {
        client, torrent, failureSignal: failure.signal,
        setSignal(next) {
          signal?.removeEventListener('abort', onAbort); signal = next;
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        },
        enableCache() { store.maxBytes = windowBytes; },
        retainReads(owner, file) {
          cacheContext = { owner, first: Math.floor(file.offset / torrent.pieceLength), last: Math.floor((file.offset + file.size - 1) / torrent.pieceLength) };
        },
        rotate(first, last) {
          last = Math.min(last, torrent.pieces.length - 1);
          // A probe or seek leaves a partial window. Reuse its peers only
          // when no completed piece is still being hashed/stored: WebTorrent
          // does not recheck piece identity after its asynchronous hash.
          for (let index = first; index <= last; index++) {
            if (torrent.pieces[index]?.missing === 0) return false;
          }
          for (const wire of torrent.wires) {
            while (wire.requests.length) {
              const request = wire.requests[0];
              wire.cancel(request.piece, request.offset, request.length);
            }
          }
          for (let index = first; index <= last; index++) {
            const verified = torrent.bitfield.get(index);
            const piece = torrent.pieces[index];
            if (!verified && piece.missing === piece.length) continue;
            // Reset both cached and partially downloaded pieces. Cancelled
            // block callbacks cannot fill the replaced piece instance.
            // Keep this private WebTorrent adapter covered by real TCP tests.
            torrent._markUnverified(index);
            if (!verified) continue;
            for (const wire of torrent.wires) wire.lt_donthave.donthave(index);
          }
          store.chunks.clear(); store.bytes = 0;
          return true;
        },
        async close() { signal?.removeEventListener('abort', onAbort); await closeClient(client); }
      };
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', abort);
      await closeClient(client);
      throw error;
    }
  }
  function discardWindow(window) {
    if (window.closing) return window.closing;
    window.closing = (async () => {
      window.operation.controller.abort(abortError());
      try {
        const connection = await window.ready.catch(() => null);
        await connection?.close();
      } finally { window.operation.dispose(); windows.delete(window); }
    })();
    return window.closing;
  }
  async function acquireWindow(source, position, signal) {
    const absolute = position + source.file.offset;
    const pieceLength = source.parsed.pieceLength;
    const first = Math.floor(absolute / pieceLength);
    const slots = Math.floor(windowBytes / pieceLength);
    while (true) {
      check(signal);
      let idle;
      for (const window of windows) {
        if (window.busy || window.closing) continue;
        if (window.source === source && !window.connection.client.destroyed && !window.connection.failureSignal.aborted
          && absolute >= window.start && absolute <= window.end) {
          window.busy = true;
          return window;
        }
        idle ||= window;
      }
      // Preserve proven peers across sequential windows and the small header,
      // tail-index and saved-position reads required by a resumed stream.
      for (const window of windows) {
        if (window.busy || window.closing || window.source !== source
          || window.connection.client.destroyed || window.connection.failureSignal.aborted) continue;
        if (!window.connection.rotate(window.start / pieceLength, (window.end + 1) / pieceLength - 1)) continue;
        window.start = first * pieceLength; window.end = (first + slots) * pieceLength - 1;
        window.busy = true;
        return window;
      }
      if (windows.size >= maxConcurrentStreams) {
        if (idle) await discardWindow(idle);
        else {
          const closing = [...windows].map(window => window.closing).filter(Boolean);
          if (!closing.length) throw new Error('Torrent window cache is busy.');
          await abortable(() => Promise.race(closing), signal);
        }
        continue;
      }
      const window = {
        source, start: first * pieceLength, end: (first + slots) * pieceLength - 1,
        busy: true, operation: linkedController(source.controller.signal, 0)
      };
      windows.add(window);
      const pending = source.pendingConnection; source.pendingConnection = null;
      const adopt = pending && !pending.connection.client.destroyed;
      window.ready = adopt ? Promise.resolve(pending.connection)
        : clientTorrent(source.bytes, window.operation.controller.signal, false, source.parsed, source.peers);
      try {
        window.connection = await abortable(() => window.ready, signal);
        check(signal);
        if (adopt) {
          // Metadata has a zero-byte piece store. Enable it only after a
          // payload window is reserved, without disconnecting its live peer.
          pending.claimed = true;
          window.connection.setSignal(window.operation.controller.signal);
          window.connection.enableCache();
        }
        window.connection.retainReads(source.cache, source.file);
        return window;
      } catch (error) { await discardWindow(window); throw error; }
    }
  }
  function releaseWindow(window) {
    if (!window) return;
    const { torrent } = window.connection;
    if (!torrent.destroyed) {
      torrent.files[window.source.file.index]?.deselect();
    }
    window.busy = false;
    if (window.source.controller.signal.aborted) void discardWindow(window);
    else if (!window.closing) { windows.delete(window); windows.add(window); }
  }
  async function search(media, settings, { signal } = {}) {
    ensureOpen(); check(signal);
    if (!settings.torrentIndexerUrl) return [];
    const endpoint = new URL(settings.torrentIndexerUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Torrent indexer URL must use HTTP or HTTPS.');
    if (!endpoint.pathname || endpoint.pathname === '/') endpoint.pathname = '/api';
    const releases = new Map();
    for (const title of titleVariants(media.title)) {
      for (const mode of [media.type === 'tv' ? 'tvsearch' : 'movie', 'search']) {
        const url = new URL(endpoint);
        url.searchParams.set('apikey', settings.torrentIndexerKey || '');
        url.searchParams.set('t', mode); url.searchParams.set('limit', '100');
        url.searchParams.set('q', `${title}${mode === 'search' ? ` ${episodeTag(media) || media.year || ''}` : ''}`.trim());
        if (media.type === 'tv' && mode === 'tvsearch') { url.searchParams.set('season', media.season); url.searchParams.set('ep', media.episode); }
        const operation = linkedController(signal, timeoutMs); operations.add(operation.controller);
        try {
          const response = await request(url, { signal: operation.controller.signal });
          const xml = (await boundedBody(response, METADATA_LIMIT)).toString('utf8');
          for (const release of torrentSearchResults(xml)) if (release.seeders !== 0) releases.set(release.torrentUrl, release);
        } finally { operations.delete(operation.controller); operation.dispose(); }
        if (releases.size) break;
      }
    }
    return rankTorrentReleases([...releases.values()], media, settings);
  }
  async function candidateMetadata(candidate, settings, indexerOrigin, attempted, signal, retainConnection = false) {
    const metadata = linkedController(signal, metadataTimeoutMs);
    let connection;
    try {
      const result = await abortable(async () => {
        let bytes; let knownHash; let peers;
        let url = new URL(candidate.torrentUrl);
        for (let redirects = 0; ; redirects++) {
          check(metadata.controller.signal);
          if (url.protocol === 'magnet:') {
            knownHash = magnetInfoHash(url);
            if (knownHash && attempted.has(knownHash)) return null;
            if (knownHash) attempted.add(knownHash);
            peers = new Set();
            connection = await clientTorrent(url.href, metadata.controller.signal, true, undefined, peers);
            bytes = Buffer.from(connection.torrent.torrentFile);
            if (!retainConnection) { await connection.close(); connection = null; }
            break;
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Torrent metadata URL must use HTTP, HTTPS or magnet.');
          if (indexerOrigin && url.origin === indexerOrigin && !url.searchParams.has('apikey')) url.searchParams.set('apikey', settings.torrentIndexerKey);
          const response = await request(url, { signal: metadata.controller.signal, redirect: 'manual' });
          check(metadata.controller.signal);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('Torrent metadata redirect has no location.');
            if (redirects >= 20) throw new Error('Too many torrent metadata redirects.');
            url = new URL(location, url);
            continue;
          }
          bytes = await boundedBody(response, METADATA_LIMIT);
          break;
        }
        if (bytes.length > METADATA_LIMIT) throw new Error('Torrent metadata is too large.');
        const parsed = await parse(bytes);
        check(metadata.controller.signal);
        const hash = String(parsed.infoHash).toLowerCase();
        if (hash !== knownHash && attempted.has(hash)) return null;
        attempted.add(hash);
        return { bytes, parsed, peers, connection };
      }, metadata.controller.signal);
      if (result?.connection) result.connection.setSignal(signal);
      else await connection?.close();
      return result;
    } catch (error) { await connection?.close(); throw error; }
    finally { metadata.dispose(); }
  }
  async function select(media, settings, { signal, release, excludeInfoHashes = [], validate } = {}) {
    ensureOpen(); check(signal);
    const attempted = new Set([...excludeInfoHashes].map(value => String(value).toLowerCase()));
    if (metadataActive >= maxConcurrentStreams) throw new Error('Torrent metadata selection is busy.');
    metadataActive++;
    const operation = linkedController(signal, timeoutMs); operations.add(operation.controller);
    try {
      const candidates = release ? rankTorrentReleases([release], media, settings) : await abortable(() => search(media, settings, { signal: operation.controller.signal }), operation.controller.signal);
      const indexerOrigin = settings.torrentIndexerKey ? new URL(settings.torrentIndexerUrl).origin : null;
      let lastError;
      for (const candidate of candidates) {
        check(operation.controller.signal);
        let retained; let descriptor;
        try {
          const metadata = await candidateMetadata(candidate, settings, indexerOrigin, attempted, operation.controller.signal, Boolean(validate));
          if (!metadata) continue;
          const { bytes, parsed, peers, connection } = metadata;
          if (connection) retained = { connection, claimed: false };
          if (parsed.pieceLength > cacheBytes / 2) throw new Error('Torrent pieces exceed the bounded playback cache.');
          const file = torrentFileSelection(parsed, media, candidate);
          descriptor = { kind: 'torrent', version: 1, title: candidate.title, name: file.path, size: file.size, strategy: file.strategy, infoHash: parsed.infoHash, torrent: bytes.toString('base64'), media: { type: media.type, title: media.title, alternativeTitles: media.alternativeTitles, year: media.year, season: media.season, episode: media.episode }, file, selectedAt: Date.now() };
          if (peers?.size) metadataPeers.set(descriptor, peers);
          if (retained) metadataConnections.set(descriptor, retained);
          if (validate) {
            await abortable(() => validate(descriptor, { signal: operation.controller.signal }), operation.controller.signal);
            check(operation.controller.signal);
          }
          return descriptor;
        } catch (error) { check(operation.controller.signal); lastError = error; }
        finally {
          if (retained && !retained.claimed) {
            metadataConnections.delete(descriptor);
            await retained.connection.close();
          }
        }
      }
      if (lastError) throw lastError;
      return null;
    } finally { metadataActive--; operations.delete(operation.controller); operation.dispose(); }
  }
  async function serve(req, res) {
    const id = req.url?.split('/')[1]; const source = sources.get(id);
    if (!source) { res.writeHead(404); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const range = torrentByteRange(req.headers.range, source.file.size);
    const headers = { 'accept-ranges': 'bytes', 'content-type': source.file.mime, 'cache-control': 'no-store' };
    if (!range) { res.writeHead(416, { ...headers, 'content-range': `bytes */${source.file.size}` }); res.end(); return; }
    headers['content-length'] = String(range.end - range.start + 1);
    if (range.status === 206) headers['content-range'] = `bytes ${range.start}-${range.end}/${source.file.size}`;
    source.touched = Date.now();
    if (req.method === 'HEAD') { res.writeHead(range.status, headers); res.end(); return; }
    if (admission.stats().queued >= maxQueuedReaders) { res.writeHead(429, { 'retry-after': '1' }); res.end(); return; }
    const operation = linkedController(source.controller.signal, 0); operations.add(operation.controller); source.readers.add(operation.controller);
    let settled; const completion = new Promise(resolve => { settled = resolve; }); source.completions.add(completion);
    let window; let iterator; let timer; let release;
    const touch = () => { source.touched = Date.now(); clearTimeout(timer); timer = setTimeout(() => operation.controller.abort(new Error('Torrent playback stalled.')), timeoutMs); timer.unref?.(); };
    const cancel = () => operation.controller.abort(abortError());
    const onAbort = () => res.destroy(operation.controller.signal.reason);
    res.once('close', cancel); operation.controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      touch();
      // FFmpeg opens a seek response before closing its previous range. Send
      // headers before waiting for a reader so that seek cannot deadlock.
      res.writeHead(range.status, headers); res.flushHeaders();
      release = await admission.acquire({ signal: operation.controller.signal });
      check(operation.controller.signal);
      let position = range.start;
      while (position <= range.end) {
        check(operation.controller.signal); touch();
        const absolute = position + source.file.offset;
        const pieceIndex = Math.floor(absolute / source.parsed.pieceLength);
        const cached = retainedPiece(source, pieceIndex);
        if (cached) {
          const offset = absolute % source.parsed.pieceLength;
          const output = cached.subarray(offset, Math.min(cached.length, offset + range.end - position + 1));
          if (!output.length) throw new Error('Cached torrent piece does not cover the requested range.');
          if (!res.write(output)) await drain(res, operation.controller.signal);
          position += output.length;
          continue;
        }
        window = await acquireWindow(source, position, operation.controller.signal);
        const { torrent } = window.connection;
        const readSignal = AbortSignal.any([operation.controller.signal, window.connection.failureSignal]);
        check(readSignal);
        const file = torrent.files[source.file.index];
        if (!file || file.path !== source.file.path || file.length !== source.file.size) throw new Error('Torrent file changed since selection.');
        let end = Math.min(range.end, window.end - file.offset);
        // Stop before a retained piece instead of downloading it again as
        // part of a larger uncached range.
        const lastPiece = Math.floor((end + file.offset) / source.parsed.pieceLength);
        for (let index = pieceIndex + 1; index <= lastPiece; index++) {
          if (retainedPiece(source, index)) { end = index * source.parsed.pieceLength - file.offset - 1; break; }
        }
        // WebTorrent treats end:0 as unspecified. Read two bytes in that case
        // and trim the response, never expanding a one-byte HTTP range.
        iterator = file[Symbol.asyncIterator]({ start: position, end: end === 0 ? Math.min(1, file.length - 1) : end });
        let received = 0;
        while (true) {
          const { done, value } = await nextPiece(iterator, readSignal);
          if (done) break;
          check(readSignal); touch();
          const output = value.subarray(0, end - position + 1 - received);
          received += output.byteLength;
          if (!res.write(output)) await drain(res, readSignal);
        }
        if (received !== end - position + 1) throw new Error('Torrent ended before the requested byte range was complete.');
        await iterator.return(); iterator = null;
        releaseWindow(window); window = null;
        position = end + 1;
      }
      res.end();
    } catch (error) {
      if (window && !operation.controller.signal.aborted) { await discardWindow(window); window = null; }
      res.destroy(error);
    }
    finally {
      clearTimeout(timer); await iterator?.return(); releaseWindow(window);
      res.removeListener('close', cancel); operation.controller.signal.removeEventListener('abort', onAbort);
      operation.dispose(); operations.delete(operation.controller); source.readers.delete(operation.controller); source.touched = Date.now(); release?.();
      source.completions.delete(completion); settled();
    }
  }
  async function startServer() {
    if (!starting) starting = (async () => {
      server = createServer((req, res) => { void serve(req, res); });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); server.unref();
      return server.address().port;
    })();
    return starting;
  }
  function disposeSource(id) {
    const source = sources.get(id); if (!source) return;
    source.controller.abort(abortError()); sources.delete(id);
    source.signal?.removeEventListener('abort', source.cancel);
    return Promise.all([...source.completions, source.pendingConnection?.connection.close(), ...[...windows].filter(window => window.source === source).map(discardWindow)]);
  }
  async function open(descriptor, { signal, connect = false, media = descriptor?.media } = {}) {
    ensureOpen(); check(signal);
    if (sources.size >= maxSources) throw new Error('Too many active torrent playback sources.');
    if (descriptor?.kind !== 'torrent' || descriptor.version !== 1 || typeof descriptor.torrent !== 'string' || descriptor.torrent.length > METADATA_LIMIT * 1.4) throw new Error('Invalid saved torrent source.');
    const bytes = Buffer.from(descriptor.torrent, 'base64'); const parsed = await parse(bytes);
    if (parsed.infoHash !== descriptor.infoHash || parsed.pieceLength > cacheBytes / 2) throw new Error('Saved torrent source is invalid or exceeds the piece cache limit.');
    const file = torrentFileSelection(parsed, descriptor.media, descriptor);
    if (file.index !== descriptor.file.index || file.path !== descriptor.file.path || file.size !== descriptor.file.size) throw new Error('Saved torrent source file no longer matches.');
    const port = await startServer(); ensureOpen(); check(signal);
    if (sources.size >= maxSources) throw new Error('Too many active torrent playback sources.');
    const id = randomUUID(); const controller = new AbortController();
    const cancel = () => disposeSource(id);
    const pendingConnection = metadataConnections.get(descriptor); metadataConnections.delete(descriptor);
    const source = { bytes, parsed, file, cache: cachedSource(descriptor, media), peers: metadataPeers.get(descriptor) || new Set(), pendingConnection, controller, readers: new Set(), completions: new Set(), touched: Date.now(), signal, cancel };
    sources.set(id, source);
    signal?.addEventListener('abort', cancel, { once: true });
    if (connect) {
      const operation = linkedController(controller.signal, metadataTimeoutMs);
      operations.add(operation.controller);
      let window; let release;
      try {
        // Saved metadata has no live peer. Connect before media inspection,
        // retaining this same bounded window for the probe and playback.
        release = await admission.acquire({ signal: operation.controller.signal });
        window = await acquireWindow(source, 0, operation.controller.signal);
        const { torrent } = window.connection;
        const connectSignal = AbortSignal.any([operation.controller.signal, window.connection.failureSignal]);
        check(connectSignal);
        if (!torrent.wires.length) await once(torrent, 'wire', { signal: connectSignal });
        check(connectSignal);
      } catch (error) { await disposeSource(id); throw error; }
      finally {
        releaseWindow(window); release?.();
        operations.delete(operation.controller); operation.dispose();
      }
    }
    return { url: `http://127.0.0.1:${port}/${id}/video`, size: file.size, mime: file.mime, filename: file.path, strategy: file.strategy, close: async () => disposeSource(id) };
  }
  const sweep = setInterval(() => {
    for (const [id, source] of sources) if (!source.readers.size && Date.now() - source.touched >= idleMs) disposeSource(id);
  }, Math.max(100, Math.min(idleMs, 30000))); sweep.unref();
  async function close() {
    closed = true; clearInterval(sweep);
    for (const controller of operations) controller.abort(abortError());
    await Promise.all([...sources.keys()].map(disposeSource));
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    dhtNodes.clear();
    clear();
  }
  return { search, select, open, close, clear };
}
