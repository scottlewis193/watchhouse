const defaultClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer)
};

async function preparedCandidate(pending, softWaitMs, clock) {
  const preferred = pending[0];
  if (preferred.settled || preferred.readiness == null) return preferred;
  const alternatives = pending.slice(1).filter(item =>
    item.readiness === preferred.readiness && (!item.settled || 'value' in item.outcome));
  if (!alternatives.length) return preferred;

  let timer;
  try {
    // The deadline belongs to the request, not to each poll or consumer retry.
    const wait = preferred.startedAt + softWaitMs - clock.now();
    if (wait > 0) {
      await Promise.race([
        preferred.result,
        new Promise(resolve => { timer = clock.setTimeout(resolve, wait); })
      ]);
    }
    while (!preferred.settled) {
      const ready = alternatives.find(item => item.settled && 'value' in item.outcome);
      if (ready) return ready;
      const waiting = alternatives.filter(item => !item.settled);
      if (!waiting.length) break;
      // Settled failures and incompatible work cannot wake this wait repeatedly.
      await Promise.race([preferred.result, ...waiting.map(item => item.result)]);
    }
    return preferred;
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

// Keep lookahead bounded within each ranking tier. Dynamic deferral never drops
// candidates or crosses a tier. Slow-description deferral is explicitly opt-in;
// readinessKey must include every size/audio/resolution/playback preference.
export async function* prefetchReleaseDescriptions(releases, load, width = 3, groupKey, deferred, options = {}) {
  const controller = new AbortController();
  const count = Math.max(1, Math.min(releases.length, width));
  const { deferSlow = false, readinessKey, preparedPriority, softWaitMs = 1500, clock = defaultClock } = options;
  const slowDeferral = deferSlow === true && typeof readinessKey === 'function' && count > 1;
  const preferPrepared = typeof preparedPriority === 'function' && typeof readinessKey === 'function' && count > 1;
  const start = index => {
    const item = {
      index,
      readiness: slowDeferral || preferPrepared ? readinessKey(releases[index]) : undefined,
      startedAt: slowDeferral ? clock.now() : 0,
      settled: false
    };
    item.result = Promise.resolve().then(() => load(releases[index], controller.signal))
      .then(value => ({ value }), error => ({ error }))
      .then(outcome => {
        item.outcome = outcome;
        item.settled = true;
        return outcome;
      });
    return item;
  };
  const pending = [];
  let next = 0, remaining = [];
  try {
    while (next < releases.length || remaining.length || pending.length) {
      if (!remaining.length && !pending.length) {
        const group = groupKey?.(releases[next]);
        do { remaining.push(next++); }
        while (next < releases.length && (!groupKey || groupKey(releases[next]) === group));
      }
      while (remaining.length && pending.length < count) {
        let slot = deferred ? remaining.findIndex(index => !deferred(releases[index])) : 0;
        if (slot < 0) {
          // Do not refill with deferred work while a preferred candidate waits.
          if (pending.some(item => !deferred(releases[item.index]))) break;
          slot = 0;
        }
        const [index] = remaining.splice(slot, 1);
        pending.push(start(index));
      }
      const prepared = slowDeferral ? await preparedCandidate(pending, softWaitMs, clock) : pending[0];
      await prepared.result;
      let item = prepared;
      if (preferPrepared && prepared.readiness != null && 'value' in prepared.outcome) {
        let priority = preparedPriority(prepared.outcome.value, releases[prepared.index]);
        if (!Number.isFinite(priority)) priority = Infinity;
        for (const candidate of pending) {
          if (!candidate.settled || candidate.readiness !== prepared.readiness || !('value' in candidate.outcome)) continue;
          const alternative = preparedPriority(candidate.outcome.value, releases[candidate.index]);
          if (Number.isFinite(alternative) && alternative < priority) { item = candidate; priority = alternative; }
        }
      }
      if (item !== pending[0]) {
        if (item !== prepared) options.onReadinessPreferred?.(pending[0].index, item.index);
        else options.onDeferred?.(pending[0].index, item.index);
      }
      pending.splice(pending.indexOf(item), 1);
      yield { index: item.index, ...item.outcome };
    }
  } finally { controller.abort(); }
}
