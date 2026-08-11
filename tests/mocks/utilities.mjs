// Mirrors assets/utilities.js fetchConfig closely enough for request assertions.
export function fetchConfig(type = 'json', config = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: `application/${type}`, ...config.headers };
  if (type === 'javascript') {
    headers['X-Requested-With'] = 'XMLHttpRequest';
    delete headers['Content-Type'];
  }
  return { method: 'POST', headers, body: config.body };
}
