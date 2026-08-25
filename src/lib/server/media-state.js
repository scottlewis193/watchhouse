import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = { version: 1, library: {}, progress: {} };

function mediaKey(media) {
  const base = `${media.type}:${media.id}`;
  return media.type === 'tv' && media.season && media.episode ? `${base}:s${media.season}:e${media.episode}` : base;
}

function normalizedMedia(media) {
  const id = Number(media?.id), type = media?.type;
  if (!Number.isInteger(id) || id < 1 || !['movie', 'tv'].includes(type) || !String(media?.title || '').trim()) throw new Error('A valid movie or show is required.');
  const normalized = { id, type, title: String(media.title).trim(), year: String(media.year || '').slice(0, 4), poster: String(media.poster || '') };
  if (type === 'tv' && media.season && media.episode) Object.assign(normalized, { season: Number(media.season), episode: Number(media.episode), episodeTitle: String(media.episodeTitle || '') });
  const durationHint = Number(media.durationHint);
  if (Number.isFinite(durationHint) && durationHint > 0) normalized.durationHint = durationHint;
  return normalized;
}

function publicState(state) {
  const library = Object.values(state.library).sort((a, b) => b.addedAt - a.addedAt);
  const progress = Object.values(state.progress).sort((a, b) => b.updatedAt - a.updatedAt);
  const continueWatching = progress
    .filter(item => !item.watched && item.position >= 5 && (!item.duration || item.duration - item.position > 30))
    .map(item => ({ ...item.media, position: item.position, duration: item.duration, ...(item.duration ? { progressPercent: Math.min(100, Math.max(0, item.position / item.duration * 100)) } : {}) }));
  return { library, progress, continueWatching };
}

function updateProgressEntry(state, value, update, updatedAt) {
  const key = mediaKey(value);
  const current = state.progress[key] || { media: value, position: 0, duration: 0, watched: false };
  const duration = Math.max(0, Number(update.duration ?? current.duration) || 0);
  const watched = update.watched === undefined ? current.watched : Boolean(update.watched);
  let position = update.reset ? 0 : Math.max(0, Number(update.position ?? current.position) || 0);
  if (duration) position = Math.min(position, duration);
  if (watched && duration) position = duration;
  state.progress[key] = { media: value, position, duration, watched, updatedAt };
}

export function createMediaStateStore(path, { now = () => Date.now() } = {}) {
  let writes = Promise.resolve();

  async function load() {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      return { ...EMPTY_STATE, ...value, library: value.library || {}, progress: value.progress || {} };
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async function save(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.pending`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  }

  function mutate(change) {
    writes = writes.then(async () => { const state = await load(); change(state); await save(state); return publicState(state); });
    return writes;
  }

  return {
    async read() { await writes; return publicState(await load()); },
    setLibrary(media, inLibrary) {
      const value = normalizedMedia(media), key = `${value.type}:${value.id}`;
      delete value.season; delete value.episode; delete value.episodeTitle;
      return mutate(state => { if (inLibrary) state.library[key] = { ...value, addedAt: now() }; else delete state.library[key]; });
    },
    setProgress(media, update = {}) {
      const value = normalizedMedia(media);
      return mutate(state => updateProgressEntry(state, value, update, now()));
    },
    setProgressMany(media, update = {}) {
      if (!Array.isArray(media) || !media.length) throw new Error('At least one episode is required.');
      const values = media.map(normalizedMedia);
      return mutate(state => { for (const value of values) updateProgressEntry(state, value, update, now()); });
    }
  };
}
