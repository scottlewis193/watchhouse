import test from 'node:test';
import assert from 'node:assert/strict';
import { createNntpPool } from '../src/lib/server/nntp-pool.js';

const settings = { usenetHost: 'provider', usenetUser: 'viewer', usenetPass: 'one', maxConnections: 1 };
test('separate clients reuse authentication and never share an active protocol stream', async () => {
  let opened = 0, active = 0, peak = 0;
  const pool = createNntpPool(async () => {
    opened++;
    return { async body(_id, line) { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); await line('complete'); active--; }, close() {} };
  });
  try {
    const a = pool.client(settings), b = pool.client(settings);
    await Promise.all([a.body('a', () => {}), b.body('b', () => {})]);
    a.close(); b.close();
    await pool.client(settings).body('c', () => {});
    assert.equal(opened, 1); assert.equal(peak, 1);
    await pool.client({ ...settings, usenetPass: 'two' }).body('c', () => {});
    assert.equal(opened, 2, 'credential changes must authenticate again');
  } finally { pool.clearIdle(); }
});
test('a partial failed BODY is discarded and a later request gets a fresh connection', async () => {
  let opened = 0;
  const pool = createNntpPool(async () => ({ async body() { if (++opened === 1) throw new Error('truncated'); }, close() {} }));
  try {
    await assert.rejects(pool.client(settings).body('a', () => {}));
    await pool.client(settings).body('b', () => {});
    assert.equal(opened, 2);
  } finally { pool.clearIdle(); }
});

test('closing a reader aborts a pending login and immediately frees its connection slot', async () => {
  let connecting, attempts = 0;
  const started = new Promise(resolve => { connecting = resolve; });
  const pool = createNntpPool(async options => {
    if (++attempts === 1) {
      connecting();
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    return { body: async () => {}, close() {} };
  });
  const first = pool.client(settings);
  const pending = first.body('one', () => {});
  void pending.catch(() => {});
  try {
    await started;
    first.close();
    await assert.rejects(pending, /Provider reader closed/);
    await pool.client(settings).body('two', () => {});
    assert.equal(attempts, 2);
  } finally { pool.clearIdle(); }
});

test('preconnecting completes login before an article is needed and reuses that connection', async () => {
  let opened = 0, reads = 0, connected, finish;
  const connecting = new Promise(resolve => { connected = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const pool = createNntpPool(async () => {
    opened++; connected(); await gate;
    return { body: async () => { reads++; }, close() {} };
  });
  try {
    const warming = pool.warm(settings);
    await connecting; assert.equal(reads, 0);
    finish(); await warming;
    await pool.client(settings).body('one', () => {});
    assert.equal(opened, 1); assert.equal(reads, 1);
  } finally { finish(); pool.clearIdle(); }
});

test('a preconnected socket survives discovery even when normal background-friendly idle expiry is shorter', async () => {
  let opened = 0;
  const pool = createNntpPool(async () => { opened++; return { body: async () => {}, close() {} }; }, { idleMs: 1500 });
  try {
    await pool.warm({ ...settings, downloadNextEpisode: true });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await pool.client({ ...settings, downloadNextEpisode: true }).body('one', () => {});
    assert.equal(opened, 1, 'keep the connection available while the NZB lookup finishes');
  } finally { pool.clearIdle(); }
});
