// Keep validated source bytes across player sessions, with one global byte budget.
// Source identity prevents bytes from leaking between releases or provider plans.
export function createSegmentCache(maximumBytes = 64 * 1024 * 1024) {
  const sources = new WeakMap(), entries = new Map();
  let size = 0;
  function remove(entry) {
    entries.delete(entry);
    entry.owner.delete(entry.index);
    size -= entry.bytes.length;
  }
  return {
    get(source, index) {
      const entry = sources.get(source)?.get(index);
      if (!entry) return;
      entries.delete(entry); entries.set(entry, true);
      return entry.bytes;
    },
    set(source, index, bytes) {
      let owner = sources.get(source);
      if (!owner) { owner = new Map(); sources.set(source, owner); }
      if (owner.has(index)) remove(owner.get(index));
      if (bytes.length > maximumBytes) return;
      const entry = { owner, index, bytes };
      owner.set(index, entry); entries.set(entry, true); size += bytes.length;
      while (size > maximumBytes) remove(entries.keys().next().value);
    }
  };
}
