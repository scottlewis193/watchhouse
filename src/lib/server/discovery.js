import { mapTmdbTitles } from '../../../media.js';

const MAX_PAGE = 500;

function shelfDefinitions() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  return [
    { id: 'current-year-movies', title: `${year} movies`, path: 'discover/movie', type: 'movie', params: { 'primary_release_date.gte': `${year}-01-01`, 'primary_release_date.lte': today } },
    { id: 'popular-movies', title: 'Popular movies', path: 'movie/popular', type: 'movie' },
    { id: 'popular-shows', title: 'Popular shows', path: 'tv/popular', type: 'tv' },
    { id: 'netflix-shows', title: 'Popular on Netflix', path: 'discover/tv', type: 'tv', network: 213 },
    { id: 'prime-video-shows', title: 'Popular on Prime Video', path: 'discover/tv', type: 'tv', network: 1024 },
    { id: 'disney-plus-shows', title: 'Popular on Disney+', path: 'discover/tv', type: 'tv', network: 2739 },
    { id: 'apple-tv-shows', title: 'Popular on Apple TV+', path: 'discover/tv', type: 'tv', network: 2552 },
    { id: 'hbo-shows', title: 'Popular on HBO', path: 'discover/tv', type: 'tv', network: 49 },
    { id: 'bbc-one-shows', title: 'Popular on BBC One', path: 'discover/tv', type: 'tv', network: 4 },
    { id: 'itv1-shows', title: 'Popular on ITV1', path: 'discover/tv', type: 'tv', network: 9 },
    { id: 'channel-4-shows', title: 'Popular on Channel 4', path: 'discover/tv', type: 'tv', network: 26 },
    { id: 'sky-atlantic-shows', title: 'Popular on Sky Atlantic', path: 'discover/tv', type: 'tv', network: 1063 },
    { id: 'action-movies', title: 'Action movies', path: 'discover/movie', type: 'movie', genre: 'Action' },
    { id: 'comedy-movies', title: 'Comedy movies', path: 'discover/movie', type: 'movie', genre: 'Comedy' },
    { id: 'crime-movies', title: 'Crime movies', path: 'discover/movie', type: 'movie', genre: 'Crime' },
    { id: 'science-fiction-movies', title: 'Science fiction movies', path: 'discover/movie', type: 'movie', genre: 'Science Fiction' },
    { id: 'action-shows', title: 'Action & adventure shows', path: 'discover/tv', type: 'tv', genre: 'Action & Adventure' },
    { id: 'comedy-shows', title: 'Comedy shows', path: 'discover/tv', type: 'tv', genre: 'Comedy' },
    { id: 'crime-shows', title: 'Crime shows', path: 'discover/tv', type: 'tv', genre: 'Crime' },
    { id: 'science-fiction-shows', title: 'Sci-fi & fantasy shows', path: 'discover/tv', type: 'tv', genre: 'Sci-Fi & Fantasy' }
  ];
}

function genreId(genres, name) {
  return genres.find(genre => genre.name.toLowerCase() === name.toLowerCase())?.id;
}

function parsePage(page) {
  if (!['number', 'string'].includes(typeof page) || !/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page)) || Number(page) > MAX_PAGE) {
    throw Object.assign(new Error('Discovery page must be an integer from 1 to 500.'), { status: 400 });
  }
  return Number(page);
}

async function fetchPage(request, shelf, page, genre) {
  const filtered = shelf.path.startsWith('discover/');
  const payload = await request(shelf.path, {
    language: 'en-GB', page,
    ...(filtered ? {
      include_adult: false, sort_by: 'popularity.desc',
      ...(shelf.type === 'movie' ? { include_video: false } : { include_null_first_air_dates: false }),
      ...(genre ? { with_genres: genre } : {}),
      ...(shelf.network ? { with_networks: shelf.network } : {}),
      ...shelf.params
    } : {})
  });
  const items = [...new Map(mapTmdbTitles(payload, shelf.type).map(item => [`${item.type}:${item.id}`, item])).values()];
  const totalPages = Math.min(MAX_PAGE, Math.max(0, Math.trunc(Number(payload.total_pages) || 0)));
  const hasMore = page < totalPages;
  return {
    id: shelf.id, title: shelf.title, items, page, totalPages,
    totalResults: Math.max(0, Math.trunc(Number(payload.total_results) || items.length)),
    hasMore, nextPage: hasMore ? page + 1 : null
  };
}

export async function fetchDiscoveryShelves(request) {
  // Keep catalogue calls sequential: smaller TMDB quotas must also support discovery.
  const movieGenres = (await request('genre/movie/list', { language: 'en-GB' })).genres || [];
  const tvGenres = (await request('genre/tv/list', { language: 'en-GB' })).genres || [];
  const shelves = [];
  for (const shelf of shelfDefinitions()) {
    const genre = shelf.genre ? genreId(shelf.type === 'movie' ? movieGenres : tvGenres, shelf.genre) : undefined;
    if (shelf.genre && !genre) continue;
    shelves.push(await fetchPage(request, shelf, 1, genre));
  }
  return shelves;
}

export async function fetchDiscoveryShelfPage(request, id, page = 1) {
  const shelf = shelfDefinitions().find(shelf => shelf.id === id);
  if (!shelf) throw Object.assign(new Error('Unknown discovery shelf.'), { status: 404 });
  const number = parsePage(page);
  let genre;
  if (shelf.genre) {
    const genres = (await request(`genre/${shelf.type}/list`, { language: 'en-GB' })).genres || [];
    genre = genreId(genres, shelf.genre);
    if (!genre) throw Object.assign(new Error('Discovery genre is unavailable.'), { status: 404 });
  }
  return fetchPage(request, shelf, number, genre);
}
