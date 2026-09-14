import { mkdir, readdir, stat, open, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DownloadCancelledError, onDownloadCancel, throwIfDownloadCancelled } from './download-cancellation.js';

async function assembleVolume(volume, signal) {
  const pending = `${volume.path}.assembling`;
  try {
    async function* parts() {
      for (let index = 0; index < volume.posted.segments.length; index++) {
        signal.throwIfAborted();
        yield* createReadStream(join(volume.parts, String(index).padStart(6, '0')));
      }
    }
    await pipeline(parts(), createWriteStream(pending), { signal });
    signal.throwIfAborted();
    await rename(pending, volume.path);
    await rm(volume.parts, { recursive: true, force: true });
  } catch (error) { await rm(pending, { force: true }); throw error; }
}

// One network budget across all volumes; a separate serial assembly queue keeps
// disk copying bounded without holding up the next volume's network requests.
export async function downloadPostedFiles(files, settings, job, state, {
  connect, decode, progress = () => {}, assemble = assembleVolume, workerLimit = 12
}) {
  const controller = new AbortController();
  const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
  const clients = new Set();
  let failure, assembly = Promise.resolve(), next = 0;
  const queue = [], destinations = new Set();
  function stop(error) {
    failure ||= error;
    controller.abort(error);
    for (const client of clients) client.close();
  }
  const removeCancel = onDownloadCancel(job, () => stop(new DownloadCancelledError()));
  function scheduleAssembly(volume) {
    assembly = assembly.then(async () => {
      signal.throwIfAborted();
      await assemble(volume, signal);
    }).catch(stop);
  }
  try {
    for (const file of files) {
      throwIfDownloadCancelled(job); signal.throwIfAborted();
      // Match the previous serial writer's first-file-wins behaviour when NZB
      // subjects normalize to the same filename; never write it concurrently.
      if (destinations.has(file.path)) continue;
      destinations.add(file.path);
      try {
        const existing = await stat(file.path);
        state.bytes += existing.size; state.completed += file.posted.segments.length;
        continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const volume = { ...file, parts: `${file.path}.parts`, remaining: 0 };
      await mkdir(volume.parts, { recursive: true });
      const saved = new Set(await readdir(volume.parts));
      for (let index = 0; index < file.posted.segments.length; index++) {
        const name = String(index).padStart(6, '0'), part = join(volume.parts, name);
        if (saved.has(name)) { state.bytes += (await stat(part)).size; state.completed++; }
        else { volume.remaining++; queue.push({ volume, part, segment: file.posted.segments[index] }); }
      }
      if (!volume.remaining) scheduleAssembly(volume);
    }
    progress();
    const width = Math.min(settings.backgroundJob ? 1 : Math.max(1, Number(settings.maxConnections) || 4), workerLimit, queue.length);
    await Promise.all(Array.from({ length: width }, async () => {
      let client;
      try {
        signal.throwIfAborted();
        client = await connect({ ...settings, signal }); clients.add(client);
        signal.throwIfAborted();
        while (next < queue.length) {
          signal.throwIfAborted();
          const item = queue[next++], pending = `${item.part}.pending`;
          let writer, bytes = 0, chunks = [], buffered = 0;
          try {
            writer = await open(pending, 'w');
            const flush = async () => {
              if (!buffered) return;
              const block = Buffer.concat(chunks, buffered);
              chunks = []; buffered = 0;
              let offset = 0;
              while (offset < block.length) {
                signal.throwIfAborted();
                const { bytesWritten } = await writer.write(block, offset, block.length - offset);
                if (!bytesWritten) throw new Error('Unable to write downloaded article.');
                offset += bytesWritten;
              }
            };
            await client.body(item.segment.id, async line => {
              signal.throwIfAborted();
              if (line.startsWith('=y')) return;
              const chunk = decode(line);
              chunks.push(chunk); buffered += chunk.length; bytes += chunk.length;
              if (buffered >= 64 * 1024) await flush();
            });
            await flush();
            await writer.close(); writer = null;
            signal.throwIfAborted();
            await rename(pending, item.part);
            state.bytes += bytes; state.completed++; progress();
            if (--item.volume.remaining === 0) scheduleAssembly(item.volume);
          } catch (error) {
            await writer?.close(); await rm(pending, { force: true }); throw error;
          }
        }
      } catch (error) { stop(error); }
      finally { if (client) { clients.delete(client); client.close(); } }
    }));
    await assembly;
    throwIfDownloadCancelled(job);
    if (failure) throw failure;
    signal.throwIfAborted();
  } catch (error) {
    stop(error); await assembly; throw error;
  } finally { removeCancel(); }
}
