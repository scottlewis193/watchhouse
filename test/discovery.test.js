import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDiscoveryShelves, fetchDiscoveryShelfPage } from '../src/lib/server/discovery.js';

const movieGenres = [
  { id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 878, name: 'Science Fiction' }
];
const tvGenres = [
  { id: 10759, name: 'Action & Adventure' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 10765, name: 'Sci-Fi & Fantasy' }
];
const title = id => ({ id, title: `Title ${id}`, release_date: '2025-01-01', poster_path: '/poster.jpg' });

test('loads every homepage shelf sequentially without bursting catalogue requests', async () => {
  let active = 0, nextId = 300;
  const requests = [];
  const request = async (path, params) => {
    requests.push({ path, params });
    active++;
    try {
      assert.equal(active, 1);
      await new Promise(resolve => setImmediate(resolve));
      if (path === 'genre/movie/list') return { genres: movieGenres };
      if (path === 'genre/tv/list') return { genres: tvGenres };
      return { results: [title(nextId++)], total_pages: 10, total_results: 200 };
    } finally { active--; }
  };
  const shelves = await fetchDiscoveryShelves(request);
  assert.equal(requests.length, 22);
  assert.equal(shelves.length, 20);
  assert.equal(shelves[0].id, 'current-year-movies');
  assert.deepEqual(shelves.slice(3, 12).map(shelf => shelf.id), [
    'netflix-shows', 'prime-video-shows', 'disney-plus-shows', 'apple-tv-shows', 'hbo-shows',
    'bbc-one-shows', 'itv1-shows', 'channel-4-shows', 'sky-atlantic-shows'
  ]);
  assert.deepEqual(requests.slice(5, 14).map(({ path, params }) => ({ path, network: params.with_networks, sort: params.sort_by })), [
    { path: 'discover/tv', network: 213, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 1024, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 2739, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 2552, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 49, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 4, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 9, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 26, sort: 'popularity.desc' },
    { path: 'discover/tv', network: 1063, sort: 'popularity.desc' }
  ]);
  assert.ok(shelves.every(shelf => shelf.page === 1 && shelf.hasMore && shelf.nextPage === 2));
});

test('current-year movies are bounded from January through today on every page', async () => {
  const today = new Date().toISOString().slice(0, 10), year = today.slice(0, 4);
  const shelf = await fetchDiscoveryShelfPage(async (path, params) => {
    assert.equal(path, 'discover/movie');
    assert.deepEqual(params, {
      language: 'en-GB', page: 3, include_adult: false, sort_by: 'popularity.desc', include_video: false,
      'primary_release_date.gte': `${year}-01-01`, 'primary_release_date.lte': today
    });
    return { results: [title(1)], total_pages: 4, total_results: 61 };
  }, 'current-year-movies', '3');
  assert.equal(shelf.title, `${year} movies`);
  assert.equal(shelf.page, 3);
  assert.equal(shelf.nextPage, 4);
  assert.equal(shelf.totalPages, 4);
  assert.equal(shelf.totalResults, 61);
});

test('discovery retains the entire TMDB page, deduplicates cards, and reports exhaustion', async () => {
  const results = Array.from({ length: 20 }, (_, index) => title(index + 1));
  const shelf = await fetchDiscoveryShelfPage(async (path, params) => {
    assert.equal(path, 'movie/popular');
    assert.equal(params.page, 2);
    return { results: [...results, results[0]], total_pages: 2, total_results: 40 };
  }, 'popular-movies', 2);
  assert.deepEqual(shelf.items.map(item => item.id), results.map(item => item.id));
  assert.ok(shelf.items.every(item => item.type === 'movie'));
  assert.equal(shelf.hasMore, false);
  assert.equal(shelf.nextPage, null);
});

test('network and genre pagination keeps the original shelf filters and media types', async () => {
  const requests = [];
  const request = async (path, params) => {
    requests.push({ path, params });
    if (path === 'genre/tv/list') return { genres: tvGenres };
    return { results: [{ id: 1, name: 'Series' }], total_pages: 8, total_results: 160 };
  };
  const network = await fetchDiscoveryShelfPage(request, 'netflix-shows', 4);
  const genre = await fetchDiscoveryShelfPage(request, 'action-shows', 5);
  assert.equal(requests[0].params.with_networks, 213);
  assert.equal(requests[0].params.page, 4);
  assert.equal(requests[1].path, 'genre/tv/list');
  assert.equal(requests[2].params.with_genres, 10759);
  assert.equal(requests[2].params.page, 5);
  assert.equal(requests[2].params.include_null_first_air_dates, false);
  assert.equal(network.items[0].type, 'tv');
  assert.equal(genre.items[0].type, 'tv');
});

test('discovery caps normal TMDB pagination at page 500', async () => {
  const request = async () => ({ results: [title(1)], total_pages: 3500, total_results: 70000 });
  const penultimate = await fetchDiscoveryShelfPage(request, 'popular-movies', 499);
  assert.equal(penultimate.totalPages, 500);
  assert.equal(penultimate.nextPage, 500);
  const last = await fetchDiscoveryShelfPage(request, 'popular-movies', 500);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextPage, null);
});

test('empty catalogue pages are exhausted', async () => {
  const shelf = await fetchDiscoveryShelfPage(async () => ({ results: [], total_pages: 0, total_results: 0 }), 'popular-movies');
  assert.equal(shelf.page, 1);
  assert.equal(shelf.totalResults, 0);
  assert.equal(shelf.hasMore, false);
  assert.deepEqual(shelf.items, []);
});

test('unknown shelf IDs and invalid pages are rejected before contacting TMDB', async () => {
  const request = async () => { assert.fail('Invalid requests must not contact TMDB'); };
  for (const id of ['../movie/popular', 'constructor', '__proto__', 'continue-watching', 'popular-movies?page=2', '']) {
    await assert.rejects(fetchDiscoveryShelfPage(request, id, 1), { status: 404 });
  }
  for (const page of [0, -1, 501, 1.5, NaN, Infinity, '', '01', '1.0', '1e2', ' 2 ', '2junk', null, true, [1], {}]) {
    await assert.rejects(fetchDiscoveryShelfPage(request, 'popular-movies', page), { status: 400 });
  }
});

test('a missing genre never degrades into an unfiltered discovery page', async () => {
  let requests = 0;
  await assert.rejects(fetchDiscoveryShelfPage(async path => {
    requests++;
    assert.equal(path, 'genre/movie/list');
    return { genres: [] };
  }, 'action-movies', 2), { status: 404 });
  assert.equal(requests, 1);
});

test('TMDB failures remain visible to callers for retry', async () => {
  const error = Object.assign(new Error('TMDB rate limit reached.'), { status: 429 });
  await assert.rejects(fetchDiscoveryShelfPage(async () => { throw error; }, 'popular-movies', 2), error);
});
