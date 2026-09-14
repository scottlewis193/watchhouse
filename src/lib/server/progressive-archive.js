import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { waitForDrain } from './stream-drain.js';

export function archiveByteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end, partial: true } : null;
}

// Input is a seekable archive assembled virtually from provider byte ranges.
// Output is a seekable growing file: unread ranges wait for extraction, never
// masquerade as zero-filled sparse data or an early EOF.
export async function createProgressiveArchiveSource(input, {
  root, helper = join(process.cwd(), 'scripts', 'progressive-archive.py'),
  startupTimeoutMs = 30000, idleMs = 30000, onProgress = () => {}
}) {
  const directory = await mkdtemp(join(root, 'playback-progressive-'));
  const output = join(directory, 'video');
  const token = randomUUID(), changes = new EventEmitter();
  let child, metadata, available = 0, complete = false, failure, closed = false, closing, idle, refs = 0;
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const completion = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  void ready.catch(() => {}); void completion.catch(() => {});
  function fail(error) { failure ||= error; readyReject(failure); doneReject(failure); changes.emit('change'); }
  const wait = signal => new Promise(resolve => {
    const done = () => { changes.off('change', done); signal.removeEventListener('abort', done); resolve(); };
    changes.once('change', done); signal.addEventListener('abort', done, { once: true });
    if (signal.aborted || failure || closed) done();
  });
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => { controller.abort(); changes.emit('change'); });
    void (async () => {
      const archive = req.url === `/${token}/archive`, video = req.url === `/${token}/video`;
      if ((!archive && !video) || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end(); }
      if (closed || failure) throw failure || new Error('Archive source closed');
      const size = archive ? input.size : metadata?.size;
      if (!size) { res.writeHead(503); return res.end(); }
      const range = archiveByteRange(req.headers.range, size);
      if (!range) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      const { start, end, partial } = range;
      res.writeHead(partial ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      if (archive) {
        // Bound every allocation even if an unexpected client asks for everything.
        for (let offset = start; offset <= end && !controller.signal.aborted; offset += 4 * 1024 * 1024) {
          const stop = Math.min(end, offset + 4 * 1024 * 1024 - 1);
          const bytes = await input.read(offset, stop, controller.signal);
          if (bytes.length !== stop - offset + 1) throw new Error('Incomplete archive range');
          if (!res.write(bytes)) await waitForDrain(res);
        }
      } else {
        let file;
        try {
          let offset = start;
          while (offset <= end && !controller.signal.aborted) {
            if (failure || closed) throw failure || new Error('Archive source closed');
            if (offset >= available) {
              if (complete) throw new Error('Extracted video ended unexpectedly');
              await wait(controller.signal); continue;
            }
            file ||= await open(output, 'r');
            const count = Math.min(256 * 1024, available - offset, end - offset + 1);
            const buffer = Buffer.allocUnsafe(count);
            const { bytesRead } = await file.read(buffer, 0, count, offset);
            if (!bytesRead) throw new Error('Extracted video could not be read');
            offset += bytesRead;
            if (!res.write(buffer.subarray(0, bytesRead))) await waitForDrain(res);
          }
        } finally { await file?.close(); }
      }
      if (!controller.signal.aborted) res.end();
    })().catch(error => { if (res.headersSent) res.destroy(); else { res.writeHead(500); res.end(); } });
  });
  let timeout;
  async function close() {
    if (closing) return closing;
    closed = true; clearTimeout(idle); clearTimeout(timeout);
    fail(new Error('Archive source closed'));
    closing = (async () => {
      const ended = child?.pid && child.exitCode === null && child.signalCode === null ? once(child, 'close').catch(() => {}) : Promise.resolve();
      child?.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 2000); force.unref();
      server.closeAllConnections();
      await Promise.all([ended, input.close(), new Promise(resolve => server.close(resolve))]);
      clearTimeout(force);
      await rm(directory, { recursive: true, force: true });
    })();
    return closing;
  }
  function expire(ttl = idleMs) { clearTimeout(idle); idle = setTimeout(() => void close().catch(() => {}), ttl); idle.unref(); }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/${token}`;
    child = spawn('python3', [helper, `${base}/archive`, output, String(input.size)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000); });
    child.on('error', fail);
    child.stdout.on('data', data => {
      pending += data;
      if (pending.length > 65536) { fail(new Error('Invalid archive helper output')); child.kill(); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'metadata') {
            if (!Number.isSafeInteger(event.size) || event.size <= 0 || typeof event.name !== 'string') throw new Error('Invalid archive video metadata');
            metadata = { name: event.name, size: event.size };
          } else if (event.type === 'progress' || event.type === 'complete') {
            if (!metadata || !Number.isSafeInteger(event.bytes) || event.bytes < available || event.bytes > metadata.size) throw new Error('Invalid archive extraction progress');
            available = event.bytes;
            if (event.type === 'complete') { if (available !== metadata.size) throw new Error('Incomplete archive video'); complete = true; }
            onProgress({ available, total: metadata.size, complete });
            if (available >= Math.min(metadata.size, 65536)) readyResolve();
          } else if (event.type === 'error') throw new Error(event.message || 'Archive extraction failed');
          changes.emit('change');
        } catch (error) { fail(error); child.kill(); }
      }
    });
    child.on('close', code => {
      if (code !== 0 || !complete) fail(new Error(stderr || 'Progressive archive extraction failed'));
      else doneResolve();
      void input.close().catch(() => {});
      changes.emit('change');
    });
    timeout = setTimeout(() => { fail(new Error('Progressive archive startup timed out')); child.kill(); }, startupTimeoutMs);
    timeout.unref();
    await ready;
    clearTimeout(timeout); expire();
    return {
      metadata, completion,
      get closed() { return closed; }, get failure() { return failure; },
      get available() { return available; }, get complete() { return complete; },
      retain() {
        if (closed || failure) throw failure || new Error('Archive source closed');
        refs++; clearTimeout(idle);
        let released = false;
        return { url: `${base}/video`, close() { if (!released) { released = true; if (--refs === 0) expire(Math.min(idleMs, 5000)); } } };
      }, close
    };
  } catch (error) { await close(); throw error; }
}
