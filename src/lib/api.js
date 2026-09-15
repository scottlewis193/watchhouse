async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

export const api = {
  get: (path, options) => request(path, options),
  put: (path, body) => request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  post: (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
  delete: (path, body) => request(path, { method: 'DELETE', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
};
