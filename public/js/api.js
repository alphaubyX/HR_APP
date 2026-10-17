// Thin wrapper around the REST API.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store', // always the latest data, never a stored copy
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) window.dispatchEvent(new Event('hr:signed-out'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  // kept for approval instead of done: say so (the page's own "Saved" message is held back)
  if (res.status === 202 && data && data.pending) window.dispatchEvent(new CustomEvent('hr:pending-approval', { detail: data }));
  // something was saved: lists kept in the page (departments, people …) must be read again
  if (method !== 'GET' && !url.startsWith('/api/login')) window.dispatchEvent(new Event('hr:data-changed'));
  return data;
}

const qs = (params) => {
  const p = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p)}` : '';
};

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};
