const listeners = new WeakMap();
export function notifyPlayback(job) {
  job.revision = (job.revision || 0) + 1;
  for (const listener of listeners.get(job) || []) listener();
}
export function waitForPlayback(job, revision, { signal, timeout = 15000 } = {}) {
  if (['ready', 'error', 'cancelled'].includes(job.status) || (job.revision || 0) !== revision || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    if (!listeners.has(job)) listeners.set(job, new Set());
    const done = () => { clearTimeout(timer); listeners.get(job).delete(done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, timeout);
    listeners.get(job).add(done); signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}
