// Overlap only a small window of NZB requests. Consume in ranking order so a
// faster response cannot win over a preferred release, and abort unused work.
export async function* prefetchReleaseDescriptions(releases, load, width = 3) {
  const controller = new AbortController();
  const count = Math.max(1, Math.min(releases.length, width));
  const start = index => Promise.resolve().then(() => load(releases[index], controller.signal))
    .then(value => ({ value }), error => ({ error }));
  const pending = Array.from({ length: Math.min(count, releases.length) }, (_, index) => start(index));
  try {
    for (let index = 0; index < releases.length; index++) {
      yield { index, ...await pending.shift() };
      if (index + count < releases.length) pending.push(start(index + count));
    }
  } finally { controller.abort(); }
}
