// Keep validated source bytes across player sessions, with one global byte budget.
// Source identity prevents bytes from leaking between releases or provider plans.
export function createSegmentCache(maximumBytes = 64 * 1024 * 1024) {
  const sources = new WeakMap(), inflight = new WeakMap(), entries = new Map();
  let size = 0;
  function remove(entry) {
    entries.delete(entry);
    entry.owner.delete(entry.index);
    size -= entry.bytes.length;
  }
  const cache = {
    get(source, index) {
      const entry = sources.get(source)?.get(index);
      if (!entry) return;
      entries.delete(entry); entries.set(entry, true);
      return entry.bytes;
    },
    load(source, index, produce) {
      const bytes = cache.get(source, index);
      if (bytes) return Promise.resolve(bytes);
      let pending = inflight.get(source);
      if (!pending) { pending = new Map(); inflight.set(source, pending); }
      if (pending.has(index)) return pending.get(index);
      const request = Promise.resolve().then(produce).then(bytes => { cache.set(source, index, bytes); return bytes; });
      pending.set(index, request);
      void request.finally(() => pending.delete(index)).catch(() => {});
      return request;
    },
    set(source, index, bytes) {
      let owner = sources.get(source);
      if (!owner) { owner = new Map(); sources.set(source, owner); }
      if (owner.has(index)) remove(owner.get(index));
      if (bytes.length > maximumBytes) return;
      const entry = { owner, index, bytes };
      owner.set(index, entry); entries.set(entry, true); size += bytes.length;
      while (size > maximumBytes) remove(entries.keys().next().value);
    },
    delete(source) {
      const owner = sources.get(source);
      if (!owner) return;
      for (const entry of [...owner.values()]) remove(entry);
      sources.delete(source);
      inflight.delete(source);
    }
  };
  return cache;
}
