import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Saved settings stay separate from runtime credentials, including on update/reset.
export function createSettingsStore(path, { env = process.env } = {}) {
  let reportedError = '';

  async function readSaved() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async function effective(saved) {
    const bundledPath = env.WATCHHOUSE_BUNDLED_TORZNAB_FILE;
    const enabled = Boolean(bundledPath) && String(env.WATCHHOUSE_BUNDLED_INDEXER).trim().toLowerCase() !== 'false';
    if (!enabled) return saved;
    let bundled;
    try {
      bundled = JSON.parse(await readFile(bundledPath, 'utf8'));
      if (typeof bundled?.torrentIndexerUrl !== 'string' || !bundled.torrentIndexerUrl.trim() || typeof bundled.torrentIndexerKey !== 'string' || !bundled.torrentIndexerKey.trim() || !Array.isArray(bundled.indexers) || !bundled.indexers.length || !bundled.indexers.every(id => typeof id === 'string' && id.length)) {
        throw new Error('Invalid bundled configuration');
      }
      reportedError = '';
    } catch (error) {
      // Startup may still be preparing Jackett. Never log the private JSON/parser error.
      if (error.code !== 'ENOENT' && reportedError !== (error.code || 'invalid')) {
        reportedError = error.code || 'invalid';
        console.error(`Bundled Torznab configuration could not be loaded (${reportedError}).`);
      }
      bundled = null;
    }
    const active = Boolean(bundled && !saved.torrentIndexerUrl?.trim());
    return {
      ...saved,
      ...(active ? { torrentIndexerUrl: bundled.torrentIndexerUrl, torrentIndexerKey: bundled.torrentIndexerKey } : {}),
      bundledTorrent: { enabled: true, available: Boolean(bundled), active, indexers: bundled?.indexers || [] }
    };
  }

  async function save(saved) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(saved, null, 2), { mode: 0o600 });
    return effective(saved);
  }

  return {
    async read() { return effective(await readSaved()); },
    async update(incoming) {
      const current = await readSaved();
      const next = { ...current, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== '')) };
      if (Object.hasOwn(incoming, 'torrentIndexerUrl')) {
        const url = incoming.torrentIndexerUrl.trim();
        if (url) {
          next.torrentIndexerUrl = url;
          next.torrentIndexerKey = incoming.torrentIndexerKey || (url === current.torrentIndexerUrl ? current.torrentIndexerKey : '') || '';
        } else {
          delete next.torrentIndexerUrl;
          delete next.torrentIndexerKey;
        }
      }
      if (!next.torrentIndexerUrl) delete next.torrentIndexerKey;
      for (const key of ['bundledTorrent', 'hasTorrentIndexer', 'hasTorrentIndexerKey', 'hasIndexerKey', 'hasUsenetPass', 'hasTmdbToken', 'watchmodeKey', 'omdbKey', 'downloadNextEpisode']) delete next[key];
      return save(next);
    },
    async reset() { return save({}); }
  };
}
