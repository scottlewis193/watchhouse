import { PassThrough, Readable } from 'node:stream';

import { waitForDrain } from './stream-drain.js';

function requestBody(request) {
  return (async function* () {
    if (!request.body) return;
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    } finally { reader.releaseLock(); }
  })();
}

export async function respond(request, url, handleRequest) {
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  let status = 200;
  let headers = {};
  let headersReady;
  const ready = new Promise(resolve => { headersReady = resolve; });
  let closed = false;
  const closeListeners = new Set();
  const abort = () => output.destroy();
  // Cancelling the response body need not abort the incoming Request signal.
  // Both paths must release the converter and unblock its pending writes.
  output.once('close', () => {
    closed = true;
    request.signal.removeEventListener('abort', abort);
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  });
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const nodeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    on(event, listener) { if (event === 'close') { if (closed) queueMicrotask(listener); else closeListeners.add(listener); } return nodeRequest; },
    [Symbol.asyncIterator]: () => requestBody(request)
  };
  const nodeResponse = {
    headersSent: false,
    writeHead(nextStatus, nextHeaders = {}) { status = nextStatus; headers = nextHeaders; this.headersSent = true; headersReady(); return this; },
    write: chunk => output.write(chunk),
    waitForDrain: () => waitForDrain(output),
    end: chunk => output.end(chunk),
    destroy: error => output.destroy(error),
    get destroyed() { return output.destroyed; }
  };
  void handleRequest(nodeRequest, nodeResponse).catch(error => output.destroy(error));
  await ready;
  const responseHeaders = new Headers(headers);
  return new Response(status === 204 ? null : Readable.toWeb(output), { status, headers: responseHeaders });
}
