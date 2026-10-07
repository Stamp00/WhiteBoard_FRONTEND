import { api, ApiError, getToken, setToken, clearToken, decodeToken, tokenIsValid, setUnauthorizedHandler } from './api.js';
import { $, toast, showError, timeAgo, debounce } from './ui.js';

const COLORS = ['#fef08a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac'];
const POLL_MS = window.APP_CONFIG.POLL_INTERVAL_MS ?? 3000;
const BOARD_KEY = 'whiteboard.board';

const state = {
  user: null,          // { id, username, role } från JWT
  boards: [],
  boardId: null,
  usernames: new Map(), // användar-id -> användarnamn
  notes: new Map(),     // lapp-id -> { data, el, busy, pending, changedAt, saveText }
  deleted: new Set(),   // lappar vi raderat men som en pågående polling kan returnera
  pollTimer: null,
  polling: false,
};

// ---------------- Inloggning ----------------

let authMode = 'login';

function showAuth(message) {
  stopPolling();
  $('#board-view').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-error').textContent = message ?? '';
  $('#auth-form [name=username]').focus();
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $('#auth-submit').textContent = mode === 'login' ? 'Logga in' : 'Skapa konto';
  $('#auth-hint').hidden = mode === 'login';
  $('#auth-form [name=password]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

function validateCredentials(username, password) {
  if (!username || !password) return 'Fyll i både användarnamn och lösenord.';
  if (authMode === 'register') {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return 'Användarnamnet ska vara 3–32 tecken: bokstäver a–z, siffror, _ . eller -';
    if (password.length < 8) return 'Lösenordet måste vara minst 8 tecken.';
  }
  return null;
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.username.value.trim();
  const password = form.password.value;
  const error = validateCredentials(username, password);
  if (error) {
    $('#auth-error').textContent = error;
    return;
  }

  const submit = $('#auth-submit');
  submit.disabled = true;
  $('#auth-error').textContent = '';
  try {
    if (authMode === 'register') {
      await api.register(username, password);
      toast(`Kontot ${username.toLowerCase()} skapades!`, { type: 'success' });
    }
    const { token } = await api.login(username, password);
    setToken(token);
    form.reset();
    await startApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function logout(message) {
  clearToken();
  state.user = null;
  clearBoard();
  showAuth(message);
}

// ---------------- Boards ----------------

async function startApp() {
  if (!tokenIsValid()) return showAuth();
  const payload = decodeToken();
  state.user = { id: Number(payload.sub), username: payload.username, role: payload.role };

  $('#auth-view').hidden = true;
  $('#board-view').hidden = false;
  $('#user-name').textContent = state.user.username;

  // Användarnamn behövs bara för att visa vem som ändrat – fel här är inte kritiska
  api.listUsers()
    .then((users) => users.forEach((u) => state.usernames.set(u.id, u.username)))
    .catch(() => {});

  try {
    await loadBoards();
  } catch (err) {
    showError(err);
  }
}

async function loadBoards(selectId) {
  state.boards = await api.listBoards();
  const select = $('#board-select');
  select.replaceChildren(...state.boards.map((b) => new Option(b.name, b.id)));

  const hasBoards = state.boards.length > 0;
  $('#no-boards').hidden = hasBoards;
  $('#canvas').hidden = !hasBoards;
  for (const id of ['#board-select', '#share-btn', '#new-note-btn']) $(id).disabled = !hasBoards;
  if (!hasBoards) return clearBoard();

  const wanted = selectId ?? Number(localStorage.getItem(BOARD_KEY));
  const board = state.boards.find((b) => b.id === wanted) ?? state.boards[0];
  await openBoard(board.id);
}

function clearBoard() {
  stopPolling();
  state.boardId = null;
  state.notes.forEach((n) => n.el.remove());
  state.notes.clear();
  state.deleted.clear();
}

async function openBoard(boardId) {
  clearBoard();
  state.boardId = boardId;
  localStorage.setItem(BOARD_KEY, String(boardId));
  $('#board-select').value = String(boardId);
  const board = currentBoard();
  $('#share-btn').disabled = !canManage(board);
  document.title = `${board.name} – Whiteboard`;
  await poll();
  startPolling();
}

const currentBoard = () => state.boards.find((b) => b.id === state.boardId);
const canManage = (board) => board && (state.user.role === 'ADMIN' || board.createdBy === state.user.id);

function openBoardDialog() {
  const dialog = $('#board-dialog');
  const form = $('#board-form');
  form.reset();
  form.querySelector('.form-error').textContent = '';
  dialog.showModal();
}

async function onBoardDialogClose() {
  const dialog = $('#board-dialog');
  if (dialog.returnValue !== 'ok') return;
  const name = $('#board-form').name.value.trim();
  if (!name) return;
  try {
    const board = await api.createBoard(name);
    toast(`Boarden "${board.name}" skapades`, { type: 'success' });
    await loadBoards(board.id);
  } catch (err) {
    showError(err);
  }
}

async function openShareDialog() {
  const board = currentBoard();
  if (!board) return;
  const list = $('#share-list');
  const form = $('#share-form');
  form.querySelector('.form-error').textContent = '';
  try {
    const users = await api.listUsers();
    users.forEach((u) => state.usernames.set(u.id, u.username));
    list.replaceChildren(...users.map((u) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = u.id;
      box.checked = board.userIds.includes(u.id);
      box.disabled = u.id === board.createdBy;
      label.append(box, ` ${u.username}${u.id === board.createdBy ? ' (ägare)' : ''}`);
      return label;
    }));
    $('#share-dialog').showModal();
  } catch (err) {
    showError(err);
  }
}

async function onShareDialogClose() {
  if ($('#share-dialog').returnValue !== 'ok') return;
  const userIds = [...$('#share-list').querySelectorAll('input:checked')].map((b) => Number(b.value));
  try {
    const updated = await api.updateBoard(state.boardId, { userIds });
    state.boards = state.boards.map((b) => (b.id === updated.id ? { ...b, ...updated } : b));
    toast('Delningen sparades', { type: 'success' });
  } catch (err) {
    showError(err);
  }
}

// ---------------- Polling ----------------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function setSync(text, type = '') {
  const el = $('#sync-status');
  el.textContent = text;
  el.className = `sync ${type}`;
}

async function poll() {
  if (state.polling || !state.boardId || document.hidden) return;
  state.polling = true;
  const boardId = state.boardId;
  const startedAt = Date.now();
  try {
    const notes = await api.listNotes(boardId);
    if (boardId !== state.boardId) return; // bytte board under tiden
    mergeNotes(notes, startedAt);
    setSync('Synkad', 'ok');
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      toast('Du har inte längre tillgång till den här boarden', { type: 'error' });
      await loadBoards().catch(showError);
    } else if (!(err instanceof ApiError && err.status === 401)) {
      setSync('Offline – försöker igen…', 'error');
    }
  } finally {
    state.polling = false;
  }
}

// Slå ihop serverns lappar med de lokala utan att skriva över sådant användaren håller på med
function mergeNotes(serverNotes, pollStartedAt) {
  const seen = new Set();
  for (const data of serverNotes) {
    seen.add(data.id);
    if (state.deleted.has(data.id)) continue;
    const note = state.notes.get(data.id);
    if (!note) {
      addNote(data);
    } else if (!note.busy && note.pending === 0 && note.changedAt < pollStartedAt) {
      note.data = data;
      renderNote(note);
    }
  }
  for (const [id, note] of state.notes) {
    if (!seen.has(id) && note.pending === 0 && note.changedAt < pollStartedAt) {
      note.el.remove();
      state.notes.delete(id);
    }
  }
  updateCanvas();
}

// ---------------- Lappar ----------------

function addNote(data) {
  const el = $('#note-template').content.firstElementChild.cloneNode(true);
  const note = { data, el, busy: false, pending: 0, changedAt: 0 };
  state.notes.set(data.id, note);

  const colors = el.querySelector('.colors');
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.className = 'color-dot';
    btn.style.background = color;
    btn.dataset.color = color;
    btn.title = 'Byt färg';
    btn.setAttribute('aria-label', `Byt färg till ${color}`);
    btn.addEventListener('click', () => {
      note.data.color = color;
      renderNote(note);
      save(note, { color });
    });
    colors.append(btn);
  }

  const textarea = el.querySelector('.note-text');
  note.saveText = debounce(() => save(note, { text: textarea.value }), 600);
  textarea.addEventListener('input', () => {
    note.data.text = textarea.value;
    note.changedAt = Date.now();
    note.saveText();
  });
  textarea.addEventListener('focus', () => { note.busy = true; bringToFront(note, true); });
  textarea.addEventListener('blur', () => {
    note.busy = false;
    if (textarea.value !== note.lastSavedText) note.saveText.flush();
  });
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') textarea.blur(); });

  el.querySelector('.delete').addEventListener('click', () => deleteNote(note));
  makeDraggable(note, el.querySelector('.note-bar'));
  makeResizable(note, el.querySelector('.resize-handle'));

  $('#canvas').append(el);
  renderNote(note);
  return note;
}

function renderNote(note) {
  const { el, data } = note;
  el.style.left = `${data.x}px`;
  el.style.top = `${data.y}px`;
  el.style.width = `${data.width}px`;
  el.style.height = `${data.height}px`;
  el.style.zIndex = data.zIndex;
  el.style.setProperty('--note-color', data.color);
  el.querySelectorAll('.color-dot').forEach((d) => d.classList.toggle('active', d.dataset.color === data.color));

  const textarea = el.querySelector('.note-text');
  if (document.activeElement !== textarea && textarea.value !== data.text) textarea.value = data.text;
  note.lastSavedText ??= data.text;

  const who = state.usernames.get(data.updatedBy);
  el.querySelector('.note-meta').textContent = `${who ? `${who} · ` : ''}${timeAgo(data.updatedAt)}`;
  el.querySelector('.note-meta').title = `Senast ändrad ${new Date(data.updatedAt).toLocaleString('sv')}`;
}

async function save(note, changes) {
  note.pending++;
  note.changedAt = Date.now();
  if ('text' in changes) note.lastSavedText = changes.text;
  try {
    const updated = await api.updateNote(note.data.id, changes);
    // Behåll lokala ändringar som gjorts medan anropet pågick
    note.data = { ...updated, ...pickLocal(note) };
    if (note.pending === 1) renderNote(note);
  } catch (err) {
    if (err.status === 404) {
      toast('Lappen har raderats av någon annan', { type: 'error' });
      note.el.remove();
      state.notes.delete(note.data.id);
    } else {
      showError(err);
    }
  } finally {
    note.pending--;
    note.changedAt = Date.now();
  }
}

// Fält som användaren just nu ändrar lokalt ska inte skrivas över av serverns svar
function pickLocal(note) {
  const local = {};
  const textarea = note.el.querySelector('.note-text');
  if (document.activeElement === textarea) local.text = textarea.value;
  if (note.busy) Object.assign(local, { x: note.data.x, y: note.data.y, width: note.data.width, height: note.data.height });
  return local;
}

function maxZ() {
  let max = 0;
  for (const n of state.notes.values()) max = Math.max(max, n.data.zIndex);
  return max;
}

// Lägger lappen överst. Returnerar true om z-index ändrades.
function bringToFront(note, persist = false) {
  const top = maxZ();
  if (note.data.zIndex === top && [...state.notes.values()].filter((n) => n.data.zIndex === top).length === 1) return false;
  note.data.zIndex = top + 1;
  note.el.style.zIndex = note.data.zIndex;
  if (persist) save(note, { zIndex: note.data.zIndex });
  return true;
}

function makeDraggable(note, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    note.busy = true;
    note.el.classList.add('dragging');
    const raised = bringToFront(note);
    const start = { x: e.clientX, y: e.clientY, left: note.data.x, top: note.data.y };

    const onMove = (ev) => {
      note.data.x = Math.max(0, Math.round(start.left + ev.clientX - start.x));
      note.data.y = Math.max(0, Math.round(start.top + ev.clientY - start.y));
      note.el.style.left = `${note.data.x}px`;
      note.el.style.top = `${note.data.y}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      note.busy = false;
      note.el.classList.remove('dragging');
      const moved = note.data.x !== start.left || note.data.y !== start.top;
      // Spara nya positionen först när musknappen släpps
      if (moved) save(note, { x: note.data.x, y: note.data.y, zIndex: note.data.zIndex });
      else if (raised) save(note, { zIndex: note.data.zIndex });
      updateCanvas();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function makeResizable(note, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    note.busy = true;
    const start = { x: e.clientX, y: e.clientY, w: note.data.width, h: note.data.height };

    const onMove = (ev) => {
      note.data.width = Math.min(1200, Math.max(120, Math.round(start.w + ev.clientX - start.x)));
      note.data.height = Math.min(1200, Math.max(100, Math.round(start.h + ev.clientY - start.y)));
      note.el.style.width = `${note.data.width}px`;
      note.el.style.height = `${note.data.height}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      note.busy = false;
      if (note.data.width !== start.w || note.data.height !== start.h) {
        save(note, { width: note.data.width, height: note.data.height });
      }
      updateCanvas();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

async function createNote(x, y) {
  if (!state.boardId) return;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  try {
    const data = await api.createNote(state.boardId, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), color, zIndex: maxZ() + 1 });
    const note = state.notes.get(data.id) ?? addNote(data);
    updateCanvas();
    note.el.querySelector('.note-text').focus();
  } catch (err) {
    showError(err);
  }
}

async function deleteNote(note) {
  const { id, ...rest } = note.data;
  note.saveText.cancel();
  state.deleted.add(id);
  note.el.remove();
  state.notes.delete(id);
  updateCanvas();
  try {
    await api.deleteNote(id);
    const boardId = state.boardId;
    toast('Lappen raderades', {
      action: {
        label: 'Ångra',
        onClick: async () => {
          if (boardId !== state.boardId) return;
          try {
            const { text, color, x, y, width, height, zIndex } = rest;
            addNote(await api.createNote(boardId, { text, color, x, y, width, height, zIndex }));
            updateCanvas();
          } catch (err) {
            showError(err);
          }
        },
      },
      duration: 6000,
    });
  } catch (err) {
    if (err.status !== 404) {
      state.deleted.delete(id);
      showError(err);
      poll();
    }
  }
}

// Gör ytan större än lapparna så att man alltid kan dra längre bort
function updateCanvas() {
  let w = 0;
  let h = 0;
  for (const { data } of state.notes.values()) {
    w = Math.max(w, data.x + data.width);
    h = Math.max(h, data.y + data.height);
  }
  const canvas = $('#canvas');
  canvas.style.width = `${Math.max(w + 600, 3000)}px`;
  canvas.style.height = `${Math.max(h + 600, 2000)}px`;
  $('#empty-hint').hidden = state.notes.size > 0;
}

// ---------------- Start ----------------

function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('#auth-form').addEventListener('submit', onAuthSubmit);
  $('#logout-btn').addEventListener('click', () => logout());

  $('#board-select').addEventListener('change', (e) => openBoard(Number(e.target.value)).catch(showError));
  $('#new-board-btn').addEventListener('click', openBoardDialog);
  $('#first-board-btn').addEventListener('click', openBoardDialog);
  $('#board-dialog').addEventListener('close', onBoardDialogClose);
  $('#share-btn').addEventListener('click', openShareDialog);
  $('#share-dialog').addEventListener('close', onShareDialogClose);

  const wrap = $('#canvas-wrap');
  $('#new-note-btn').addEventListener('click', () => {
    const offset = (state.notes.size % 8) * 24;
    createNote(wrap.scrollLeft + 60 + offset, wrap.scrollTop + 60 + offset);
  });
  $('#canvas').addEventListener('dblclick', (e) => {
    if (e.target !== e.currentTarget && !e.target.classList.contains('empty-hint')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    createNote(e.clientX - rect.left - 110, e.clientY - rect.top - 20);
  });

  // Hämta ändringar direkt när fliken blir aktiv igen
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
  window.addEventListener('online', poll);

  // Uppdatera "x minuter sedan" då och då
  setInterval(() => state.notes.forEach((n) => { if (!n.busy) renderNote(n); }), 30000);
}

setUnauthorizedHandler((message) => logout(message || 'Sessionen har gått ut, logga in på nytt.'));
bindEvents();
setAuthMode('login');
if (tokenIsValid()) {
  startApp();
} else {
  const expired = Boolean(getToken());
  clearToken();
  showAuth(expired ? 'Sessionen har gått ut, logga in på nytt.' : '');
}
