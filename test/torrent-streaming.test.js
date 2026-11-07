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
test('well-seeded playback remains reachable before tiny unavailable swarms exhaust selection', async () => {
  const releases = [
    ...['a', 'b', 'c', 'd'].map((hash, index) => ({ hash, size: 200e6 + index, seeds: 1 })),
    { hash: 'e', size: 2800e6, seeds: 69 }
  ];
  const service = createTorrentStreaming({
    timeoutMs: 120, metadataTimeoutMs: 50,
    request: async (url, { signal }) => {
      if (url.pathname === '/api') return new Response(`<rss>${releases.map(({ hash, size, seeds }) =>
        `<item><title>Silo.S01E02.1080p.x264.${hash}</title><torznab:attr name="seeders" value="${seeds}"/><enclosure url="https://indexer.example/${hash}" length="${size}"/></item>`
      ).join('')}</rss>`);
      if (url.pathname === '/e') return new Response('healthy torrent metadata');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Metadata request was not cancelled.')), 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    },
    parse: async () => ({ ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'e'.repeat(40), pieces: ['a'] })
  });
  try {
    const selected = await service.select(media, { ...settings, targetResolution: 'auto' });
    assert.equal(selected.infoHash, 'e'.repeat(40));
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

test('DHT contacts are bounded, validated and retained across live and cancelled clients without enabling disabled DHT', async () => {
  const nodes = Array.from({ length: 80 }, (_, index) => ({ host: '192.0.2.1', port: 10000 + index }));
  nodes.push({ host: 'not an address', port: 6881 }, { host: '192.0.2.2', port: 0 }, { host: '192.0.2.2', port: 65536 }, { host: null, port: 6881 });
  const clients = [], added = [];
  const firstController = new AbortController();
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let currentController = firstController;
  const service = createTorrentStreaming({
    createClient: async options => {
      assert.equal(options.dht, undefined, 'the dependency must retain its default bootstrap configuration');
      const index = clients.length, contacts = [];
      const controller = currentController;
      const client = stalledMetadataClient(() => {
        if (index === 0) started();
        else queueMicrotask(() => controller.abort(new Error('Selection cancelled.')));
      });
      client.dht = index === 3 ? false : {
        toJSON() {
          assert.equal(client.destroyed, undefined, 'contacts must be captured before client destruction');
          return { nodes: index === 0 ? nodes : [] };
        },
        addNode(node) { contacts.push({ ...node }); node.id = 'not retained'; }
      };
      clients.push(client); added.push(contacts);
      return client;
    }
  });
  const selecting = (signal, hash) => service.select(media, settings, {
    signal, release: { title: 'Silo.S01E02.x264', torrentUrl: `magnet:?xt=urn:btih:${hash.repeat(40)}` }
  });
  try {
    const first = assert.rejects(selecting(firstController.signal, 'a'), /Selection cancelled/);
    await firstStarted;
    currentController = new AbortController();
    await assert.rejects(selecting(currentController.signal, 'b'), /Selection cancelled/);
    assert.deepEqual(added[1], nodes.slice(16, 80), 'a new client must reuse contacts from the still-live metadata client');
    firstController.abort(new Error('Selection cancelled.'));
    await first;
    currentController = new AbortController();
    await assert.rejects(selecting(currentController.signal, 'c'), /Selection cancelled/);
    assert.deepEqual(added[2], nodes.slice(16, 80), 'teardown must preserve only address contacts, not DHT-owned node objects');
    currentController = new AbortController();
    await assert.rejects(selecting(currentController.signal, 'd'), /Selection cancelled/);
    assert.deepEqual(added[3], [], 'dht:false must stay disabled');
  } finally {
    firstController.abort(new Error('Selection cancelled.'));
    await service.close();
  }
  assert.ok(clients.every(client => client.destroyed));
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

test('saved playback reuses DHT contacts when its original bootstrap node goes offline', { timeout: 15000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const { default: DHT } = await import('bittorrent-dht');
  const { createSocket } = await import('node:dgram');
  const options = { tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const bootstrap = new DHT({ bootstrap: false });
  const rendezvous = new DHT({ bootstrap: false });
  const seeder = new WebTorrent({ ...options, dht: { bootstrap: false } });
  const clients = [];
  let service, source, blackhole;
  const listen = dht => new Promise(resolve => dht.listen(0, '127.0.0.1', resolve));
  const destroyDht = dht => dht.destroyed ? Promise.resolve() : new Promise(resolve => dht.destroy(resolve));
  try {
    await Promise.all([listen(bootstrap), listen(rendezvous)]);
    const firstNode = { host: '127.0.0.1', port: bootstrap.address().port };
    const warmNode = { host: '127.0.0.1', port: rendezvous.address().port };
    bootstrap.addNode({ ...warmNode, id: rendezvous.nodeId });
    seeder.dht.addNode({ ...warmNode, id: rendezvous.nodeId });
    const payload = Buffer.alloc(128 * 1024, 79);
    const seeded = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength: 16384,
      store: BoundedTorrentStore, storeOpts: { maxBytes: payload.length }
    }, resolve));
    await new Promise((resolve, reject) => seeder.dht.announce(seeded.infoHash, seeder.torrentPort, error => error ? reject(error) : resolve()));
    service = createTorrentStreaming({
      timeoutMs: 5000, metadataTimeoutMs: 5000,
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options, dht: { bootstrap: [firstNode], timeout: 30000 } });
        const record = { client, ready: false };
        client.dht.once('ready', () => { record.ready = true; });
        clients.push(record);
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: `magnet:?xt=urn:btih:${seeded.infoHash}` }
    });
    assert.equal(clients.length, 1);
    assert.ok(clients[0].client.destroyed, 'metadata discovery must close before saved-source playback');
    await destroyDht(bootstrap);
    // Keep the old endpoint unanswered, rather than letting an unrelated
    // ephemeral socket reuse it and make cold discovery nondeterministic.
    blackhole = createSocket('udp4');
    await new Promise(resolve => blackhole.bind(firstNode.port, firstNode.host, resolve));
    source = await service.open(JSON.parse(JSON.stringify(descriptor)), { connect: true });
    const response = await fetch(source.url, { headers: { range: 'bytes=0-65535' }, signal: AbortSignal.timeout(3000) });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(0, 65536));
    assert.equal(clients.length, 2);
    assert.equal(clients[1].ready, false, 'cached nodes must supply playback before the dead bootstrap query completes');
  } finally {
    await source?.close();
    await service?.close();
    await new Promise(resolve => seeder.destroy(resolve));
    await Promise.all([destroyDht(bootstrap), destroyDht(rendezvous)]);
    if (blackhole) await new Promise(resolve => blackhole.close(resolve));
  }
  assert.ok(clients.every(({ client }) => client.destroyed));
});

for (const failure of ['client error', 'torrent error', 'torrent close']) test(`${failure} promptly terminates a reader whose iterator never settles`, async () => {
  const parsed = { ...metadata([video('Silo.S01E02.x264.mkv')]), infoHash: 'a'.repeat(40), pieces: ['a'] };
  const client = new EventEmitter(), torrent = new EventEmitter();
  let started, returned = false, store;
  const reading = new Promise(resolve => { started = resolve; });
  torrent.files = [{
    ...parsed.files[0], deselect() {},
    [Symbol.asyncIterator]() {
      return {
        next() { started(); return new Promise(() => {}); },
        async return() { returned = true; return { done: true }; }
      };
    }
  }];
  torrent.pause = torrent.resume = () => {};
  client.add = (_id, options, ready) => {
    store = new options.store(parsed.pieceLength, options.storeOpts);
    queueMicrotask(() => ready(torrent));
    return torrent;
  };
  client.destroy = callback => {
    client.destroyed = torrent.destroyed = true;
    torrent.emit('close');
    store.close(callback);
  };
  const service = createTorrentStreaming({
    request: async () => new Response('metadata'),
    parse: async () => parsed, createClient: async () => client,
    timeoutMs: 5000
  });
  let source;
  try {
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: 'https://indexer.example/file' }
    });
    source = await service.open(descriptor);
    const deadline = AbortSignal.timeout(1000);
    const response = await fetch(source.url, { signal: deadline });
    await reading;
    if (failure === 'client error') client.emit('error', new Error('Client transport failed.'));
    else {
      torrent.destroyed = true;
      if (failure === 'torrent error') torrent.emit('error', new Error('Torrent transport failed.'));
      else torrent.emit('close');
    }
    await assert.rejects(response.arrayBuffer(), () => {
      assert.equal(deadline.aborted, false, 'the connection failure must finish the response before caller or stall timeout');
      return true;
    });
  } finally { await source?.close(); await service.close(); }
  assert.equal(returned, true, 'the pending iterator must be returned during cleanup');
  assert.equal(client.destroyed, true);
  assert.equal(store.bytes, 0);
});

test('playback can reconnect to a metadata peer without another discovery service', { timeout: 10000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const options = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(options);
  let service, source, discover = true;
  try {
    const payload = Buffer.alloc(128 * 1024, 83);
    const seeded = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength: 16384
    }, resolve));
    service = createTorrentStreaming({
      timeoutMs: 2000,
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options });
        if (discover) {
          discover = false;
          const add = client.add.bind(client);
          client.add = (...args) => {
            const torrent = add(...args);
            torrent.once('infoHash', () => torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`));
            return torrent;
          };
        }
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: `magnet:?xt=urn:btih:${seeded.infoHash}` }
    });
    source = await service.open(descriptor);
    const response = await fetch(source.url, { headers: { range: 'bytes=0-65535' }, signal: AbortSignal.timeout(2000) });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(0, 65536));
  } finally {
    await source?.close();
    await service?.close();
    await new Promise(resolve => seeder.destroy(resolve));
  }
});

for (const restored of [false, true]) test(restored
  ? 'saved torrent playback connects before inspection and keeps that wire for its first payload'
  : 'foreground playback keeps its metadata connection when new connections become unavailable', { timeout: 10000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const { createServer: tcpServer, connect } = await import('node:net');
  const options = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(options);
  const sockets = new Set();
  let service, source, proxy, proxyClosed, discover = true;
  try {
    const payload = Buffer.alloc(128 * 1024, 91);
    const seeded = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength: 16384,
      store: BoundedTorrentStore, storeOpts: { maxBytes: 1024 ** 2 }
    }, resolve));
    proxy = tcpServer(socket => {
      const upstream = connect(seeder.torrentPort, '127.0.0.1');
      for (const active of [socket, upstream]) {
        sockets.add(active);
        active.on('error', () => { socket.destroy(); upstream.destroy(); });
        active.on('close', () => { sockets.delete(active); socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream); upstream.pipe(socket);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const peer = `127.0.0.1:${proxy.address().port}`;
    service = createTorrentStreaming({
      cacheBytes: 1024 ** 2, maxConcurrentStreams: 1, timeoutMs: 5000,
      request: async () => new Response(seeded.torrentFile),
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options });
        if (discover) {
          discover = false;
          const add = client.add.bind(client);
          client.add = (...args) => {
            const torrent = add(...args);
            torrent.once('infoHash', () => torrent.addPeer(peer));
            return torrent;
          };
        }
        return client;
      }
    });
    const validate = async descriptor => {
      source = await service.open(restored ? JSON.parse(JSON.stringify(descriptor)) : descriptor, { connect: true });
      proxyClosed = new Promise(resolve => proxy.once('close', resolve));
      proxy.close();
      const response = await fetch(source.url, { headers: { range: 'bytes=0-65535' }, signal: AbortSignal.timeout(2000) });
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(0, 65536));
    };
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: restored ? 'https://indexer.example/file' : `magnet:?xt=urn:btih:${seeded.infoHash}` },
      validate: restored ? undefined : validate
    });
    if (restored) await validate(descriptor);
  } finally {
    await source?.close();
    await service?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    await proxyClosed;
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

test('allowed-fast grants cannot fill playback windows with unrelated torrent pieces', { timeout: 15000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const { default: Wire } = await import('bittorrent-protocol');
  const { createServer: tcpServer } = await import('node:net');
  const options = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(options);
  const sockets = new Set(), timers = new Set();
  const pieceLength = 400 * 1024;
  const payload = Buffer.alloc(3 * 1024 ** 2 + 101);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  let service, source, peerServer;
  try {
    const seeded = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength,
      store: BoundedTorrentStore, storeOpts: { maxBytes: payload.length }
    }, resolve));
    peerServer = tcpServer(socket => {
      sockets.add(socket);
      const wire = new Wire();
      socket.on('error', () => socket.destroy());
      socket.once('close', () => { sockets.delete(socket); wire.destroy(); });
      wire.on('error', () => socket.destroy());
      wire.on('handshake', infoHash => {
        wire.handshake(infoHash, Buffer.alloc(20, 31), { fast: true });
        wire.haveAll();
      });
      wire.once('interested', () => {
        // Grant after the client has installed its metadata-aware scheduler.
        // BEP6 permits this piece while choked, outside the first window.
        wire.allowedFast(6);
        const timer = setTimeout(() => { timers.delete(timer); if (!wire.destroyed) wire.unchoke(); }, 100);
        timers.add(timer);
      });
      wire.on('have', index => { if (index === 6) wire.unchoke(); });
      wire.on('request', (index, offset, length, callback) => {
        const start = index * pieceLength + offset;
        callback(null, payload.subarray(start, start + length));
      });
      socket.pipe(wire).pipe(socket);
    });
    await new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve));
    const peer = `127.0.0.1:${peerServer.address().port}`;
    service = createTorrentStreaming({
      cacheBytes: 1024 ** 2, maxConcurrentStreams: 2, timeoutMs: 3000,
      request: async () => new Response(seeded.torrentFile),
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options });
        const add = client.add.bind(client);
        client.add = (...args) => {
          const torrent = add(...args);
          torrent.once('infoHash', () => torrent.addPeer(peer));
          return torrent;
        };
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: 'https://indexer.example/torrent' }
    });
    source = await service.open(descriptor);
    const response = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
    const actual = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(actual, payload.subarray(0));
  } finally {
    await source?.close();
    await service?.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (peerServer?.listening) await new Promise(resolve => peerServer.close(resolve));
    await new Promise(resolve => seeder.destroy(resolve));
  }
});

test('playback crosses cache windows and seeks back when only its original peer connection remains available', { timeout: 15000 }, async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const { createServer: tcpServer, connect } = await import('node:net');
  const options = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(options);
  const sockets = new Set();
  const payload = Buffer.alloc(3 * 1024 ** 2 + 317);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  let service, source, proxy, proxyClosed;
  try {
    const seeded = await new Promise(resolve => seeder.seed(payload, {
      name: 'Silo.S01E02.x264.mkv', announce: [], pieceLength: 65536,
      store: BoundedTorrentStore, storeOpts: { maxBytes: payload.length }
    }, resolve));
    proxy = tcpServer(socket => {
      const upstream = connect(seeder.torrentPort, '127.0.0.1');
      for (const active of [socket, upstream]) {
        sockets.add(active);
        active.on('error', () => { socket.destroy(); upstream.destroy(); });
        active.once('close', () => { sockets.delete(active); socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream); upstream.pipe(socket);
      proxyClosed = new Promise(resolve => proxy.close(resolve));
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const peer = `127.0.0.1:${proxy.address().port}`;
    service = createTorrentStreaming({
      cacheBytes: 1024 ** 2, maxConcurrentStreams: 2, timeoutMs: 2000,
      request: async () => new Response(seeded.torrentFile),
      createClient: async settings => {
        const client = new WebTorrent({ ...settings, ...options });
        const add = client.add.bind(client);
        client.add = (...args) => {
          const torrent = add(...args);
          torrent.once('infoHash', () => torrent.addPeer(peer));
          return torrent;
        };
        return client;
      }
    });
    const descriptor = await service.select(media, settings, {
      release: { title: 'Silo.S01E02.x264', torrentUrl: 'https://indexer.example/torrent' }
    });
    source = await service.open(descriptor);
    const read = async range => Buffer.from(await (await fetch(source.url, {
      headers: range ? { range } : {}, signal: AbortSignal.timeout(6000)
    })).arrayBuffer());
    assert.deepEqual(await read(), payload.subarray(0));
    assert.deepEqual(await read('bytes=133-1048708'), payload.subarray(133, 1048709));
  } finally {
    await source?.close();
    await service?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    await proxyClosed;
    await new Promise(resolve => seeder.destroy(resolve));
  }
});
