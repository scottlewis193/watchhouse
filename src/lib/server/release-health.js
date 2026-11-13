import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { offlineMediaKey } from '../offline.js';

export function releaseIdentity(release) {
  if (!release?.nzbUrl) return release?.title || '';
  const url = new URL(release.nzbUrl);
  url.searchParams.delete('apikey');
  url.searchParams.sort();
  return `upload:${createHash('sha256').update(url.href).digest('hex')}`;
}

export function articleSetIdentity(files) {
  const ids = [...new Set(files.flatMap(file => (file.segments || [])
    .map(segment => String(segment.id || '').replace(/[<>]/g, '').trim()).filter(Boolean)))].sort();
  if (!ids.length) return null;
  const hash = createHash('sha256');
  for (const id of ids) hash.update(`${id.length}:`).update(id);
  return `articles:${hash.digest('hex')}`;
}

export function createReleaseHealthStore(path, { now = Date.now, ttl = 24 * 60 * 60 * 1000, maximum = 1000 } = {}) {
  let entries, loading, saving = Promise.resolve();
  const key = (settings, media, release) => createHash('sha256').update(JSON.stringify([
    2, settings.usenetHost, Number(settings.usenetPort || 563), settings.usenetUser, settings.usenetPass, Boolean(settings.repairVideoTimeline),
    media.type, media.id ?? media.title, media.season, media.episode, release
  ])).digest('hex');
  async function load() {
    loading ||= readFile(path, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }).then(value => { entries = new Map(Array.isArray(value) ? value.filter(entry => Array.isArray(entry) && entry.length === 2) : []); });
    await loading;
  }
  const expiry = value => typeof value === 'number' ? value : value?.expires || 0;
  const save = () => {
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify([...entries]), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    return saving;
  };
  return {
    async get(settings, media, release) {
      await load();
      const value = entries.get(key(settings, media, release)), expires = expiry(value);
      return expires > now() ? { reason: value?.reason, expires } : null;
    },
    async has(settings, media, release) {
      await load();
      return expiry(entries.get(key(settings, media, release))) > now();
    },
    async reject(settings, media, release, reason) {
      await load();
      const id = key(settings, media, release);
      const previous = entries.get(id);
      const retainedReason = ['ARCHIVE_ENCRYPTED', 'ARCHIVE_UNSUPPORTED'].includes(reason) ? reason : expiry(previous) > now() ? previous?.reason : undefined;
      entries.delete(id); entries.set(id, { expires: now() + ttl, media: createHash('sha256').update(offlineMediaKey(media)).digest('hex'), ...(retainedReason ? { reason: retainedReason } : {}) });
      for (const [entry, value] of entries) if (expiry(value) <= now()) entries.delete(entry);
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
      await save();
    },
    async delete(media) {
      await load();
      const mediaKey = createHash('sha256').update(offlineMediaKey(media)).digest('hex');
      for (const [entry, value] of entries) if (value?.media === mediaKey) entries.delete(entry);
      await save();
    }
  };
}
