#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

process.umask(0o077);

const dataDirectory = '/app/data/jackett';
const runtimeFile = process.env.WATCHHOUSE_BUNDLED_TORZNAB_FILE || '/app/data/bundled-torznab.json';
const origin = 'http://127.0.0.1:9117';
const children = new Set();
const stopping = new AbortController();
let apiKey;
let shutdownPromise;

function log(message) {
  console.error(`[bundled-indexer] ${message}`);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read JSON configuration ${path}: ${error.code || 'invalid JSON'}`);
  }
}

function launch(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', detached: true });
  children.add(child);
  child.closed = new Promise((resolve) => {
    child.once('error', (error) => {
      child.launchError = error;
      resolve(1);
    });
    child.once('close', (code, signal) => {
      child.finished = true;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  return child;
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') log(`Could not forward ${signal}: ${error.message}`);
  }
}

function shutdown(code, signal = 'SIGTERM') {
  if (shutdownPromise) return shutdownPromise;
  stopping.abort();
  shutdownPromise = (async () => {
    await rm(runtimeFile, { force: true }).catch((error) => log(`Could not remove runtime configuration: ${error.message}`));
    const running = [...children];
    for (const child of running) signalGroup(child, signal);
    const killTimer = setTimeout(() => {
      for (const child of running) signalGroup(child, 'SIGKILL');
    }, 10_000);
    await Promise.all(running.map((child) => child.closed));
    clearTimeout(killTimer);
    // A child may have exited before its FFmpeg or other descendants. Its
    // process group remains ours to terminate; tini reaps orphaned descendants.
    for (const child of running) signalGroup(child, 'SIGKILL');
    process.exit(code);
  })();
  return shutdownPromise;
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { void shutdown(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143, signal); });
}

async function request(path, { timeout = 10_000 } = {}) {
  const url = new URL(path, origin);
  url.searchParams.set('apikey', apiKey);
  const response = await fetch(url, {
    signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(timeout)])
  });
  if (!response.ok) throw new Error(`Jackett GET ${url.pathname} returned HTTP ${response.status}`);
  return response.text();
}

async function reportSources(indexers) {
  for (const id of indexers) {
    if (stopping.signal.aborted) return;
    try {
      const result = await request(`/api/v2.0/indexers/${id}/results/torznab/api?t=search&q=${new Date().getUTCFullYear()}&limit=1`, { timeout: 20_000 });
      if (!/<rss[\s>]/.test(result)) throw new Error('Jackett did not return a Torznab RSS response');
      if (/<item[\s>]/.test(result)) {
        log(`Public source ${id} returned releases in a live search.`);
      } else {
        log(`Public source ${id} returned no releases; live availability is not confirmed. Watchhouse remains running.`);
      }
    } catch (error) {
      if (stopping.signal.aborted) return;
      log(`Public source ${id} is unavailable (${error.message}); Watchhouse remains running. Site blocks/CAPTCHAs are not bypassed.`);
    }
  }
}

async function configureSources(indexers) {
  const directory = join(dataDirectory, 'Indexers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const id of indexers) {
    let definition;
    try {
      definition = await readFile(`/opt/jackett/Definitions/${id}.yml`, 'utf8');
    } catch (error) {
      throw new Error(`Cannot load packaged public definition ${id}: ${error.code || 'read failed'}`);
    }
    // Validate the bundled YAML's top-level classification, without duplicating
    // Jackett's schema/parser or accepting a source that needs login credentials.
    if (!/^type:\s*(?:public|"public"|'public')\s*(?:#.*)?$/m.test(definition) || /^login\s*:/m.test(definition)) {
      throw new Error(`Indexer ${id} is not a packaged no-login public definition.`);
    }
  }
  // This dedicated Jackett instance must aggregate only the requested sources,
  // including after WATCHHOUSE_PUBLIC_INDEXERS changes on a persistent volume.
  for (const file of await readdir(directory)) {
    if (file.endsWith('.json') && !indexers.includes(file.slice(0, -5))) {
      await rm(join(directory, file));
    }
  }
  for (const id of indexers) {
    const path = join(directory, `${id}.json`);
    const existing = await readJson(path, null);
    if (existing !== null && !Array.isArray(existing)) throw new Error(`Invalid saved configuration for ${id}: expected an array.`);
    // Jackett's LoadFromSavedConfiguration accepts [] as defaults-only config,
    // sets IsConfigured, and does not contact the public site during loading.
    if (existing === null) await writeJson(path, []);
    await chmod(path, 0o600);
  }
}

async function confirmSources(indexers) {
  const xml = await request('/api/v2.0/indexers/all/results/torznab/api?t=indexers&configured=true');
  const configured = new Map([...xml.matchAll(/<indexer\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/indexer>/g)]
    .map((match) => [match[1], /<type>public<\/type>/.test(match[2])]));
  if (configured.size !== indexers.length || indexers.some((id) => configured.get(id) !== true)) {
    throw new Error('Jackett did not load the exact requested public indexer configuration.');
  }
}

async function main() {
  await rm(runtimeFile, { force: true });
  const indexers = [...new Set((process.env.WATCHHOUSE_PUBLIC_INDEXERS ?? 'limetorrents,torrentdownloads')
    .split(',').map((id) => id.trim()).filter(Boolean))];
  if (!indexers.length || indexers.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))) {
    throw new Error('WATCHHOUSE_PUBLIC_INDEXERS must contain comma-separated public Jackett indexer IDs.');
  }

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  await configureSources(indexers);
  const configPath = join(dataDirectory, 'ServerConfig.json');
  const serverConfig = await readJson(configPath, {});
  apiKey = typeof serverConfig.APIKey === 'string' && serverConfig.APIKey ? serverConfig.APIKey : randomBytes(32).toString('hex');
  await writeJson(configPath, {
    ...serverConfig,
    APIKey: apiKey,
    Port: 9117,
    LocalBindAddress: '127.0.0.1',
    AllowExternal: false,
    UpdateDisabled: true
  });

  if (stopping.signal.aborted) return;
  const jackett = launch('/opt/jackett/jackett', [
    '--DataFolder', dataDirectory, '--ListenPrivate', '--Port', '9117', '--NoUpdates', '--NoRestart'
  ]);
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (stopping.signal.aborted) return;
    if (jackett.finished || jackett.launchError) throw new Error(`Jackett exited before becoming ready${jackett.launchError ? `: ${jackett.launchError.message}` : ''}.`);
    try {
      const health = JSON.parse(await request('/health'));
      if (health.status !== 'OK') throw new Error('Jackett health endpoint is not ready.');
      break;
    } catch (error) {
      lastError = error;
      await delay(500, undefined, { signal: stopping.signal });
    }
  }
  if (Date.now() >= deadline) throw new Error(`Jackett did not become ready: ${lastError?.message || 'startup deadline exceeded'}`);
  await confirmSources(indexers);
  if (stopping.signal.aborted) return;
  if (jackett.finished || jackett.launchError) throw new Error('Jackett exited during bootstrap.');

  await writeJson(runtimeFile, {
    torrentIndexerUrl: `${origin}/api/v2.0/indexers/all/results/torznab`,
    torrentIndexerKey: apiKey,
    indexers
  });
  if (stopping.signal.aborted) {
    await rm(runtimeFile, { force: true });
    return;
  }
  log(`Jackett is ready on loopback; configured public sources: ${indexers.join(', ')}. Live source availability is checked separately.`);

  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Missing Watchhouse command.');
  if (jackett.finished || jackett.launchError) throw new Error('Jackett exited during bootstrap.');
  const app = launch(command, args);
  void app.closed.then((code) => shutdown(code));
  void jackett.closed.then(() => {
    if (!stopping.signal.aborted) {
      log('Jackett exited unexpectedly; stopping Watchhouse.');
      void shutdown(1);
    }
  });
  void reportSources(indexers);
}

main().catch((error) => {
  if (!stopping.signal.aborted) log(`Startup failed: ${error.message}`);
  void shutdown(1);
});
