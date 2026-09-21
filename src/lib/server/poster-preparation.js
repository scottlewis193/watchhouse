export function createPosterPreparation({ budgetMs = 20000, ttlMs = 30 * 60 * 1000, maximum = 4 } = {}) {
  const records = new Map();

  function remove(key, record) {
    if (records.get(key) !== record) return;
    records.delete(key);
    clearTimeout(record.budget);
    clearTimeout(record.expiry);
    record.controller.abort(new Error('Poster preparation cancelled.'));
  }

  function cancel() {
    for (const [key, record] of records) remove(key, record);
  }

  return {
    start(key, job, prepare, warm) {
      const existing = records.get(key);
      if (existing && !existing.controller.signal.aborted) return existing.job;

      const record = { key, job, controller: new AbortController(), claimed: false };
      records.set(key, record);
      record.budget = setTimeout(() => remove(key, record), budgetMs);
      record.budget.unref();
      record.expiry = setTimeout(() => remove(key, record), ttlMs);
      record.expiry.unref();
      record.completion = (async () => {
        try {
          await prepare(record.controller.signal);
          if (job.status === 'ready' && !record.claimed && !record.controller.signal.aborted) {
            await warm(record.controller.signal, () => record.claimed);
          }
        } catch {} finally {
          clearTimeout(record.budget);
        }
      })();

      while (records.size > maximum) {
        const oldest = records.entries().next().value;
        if (!oldest) break;
        remove(...oldest);
      }
      return job;
    },

    take(key) {
      const record = records.get(key);
      if (!record || record.controller.signal.aborted || ['error', 'cancelled'].includes(record.job.status)) {
        if (record) remove(key, record);
        return null;
      }
      records.delete(key);
      record.claimed = true;
      clearTimeout(record.budget);
      clearTimeout(record.expiry);
      return record.job;
    },

    delete(key) {
      const record = records.get(key);
      if (record) remove(key, record);
    },

    cancel
  };
}
