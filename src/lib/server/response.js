import { PassThrough } from 'node:stream';

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

function webResponseBody(output) {
  let settled = false;
  let detach;
  return new ReadableStream({
    start(controller) {
      const finish = error => {
        if (settled) return;
        settled = true;
        detach();
        if (error) controller.error(error);
        else controller.close();
      };
      const data = chunk => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) output.pause();
      };
      const end = () => finish();
      const close = () => finish(new DOMException('Playback response closed.', 'AbortError'));
      const error = cause => finish(cause);
      detach = () => {
        output.pause();
        output.off('data', data);
        output.off('end', end);
        output.off('close', close);
        output.off('error', error);
      };
      output.on('data', data);
      output.once('end', end);
      output.once('close', close);
      output.once('error', error);
      output.pause();
    },
    pull() { if (!settled) output.resume(); },
    cancel() {
      // Node may already have scheduled a resume/data callback. Detach it
      // synchronously before destroying the producer or closing the controller.
      if (settled) return;
      settled = true;
      detach();
      output.destroy();
    }
  }, new ByteLengthQueuingStrategy({ highWaterMark: output.readableHighWaterMark }));
}

export async function respond(request, url, handleRequest) {
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  let status = 200;
  let headers = {};
  let headersReady, headersFailed;
  const ready = new Promise((resolve, reject) => { headersReady = resolve; headersFailed = reject; });
  // Handle failures even before response headers or a web reader exist.
  output.on('error', headersFailed);
  const responseBody = webResponseBody(output);
  let closed = false;
  const closeListeners = new Set();
  const abort = () => output.destroy();
  // Cancelling the response body need not abort the incoming Request signal.
  // Both paths must release the converter and unblock its pending writes.
  output.once('close', () => {
    closed = true;
    headersFailed(new DOMException('Playback response closed.', 'AbortError'));
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
  try { void Promise.resolve(handleRequest(nodeRequest, nodeResponse)).catch(error => output.destroy(error)); }
  catch (error) { output.destroy(error); }
  await ready;
  const responseHeaders = new Headers(headers);
  if ([204, 205, 304].includes(status) || request.method === 'HEAD') {
    await responseBody.cancel().catch(() => {});
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(responseBody, { status, headers: responseHeaders });
}
