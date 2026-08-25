import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { handleRequest } from '$lib/server/streamer.js';

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

async function respond(request, url) {
  const output = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  let status = 200;
  let headers = {};
  let headersReady;
  const ready = new Promise(resolve => { headersReady = resolve; });
  const nodeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    on(event, listener) { if (event === 'close') request.signal.addEventListener('abort', listener, { once: true }); return nodeRequest; },
    [Symbol.asyncIterator]: () => requestBody(request)
  };
  const nodeResponse = {
    headersSent: false,
    writeHead(nextStatus, nextHeaders = {}) { status = nextStatus; headers = nextHeaders; this.headersSent = true; headersReady(); return this; },
    write: chunk => output.write(chunk),
    waitForDrain: () => once(output, 'drain'),
    end: chunk => output.end(chunk),
    destroy: error => output.destroy(error),
    get destroyed() { return output.destroyed; }
  };
  void handleRequest(nodeRequest, nodeResponse).catch(error => output.destroy(error));
  await ready;
  const responseHeaders = new Headers(headers);
  return new Response(status === 204 ? null : Readable.toWeb(output), { status, headers: responseHeaders });
}

export const GET = ({ request, url }) => respond(request, url);
export const POST = ({ request, url }) => respond(request, url);
export const PUT = ({ request, url }) => respond(request, url);
export const DELETE = ({ request, url }) => respond(request, url);
