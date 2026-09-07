import { handleRequest } from '$lib/server/streamer.js';
import { respond } from '$lib/server/response.js';

export const GET = ({ request, url }) => respond(request, url, handleRequest);
export const POST = ({ request, url }) => respond(request, url, handleRequest);
export const PUT = ({ request, url }) => respond(request, url, handleRequest);
export const DELETE = ({ request, url }) => respond(request, url, handleRequest);
