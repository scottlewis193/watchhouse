// Serialize writes and retain the latest snapshot per title while a request is pending.
export function createProgressWriter(write, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)), isCurrent = () => true, onSaved = () => {}, onError = () => {} } = {}) {
  const pending = new Map();
  let running;
  async function drain() {
    while (pending.size) {
      const [key, snapshot] = pending.entries().next().value;
      pending.delete(key);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const state = await write(snapshot);
          if (isCurrent(key) && !pending.has(key)) onSaved(state, key);
          break;
        } catch (error) {
          if (attempt === 2 || error.status && error.status < 500 && ![408, 429].includes(error.status)) { onError(error); break; }
          await delay(250 * 2 ** attempt);
          // A newer snapshot supersedes the failed write, including watched-state updates.
          if (pending.has(key)) break;
        }
      }
    }
  }
  return {
    enqueue(key, snapshot) {
      const previous = pending.get(key);
      const next = { ...previous, ...JSON.parse(JSON.stringify(snapshot)) };
      if (snapshot.position !== undefined && snapshot.reset === undefined) delete next.reset;
      pending.set(key, next);
      if (!running) running = drain().finally(() => { running = null; });
      return running;
    },
    get pending() { return Boolean(running); }
  };
}
