import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { BoundedTorrentStore, createTorrentStreaming, torrentByteRange, torrentFileSelection, torrentSearchResults } from '../src/lib/server/torrent-streaming.js';

const media = { type: 'tv', title: 'Silo', season: 1, episode: 2 };
const settings = { torrentIndexerUrl: 'https://indexer.example/api', torrentIndexerKey: 'secret', targetResolution: '1080p', playbackQuality: 'fast' };
const video = (path, offset = 0, length = 100) => ({ path, name: path.split('/').at(-1), offset, length });
const metadata = files => ({ pieceLength: 16384, files });
const storeCall = (store, name, ...args) => new Promise((resolve, reject) => store[name](...args, (error, value) => error ? reject(error) : resolve(value)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function stalledMetadataClient(onAdd = () => {}) {
  const client = new EventEmitter();
  let timer;
  client.add = (id, options) => {
    assert.equal(options.deselect, true);
    assert.equal(options.uploads, false);
    assert.equal(options.storeOpts.maxBytes, 0, 'metadata clients cannot retain payload pieces');
    timer = setTimeout(() => client.emit('error', new Error('Unexpected long metadata wait.')), 1000);
    onAdd(id);
    return new EventEmitter();
  };
  client.destroy = callback => { client.destroyed = true; clearTimeout(timer); callback(); };
  return client;
}

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

test('episode tags repeated in a torrent folder and filename identify one episode rather than a collection', () => {
  const episode = { type: 'tv', title: 'Shrinking', season: 2, episode: 4 };
  const path = 'Shrinking.S02E04.1080p.WEB.H264-SuccessfulCrab[TGx]/shrinking.s02e04.1080p.web.h264-successfulcrab.mkv';
  const file = torrentFileSelection(metadata([video(path)]), episode, { title: 'Shrinking S02E04 1080p WEB H264 SuccessfulCrab[TGx]' });
  assert.equal(file.path, path);
  assert.equal(file.strategy, 'remux');
  for (const conflicting of [
    'Shrinking.S02E03/shrinking.s02e04.mkv',
    'Shrinking.S02E04/shrinking.s02e05.mkv',
    'Shrinking.S02E04/shrinking.s02e04e05.mkv',
    'Shrinking.S02E04/shrinking.s02e04-05.mkv'
  ]) {
    assert.throws(() => torrentFileSelection(metadata([video(conflicting)]), episode, { title: 'Shrinking S02E04 1080p WEB H264' }));
  }
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

test('torrent swarm health outranks generic release-score bonuses within the same playback preference tier', async () => {
  const shrinking = { type: 'tv', title: 'Shrinking', season: 2, episode: 4 };
  const releases = [
    ['Shrinking S02E04 Ci Sei Cascato ITA ENG 1080p ATVP WEB DL DDP5 1 Atmos H 264 MeM GP mkv', 40],
    ['Shrinking S02E04 1080p WEB H264 SuccessfulCrab[TGx]', 517]
  ];
  const service = createTorrentStreaming({
    request: async () => new Response(`<rss>${releases.map(([title, seeders], index) => `<item><title>${title}</title><torznab:attr name="seeders" value="${seeders}"/><enclosure url="https://indexer.example/${index}"/></item>`).join('')}</rss>`)
  });
  try {
    assert.deepEqual((await service.search(shrinking, settings)).map(release => release.seeders), [517, 40]);
  } finally { await service.close(); }
});

test('swarm health preserves explicit target resolution and fast versus quality compatibility preferences', async () => {
  const releases = [
    ['Silo.S01E02.1080p.HEVC.WEB-DL.English', 1],
    ['Silo.S01E02.1080p.x264', 10000],
    ['Silo.S01E02.720p.x264', 20000],
    ['Silo.S01E02.2160p.x264', 30000],
    ['Silo.S01E02.1080p.HDR.x264', 40000],
    ['Silo.S01E02.1080p.French.x264', 50000]
  ];
  const service = createTorrentStreaming({
    request: async () => new Response(`<rss>${releases.map(([title, seeders], index) => `<item><title>${title}</title><torznab:attr name="seeders" value="${seeders}"/><enclosure url="https://indexer.example/${index}"/></item>`).join('')}</rss>`)
  });
  try {
    assert.deepEqual((await service.search(media, settings)).map(release => release.title), [releases[1][0], releases[0][0], releases[2][0]]);
    assert.deepEqual((await service.search(media, { ...settings, playbackQuality: 'quality' })).map(release => release.title), [releases[0][0], releases[1][0], releases[2][0]]);
  } finally { await service.close(); }
});

test('Start fastest with automatic resolution reaches lower-demand native torrents before large high-seed releases', async () => {
  const releases = [
    ['Silo.S01E02.1080p.WEB.H264.SuccessfulCrab', 517, 2813e6],
    ['Silo.S01E02.720p.WEB.H264.SYLiX', 55, 948e6],
    ['Silo.S01E02.WEB.x264.TORRENTGALAXY', 59, 225e6]
  ];
  const service = createTorrentStreaming({
    request: async () => new Response(`<rss>${releases.map(([title, seeders, size], index) => `<item><title>${title}</title><torznab:attr name="seeders" value="${seeders}"/><enclosure url="https://indexer.example/${index}" length="${size}"/></item>`).join('')}</rss>`)
  });
  try {
    const automatic = { ...settings, targetResolution: 'auto' };
    assert.deepEqual((await service.search(media, automatic)).map(release => release.size), [225e6, 948e6, 2813e6]);
    assert.equal((await service.search(media, settings))[0].title, releases[0][0]);
    for (const playbackQuality of ['balanced', 'quality']) {
      assert.equal((await service.search(media, { ...automatic, playbackQuality }))[0].title, releases[0][0]);
    }
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

test('torrent selection skips a metadata-compatible release that fails playback admission', async () => {
  const service = createTorrentStreaming({
    request: async url => new Response(url.pathname === '/api'
      ? '<rss><item><title>Silo.S01E02.1080p.x264.First</title><enclosure url="https://indexer.example/slow"/></item><item><title>Silo.S01E02.1080p.x264.Second</title><enclosure url="https://indexer.example/fast"/></item></rss>'
      : url.pathname.slice(1)),
    parse: async bytes => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: (bytes.toString() === 'slow' ? 'a' : 'b').repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings, {
      validate: async source => {
        if (source.infoHash === 'a'.repeat(40)) throw Object.assign(new Error('Torrent is too slow.'), { code: 'PLAYBACK_TOO_SLOW' });
      }
    });
    assert.equal(selected.infoHash, 'b'.repeat(40));
  } finally { await service.close(); }
});

test('a stalled metadata result does not consume the deadline for a later playable torrent', async () => {
  const service = createTorrentStreaming({
    timeoutMs: 200, metadataTimeoutMs: 20,
    request: async (url, { signal }) => {
      if (url.pathname === '/api') return new Response('<rss><item><title>Silo.S01E02.1080p.x264.First</title><enclosure url="https://indexer.example/stalled"/></item><item><title>Silo.S01E02.1080p.x264.Second</title><enclosure url="https://indexer.example/healthy"/></item></rss>');
      if (url.pathname === '/stalled') return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The stalled request was not cancelled.')), 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return new Response('healthy torrent metadata');
    },
    parse: async () => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'b'.repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings, { validate: async () => {} });
    assert.equal(selected.title, 'Silo.S01E02.1080p.x264.Second');
  } finally { await service.close(); }
});

test('playable torrents remain reachable after more than three playback rejections', async () => {
  const validated = [];
  const service = createTorrentStreaming({
    request: async url => new Response(url.pathname === '/api'
      ? `<rss>${['a', 'b', 'c', 'd', 'e'].map(hash => `<item><title>Silo.S01E02.1080p.x264.${hash}</title><enclosure url="https://indexer.example/${hash}"/></item>`).join('')}</rss>`
      : url.pathname.slice(1)),
    parse: async bytes => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: bytes.toString().repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings, {
      validate: async descriptor => {
        validated.push(descriptor.infoHash);
        if (descriptor.infoHash !== 'e'.repeat(40)) throw new Error('Playback preflight rejected this torrent.');
      }
    });
    assert.equal(selected.infoHash, 'e'.repeat(40));
    assert.equal(validated.length, 5);
  } finally { await service.close(); }
});

test('rejected swarms are not reconnected through alternate magnets or revalidated through duplicate metadata', async () => {
  const rejectedHash = '0'.repeat(40);
  const validated = [];
  let clients = 0;
  const urls = [
    `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
    'https://indexer.example/rejected',
    `magnet:?xt=urn:btih:${rejectedHash}`,
    `magnet:?xt=urn:btih:${'A'.repeat(32)}`,
    'https://indexer.example/redirect',
    'https://indexer.example/duplicate',
    'https://indexer.example/healthy'
  ];
  const service = createTorrentStreaming({
    request: async url => {
      if (url.pathname === '/api') return new Response(`<rss>${urls.map((torrentUrl, index) => `<item><title>Silo.S01E02.1080p.x264.${index}</title><enclosure url="${torrentUrl}"/></item>`).join('')}</rss>`);
      if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: `magnet:?xt=urn:btih:${rejectedHash}` } });
      return new Response(url.pathname);
    },
    createClient: async () => { clients++; throw new Error('A known rejected swarm must not be reconnected.'); },
    parse: async bytes => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: bytes.toString() === '/healthy' ? 'b'.repeat(40) : rejectedHash, pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings, {
      excludeInfoHashes: new Set(['C'.repeat(40)]),
      validate: async descriptor => {
        validated.push(descriptor.infoHash);
        if (descriptor.infoHash === rejectedHash) throw new Error('Playback preflight rejected this swarm.');
      }
    });
    assert.equal(selected.infoHash, 'b'.repeat(40));
    assert.deepEqual(validated, [rejectedHash, 'b'.repeat(40)]);
    assert.equal(clients, 0);
  } finally { await service.close(); }
});

test('timed-out magnet clients close and alternate results do not reconnect the same stalled swarm', async () => {
  const clients = [];
  const urls = [`magnet:?xt=urn:btih:${'0'.repeat(40)}`, `magnet:?xt=urn:btih:${'A'.repeat(32)}`, 'https://indexer.example/healthy'];
  const service = createTorrentStreaming({
    timeoutMs: 300, metadataTimeoutMs: 20,
    request: async url => new Response(url.pathname === '/api'
      ? `<rss>${urls.map((torrentUrl, index) => `<item><title>Silo.S01E02.1080p.x264.${index}</title><enclosure url="${torrentUrl}"/></item>`).join('')}</rss>`
      : 'healthy'),
    createClient: async () => { const client = stalledMetadataClient(); clients.push(client); return client; },
    parse: async () => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'b'.repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings);
    assert.equal(selected.infoHash, 'b'.repeat(40));
    assert.equal(clients.length, 1);
    assert.ok(clients[0].destroyed);
  } finally { await service.close(); }
});

for (const cancel of ['caller', 'service']) {
  test(`${cancel} cancellation destroys stalled metadata clients and stops candidate turnover`, async () => {
    const controller = new AbortController();
    const client = stalledMetadataClient(() => queueMicrotask(() => {
      if (cancel === 'caller') controller.abort(new Error('Caller stopped selection.'));
      else void service.close();
    }));
    const service = createTorrentStreaming({ createClient: async () => client });
    try {
      await assert.rejects(service.select(media, settings, {
        signal: controller.signal,
        release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }
      }), cancel === 'caller' ? /Caller stopped selection/ : { name: 'AbortError' });
      assert.ok(client.destroyed);
    } finally { await service.close(); }
  });
}

test('metadata parsing has a candidate deadline even when the parser cannot be cancelled', async () => {
  const service = createTorrentStreaming({
    timeoutMs: 300, metadataTimeoutMs: 20,
    request: async url => new Response(url.pathname === '/api'
      ? '<rss><item><title>Silo.S01E02.1080p.x264.First</title><enclosure url="https://indexer.example/stalled"/></item><item><title>Silo.S01E02.1080p.x264.Second</title><enclosure url="https://indexer.example/healthy"/></item></rss>'
      : url.pathname),
    parse: async bytes => {
      if (bytes.toString() === '/stalled') await pause(100);
      return { ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: (bytes.toString() === '/healthy' ? 'b' : 'a').repeat(40), pieces: ['a'] };
    }
  });
  try {
    const selected = await service.select(media, settings);
    assert.equal(selected.infoHash, 'b'.repeat(40));
  } finally { await service.close(); }
});

test('the metadata deadline covers a redirected response body without consuming the next candidate', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/stalled' }); res.end(); }
    else if (req.url === '/stalled') { res.writeHead(200); res.write('incomplete torrent metadata'); }
    else res.end('healthy');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = createTorrentStreaming({
    timeoutMs: 1000, metadataTimeoutMs: 50,
    request: (url, options) => url.pathname === '/api'
      ? Promise.resolve(new Response(`<rss><item><title>Silo.S01E02.1080p.x264.First</title><enclosure url="${origin}/redirect"/></item><item><title>Silo.S01E02.1080p.x264.Second</title><enclosure url="${origin}/healthy"/></item></rss>`))
      : fetch(url, options),
    parse: async bytes => {
      assert.equal(bytes.toString(), 'healthy');
      return { ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'b'.repeat(40), pieces: ['a'] };
    }
  });
  try {
    const selected = await service.select(media, settings);
    assert.equal(selected.infoHash, 'b'.repeat(40));
  } finally {
    await service.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a completed metadata deadline cannot cancel validation or a retained playback source', async () => {
  let source;
  const service = createTorrentStreaming({
    timeoutMs: 500, metadataTimeoutMs: 20,
    request: async () => new Response('metadata'),
    parse: async () => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'b'.repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.1080p.x264', torrentUrl: 'https://indexer.example/healthy' },
      validate: async (descriptor, { signal }) => {
        source = await service.open(descriptor, { signal });
        await pause(50);
        assert.equal(signal.aborted, false);
      }
    });
    assert.equal(selected.infoHash, 'b'.repeat(40));
    await pause(30);
    assert.equal((await fetch(source.url, { method: 'HEAD' })).status, 200);
  } finally { await source?.close(); await service.close(); }
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
  let peakClients = 0;
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
        peakClients = Math.max(peakClients, clients.filter(client => !client.destroyed).length + 1);
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
      assert.equal(peakClients, 1, 'retained windows must share the active reader budget rather than allocate another cache');
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

test('a verified opening window remains readable after its peer disconnects', { timeout: 10000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const options = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(options);
  let service, source, seederClosed = false;
  try {
    const payload = Buffer.alloc(128 * 1024, 73);
    const torrent = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength: 16384
    }, resolve));
    const peer = `127.0.0.1:${seeder.torrentPort}`;
    service = createTorrentStreaming({
      cacheBytes: 1024 ** 2, maxConcurrentStreams: 1, timeoutMs: 2000,
      request: async () => new Response(torrent.torrentFile),
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options });
        const add = client.add.bind(client);
        client.add = (...args) => {
          const active = add(...args);
          active.once('infoHash', () => active.addPeer(peer));
          return active;
        };
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: 'https://indexer.example/torrent' }
    });
    source = await service.open(descriptor);
    const read = async () => Buffer.from(await (await fetch(source.url, {
      headers: { range: 'bytes=0-65535' }, signal: AbortSignal.timeout(3000)
    })).arrayBuffer());
    assert.deepEqual(await read(), payload.subarray(0, 65536));
    await new Promise(resolve => seeder.destroy(resolve));
    seederClosed = true;
    assert.deepEqual(await read(), payload.subarray(0, 65536));
  } finally {
    await source?.close();
    await service?.close();
    if (!seederClosed) await new Promise(resolve => seeder.destroy(resolve));
  }
});
