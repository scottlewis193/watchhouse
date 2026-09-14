import { createHash } from 'node:crypto';

// Lease per complete command/article, rather than per range-reader lane. This
// bounds real sockets without deadlocking two readers holding idle lanes.
export function createNntpPool(connect, { acquire = async () => () => {}, idleMs = 5000 } = {}) {
  const accounts = new Map();
  const key = settings => createHash('sha256').update(JSON.stringify([
    settings.usenetHost, Number(settings.usenetPort || 563), settings.usenetUser, settings.usenetPass
  ])).digest('hex');
  const usable = client => !client.error && !client.socket?.destroyed;
  function discard(account, entry) {
    clearTimeout(entry.timer);
    if (!account.entries.delete(entry)) return;
    entry.client?.close();
    for (const wake of account.waiters) wake();
  }
  async function borrow(settings, signal) {
    const id = key(settings);
    // Settings changes must not leave idle authenticated sockets behind.
    for (const [other, account] of accounts) if (other !== id) {
      for (const entry of account.entries) if (!entry.busy) discard(account, entry);
      if (!account.entries.size) accounts.delete(other);
    }
    if (!accounts.has(id)) accounts.set(id, { entries: new Set(), waiters: new Set() });
    const account = accounts.get(id);
    while (true) {
      signal.throwIfAborted();
      for (const entry of account.entries) {
        if (entry.busy) continue;
        if (!usable(entry.client)) { discard(account, entry); continue; }
        clearTimeout(entry.timer); entry.busy = true; entry.client.socket?.ref?.();
        return { account, entry };
      }
      if (account.entries.size < Math.max(1, Number(settings.maxConnections) || 4)) {
        const entry = { busy: true };
        account.entries.add(entry);
        try {
          entry.client = await connect({ ...settings, signal });
          signal.throwIfAborted();
          return { account, entry };
        } catch (error) { discard(account, entry); throw error; }
      }
      await new Promise((resolve, reject) => {
        const done = () => { account.waiters.delete(done); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { done(); reject(signal.reason); };
        account.waiters.add(done); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  function client(settings, idleTimeout = settings.downloadNextEpisode ? 1000 : idleMs) {
    const controller = new AbortController();
    const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
    let active = null, previous;
    const operation = async (method, ...args) => {
      signal.throwIfAborted();
      const release = await acquire({ ...settings, signal });
      let lease, successful = false;
      const abort = () => active?.socket?.destroy();
      signal.addEventListener('abort', abort, { once: true });
      try {
        lease = await borrow(settings, signal); active = lease.entry.client;
        lease.entry.generation = (lease.entry.generation || 0) + 1;
        previous = { ...lease, generation: lease.entry.generation };
        signal.throwIfAborted();
        const result = method === 'ready' ? undefined : await active[method](...args);
        signal.throwIfAborted(); successful = true;
        return result;
      } finally {
        signal.removeEventListener('abort', abort); active = null;
        if (lease) {
          const { account, entry } = lease;
          if (!successful || !usable(entry.client)) discard(account, entry);
          else {
            entry.busy = false;
            entry.client.socket?.unref?.();
            entry.timer = setTimeout(() => discard(account, entry), idleTimeout);
            entry.timer.unref();
            for (const wake of account.waiters) wake();
          }
        }
        release();
      }
    };
    return { ready: () => operation('ready'), body: (...args) => operation('body', ...args), has: (...args) => operation('has', ...args), discard() {
      if (active) active.socket?.destroy();
      else if (previous && !previous.entry.busy && previous.entry.generation === previous.generation) discard(previous.account, previous.entry);
    }, close() { controller.abort(new Error('Provider reader closed.')); } };
  }
  return { client, async warm(settings) { const reader = client(settings, idleMs); try { await reader.ready(); } finally { reader.close(); } }, clearIdle() { for (const account of accounts.values()) for (const entry of account.entries) if (!entry.busy) discard(account, entry); } };
}
