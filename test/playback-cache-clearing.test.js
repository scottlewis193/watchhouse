import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearPlaybackCacheForMedia } from '../src/lib/server/streamer.js';

test('clears only the selected movie playback cache and keeps offline data out of scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playback-clear-'));
  const movie = { type: 'movie', id: 7, title: 'Target' }, other = { type: 'movie', id: 8, title: 'Other' };
  const targetDirectory = join(root, 'playback-target'), otherDirectory = join(root, 'playback-other');
  await Promise.all([mkdir(targetDirectory), mkdir(otherDirectory)]);
  const targetFile = {}, otherFile = {};
  const targetJob = { media: movie, file: targetFile, directory: targetDirectory, status: 'ready', archiveSource: { close: async () => { targetJob.sourceClosed = true; } } };
  const jobs = new Map([['target-job', targetJob], ['other-job', { media: other, file: otherFile, directory: otherDirectory, status: 'ready' }]]);
  let sessionClosed = 0, planDeleted, archiveDeleted, persisted, healthDeleted, posterCancelled = 0, inspectionDeleted, segmentDeleted;
  const sessions = new Map([
    ['target-session', { jobId: 'target-job', session: { close: async () => { sessionClosed++; } } }],
    ['other-session', { jobId: 'other-job', session: { close: async () => {} } }]
  ]);
  try {
    const result = await clearPlaybackCacheForMedia(movie, {
      plans: { delete: media => { planDeleted = media; } },
      archivePlans: { delete: media => { archiveDeleted = media; } },
      persistence: { deleteMedia: async media => { persisted = media; return { sources: 2 }; } },
      health: { delete: async media => { healthDeleted = media; } },
      jobs, sessions,
      inspections: { delete: file => { inspectionDeleted = file; } },
      segments: { delete: file => { segmentDeleted = file; } },
      poster: { cancel: () => { posterCancelled++; } }, root
    });
    assert.deepEqual(result, { jobs: 1, sessions: 1, sources: 2, directories: 1 });
    assert.equal(jobs.has('target-job'), false);
    assert.equal(jobs.has('other-job'), true);
    assert.equal(sessions.has('target-session'), false);
    assert.equal(sessions.has('other-session'), true);
    assert.equal(sessionClosed, 1);
    assert.equal(targetJob.sourceClosed, true);
    assert.equal(planDeleted, movie);
    assert.equal(archiveDeleted, movie);
    assert.equal(persisted, movie);
    assert.equal(healthDeleted, movie);
    assert.equal(posterCancelled, 1);
    assert.equal(inspectionDeleted, targetFile);
    assert.equal(segmentDeleted, targetFile);
    await assert.rejects(access(targetDirectory));
    await access(otherDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an episode is required when clearing TV playback cache', async () => {
  await assert.rejects(clearPlaybackCacheForMedia({ type: 'tv', id: 7, season: 1 }, {}), /individual movie or episode/);
});

test('the watch toolbar exposes a confirmed per-item cache action', () => {
  const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(source, /aria-label=\{media\.type === 'tv' \? 'Clear episode cache' : 'Clear movie cache'\}/);
  assert.match(source, /watch progress and offline downloads will be kept/);
  assert.match(source, /api\.delete\('\/api\/cache', item\)/);
});

test('cache feedback uses a fixed toast instead of the hero alert position', () => {
  const source = readFileSync(new URL('../src/routes/watch/[type]/[id]/+page.svelte', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  assert.match(source, /class="watch-toast-stack"/);
  assert.match(source, /class="watch-toast-stack"[^>]*aria-live="polite"/);
  assert.match(styles, /\.watch-toast-stack\s*\{[^}]*position:\s*fixed;/s);
});
