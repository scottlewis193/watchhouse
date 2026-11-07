import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactPlaybackReport } from '../playback-trace.js';

export const MAX_BUFFERING_REPORT_BYTES = 60 * 1024;

// A separate data file survives playback cache clearing and container replacement.
export function createBufferingReportStore(path, { limit = 20 } = {}) {
  let pending = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return {
    async list() { await pending; return read(); },
    save(input) {
      const report = redactPlaybackReport(input);
      if (!report.incident?.id || typeof report.jobId !== 'string') throw new Error('A buffering incident and playback job are required.');
      if (Buffer.byteLength(JSON.stringify(report)) > 128 * 1024) throw new Error('The buffering report is too large.');
      const work = pending.then(async () => {
        const previous = await read();
        const existing = previous.find(item => item.jobId === report.jobId && item.incident.id === report.incident.id);
        // A slow initial upload can arrive after the recovered report.
        if (existing && (existing.incident.durationMs || 0) > (report.incident.durationMs || 0)) return existing;
        const reports = previous.filter(item => item.jobId !== report.jobId || item.incident.id !== report.incident.id);
        const saved = { ...report, savedAt: Date.now() };
        reports.push(saved);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(reports.slice(-limit)), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        return saved;
      });
      pending = work.catch(() => {});
      return work;
    }
  };
}

export async function readBufferingReport(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > MAX_BUFFERING_REPORT_BYTES) throw new Error('The buffering report is too large.');
    chunks.push(data);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.jobId !== 'string' ||
      typeof input.incident?.id !== 'string' || !['buffering', 'recovered', 'paused', 'source-changed', 'interrupted'].includes(input.incident?.outcome)) {
    throw new Error('A valid buffering report is required.');
  }
  return input;
}
