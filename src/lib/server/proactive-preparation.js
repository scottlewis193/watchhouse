// Producers are lazy: a long series cannot fill an unbounded pending queue.
export function createProactivePreparation({ key, prepare, now = Date.now, ttl = 30 * 60 * 1000, maximum = 1200, budgetMs = 45000, delayMs = 250 } = {}) {
  const producers = new Map(), completed = new Map(), submitted = new Map();
  let scope, controller = new AbortController(), running = false, generation = 0;
  const sleep = signal => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, delayMs); timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
  async function drain(version, signal) {
    running = true;
    try {
      while (!signal.aborted && producers.size) {
        const [id, producer] = producers.entries().next().value;
        producers.delete(id);
        let entry;
        try { entry = await producer.iterator.next(); }
        catch { submitted.delete(id); continue; }
        if (signal.aborted) break;
        if (entry.done) continue;
        producers.set(id, producer);
        const media = entry.value, idKey = key(media, producer.settings);
        if (!idKey || (completed.get(idKey) || 0) > now()) continue;
        const attempt = new AbortController();
        const abort = () => attempt.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => attempt.abort(new Error('Background source check timed out.')), budgetMs); timer.unref?.();
        let ready = false;
        try { ready = await prepare(media, producer.settings, attempt.signal); }
        catch { /* Playback retries failed preparation on demand. */ }
        finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
        if (signal.aborted) break;
        completed.set(idKey, now() + (ready ? ttl : Math.min(ttl, 60000)));
        while (completed.size > maximum) completed.delete(completed.keys().next().value);
        await sleep(signal);
      }
    } finally {
      if (version === generation) {
        running = false;
        if (producers.size && !signal.aborted) void drain(version, signal);
      }
    }
  }
  return {
    enqueue(id, items, settings, variant) {
      if (scope !== variant) { this.cancel(); scope = variant; }
      if ((submitted.get(id) || 0) > now()) return;
      submitted.set(id, now() + ttl);
      while (submitted.size > maximum) submitted.delete(submitted.keys().next().value);
      if (producers.has(id)) return;
      producers.set(id, { iterator: items[Symbol.asyncIterator]?.() || items[Symbol.iterator](), settings });
      if (!running) void drain(generation, controller.signal);
    },
    cancel() {
      generation++; controller.abort(); controller = new AbortController();
      producers.clear(); completed.clear(); submitted.clear(); running = false; scope = undefined;
    }
  };
}

export async function* remainingAiredEpisodes(media, seasons, episodes, today = new Date().toISOString().slice(0, 10)) {
  for (const season of await seasons(media.id)) {
    if (season.number < Number(media.season || 1)) continue;
    for (const episode of await episodes(media.id, season.number)) {
      if (season.number === Number(media.season || 1) && episode.number <= Number(media.episode || 0)) continue;
      if (!episode.airDate || episode.airDate > today) continue;
      yield { ...media, season: season.number, episode: episode.number, episodeTitle: episode.name, durationHint: episode.runtime * 60 };
    }
  }
}
