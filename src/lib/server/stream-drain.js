export function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { stream.off('drain', drained); stream.off('close', closed); stream.off('error', failed); };
    const drained = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const closed = () => failed(new Error('Playback response closed.'));
    if (stream.destroyed) { closed(); return; }
    stream.once('drain', drained); stream.once('close', closed); stream.once('error', failed);
  });
}
