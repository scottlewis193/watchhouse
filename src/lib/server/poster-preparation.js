export function createPosterPreparation({ budgetMs = 20000, ttlMs = 300000 } = {}) {
  let current;
  function cancel() {
    if (!current) return;
    clearTimeout(current.budget); clearTimeout(current.expiry);
    current.controller.abort(new Error('Poster preparation cancelled.'));
    current = null;
  }
  return {
    start(key, job, prepare, warm) {
      if (current?.key === key && !current.controller.signal.aborted) return current.job;
      cancel();
      const record = { key, job, controller: new AbortController(), claimed: false };
      current = record;
      record.budget = setTimeout(() => { if (current === record) cancel(); }, budgetMs); record.budget.unref();
      record.expiry = setTimeout(() => { if (current === record) cancel(); }, ttlMs); record.expiry.unref();
      record.completion = (async () => {
        try {
          await prepare(record.controller.signal);
          if (job.status === 'ready' && !record.claimed && !record.controller.signal.aborted) await warm(record.controller.signal, () => record.claimed);
        } catch {} finally { clearTimeout(record.budget); }
      })();
      return job;
    },
    take(key) {
      if (current?.key !== key || current.controller.signal.aborted || ['error', 'cancelled'].includes(current.job.status)) { cancel(); return null; }
      const record = current; current = null; record.claimed = true;
      clearTimeout(record.budget); clearTimeout(record.expiry);
      return record.job;
    },
    cancel
  };
}
