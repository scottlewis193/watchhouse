export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled.');
    this.name = 'DownloadCancelledError';
    this.code = 'DOWNLOAD_CANCELLED';
  }
}

function handlers(job) {
  if (!job.cancelHandlers) Object.defineProperty(job, 'cancelHandlers', { value: new Set(), configurable: true });
  return job.cancelHandlers;
}

export function onDownloadCancel(job, release) {
  if (job.cancelled) {
    release();
    return () => {};
  }
  handlers(job).add(release);
  return () => job.cancelHandlers?.delete(release);
}

export function cancelDownloadJob(job) {
  if (!job || job.cancelled || ['ready', 'error', 'cancelled'].includes(job.status)) return false;
  job.cancelled = true;
  job.status = 'cancelling';
  job.message = 'Cancelling download…';
  for (const release of [...handlers(job)]) {
    try { release(); } catch {}
  }
  job.cancelHandlers.clear();
  return true;
}

export function throwIfDownloadCancelled(job) {
  if (job?.cancelled) throw new DownloadCancelledError();
}

export function isDownloadCancelled(job, error) {
  return Boolean(job?.cancelled || error?.code === 'DOWNLOAD_CANCELLED');
}
