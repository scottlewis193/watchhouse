export function createPosterPreparation({ budgetMs = 20000, intentBudgetMs = 30000, intentCancellationTtlMs = 30000, ttlMs = 30 * 60 * 1000, maximum = 4 } = {}) {
  const records = new Map(), intents = new Map(), cancelledIntents = new Map();

  function forgetIntent(record) {
    if (intents.get(record.requestId) === record) intents.delete(record.requestId);
    delete record.requestId;
  }

  function setBudget(record) {
    clearTimeout(record.budget);
    record.budget = setTimeout(() => remove(record.key, record), record.intent ? intentBudgetMs : budgetMs);
    record.budget.unref?.();
  }

  function remove(key, record) {
    if (records.get(key) !== record) return;
    records.delete(key);
    forgetIntent(record);
    clearTimeout(record.budget);
    clearTimeout(record.expiry);
    record.controller.abort(new Error('Poster preparation cancelled.'));
  }

  function cancel() {
    for (const [key, record] of records) remove(key, record);
  }

  return {
    start(key, job, prepare, warm, { intent = false, requestId } = {}) {
      if (intent && (typeof requestId !== 'string' || !requestId)) throw new Error('Play intent requires a request ID.');
      if (intent && cancelledIntents.has(requestId)) {
        if (cancelledIntents.get(requestId) > Date.now()) return null;
        cancelledIntents.delete(requestId);
      }
      const existing = records.get(key);
      if (intent) {
        for (const record of intents.values()) {
          if (record !== existing) remove(record.key, record);
        }
      }
      if (existing && !existing.controller.signal.aborted && !['error', 'cancelled'].includes(existing.job.status)) {
        if (existing.intent) {
          forgetIntent(existing);
          if (intent) {
            existing.requestId = requestId;
            intents.set(requestId, existing);
          } else {
            existing.intent = false;
            setBudget(existing);
            if (existing.completed) clearTimeout(existing.budget);
          }
        }
        return existing.job;
      }
      if (existing) remove(key, existing);

      const record = { key, job, intent, controller: new AbortController(), claimed: false };
      records.set(key, record);
      if (intent) {
        record.requestId = requestId;
        intents.set(requestId, record);
      }
      setBudget(record);
      record.expiry = setTimeout(() => remove(key, record), ttlMs);
      record.expiry.unref?.();
      record.completion = (async () => {
        try {
          await prepare(record.controller.signal);
          if (job.status === 'ready' && !record.claimed && !record.controller.signal.aborted) {
            // Validation keeps the preparation signal; only optional read-ahead
            // should stop when foreground playback takes ownership.
            record.claimController = new AbortController();
            await warm(record.controller.signal, () => record.claimed, record.claimController.signal);
          }
        } catch {
          remove(key, record);
        } finally {
          if (['error', 'cancelled'].includes(job.status)) remove(key, record);
          record.completed = true;
          if (!record.intent) clearTimeout(record.budget);
        }
      })();

      let saved = 0;
      for (const record of records.values()) if (!record.intent) saved++;
      for (const [savedKey, record] of records) {
        if (saved <= maximum) break;
        if (!record.intent) { remove(savedKey, record); saved--; }
      }
      return job;
    },

    take(key, options = {}) {
      const record = records.get(key);
      if (!record || record.controller.signal.aborted || ['error', 'cancelled'].includes(record.job.status)) {
        if (record) remove(key, record);
        return null;
      }
      if (Object.hasOwn(options, 'start') && Number(record.job.selectionStart || 0) !== Number(options.start || 0)) {
        remove(key, record);
        return null;
      }
      records.delete(key);
      record.claimed = true;
      forgetIntent(record);
      record.claimController?.abort(new Error('Poster preparation claimed by playback.'));
      clearTimeout(record.budget);
      clearTimeout(record.expiry);
      return record.job;
    },

    cancelIntent(requestId) {
      if (typeof requestId !== 'string' || !requestId) return false;
      // DELETE can beat a POST still reading settings/state. Keep that late
      // request from starting; ownership already taken by playback is untouched.
      cancelledIntents.delete(requestId);
      cancelledIntents.set(requestId, Date.now() + intentCancellationTtlMs);
      if (cancelledIntents.size > 128) cancelledIntents.delete(cancelledIntents.keys().next().value);
      const record = intents.get(requestId);
      if (!record || record.claimed) return false;
      remove(record.key, record);
      return true;
    },

    delete(key) {
      const record = records.get(key);
      if (record) remove(key, record);
    },

    cancel
  };
}
