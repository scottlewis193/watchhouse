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

export function createReleaseHealthStore(path, { now = Date.now, ttl = 24 * 60 * 60 * 1000, maximum = 1000 } = {}) {
  let entries, loading, saving = Promise.resolve();
  const key = (settings, media, release) => createHash('sha256').update(JSON.stringify([
    settings.usenetHost, settings.usenetPort || 563, settings.usenetUser,
    media.type, media.id || media.title, media.season, media.episode, release
  ])).digest('hex');
  async function load() {
    loading ||= readFile(path, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }).then(value => { entries = new Map(value); });
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
    async has(settings, media, release) {
      await load();
      return expiry(entries.get(key(settings, media, release))) > now();
    },
    async reject(settings, media, release) {
      await load();
      const id = key(settings, media, release);
      entries.delete(id); entries.set(id, { expires: now() + ttl, media: offlineMediaKey(media) });
      for (const [entry, value] of entries) if (expiry(value) <= now()) entries.delete(entry);
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
      await save();
    },
    async delete(media) {
      await load();
      const mediaKey = offlineMediaKey(media);
      for (const [entry, value] of entries) if (value?.media === mediaKey) entries.delete(entry);
      await save();
    }
  };
}
