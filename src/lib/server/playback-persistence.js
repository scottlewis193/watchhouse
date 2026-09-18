import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { offlineMediaKey } from '../offline.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export const playbackScope = settings => digest(JSON.stringify([
  1, settings.usenetHost, Number(settings.usenetPort || 563), settings.usenetUser, settings.usenetPass,
  settings.indexerUrl, settings.indexerKey, `${settings.manualReleaseSelection ? 'manual:' : ''}${settings.playbackQuality || 'balanced'}`, Number(settings.untaggedAudioTrack) || 2,
  Boolean(settings.repairVideoTimeline), Boolean(settings.frameInterpolation)
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

// Small metadata is written atomically. No credentials or NZB URLs are stored.
export function createPlaybackPersistence(root, { maximumBytes = 512 * 1024 * 1024, maximumRecords = 100, now = Date.now } = {}) {
  const recordsPath = join(root, 'records.json'), bytesRoot = join(root, 'articles');
  let records, initialized, bytesInitialized, recordWrites = Promise.resolve(), byteWrites = Promise.resolve(), queuedBytes = 0, size = 0;
  const articles = new Map(), pending = new Map();
  const initialize = () => initialized ||= (async () => {
    const data = await readFile(recordsPath, 'utf8').then(JSON.parse).catch(() => ({}));
    records = new Map(data.version === 1 && Array.isArray(data.records) ? data.records : []);
    for (const [key, entry] of records) if (!entry?.expires || entry.expires <= now()) records.delete(key);
    while (records.size > maximumRecords) records.delete(records.keys().next().value);
  })();
  const flush = () => {
    recordWrites = recordWrites.catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true });
      const temporary = `${recordsPath}.${randomUUID()}.pending`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, records: [...records] }), { mode: 0o600 });
        await rename(temporary, recordsPath);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    return recordWrites;
  };
  async function getRecord(key, ttl) {
    await initialize();
    const entry = records.get(key);
    if (!entry || entry.expires <= now() || entry.created + ttl <= now()) return null;
    records.delete(key); records.set(key, entry);
    return structuredClone(entry.value);
  }
  async function setRecord(key, value, ttl) {
    await initialize();
    records.delete(key); records.set(key, { value, created: now(), expires: now() + ttl });
    while (records.size > maximumRecords) records.delete(records.keys().next().value);
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
  return {
    getPlan: (media, settings) => getRecord(`plan:${offlineMediaKey(media)}:${playbackScope(settings)}`, playbackRetention(settings)),
    setPlan(media, settings, plan) {
      const { file, release, releaseKey, strategy } = plan;
      return setRecord(`plan:${offlineMediaKey(media)}:${playbackScope(settings)}`, { file, release, ...(releaseKey ? { releaseKey } : {}), strategy }, playbackRetention(settings));
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
