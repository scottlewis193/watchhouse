import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { offlineMediaKey } from '../offline.js';

const digest = value => createHash('sha256').update(value).digest('hex');
// Scope 5 invalidates saved choices made before TV-series year disambiguation.
export const playbackScope = settings => digest(JSON.stringify([
  5, settings.usenetHost, Number(settings.usenetPort || 563), settings.usenetUser, settings.usenetPass,
  settings.indexerUrl, settings.indexerKey, `${settings.manualReleaseSelection ? 'manual:' : ''}${settings.playbackQuality || 'balanced'}`, settings.targetResolution || 'auto', Number(settings.untaggedAudioTrack) || 2,
  Boolean(settings.repairVideoTimeline), Boolean(settings.frameInterpolation), settings.torrentIndexerUrl, settings.torrentIndexerKey
]));
export const playbackRetention = settings => Math.min(168, Math.max(1, Number(settings.cacheRetentionHours) || 24)) * 3600000;
const sourceIds = new WeakMap();
export function playbackSourceKey(file, settings) {
  const scope = playbackScope(settings);
  let entry = sourceIds.get(file);
  if (!entry || entry.scope !== scope) {
    entry = { scope, id: digest(JSON.stringify([scope, file.subject, file.segments.map(s => [s.id, s.decodedBytes])])) };
    sourceIds.set(file, entry);
  }
  return entry.id;
}
const scopedPlaybackSourceKey = (file, scope) => digest(JSON.stringify([scope, file.subject, file.segments.map(s => [s.id, s.decodedBytes])]));

const archiveLayoutKey = (archives, settings) => `archive-layout:${digest(JSON.stringify([
  1, playbackScope(settings), archives.map(file => [file.subject, file.segments.map(segment => [segment.id, segment.number, segment.bytes ?? null, segment.decodedBytes ?? null])])
]))}`;
function validArchiveLayout(layout) {
  if (!layout || typeof layout.name !== 'string' || !layout.name || !Number.isSafeInteger(layout.size) || layout.size <= 0
    || !Array.isArray(layout.parts) || !layout.parts.length || !Array.isArray(layout.volumeOffsets) || layout.volumeOffsets.length < 2
    || layout.volumeOffsets[0] !== 0 || layout.volumeOffsets.some((offset, index, offsets) => !Number.isSafeInteger(offset) || offset < 0 || index > 0 && offset <= offsets[index - 1])) return false;
  let end = 0, archiveEnd = 0;
  for (const part of layout.parts) {
    if (!part || ![part.videoStart, part.archiveStart, part.length, part.videoEnd].every(Number.isSafeInteger)
      || part.videoStart !== end || part.archiveStart < archiveEnd || part.length <= 0 || part.videoEnd !== part.videoStart + part.length
      || !Number.isSafeInteger(part.videoEnd) || !Number.isSafeInteger(part.archiveStart + part.length)
      || part.archiveStart + part.length > layout.volumeOffsets.at(-1)) return false;
    end = part.videoEnd; archiveEnd = part.archiveStart + part.length;
  }
  return end === layout.size;
}

const archiveProbeVersion = 1;
const archiveProbePrefix = (archives, settings) => `archive-probe:${archiveLayoutKey(archives, settings).slice('archive-layout:'.length)}:`;
const archiveProbeKey = (archives, settings, layout) => `${archiveProbePrefix(archives, settings)}${digest(JSON.stringify([archiveProbeVersion, layout]))}`;
function completeArchiveLayout(archives, layout) {
  if (!validArchiveLayout(layout) || !archives.length || layout.parts.length !== archives.length
    || layout.volumeOffsets.length !== archives.length + 1 || Buffer.byteLength(layout.name) > 4096
    || /[\\/\0]/.test(layout.name) || !/\.(mkv|mp4|m4v|mov|webm)$/i.test(layout.name)
    || /(^|[._ -])(sample|trailer|preview|proof)([._ -]|$)/i.test(layout.name)
    || layout.size < layout.volumeOffsets.at(-1) / 2) return false;
  for (let index = 0; index < layout.parts.length; index++) {
    if (!Number.isSafeInteger(layout.volumeOffsets[index + 1])
      || layout.parts[index].archiveStart <= layout.volumeOffsets[index]
      || layout.parts[index].archiveStart + layout.parts[index].length > layout.volumeOffsets[index + 1]) return false;
  }
  return true;
}
function archiveProbeMetadata(metadata) {
  const streamIndex = value => Number.isSafeInteger(value) && value >= 0;
  const frameRate = value => Number.isFinite(value) && value > 0;
  if (!metadata || !Array.isArray(metadata.tracks)
    || !(metadata.audioIndex === null || streamIndex(metadata.audioIndex)) || !streamIndex(metadata.videoIndex)
    || !Number.isFinite(metadata.duration) || metadata.duration < 0
    || !(metadata.videoFrameRate === null || frameRate(metadata.videoFrameRate))
    || !(metadata.videoCodec === null || typeof metadata.videoCodec === 'string')
    || metadata.repairVideoFrameRate !== undefined && !frameRate(metadata.repairVideoFrameRate)) return null;
  const tracks = [];
  for (const track of metadata.tracks) {
    if (!track || !streamIndex(track.index) || !['audio', 'captions'].includes(track.type)
      || ['language', 'label'].some(key => track[key] !== undefined && typeof track[key] !== 'string')
      || track.supported !== undefined && typeof track.supported !== 'boolean') return null;
    tracks.push({
      index: track.index, type: track.type,
      ...(track.language !== undefined ? { language: track.language } : {}),
      ...(track.label !== undefined ? { label: track.label } : {}),
      ...(track.supported !== undefined ? { supported: track.supported } : {})
    });
  }
  return {
    tracks, audioIndex: metadata.audioIndex, videoIndex: metadata.videoIndex, duration: metadata.duration,
    videoFrameRate: metadata.videoFrameRate, videoCodec: metadata.videoCodec,
    ...(metadata.repairVideoFrameRate !== undefined ? { repairVideoFrameRate: metadata.repairVideoFrameRate } : {})
  };
}

const archivePlanVersion = 1;
const isArchivePlan = value => Object.hasOwn(value, 'archivePlanVersion') || Object.hasOwn(value, 'archives') || Object.hasOwn(value, 'manifest');
function archivePlanManifest(plan) {
  if (!plan || !Array.isArray(plan.archives) || !plan.archives.length || plan.archives.length > 4096
    || typeof plan.release !== 'string' || !plan.release.trim() || Buffer.byteLength(plan.release) > 4096
    || plan.releaseKey !== undefined && (typeof plan.releaseKey !== 'string' || !plan.releaseKey.trim() || Buffer.byteLength(plan.releaseKey) > 4096)
    || !['raw', 'remux', 'transcode'].includes(plan.strategy)) return null;
  let count = 0;
  const archives = [];
  for (const file of plan.archives) {
    if (!file || typeof file.subject !== 'string' || !file.subject.trim() || Buffer.byteLength(file.subject) > 4096
      || /[\0\r\n]/.test(file.subject) || !Array.isArray(file.segments) || !file.segments.length
      || (count += file.segments.length) > 1000000) return null;
    const segments = [], ids = new Set();
    let previous = 0, bytes = 0, decodedBytes = 0;
    for (const segment of file.segments) {
      if (!segment || typeof segment.id !== 'string' || !segment.id || Buffer.byteLength(segment.id) > 1024
        || !/^(?:[^\s<>\x00-\x1f\x7f]+|<[^\s<>\x00-\x1f\x7f]+>)$/.test(segment.id) || ids.has(segment.id)
        || !Number.isSafeInteger(segment.number) || segment.number <= previous) return null;
      const saved = { id: segment.id, number: segment.number };
      for (const field of ['bytes', 'decodedBytes']) {
        if (segment[field] === undefined) continue;
        if (!Number.isSafeInteger(segment[field]) || segment[field] <= 0) return null;
        saved[field] = segment[field];
      }
      bytes += segment.bytes ?? 0; decodedBytes += segment.decodedBytes ?? 0;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(decodedBytes)) return null;
      previous = segment.number; ids.add(segment.id); segments.push(saved);
    }
    archives.push({ subject: file.subject, segments });
  }
  return { archives, release: plan.release, ...(plan.releaseKey !== undefined ? { releaseKey: plan.releaseKey } : {}), strategy: plan.strategy };
}

// Direct-source metadata has no age/count eviction; archive records and video bytes remain bounded.
// Torrent metadata may contain private tracker URLs. Records are owner-only.
export function createPlaybackPersistence(root, { maximumBytes = 512 * 1024 * 1024, now = Date.now } = {}) {
  const recordsPath = join(root, 'records.json'), bytesRoot = join(root, 'articles');
  let records, initialized, bytesInitialized, recordWrites = Promise.resolve(), byteWrites = Promise.resolve(), queuedBytes = 0, size = 0;
  const articles = new Map(), pending = new Map();
  const initialize = () => initialized ||= (async () => {
    const data = await readFile(recordsPath, 'utf8').then(JSON.parse).catch(() => ({}));
    records = new Map([1, 2].includes(data?.version) && Array.isArray(data.records) ? data.records.filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') : []);
    for (const [key, entry] of records) {
      if (!entry?.value || typeof entry.value !== 'object') records.delete(key);
      else records.set(key, { value: entry.value });
    }
  })();
  const flush = () => {
    recordWrites = recordWrites.catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true });
      const temporary = `${recordsPath}.${randomUUID()}.pending`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 2, records: [...records] }), { mode: 0o600 });
        await rename(temporary, recordsPath);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return recordWrites;
  };
  async function getRecord(key) {
    await initialize();
    const entry = records.get(key);
    return entry ? structuredClone(entry.value) : null;
  }
  async function setRecord(key, value) {
    await initialize();
    records.set(key, { value });
    await flush();
  }
  async function removeArticle(key) {
    const entry = articles.get(key);
    if (!entry) return;
    articles.delete(key); size -= entry.size;
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
      if (info?.isFile()) { articles.set(name, { size: info.size, at: info.mtimeMs }); size += info.size; }
    }
    await trim(168 * 3600000);
  })();
  const articleKey = (file, index, settings) => digest(`${playbackSourceKey(file, settings)}:${index}`);
  const trimArchiveRecords = prefix => {
    const layouts = [];
    for (const [key, entry] of records) {
      if (!key.startsWith(prefix)) continue;
      if (!(entry.value.expires > now())) records.delete(key);
      else layouts.push([key, entry.value.at]);
    }
    layouts.sort((a, b) => a[1] - b[1]);
    while (layouts.length > 128) records.delete(layouts.shift()[0]);
  };
  return {
    async getArchiveProbe(archives, settings, layout) {
      if (!completeArchiveLayout(archives, layout)) return null;
      const key = archiveProbeKey(archives, settings, layout), value = await getRecord(key);
      if (!value) return null;
      const metadata = archiveProbeMetadata(value.metadata);
      if (value.version !== archiveProbeVersion || !Number.isFinite(value.at) || value.at > now() || !Number.isFinite(value.expires)
        || !(Math.min(value.expires, value.at + playbackRetention(settings)) > now())
        || !metadata || value.checksum !== digest(JSON.stringify([key, value.metadata]))) {
        records.delete(key); await flush(); return null;
      }
      return metadata;
    },
    async setArchiveProbe(archives, settings, layout, metadata, media) {
      if (!completeArchiveLayout(archives, layout)) return;
      const saved = archiveProbeMetadata(metadata);
      if (!saved) return;
      await initialize();
      const at = now(), key = archiveProbeKey(archives, settings, layout);
      records.set(key, { value: {
        version: archiveProbeVersion, at, expires: at + playbackRetention(settings), metadata: saved,
        checksum: digest(JSON.stringify([key, saved])), media: media ? digest(offlineMediaKey(media)) : null
      } });
      trimArchiveRecords('archive-probe:'); await flush();
    },
    async getArchiveLayout(archives, settings) {
      const key = archiveLayoutKey(archives, settings), value = await getRecord(key);
      if (!value) return null;
      if (value.version !== 1 || !Number.isFinite(value.at) || !(Math.min(value.expires, value.at + playbackRetention(settings)) > now())
        || !validArchiveLayout(value.layout) || value.checksum !== digest(JSON.stringify(value.layout))) {
        records.delete(key); await flush(); return null;
      }
      return value.layout;
    },
    async setArchiveLayout(archives, settings, layout, media) {
      if (!validArchiveLayout(layout)) return;
      await initialize();
      const mapping = structuredClone(layout), at = now();
      records.set(archiveLayoutKey(archives, settings), { value: {
        version: 1, at, expires: at + playbackRetention(settings), layout: mapping,
        checksum: digest(JSON.stringify(mapping)), media: media ? digest(offlineMediaKey(media)) : null
      } });
      trimArchiveRecords('archive-layout:'); await flush();
    },
    async deleteArchiveLayout(archives, settings) {
      await initialize();
      records.delete(archiveLayoutKey(archives, settings));
      const prefix = archiveProbePrefix(archives, settings);
      for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key);
      await flush();
    },
    async getPlan(media, settings) {
      const key = `plan:${offlineMediaKey(media)}:${playbackScope(settings)}`;
      await initialize();
      const value = records.get(key)?.value;
      if (!value) return null;
      if (!isArchivePlan(value)) return structuredClone(value);
      const manifest = archivePlanManifest(value.manifest);
      if (value.archivePlanVersion !== archivePlanVersion || !manifest || !Number.isFinite(value.at) || value.at > now()
        || !Number.isFinite(value.expires) || !(Math.min(value.expires, value.at + playbackRetention(settings)) > now())
        || value.checksum !== digest(JSON.stringify([key, manifest]))) {
        records.delete(key); await flush(); return null;
      }
      return manifest;
    },
    async setPlan(media, settings, plan) {
      const key = `plan:${offlineMediaKey(media)}:${playbackScope(settings)}`;
      if (!plan.torrentSource && Object.hasOwn(plan, 'archives')) {
        const manifest = archivePlanManifest(plan);
        if (!manifest) return;
        await initialize();
        const at = now();
        records.set(key, { value: {
          archivePlanVersion, manifest, at, expires: at + playbackRetention(settings),
          checksum: digest(JSON.stringify([key, manifest]))
        } });
        const plans = [];
        for (const [recordKey, entry] of records) {
          if (!recordKey.startsWith('plan:') || !isArchivePlan(entry.value)) continue;
          if (!(entry.value.expires > at)) records.delete(recordKey);
          else plans.push([recordKey, entry.value.at]);
        }
        plans.sort((a, b) => a[1] - b[1]);
        while (plans.length > 128) records.delete(plans.shift()[0]);
        await flush(); return;
      }
      const { file, release, releaseKey, strategy, torrentSource } = plan;
      const value = torrentSource ? { torrentSource } : { file, release, ...(releaseKey ? { releaseKey } : {}), strategy };
      await setRecord(key, value);
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
      await byteWrites.catch(() => {});
      const prefix = `plan:${offlineMediaKey(media)}:`;
      const sources = [];
      let removed = 0;
      for (const [key, entry] of records) {
        if ((key.startsWith('archive-layout:') || key.startsWith('archive-probe:')) && entry.value.media === digest(offlineMediaKey(media))) records.delete(key);
      }
      for (const [key, entry] of [...records]) {
        if (!key.startsWith(prefix)) continue;
        removed++;
        const file = entry?.value?.file;
        if (file?.segments?.length) sources.push({ file, id: scopedPlaybackSourceKey(file, key.slice(prefix.length)) });
        records.delete(key);
      }
      for (const source of sources) {
        records.delete(`probe:${source.id}`);
        for (let index = 0; index < source.file.segments.length; index++) await removeArticle(digest(`${source.id}:${index}`));
      }
      await flush();
      return { sources: removed };
    },
    getProbe: (file, settings) => getRecord(`probe:${playbackSourceKey(file, settings)}`),
    setProbe: (file, settings, metadata) => setRecord(`probe:${playbackSourceKey(file, settings)}`, metadata),
    async getSegment(file, index, settings) {
      const key = articleKey(file, index, settings);
      await initializeBytes(); await pending.get(key);
      const entry = articles.get(key);
      if (!entry || entry.at + playbackRetention(settings) <= now()) return null;
      try {
        const data = await readFile(join(bytesRoot, key)), bytes = data.subarray(32);
        if (bytes.length !== file.segments[index].decodedBytes || !createHash('sha256').update(bytes).digest().equals(data.subarray(0, 32))) return null;
        entry.at = now();
        void utimes(join(bytesRoot, key), new Date(entry.at), new Date(entry.at)).catch(() => {});
        return bytes;
      } catch { return null; }
    },
    setSegment(file, index, settings, bytes) {
      if (bytes.length !== file.segments[index].decodedBytes || bytes.length + 32 > maximumBytes || queuedBytes + bytes.length > 16 * 1024 * 1024) return;
      const key = articleKey(file, index, settings);
      if (pending.has(key)) return;
      queuedBytes += bytes.length;
      const write = byteWrites.catch(() => {}).then(async () => {
        await initializeBytes();
        const temporary = join(bytesRoot, `${key}.${randomUUID()}.pending`);
        try {
          const data = Buffer.concat([createHash('sha256').update(bytes).digest(), bytes]);
          await writeFile(temporary, data, { mode: 0o600 });
          await rename(temporary, join(bytesRoot, key));
          size -= articles.get(key)?.size || 0;
          articles.set(key, { size: data.length, at: now() }); size += data.length;
          await trim(playbackRetention(settings));
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      }).finally(() => { pending.delete(key); queuedBytes -= bytes.length; });
      byteWrites = write; pending.set(key, write.catch(() => {}));
      void write.catch(() => {});
    },
    async flush() { await recordWrites; await byteWrites; },
    async prune(settings) { await initializeBytes(); await byteWrites.catch(() => {}); await trim(playbackRetention(settings)); }
  };
}
