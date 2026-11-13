import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactPlaybackReport } from '../playback-trace.js';

export const MAX_BUFFERING_REPORT_BYTES = 60 * 1024;

const startupOutcomes = ['started', 'slow', 'playing', 'failed', 'cancelled'];
const startupTerminal = incident => ['playing', 'failed', 'cancelled'].includes(incident.outcome);
const sameIncident = (left, right) => left.incident?.kind === 'startup' && right.incident?.kind === 'startup'
  ? left.incident.id === right.incident.id
  : left.incident?.kind !== 'startup' && right.incident?.kind !== 'startup' && left.jobId === right.jobId && left.incident?.id === right.incident?.id;

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
      if (!report.incident?.id || (report.incident.kind === 'startup' ? report.jobId !== null && typeof report.jobId !== 'string' : typeof report.jobId !== 'string')) throw new Error('An incident and valid playback job identity are required.');
      const work = pending.then(async () => {
        const previous = await read();
        const existing = previous.find(item => sameIncident(item, report));
        // Delayed initial uploads must not undo a terminal report or detach its job.
        if (existing && ((existing.incident.durationMs || 0) > (report.incident.durationMs || 0) ||
            (report.incident.kind === 'startup' && startupTerminal(existing.incident) && !startupTerminal(report.incident)))) return existing;
        if (report.incident.kind === 'startup' && existing?.jobId && !report.jobId) {
          report.jobId = existing.jobId;
          report.job = existing.job;
        }
        if (report.incident.kind === 'startup' && existing?.jobId === report.jobId && !report.job) report.job = existing.job;
        if (Buffer.byteLength(JSON.stringify(report)) > 128 * 1024) throw new Error('The buffering report is too large.');
        const reports = previous.filter(item => !sameIncident(item, report));
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
  const incident = input?.incident;
  const validObject = input && typeof input === 'object' && !Array.isArray(input);
  const validIncident = incident && typeof incident === 'object' && !Array.isArray(incident) && typeof incident.id === 'string' && incident.id.trim().length > 0;
  if (incident?.kind === 'startup') {
    if (!validObject || !validIncident || !(input.jobId === null || (typeof input.jobId === 'string' && input.jobId.trim())) ||
        !startupOutcomes.includes(incident.outcome) || !Number.isFinite(incident.startedAt) || incident.startedAt < 0 ||
        !Number.isFinite(incident.durationMs) || incident.durationMs < 0 || incident.targetMs !== 10000 ||
        typeof incident.stage !== 'string' || !incident.stage.trim()) {
      throw new Error('A valid startup report is required.');
    }
  } else if (!validObject || !validIncident || typeof input.jobId !== 'string' ||
      (incident.kind !== undefined && incident.kind !== 'buffering') ||
      !['buffering', 'recovered', 'paused', 'source-changed', 'interrupted'].includes(incident.outcome)) {
    throw new Error('A valid buffering report is required.');
  }
  return input;
}
