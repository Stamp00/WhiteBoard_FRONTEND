const { LOGIN_API_URL, BOARD_API_URL } = window.APP_CONFIG;
const TOKEN_KEY = 'whiteboard.token';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Token-hantering ----
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export function decodeToken(token = getToken()) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function tokenIsValid(token = getToken()) {
  const payload = token && decodeToken(token);
  return Boolean(payload?.exp && payload.exp * 1000 > Date.now());
}

// Anropas när servern svarar 401 (t.ex. token har gått ut)
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(base, path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${getToken()}`;

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Kunde inte nå servern. Kontrollera din internetanslutning.');
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error || defaultMessage(res.status);
    if (res.status === 401 && auth) onUnauthorized(message);
    throw new ApiError(res.status, message);
  }
  return data;
}

function defaultMessage(status) {
  if (status === 403) return 'Du har inte behörighet till det här.';
  if (status === 404) return 'Hittades inte.';
  if (status >= 500) return 'Något gick fel på servern. Försök igen om en stund.';
  return `Oväntat fel (${status})`;
}

const login = (path, opts) => request(LOGIN_API_URL, path, opts);
const board = (path, opts) => request(BOARD_API_URL, path, opts);

export const api = {
  register: (username, password) => login('/users', { method: 'POST', body: { username, password }, auth: false }),
  login: (username, password) => login('/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  listUsers: () => login('/users'),

  listBoards: () => board('/boards'),
  createBoard: (name) => board('/boards', { method: 'POST', body: { name } }),
  updateBoard: (id, data) => board(`/boards/${id}`, { method: 'PATCH', body: data }),

  listNotes: (boardId) => board(`/boards/${boardId}/notes`),
  createNote: (boardId, data) => board(`/boards/${boardId}/notes`, { method: 'POST', body: data }),
  updateNote: (id, data) => board(`/notes/${id}`, { method: 'PATCH', body: data }),
  deleteNote: (id) => board(`/notes/${id}`, { method: 'DELETE' }),
};
