import { once } from 'node:events';
import { throwIfDownloadCancelled } from './download-cancellation.js';

// Admission is shared by playback, probes and downloads for a provider account.
export function createTransferCoordinator({ now = Date.now, wait } = {}) {
  const waiting = new Set();
  const wake = () => { for (const resolve of waiting) resolve(); };
  const waitForChange = signal => wait ? wait() : new Promise(resolve => {
    const done = () => { clearTimeout(timer); waiting.delete(done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 100);
    waiting.add(done); signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
  const accounts = new Map(), reports = new Map();
  let backgroundActive = false, interruptBackground;
  const key = settings => JSON.stringify([settings.usenetHost, settings.usenetPort || 563, settings.usenetUser]);
  function report(id, sample) {
    for (const [key, value] of reports) if (now() - value.at > 60000) reports.delete(key);
    // Constrained players target only 15s; leave room for playback between reports.
    reports.set(id, { at: now(), safe: sample.playing === true && sample.seeking !== true && sample.readyState >= 3 && sample.bufferedAhead >= 10 });
    if (!reports.get(id).safe) interruptBackground?.();
    wake();
  }
  async function acquire(settings, job, interrupt) {
    const id = key(settings);
    if (!accounts.has(id)) accounts.set(id, { active: 0, foregroundWaiting: 0 });
    const account = accounts.get(id), background = Boolean(job), previousMessage = job?.message;
    const limit = Math.max(1, Number(settings.maxConnections) || 4);
    let pausedMessage;
    if (!background) account.foregroundWaiting++;
    try {
      while (true) {
        throwIfDownloadCancelled(job);
        settings.signal?.throwIfAborted();
        const room = account.active < limit;
        // Reports are viewer leases: silence after leaving the player must not
        // block an already queued download indefinitely. Foreground transfers
        // still win, including startup before a viewer can report its buffer.
        const viewers = [...reports.values()].filter(sample => now() - sample.at <= 10000);
        const downloadSafe = viewers.length ? viewers.every(sample => sample.safe) : account.active === 0;
        if (background ? room && !backgroundActive && !account.foregroundWaiting && downloadSafe : room) break;
        // Reclaim a background slot only when foreground work cannot fit.
        if (!background) {
          interruptBackground?.();
          if (account.active < limit) continue;
        }
        if (background) {
          pausedMessage = 'Paused background download · current playback has priority.';
          job.message = pausedMessage;
        }
        await waitForChange(settings.signal);
      }
      account.active++;
      if (background && pausedMessage && job.message === pausedMessage) job.message = previousMessage;
      if (background) { backgroundActive = true; interruptBackground = interrupt; }
      let released = false;
      return () => {
        if (released) return;
        released = true; account.active--;
        if (background) { backgroundActive = false; interruptBackground = null; }
        wake();
      };
    } finally { if (!background) account.foregroundWaiting--; }
  }
  return { acquire, report, forget(id) { reports.delete(id); wake(); } };
}

export function createBackgroundNntpClient(settings, transfers, connect) {
  let closed = false, active;
  const body = async (id, consume) => {
    while (true) {
      throwIfDownloadCancelled(settings.backgroundJob);
      if (closed) throw new Error('Background connection closed.');
      let interrupted = false;
      const release = await transfers.acquire(settings, settings.backgroundJob, () => {
        interrupted = true; active?.socket.destroy();
      });
      try {
        throwIfDownloadCancelled(settings.backgroundJob);
        active = await connect(settings);
        if (interrupted) continue;
        // Deliver only complete articles. Preemption must not append half an
        // article and then duplicate it when foreground playback releases us.
        const lines = [];
        await active.body(id, line => lines.push(line));
        if (interrupted) continue;
        for (const line of lines) await consume(line);
        return;
      } catch (error) { if (!interrupted) throw error; }
      finally {
        if (active && !active.socket.closed) {
          const ended = once(active.socket, 'close').catch(() => {}); active.close(); await ended;
        }
        active = null; release();
      }
    }
  };
  return { body, close() { closed = true; active?.close(); } };
}
