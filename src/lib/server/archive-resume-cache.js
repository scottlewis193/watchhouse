import { offlineMediaKey } from '../offline.js';

// Retain live extraction across player sessions. Production retention has no
// arbitrary time or size limit; explicit lifecycle events decide when it ends.
export function createArchiveResumeCache({ ttl = 0, maximum = Infinity, maximumBytes = Infinity, now = Date.now } = {}) {
  const entries = new Map();
  const key = (media, scope) => `${offlineMediaKey(media)}:${scope}`;
  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); clearTimeout(entry.timer); entry.lease.close();
  }
  function touch(id, entry) {
    clearTimeout(entry.timer);
    entry.expires = ttl > 0 ? now() + ttl : Infinity;
    if (ttl > 0) {
      entry.timer = setTimeout(() => {
        if (entry.plan.archiveSource.consumers > 0 && !entry.plan.archiveSource.closed && !entry.plan.archiveSource.failure) touch(id, entry);
        else remove(id);
      }, ttl);
      entry.timer.unref();
    }
    entries.delete(id); entries.set(id, entry);
  }
  return {
    get(media, scope) {
      const id = key(media, scope), entry = entries.get(id);
      if (!entry) return;
      if ((ttl > 0 && entry.expires <= now() && !(entry.plan.archiveSource.consumers > 0)) || entry.plan.archiveSource.closed || entry.plan.archiveSource.failure) { remove(id); return; }
      touch(id, entry);
      return entry.plan;
    },
    set(media, scope, plan) {
      const source = plan.archiveSource, bytes = source?.metadata?.size;
      if (!source || source.closed || source.failure || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximumBytes) return;
      const id = key(media, scope);
      const lease = source.hold ? source.hold() : source.retain();
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
