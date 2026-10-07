export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(message, { type = 'info', action, duration = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);

  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); close(); });
    el.append(btn);
  }
  $('#toasts').append(el);
  setTimeout(close, duration);
}

export const showError = (err) => toast(err.message || String(err), { type: 'error', duration: 6000 });

const rtf = new Intl.RelativeTimeFormat('sv', { numeric: 'auto' });
export function timeAgo(date) {
  const seconds = Math.round((new Date(date) - Date.now()) / 1000);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'nyss';
}

export function debounce(fn, ms) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.flush = (...args) => { clearTimeout(timer); fn(...args); };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
