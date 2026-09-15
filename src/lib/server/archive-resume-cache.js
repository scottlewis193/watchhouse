import { offlineMediaKey } from '../offline.js';

// Retain live extraction briefly across player sessions. Leases keep eviction
// from closing a source that an active player is still using.
export function createArchiveResumeCache({ ttl = 5 * 60 * 1000, maximum = 2, maximumBytes = 20 * 1024 ** 3, now = Date.now } = {}) {
  const entries = new Map();
  const key = (media, scope) => `${offlineMediaKey(media)}:${scope}`;
  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); clearTimeout(entry.timer); entry.lease.close();
  }
  function touch(id, entry) {
    clearTimeout(entry.timer);
    entry.expires = now() + ttl;
    entry.timer = setTimeout(() => {
      // One lease belongs to this cache; additional leases belong to players.
      if (entry.plan.archiveSource.consumers > 1 && !entry.plan.archiveSource.closed && !entry.plan.archiveSource.failure) touch(id, entry);
      else remove(id);
    }, ttl); entry.timer.unref();
    entries.delete(id); entries.set(id, entry);
  }
  return {
    get(media, scope) {
      const id = key(media, scope), entry = entries.get(id);
      if (!entry) return;
      if ((entry.expires <= now() && !(entry.plan.archiveSource.consumers > 1)) || entry.plan.archiveSource.closed || entry.plan.archiveSource.failure) { remove(id); return; }
      touch(id, entry);
      return entry.plan;
    },
    set(media, scope, plan) {
      const source = plan.archiveSource, bytes = source?.metadata?.size;
      if (!source || source.closed || source.failure || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximumBytes) return;
      const id = key(media, scope);
      const lease = source.retain();
      remove(id);
      const entry = { plan, bytes, lease };
      touch(id, entry);
      while (entries.size > maximum || [...entries.values()].reduce((sum, e) => sum + e.bytes, 0) > maximumBytes) remove(entries.keys().next().value);
    },
    delete(media) {
      const prefix = `${offlineMediaKey(media)}:`;
      for (const id of [...entries.keys()]) if (id.startsWith(prefix)) remove(id);
    },
    clear() { for (const id of entries.keys()) remove(id); }
  };
}
