import { createHash } from 'node:crypto';
import { releaseIdentity } from './release-health.js';

// Hints only order equivalent candidates and skip recent STAT probes. BODY,
// layout, audio, timeline and output-speed validation are never skipped.
export function createReleaseHints({ now = Date.now, availabilityTtlMs = 30000, latencyTtlMs = 120000, maximum = 1000 } = {}) {
  const entries = new Map();
  return {
    forProvider(settings) {
      const scope = createHash('sha256').update(JSON.stringify([
        settings.usenetHost, Number(settings.usenetPort || 563), settings.usenetUser, settings.usenetPass
      ])).digest('hex');
      const key = identity => `${scope}:${identity}`;
      const get = identity => {
        const id = key(identity), value = entries.get(id);
        if (!value) return null;
        const time = now();
        const available = value.availabilityExpires > time ? value.available : null;
        const elapsedMs = value.latencyExpires > time ? value.elapsedMs : null;
        if (available === null && elapsedMs === null) { entries.delete(id); return null; }
        return { available, elapsedMs };
      };
      return {
        get,
        record(identity, { available, elapsedMs } = {}) {
          if (!identity) return;
          const id = key(identity), previous = entries.get(id) || {}, value = { ...previous }, time = now();
          if (typeof available === 'boolean') { value.available = available; value.availabilityExpires = time + availabilityTtlMs; }
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0) { value.elapsedMs = elapsedMs; value.latencyExpires = time + latencyTtlMs; }
          if (value.availabilityExpires === undefined && value.latencyExpires === undefined) return;
          entries.delete(id); entries.set(id, value);
          while (entries.size > maximum) entries.delete(entries.keys().next().value);
        },
        order(releases, preferenceKey) {
          let group = -1, previous, known = false;
          const ranked = releases.map((release, index) => {
            const preference = preferenceKey(release);
            if (index === 0 || preference !== previous) group++;
            previous = preference;
            const hint = get(releaseIdentity(release));
            known ||= Boolean(hint);
            return { release, index, group, hint };
          });
          if (!known) return releases;
          const availability = item => item.hint?.available === true ? 0 : item.hint?.available === false ? 2 : 1;
          ranked.sort((a, b) => a.group - b.group || availability(a) - availability(b)
            || (a.hint?.elapsedMs ?? Infinity) - (b.hint?.elapsedMs ?? Infinity) || a.index - b.index);
          return ranked.map(item => item.release);
        }
      };
    },
    clear() { entries.clear(); }
  };
}
