import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

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
  return {
    async has(settings, media, release) {
      await load();
      return (entries.get(key(settings, media, release)) || 0) > now();
    },
    async reject(settings, media, release) {
      await load();
      const id = key(settings, media, release);
      entries.delete(id); entries.set(id, now() + ttl);
      for (const [entry, expiry] of entries) if (expiry <= now()) entries.delete(entry);
      while (entries.size > maximum) entries.delete(entries.keys().next().value);
      saving = saving.catch(() => {}).then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify([...entries]), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
      await saving;
    }
  };
}
