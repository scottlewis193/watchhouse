import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BoundedTorrentStore, createTorrentStreaming, torrentByteRange, torrentFileSelection, torrentSearchResults } from '../src/lib/server/torrent-streaming.js';

const media = { type: 'tv', title: 'Silo', season: 1, episode: 2 };
const settings = { torrentIndexerUrl: 'https://indexer.example/api', torrentIndexerKey: 'secret', targetResolution: '1080p', playbackQuality: 'fast' };
const video = (path, offset = 0, length = 100) => ({ path, name: path.split('/').at(-1), offset, length });
const metadata = files => ({ pieceLength: 16384, files });
const storeCall = (store, name, ...args) => new Promise((resolve, reject) => store[name](...args, (error, value) => error ? reject(error) : resolve(value)));

test('torrent file selection matches the requested episode and rejects archives, wrong episodes and ambiguous videos', () => {
  const parsed = metadata([video('Silo.S01E01.mkv'), video('Silo_S01E02_x264.mkv', 100), video('Silo.S01E02.sample.mp4', 200)]);
  const file = torrentFileSelection(parsed, media, { title: 'Silo.S01.1080p.x264' });
  assert.equal(file.index, 1);
  assert.equal(file.strategy, 'remux');
  for (const files of [[video('Silo.S01E01.mkv')], [video('Silo.S01E02.rar')], [video('../Silo.S01E02.mp4')], [video('Silo.S01E02E03.mkv')], [video('Silo.S01E02.mp4'), video('Silo.S01E02.alternative.mp4', 100)]]) {
    assert.throws(() => torrentFileSelection(metadata(files), media, { title: 'Silo.S01E02.1080p' }));
  }
  assert.equal(torrentFileSelection(metadata([video('Silo.S01E02.HEVC.mkv')]), media, { title: 'Silo.S01E02.HEVC' }).strategy, 'transcode');
});

test('movie collection selection uses matching filenames rather than choosing the largest unrelated film', () => {
  const movie = { type: 'movie', title: 'Toy Story', year: '1995' };
  const parsed = metadata([video('Toy.Story.Collection/Toy.Story.2.1999.mp4', 0, 1000), video('Toy.Story.Collection/Toy.Story.1995.mp4', 1000, 100)]);
  assert.equal(torrentFileSelection(parsed, movie, { title: 'Toy.Story.Collection.1995' }).index, 1);
  assert.throws(() => torrentFileSelection(metadata([video('Toy.Story.Collection/Unknown.mp4', 0, 1000), video('Toy.Story.Collection/Other.mp4', 1000, 100)]), movie, { title: 'Toy.Story.Collection' }), /no unambiguous filename/);
});

test('HTTP range parsing includes suffixes and byte zero without accepting multipart or unsatisfiable ranges', () => {
  assert.deepEqual(torrentByteRange('bytes=0-0', 100), { start: 0, end: 0, status: 206 });
  assert.deepEqual(torrentByteRange('bytes=-10', 100), { start: 90, end: 99, status: 206 });
  assert.deepEqual(torrentByteRange('bytes=90-', 100), { start: 90, end: 99, status: 206 });
  assert.deepEqual(torrentByteRange('bytes=90-200', 100), { start: 90, end: 99, status: 206 });
  for (const range of ['bytes=100-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'items=1-2', 'bytes=-']) assert.equal(torrentByteRange(range, 100), null);
});

test('piece cache refuses writes beyond its hard cap and releases all pieces on close', async () => {
  const store = new BoundedTorrentStore(4, { maxBytes: 8 });
  await storeCall(store, 'put', 0, Buffer.from('abcd'));
  await storeCall(store, 'put', 1, Buffer.from('efgh'));
  await assert.rejects(storeCall(store, 'put', 2, Buffer.from('ijkl')), /cache limit/);
  assert.equal(store.bytes, 8);
  assert.equal((await storeCall(store, 'get', 0, { offset: 1, length: 2 })).toString(), 'bc');
  assert.equal((await storeCall(store, 'get', 1, {})).toString(), 'efgh');
  await storeCall(store, 'close');
  assert.equal(store.bytes, 0);
  assert.equal(store.chunks.size, 0);
  await assert.rejects(storeCall(store, 'get', 0, {}), /not cached/);
});

test('Torznab search honours active ranking preferences without creating torrent download clients', async () => {
  let clients = 0;
  const service = createTorrentStreaming({
    createClient: async () => { clients++; throw new Error('Search must not connect to peers.'); },
    request: async url => {
      assert.equal(url.searchParams.get('apikey'), 'secret');
      assert.equal(url.searchParams.get('season'), '1');
      return new Response(`<rss>${['720p.x264', '1080p.x264', '2160p.HEVC', '1080p.HDR.x264'].map((tag, index) => `<item><title>Silo.S01E02.${tag}</title><torznab:attr name="seeders" value="3"/><enclosure url="https://indexer.example/torrent/${index}" length="100"/></item>`).join('')}</rss>`);
    }
  });
  try {
    assert.deepEqual((await service.search(media, settings)).map(release => release.title), ['Silo.S01E02.1080p.x264', 'Silo.S01E02.720p.x264']);
    assert.equal(clients, 0);
    assert.throws(() => torrentSearchResults('<error code="100" description="Bad key"/>'), /Bad key/);
  } finally { await service.close(); }
});

test('metadata selection persists a validated source without opening video streams or embedding indexer credentials', async () => {
  const parsed = { ...metadata([video('Silo.S01E02.x264.mp4')]), infoHash: 'a'.repeat(40), pieces: ['a'] };
  let clients = 0;
  const service = createTorrentStreaming({
    parse: async () => parsed,
    createClient: async () => { clients++; throw new Error('No video downloads while selecting.'); },
    request: async () => new Response(Buffer.from('torrent metadata'))
  });
  try {
    const descriptor = await service.select(media, settings, { release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: 'https://indexer.example/file?apikey=secret' } });
    assert.equal(descriptor.name, 'Silo.S01E02.x264.mp4');
    assert.equal(descriptor.file.index, 0);
    assert.equal(descriptor.strategy, 'remux');
    assert.equal(clients, 0);
    assert.ok(!JSON.stringify(descriptor).includes('secret'));
    for (const excludeInfoHashes of [[parsed.infoHash], new Set([parsed.infoHash.toUpperCase()])]) {
      assert.equal(await service.select(media, settings, { release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: 'https://indexer.example/file' }, excludeInfoHashes }), null);
    }
    const restored = JSON.parse(JSON.stringify(descriptor));
    const source = await service.open(restored);
    try {
      assert.equal((await fetch(source.url, { method: 'HEAD' })).headers.get('content-length'), '100');
      assert.equal(clients, 0);
      assert.equal((await fetch(source.url, { headers: { range: 'bytes=100-' } })).status, 416);
      assert.equal(clients, 0);
    } finally { await source.close(); }
    assert.equal((await fetch(source.url)).status, 404);
  } finally { await service.close(); }
});

test('metadata selection follows HTTP redirects to a magnet without treating it as an HTTP resource', { timeout: 30000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const localOptions = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(localOptions);
  let service;
  let server;
  try {
    const payload = Buffer.alloc(32768, 7);
    const seeded = await new Promise((resolve, reject) => {
      seeder.once('error', reject);
      seeder.seed(payload, { name: 'Silo.S01E02.1080p.x264.mp4', announce: [] }, resolve);
    });
    server = createServer((req, res) => {
      res.writeHead(302, { location: req.url.startsWith('/download') ? '/magnet' : seeded.magnetURI });
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    service = createTorrentStreaming({
      createClient: async options => {
        const client = new WebTorrent({ ...options, ...localOptions });
        const add = client.add.bind(client);
        client.add = (...args) => {
          const torrent = add(...args);
          torrent.once('infoHash', () => torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`));
          return torrent;
        };
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: `http://127.0.0.1:${server.address().port}/download` }
    });
    assert.equal(descriptor.infoHash, seeded.infoHash);
    assert.equal(descriptor.name, 'Silo.S01E02.1080p.x264.mp4');
    assert.equal(descriptor.size, payload.length);
  } finally {
    await service?.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => seeder.destroy(resolve));
  }
});

test('local TCP torrent streams exact ranges across cache windows and destroys every download client', { timeout: 60000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const localOptions = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(localOptions);
  const payload = Buffer.alloc(2 * 1024 ** 2 + 317);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const clients = [];
  let service;
  let discoverPeers;
  const discoveryReady = new Promise(resolve => { discoverPeers = resolve; });
  try {
    const seeded = await new Promise((resolve, reject) => {
      seeder.once('error', reject);
      seeder.seed(payload, { name: 'Silo.S01E02.1080p.x264.mp4', announce: [], pieceLength: 16384, store: BoundedTorrentStore, storeOpts: { maxBytes: 3 * 1024 ** 2 } }, resolve);
    });
    service = createTorrentStreaming({
      cacheBytes: 1024 ** 2,
      maxConcurrentStreams: 1,
      timeoutMs: 5000,
      request: async () => new Response(seeded.torrentFile),
      createClient: async options => {
        const discover = clients.length === 0;
        const client = new WebTorrent({ ...options, ...localOptions }); clients.push(client);
        client.on('torrent', torrent => { if (discover) void discoveryReady.then(() => { if (!torrent.destroyed) torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`); }); });
        return client;
      }
    });
    const descriptor = await service.select(media, settings, { release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: 'https://indexer.example/torrent' } });
    assert.equal(clients.length, 0, 'selection downloads no torrent payload');
    const source = await service.open(JSON.parse(JSON.stringify(descriptor)));
    try {
      // Both seek headers must arrive before a peer can supply any payload,
      // even though the second request is waiting for the only reader slot.
      const opening = await fetch(source.url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(5000) });
      const seeking = await fetch(source.url, { headers: { range: 'bytes=-317' }, signal: AbortSignal.timeout(5000) });
      discoverPeers();
      for (const [response, start, end] of [[opening, 0, 0], [seeking, payload.length - 317, payload.length - 1]]) {
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${payload.length}`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(start, end + 1));
      }
      {
        const start = 133, end = payload.length - 1;
        const response = await fetch(source.url, { headers: { range: `bytes=${start}-${end}` } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${payload.length}`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(start, end + 1));
      }
      assert.ok(clients.length >= 5, 'large ranges rotate stores instead of retaining the whole torrent');
      await Promise.all([0, 1024, 32768].map(async start => {
        const response = await fetch(source.url, { headers: { range: `bytes=${start}-${start + 65535}` } });
        assert.equal(response.status, 206, 'concurrent probes wait for the bounded reader slot');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(start, start + 65536));
      }));
      const interrupted = await fetch(source.url, { headers: { range: 'bytes=0-1048575' } });
      await interrupted.body.cancel();
    } finally { await source.close(); }
  } finally {
    await service?.close();
    await new Promise(resolve => seeder.destroy(resolve));
  }
  assert.ok(clients.every(client => client.destroyed));
});
