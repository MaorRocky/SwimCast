'use strict';
/* global ICONS */
/* global api -- exposed by preload.js via contextBridge */

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; // only used with trusted icon markup
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const icon = (name) => h('span', { class: 'i', html: ICONS[name] || '' });
const $ = (sel) => document.querySelector(sel);

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}
function fmtDuration(sec) {
  if (!sec) return '';
  const hh = Math.floor(sec / 3600); const mm = Math.round((sec % 3600) / 60);
  return hh ? `${hh} h ${mm} min` : `${mm} min`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return fmtDate(iso);
}

function artwork(src, title, cls = '') {
  const initials = (title || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const fallback = () => h('div', { class: `art art-fallback ${cls}` }, initials);
  if (!src) return fallback();
  const img = h('img', { class: `art ${cls}`, src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function toast(msg, kind = 'ok', ms = 4200) {
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'alert' : 'check'), h('div', null, msg));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

async function guard(fn, fallbackMsg) {
  try { return await fn(); } catch (e) { toast(e.message || fallbackMsg || 'Something went wrong', 'error', 7000); return undefined; }
}

// ---------------------------------------------------------------- state
const state = {
  platform: 'win32',
  podcasts: [],
  settings: {},
  canConvert: true,
  view: { type: 'welcome' },
  episodes: [],
  epQuery: '',
  epMode: 'all',
  shown: 60,
  selected: new Set(),
  dl: new Map(), // episodeId -> status
  subFilter: '',
};
const rowActions = new Map(); // episodeId -> action container in the current list

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const list = $('#pod-list');
  list.replaceChildren();
  const q = state.subFilter.toLowerCase();
  const items = state.podcasts.filter((p) => !q || p.title.toLowerCase().includes(q) || (p.author || '').toLowerCase().includes(q));
  if (!state.podcasts.length) {
    list.append(h('li', { class: 'side-empty' }, 'No podcasts yet. Import your Apple Podcasts subscriptions or add a show.'));
  }
  for (const p of items) {
    const active = state.view.type === 'podcast' && state.view.id === p.id;
    const sub = p.lastError
      ? h('div', { class: 's err' }, 'Couldn’t refresh')
      : h('div', { class: 's' }, [p.latest ? `New ${ago(p.latest)}` : `${p.episodeCount} episodes`, p.downloadedCount ? ` · ${p.downloadedCount} saved` : ''].join(''));
    list.append(h('li', { class: `pod-item${active ? ' active' : ''}`, onclick: () => openPodcast(p.id), title: p.title },
      artwork(p.artwork, p.title), h('div', { class: 'meta' }, h('div', { class: 't' }, p.title), sub)));
  }
  const totalDownloaded = state.podcasts.reduce((s, p) => s + (p.downloadedCount || 0), 0);
  $('#downloaded-count').textContent = totalDownloaded ? String(totalDownloaded) : '';
  $('#nav-downloads').classList.toggle('active', state.view.type === 'downloads');
}

function renderDlStatus() {
  const active = [...state.dl.values()].filter((s) => ['queued', 'downloading', 'converting'].includes(s.state));
  const el = $('#dl-status');
  if (!active.length) { el.hidden = true; return; }
  const total = active.reduce((s, x) => s + (x.total || 0), 0);
  const got = active.reduce((s, x) => s + (x.received || 0), 0);
  const pct = total ? Math.round((got / total) * 100) : 0;
  const running = active.filter((s) => s.state !== 'queued').length;
  el.hidden = false;
  const bar = h('div', { class: `bar${total ? '' : ' indeterminate'}` }, h('i'));
  if (total) bar.firstChild.style.width = `${pct}%`;
  el.replaceChildren(h('span', { class: 'spinner' }), h('span', null, `Downloading ${running || active.length}${active.length > running ? ` (+${active.length - running} queued)` : ''}`), bar);
}

async function reloadPodcasts() {
  state.podcasts = await api.podcasts.list();
  renderSidebar();
}

// ---------------------------------------------------------------- welcome
function renderWelcome() {
  state.view = { type: 'welcome' };
  renderSidebar();
  const isMac = state.platform === 'darwin';
  const card = (ico, title, text, onclick) => h('div', { class: 'card', onclick, tabindex: 0, role: 'button' },
    h('div', { class: 'ico' }, icon(ico)), h('h3', null, title), h('p', null, text));
  $('#main').replaceChildren(h('div', { class: 'welcome' },
    h('div', { class: 'hero', html: document.querySelector('.brand-mark').outerHTML }),
    h('h1', null, 'Your podcasts, ready for the pool'),
    h('p', null, 'Bring in the shows you follow in Apple Podcasts, pick episodes, and save them as MP3 files you can drop straight onto your swim headphones.'),
    h('div', { class: 'cards' },
      isMac
        ? card('laptop', 'Import from this Mac', 'Read the shows you follow in the Podcasts app (synced from your iPhone).', () => openImport('mac'))
        : card('phone', 'Import from iPhone', 'Use a quick Shortcut on your iPhone to send your list of shows here.', () => openImport('shortcut')),
      card('cable', 'iPhone backup (cable)', 'Connect by cable, make an unencrypted backup, and SwimCast reads your shows from it.', () => openImport('backup')),
      card('search', 'Find a podcast', 'Search the Apple Podcasts catalog or paste any RSS feed address.', () => openAdd())),
    h('div', { class: 'steps' },
      h('span', null, h('b', null, '1'), '  Add shows'), h('span', null, h('b', null, '2'), '  Download MP3s'), h('span', null, h('b', null, '3'), '  Copy to headphones'))));
}

// ---------------------------------------------------------------- podcast view
async function openPodcast(id) {
  state.view = { type: 'podcast', id };
  state.epQuery = '';
  state.epMode = 'all';
  state.shown = 60;
  state.selected.clear();
  renderSidebar();
  state.episodes = await guard(() => api.podcasts.episodes(id)) || [];
  renderPodcast();
}

function currentPodcast() { return state.podcasts.find((p) => p.id === state.view.id); }

function filteredEpisodes() {
  const q = state.epQuery.trim().toLowerCase();
  return state.episodes.filter((e) => {
    if (state.epMode === 'downloaded' && !e.downloaded) return false;
    if (state.epMode === 'new' && e.downloaded) return false;
    if (!q) return true;
    return e.title.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q);
  });
}

function renderPodcast() {
  const p = currentPodcast();
  if (!p) return renderWelcome();
  rowActions.clear();

  const desc = h('div', { class: 'desc', title: 'Click to expand', onclick: () => desc.classList.toggle('open') }, p.description || '');
  const latestSel = h('select', { 'aria-label': 'How many latest episodes' },
    ...[1, 3, 5, 10, 20].map((n) => h('option', { value: String(n), selected: n === 3 }, String(n))));
  const header = h('section', { class: 'pod-header' },
    artwork(p.artwork, p.title),
    h('div', null,
      h('h1', null, p.title),
      p.author ? h('div', { class: 'author' }, p.author) : null,
      desc,
      p.lastError ? h('div', { class: 'warn' }, icon('alert'), `Last refresh failed: ${p.lastError}`) : null,
      h('div', { class: 'header-actions' },
        h('span', { class: 'split' },
          h('button', { class: 'btn btn-primary', onclick: () => downloadLatest(Number(latestSel.value)) }, icon('download'), 'Download latest'),
          latestSel),
        h('button', { class: 'btn btn-secondary', onclick: (e) => refreshCurrent(e.currentTarget) }, icon('refresh'), 'Refresh'),
        h('button', { class: 'btn btn-secondary', onclick: () => openPodcastFolder(p) }, icon('folder'), 'Open folder'),
        p.link ? h('button', { class: 'btn btn-ghost', onclick: () => api.shell.openExternal(p.link) }, icon('link'), 'Website') : null,
        h('button', { class: 'btn btn-danger', onclick: () => removePodcast(p) }, icon('trash'), 'Remove'))));

  const search = h('input', { type: 'search', placeholder: 'Search episodes', value: state.epQuery });
  search.addEventListener('input', () => { state.epQuery = search.value; state.shown = 60; renderEpisodeList(); });
  const chip = (mode, label) => h('button', { class: `chip${state.epMode === mode ? ' active' : ''}`, onclick: (e) => {
    state.epMode = mode; state.shown = 60;
    e.currentTarget.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    e.currentTarget.classList.add('active');
    renderEpisodeList();
  } }, label);
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search-input' }, icon('search'), search),
    h('div', { class: 'chips' }, chip('all', 'All'), chip('new', 'Not downloaded'), chip('downloaded', 'Downloaded')),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted small', id: 'ep-count' }));

  $('#main').replaceChildren(h('div', { class: 'main-inner' }, header, toolbar, h('div', { id: 'ep-wrap' }), h('div', { id: 'sel-wrap' })));
  $('#main').scrollTop = 0;
  renderEpisodeList();
}

function renderEpisodeList() {
  const wrap = $('#ep-wrap');
  if (!wrap) return;
  rowActions.clear();
  const eps = filteredEpisodes();
  $('#ep-count').textContent = `${eps.length} episode${eps.length === 1 ? '' : 's'}`;
  if (!eps.length) {
    wrap.replaceChildren(h('div', { class: 'ep-list' }, h('div', { class: 'center' }, state.episodes.length ? 'No episodes match.' : 'This feed has no downloadable episodes yet.')));
    renderSelectionBar();
    return;
  }
  const list = h('div', { class: 'ep-list' });
  for (const e of eps.slice(0, state.shown)) list.append(episodeRow(e));
  if (eps.length > state.shown) {
    list.append(h('div', { class: 'more-row' }, h('button', { class: 'btn btn-secondary', onclick: () => { state.shown += 100; renderEpisodeList(); } }, `Show more (${eps.length - state.shown} older)`)));
  }
  wrap.replaceChildren(list);
  renderSelectionBar();
}

function episodeRow(e) {
  const cb = h('input', { type: 'checkbox', checked: state.selected.has(e.id), 'aria-label': `Select ${e.title}` });
  const row = h('article', { class: `ep${state.selected.has(e.id) ? ' selected' : ''}` });
  cb.addEventListener('change', () => {
    if (cb.checked) state.selected.add(e.id); else state.selected.delete(e.id);
    row.classList.toggle('selected', cb.checked);
    renderSelectionBar();
  });
  const meta = h('div', { class: 'ep-meta' },
    h('span', null, fmtDate(e.pubDate)),
    e.duration ? h('span', { class: 'dot' }, fmtDuration(e.duration)) : null,
    e.size > 100000 ? h('span', { class: 'dot' }, fmtBytes(e.size)) : null,
    e.episodeNumber ? h('span', { class: 'dot' }, `Ep. ${e.episodeNumber}${e.season ? ` · S${e.season}` : ''}`) : null,
    e.episodeType && e.episodeType !== 'full' ? h('span', { class: 'badge lane' }, e.episodeType) : null,
    e.copied ? h('span', { class: 'badge' }, icon('headphones'), 'On headphones') : null);
  const text = e.description || e.subtitle || '';
  const desc = text ? h('div', { class: 'ep-desc', title: 'Click to read more', onclick: () => desc.classList.toggle('open') }, text) : null;
  const action = h('div', { class: 'ep-action' });
  rowActions.set(e.id, action);
  renderAction(e, action);
  row.append(cb, h('div', null, meta, h('div', { class: 'ep-title' }, e.title), desc), action);
  return row;
}

function renderAction(e, el) {
  const s = state.dl.get(e.id);
  if (e.downloaded) {
    el.replaceChildren(
      h('div', { class: 'done' }, icon('check'), 'Downloaded'),
      h('div', { class: 'row' },
        h('button', { class: 'icon-btn', title: 'Show in folder', onclick: () => api.shell.showItem(e.downloaded.path) }, icon('folder')),
        h('button', { class: 'icon-btn', title: 'Delete file', onclick: () => deleteDownload(e) }, icon('trash'))));
    return;
  }
  if (s && (s.state === 'downloading' || s.state === 'queued' || s.state === 'converting')) {
    const pct = s.total ? Math.min(100, Math.round((s.received / s.total) * 100)) : 0;
    const label = s.state === 'queued' ? 'Queued' : s.state === 'converting' ? 'Converting to MP3…' : (s.total ? `${pct}%` : fmtBytes(s.received));
    const bar = h('div', { class: `bar${(s.state === 'downloading' && s.total) ? '' : ' indeterminate'}` }, h('i'));
    if (s.state === 'downloading' && s.total) bar.firstChild.style.width = `${pct}%`;
    el.replaceChildren(h('div', { class: 'progress' },
      h('div', { class: 'label' }, h('span', null, label), h('button', { class: 'icon-btn', title: 'Cancel', onclick: () => api.downloads.cancel(e.id) }, icon('x'))),
      bar));
    return;
  }
  const btn = h('button', { class: 'btn btn-secondary', onclick: () => startDownloads([e.id]) }, icon('download'), 'Download MP3');
  el.replaceChildren(...[btn, s && s.state === 'error' ? h('div', { class: 'error' }, s.error || 'Failed') : null].filter(Boolean));
}

function renderSelectionBar() {
  const wrap = $('#sel-wrap');
  if (!wrap) return;
  const ids = [...state.selected];
  if (!ids.length) { wrap.replaceChildren(); return; }
  const notDownloaded = ids.filter((id) => !state.episodes.find((e) => e.id === id)?.downloaded);
  wrap.replaceChildren(h('div', { class: 'selection-bar' },
    h('span', null, `${ids.length} selected`),
    h('button', { class: 'btn btn-primary btn-sm', disabled: !notDownloaded.length, onclick: () => { startDownloads(notDownloaded); state.selected.clear(); renderEpisodeList(); } }, icon('download'), `Download ${notDownloaded.length || ''}`),
    h('button', { class: 'btn btn-ghost-light btn-sm', onclick: () => {
      filteredEpisodes().slice(0, state.shown).forEach((e) => state.selected.add(e.id)); renderEpisodeList();
    } }, 'Select all shown'),
    h('button', { class: 'btn btn-ghost-light btn-sm', onclick: () => { state.selected.clear(); renderEpisodeList(); } }, 'Clear')));
}

async function startDownloads(ids) {
  if (!ids.length) return;
  const n = await guard(() => api.downloads.start(ids));
  if (n === 0) toast('Already downloaded or in the queue.');
}

function downloadLatest(n) {
  const ids = state.episodes.slice(0, n).filter((e) => !e.downloaded).map((e) => e.id);
  if (!ids.length) return toast(`The latest ${n} episode${n > 1 ? 's are' : ' is'} already downloaded.`);
  startDownloads(ids);
}

async function refreshCurrent(btn) {
  const p = currentPodcast();
  btn.disabled = true;
  const r = await guard(() => api.podcasts.refresh(p.id));
  btn.disabled = false;
  await reloadPodcasts();
  if (r) {
    toast(r.newCount ? `${r.newCount} new episode${r.newCount > 1 ? 's' : ''}` : 'Up to date');
    state.episodes = await api.podcasts.episodes(p.id);
  }
  renderPodcast();
}

function openPodcastFolder(p) {
  const anyDownloaded = state.episodes.find((e) => e.downloaded);
  if (anyDownloaded) api.shell.showItem(anyDownloaded.downloaded.path);
  else api.shell.openFolder();
}

async function removePodcast(p) {
  const ok = await confirmDialog(`Remove “${p.title}”?`, 'It will be removed from SwimCast only. Downloaded MP3 files stay on your computer, and Apple Podcasts is not changed.', 'Remove');
  if (!ok) return;
  await guard(() => api.podcasts.remove(p.id));
  await reloadPodcasts();
  renderWelcome();
}

async function deleteDownload(e) {
  const ok = await confirmDialog('Delete this MP3?', `“${e.title}” will be moved to the Recycle Bin / Trash. You can download it again any time.`, 'Delete');
  if (!ok) return;
  await guard(() => api.downloads.remove(e.id));
  e.downloaded = null;
  state.dl.delete(e.id);
  await reloadPodcasts();
  if (state.view.type === 'downloads') renderDownloads();
  else { const el = rowActions.get(e.id); if (el) renderAction(e, el); }
}

// ---------------------------------------------------------------- downloaded view
async function renderDownloads() {
  state.view = { type: 'downloads' };
  renderSidebar();
  const items = await guard(() => api.downloads.listDownloaded()) || [];
  const total = items.reduce((s, i) => s + (i.size || 0), 0);
  const listening = items.reduce((s, i) => s + (i.duration || 0), 0);
  const list = h('div', { class: 'ep-list' });
  if (!items.length) list.append(h('div', { class: 'center' }, 'Nothing downloaded yet. Open a podcast and press “Download MP3”.'));
  for (const it of items) {
    list.append(h('div', { class: 'list-item' },
      artwork(it.artwork, it.podcastTitle),
      h('div', { class: 'grow' }, h('div', { class: 't' }, it.title), h('div', { class: 's' }, [it.podcastTitle, fmtDate(it.pubDate), fmtDuration(it.duration), fmtBytes(it.size)].filter(Boolean).join(' · '))),
      it.copied ? h('span', { class: 'badge' }, icon('headphones'), 'On headphones') : null,
      h('button', { class: 'icon-btn', title: 'Show in folder', onclick: () => api.shell.showItem(it.path) }, icon('folder')),
      h('button', { class: 'icon-btn', title: 'Delete file', onclick: () => deleteDownload({ id: it.episodeId, title: it.title }) }, icon('trash'))));
  }
  $('#main').replaceChildren(h('div', { class: 'main-inner' },
    h('section', { class: 'pod-header', style: null },
      h('div', { class: 'art art-fallback' }, icon('check')),
      h('div', null, h('h1', null, 'Downloaded episodes'),
        h('div', { class: 'muted' }, `${items.length} files · ${fmtBytes(total) || '0 MB'}${listening ? ` · about ${fmtDuration(listening)} of listening` : ''}`),
        h('div', { class: 'header-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => openDevice() }, icon('headphones'), 'Copy to headphones'),
          h('button', { class: 'btn btn-secondary', onclick: () => api.shell.openFolder() }, icon('folder'), 'Open download folder')))),
    list));
}

// ---------------------------------------------------------------- modal plumbing
let modalCleanup = null;
function openModal(title, body, foot, { wide = false } = {}) {
  const modal = $('#modal');
  modal.style.width = wide ? 'min(900px, calc(100vw - 48px))' : '';
  modal.replaceChildren(...[
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null].filter(Boolean));
  $('#modal-backdrop').hidden = false;
  const first = modal.querySelector('input[type=search], input[type=url], textarea');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() {
  $('#modal-backdrop').hidden = true;
  $('#modal').replaceChildren();
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}
$('#modal-backdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal(); });

function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const done = (v) => { modalCleanup = null; closeModal(); resolve(v); };
    openModal(title, h('p', { class: 'muted' }, text), [
      h('div', { class: 'grow' }),
      h('button', { class: 'btn btn-secondary', onclick: () => done(false) }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onclick: () => done(true) }, okLabel)]);
    modalCleanup = () => resolve(false);
  });
}

// ---------------------------------------------------------------- add podcast
function openAdd() {
  const results = h('div', { class: 'results' });
  const status = h('div', { class: 'muted small' });
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search by show name, e.g. “Huberman”', autofocus: true });
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https://example.com/feed.xml  or  podcasts.apple.com/… link' });
  let timer = null;
  let seq = 0;

  const doSearch = async () => {
    const term = q.value.trim();
    if (!term) { results.replaceChildren(); status.textContent = ''; return; }
    const my = ++seq;
    status.replaceChildren(h('span', { class: 'spinner' }));
    const found = await guard(() => api.podcasts.search(term));
    if (my !== seq) return;
    status.textContent = found ? (found.length ? '' : 'No shows found.') : '';
    results.replaceChildren(...(found || []).map(resultCard));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 350); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); doSearch(); } });

  function resultCard(r) {
    const added = state.podcasts.some((p) => p.feedUrl.toLowerCase() === r.feedUrl.toLowerCase());
    const btn = h('button', { class: `btn ${added ? 'btn-secondary' : 'btn-primary'} btn-sm`, disabled: added }, added ? 'Added' : 'Subscribe');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }));
      const res = await guard(() => api.podcasts.add(r.feedUrl, { title: r.title, author: r.author, artwork: r.artwork, source: 'search' }));
      if (res) { btn.replaceChildren('Added'); btn.className = 'btn btn-secondary btn-sm'; await reloadPodcasts(); toast(`Subscribed to ${res.podcast.title}`); }
      else { btn.disabled = false; btn.replaceChildren('Subscribe'); }
    });
    return h('div', { class: 'result' }, artwork(r.artwork, r.title), h('div', { class: 't', title: r.title }, r.title), h('div', { class: 's' }, r.author), btn);
  }

  const addUrl = async (btn) => {
    const v = url.value.trim();
    if (!v) return url.focus();
    btn.disabled = true;
    let res;
    if (/apple\.com\/.*id\d+/i.test(v)) {
      const cands = await guard(() => api.importer.parseText(v));
      if (cands && cands[0]) res = await guard(() => api.podcasts.add(cands[0].feedUrl, { ...cands[0], source: 'link' }));
      else if (cands) toast('Could not find that show’s feed.', 'error');
    } else {
      res = await guard(() => api.podcasts.add(v, { source: 'url' }));
    }
    btn.disabled = false;
    if (res) {
      await reloadPodcasts();
      closeModal();
      toast(res.existed ? 'You already have this podcast.' : `Subscribed to ${res.podcast.title}`);
      openPodcast(res.podcast.id);
    }
  };
  const addBtn = h('button', { class: 'btn btn-primary', onclick: (e) => addUrl(e.currentTarget) }, 'Add feed');
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') addUrl(addBtn); });

  openModal('Add a podcast', [
    h('div', { class: 'field' }, h('div', { class: 'search-input', style: null }, q)),
    status, results,
    h('div', { class: 'divider' }, 'or paste a feed address'),
    h('div', { class: 'row' }, url, addBtn),
    h('p', { class: 'muted small' }, 'Subscriptions you add here live only in SwimCast — your Apple Podcasts library isn’t changed.'),
  ], null, { wide: true });
}

// ---------------------------------------------------------------- import
function openImport(tab) {
  const isMac = state.platform === 'darwin';
  const tabs = [
    ...(isMac ? [['mac', 'laptop', 'This Mac']] : []),
    ['shortcut', 'phone', 'iPhone Shortcut'],
    ['backup', 'cable', 'iPhone backup (cable)'],
    ['file', 'file', 'OPML / text file'],
  ];
  let current = tab || (isMac ? 'mac' : 'shortcut');
  const body = h('div');
  const tabBar = h('div', { class: 'tabs' });
  const getFoot = () => {
    const modal = $('#modal');
    let f = modal.querySelector('.modal-foot');
    if (!f) { f = h('div', { class: 'modal-foot' }); modal.append(f); }
    return f;
  };
  const removeFoot = () => { const f = $('#modal .modal-foot'); if (f) f.remove(); };

  const draw = () => {
    removeFoot();
    tabBar.replaceChildren(...tabs.map(([id, ic, label]) => h('button', { class: `tab${id === current ? ' active' : ''}`, onclick: () => { current = id; draw(); } }, icon(ic), label)));
    const pane = { mac: paneMac, shortcut: paneShortcut, backup: paneBackup, file: paneFile }[current]();
    body.replaceChildren(tabBar, pane);
  };
  openModal('Import your subscriptions', body, null, { wide: true });
  draw();

  // Each pane eventually calls showCandidates(list)
  function paneMac() {
    const btn = h('button', { class: 'btn btn-primary' }, icon('import'), 'Read my Podcasts library');
    const out = h('div');
    btn.addEventListener('click', async () => {
      btn.disabled = true; out.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'spinner' })));
      try { showCandidates(await api.importer.mac(), 'apple-mac'); }
      catch (e) {
        btn.disabled = false;
        out.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('div', null, e.message)));
      }
    });
    return h('div', null,
      h('div', { class: 'howto' }, 'SwimCast reads the list of shows you follow in the Podcasts app on this Mac. If you use the same Apple Account on your iPhone with iCloud sync on, it’s the same list. Nothing is changed in Apple Podcasts.'),
      btn, out);
  }

  function paneShortcut() {
    const ta = h('textarea', { class: 'input', placeholder: 'Paste the list from your iPhone here — feed URLs (one per line), Apple Podcasts links, or OPML.' });
    const go = h('button', { class: 'btn btn-primary' }, 'Find podcasts');
    const out = h('div');
    go.addEventListener('click', async () => {
      if (!ta.value.trim()) return ta.focus();
      go.disabled = true;
      const cands = await guard(() => api.importer.parseText(ta.value));
      go.disabled = false;
      if (!cands) return;
      if (!cands.length) out.replaceChildren(h('div', { class: 'notice' }, icon('alert'), 'No podcast feed addresses found in that text.'));
      else showCandidates(cands, 'apple-shortcut');
    });
    return h('div', null,
      h('div', { class: 'howto' },
        h('b', null, 'One-time setup on your iPhone (about 1 minute):'),
        h('ol', null,
          h('li', null, 'Open the ', h('b', null, 'Shortcuts'), ' app and tap ', h('b', null, '+'), ' to create a new shortcut.'),
          h('li', null, 'Add the action ', h('code', null, 'Get Podcasts from Library'), '.'),
          h('li', null, 'Add ', h('code', null, 'Get Details of Podcasts'), ' and set it to ', h('b', null, 'Feed URL'), '.'),
          h('li', null, 'Add ', h('code', null, 'Combine Text'), ' and set it to ', h('b', null, 'New Lines'), '.'),
          h('li', null, 'Add ', h('code', null, 'Share'), ' (or ', h('code', null, 'Copy to Clipboard'), ' if you use a Mac) and name it “Export podcasts”.')),
        h('div', { class: 'small muted', style: null }, 'Run it, send the list to yourself (email, WhatsApp, iCloud Drive…), then paste it below. Apple Podcasts links (podcasts.apple.com/…) work too.')),
      h('div', { class: 'field' }, ta),
      h('div', { class: 'row' }, go, h('button', { class: 'btn btn-secondary', onclick: async () => { const t = await guard(() => api.importer.openFile()); if (t) ta.value = t; } }, icon('file'), 'Open a file instead')),
      out);
  }

  function paneBackup() {
    const out = h('div', { class: 'list' }, h('div', { class: 'center' }, h('span', { class: 'spinner' })));
    const msg = h('div');
    const renderList = (backups) => {
      if (!backups.length) {
        out.replaceChildren(h('div', { class: 'center' }, 'No iPhone backups found on this computer yet.'));
        return;
      }
      out.replaceChildren(...backups.map((b) => {
        const btn = h('button', { class: 'btn btn-primary btn-sm' }, 'Read podcasts');
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }));
          try { showCandidates(await api.importer.fromBackup(b.dir), 'apple-backup'); }
          catch (e) { btn.disabled = false; btn.replaceChildren('Read podcasts'); msg.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('div', null, e.message))); }
        });
        return h('div', { class: 'list-item' }, h('div', { class: 'art art-fallback' }, icon('phone')),
          h('div', { class: 'grow' }, h('div', { class: 't' }, b.name), h('div', { class: 's' }, [b.product, b.date ? `Backed up ${ago(b.date)}` : ''].filter(Boolean).join(' · '))), btn);
      }));
    };
    guard(() => api.importer.listBackups()).then((b) => renderList(b || []));
    const appName = state.platform === 'darwin' ? 'Finder (click your iPhone in the sidebar)' : 'the Apple Devices app (or iTunes)';
    return h('div', null,
      h('div', { class: 'howto' },
        h('b', null, 'Read your shows from a cable backup:'),
        h('ol', null,
          h('li', null, 'Connect your iPhone with a cable and open ', appName, '.'),
          h('li', null, 'Make sure ', h('b', null, 'Encrypt local backup'), ' is off, then choose ', h('b', null, 'Back Up Now'), '.'),
          h('li', null, 'When it finishes, pick the backup below.')),
        h('div', { class: 'small muted' }, 'Backups can take a while and use several GB. The iPhone Shortcut is usually quicker.')),
      msg, out,
      h('div', { class: 'row', style: null }, h('button', { class: 'btn btn-ghost', onclick: async () => { const b = await guard(() => api.importer.chooseBackup()); if (b) renderList(b); } }, icon('folder'), 'Backup is somewhere else…')));
  }

  function paneFile() {
    const out = h('div');
    const btn = h('button', { class: 'btn btn-primary' }, icon('file'), 'Choose OPML or text file');
    btn.addEventListener('click', async () => {
      const text = await guard(() => api.importer.openFile());
      if (!text) return;
      const cands = await guard(() => api.importer.parseText(text));
      if (cands && cands.length) showCandidates(cands, 'opml');
      else if (cands) out.replaceChildren(h('div', { class: 'notice' }, icon('alert'), 'No podcast feeds found in that file.'));
    });
    return h('div', null, h('div', { class: 'howto' }, 'Most podcast apps (Overcast, Pocket Casts, Castro…) can export an OPML file of your subscriptions. A plain text file with one feed address per line works too.'), btn, out);
  }

  function showCandidates(cands, source) {
    const fresh = cands.filter((c) => !c.alreadyAdded);
    const chosen = new Set(fresh.map((c) => c.feedUrl));
    const countBtn = h('button', { class: 'btn btn-primary' });
    const updateBtn = () => { countBtn.textContent = `Add ${chosen.size} podcast${chosen.size === 1 ? '' : 's'}`; countBtn.disabled = !chosen.size; };
    const list = h('div', { class: 'list' }, ...cands.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: !c.alreadyAdded, disabled: c.alreadyAdded });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(c.feedUrl); else chosen.delete(c.feedUrl); updateBtn(); });
      return h('label', { class: `list-item${c.alreadyAdded ? ' dim' : ''}` }, cb, artwork(c.artwork, c.title || c.feedUrl),
        h('div', { class: 'grow' }, h('div', { class: 't' }, c.title || c.feedUrl), h('div', { class: 's' }, c.alreadyAdded ? 'Already in SwimCast' : (c.author || c.feedUrl))));
    }));
    updateBtn();
    const progress = h('div', { class: 'grow muted small' }, `${cands.length} found${cands.length - fresh.length ? ` · ${cands.length - fresh.length} already added` : ''}`);
    countBtn.addEventListener('click', async () => {
      countBtn.disabled = true;
      const picked = cands.filter((c) => chosen.has(c.feedUrl)).map((c) => ({ ...c, source }));
      const off = api.on('import:progress', (p) => { progress.textContent = `Adding ${p.done} of ${p.total}…`; });
      const results = await guard(() => api.podcasts.addMany(picked));
      off();
      await reloadPodcasts();
      if (!results) { countBtn.disabled = false; return; }
      const ok = results.filter((r) => r.ok && !r.existed).length;
      const failed = results.filter((r) => !r.ok);
      if (!failed.length) {
        closeModal();
        toast(`Added ${ok} podcast${ok === 1 ? '' : 's'}`);
        if (state.view.type === 'welcome' && state.podcasts[0]) openPodcast(state.podcasts[0].id);
        return;
      }
      body.replaceChildren(
        h('div', { class: 'notice info' }, icon('check'), `Added ${ok}. ${failed.length} couldn’t be loaded:`),
        h('div', { class: 'list' }, ...failed.map((f) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('div', { class: 't' }, f.title || f.feedUrl), h('div', { class: 's' }, f.error))))));
      getFoot().replaceChildren(h('div', { class: 'grow' }), h('button', { class: 'btn btn-primary', onclick: closeModal }, 'Done'));
    });
    body.replaceChildren(tabBar, h('p', { class: 'muted' }, 'Choose which shows to add to SwimCast:'), list);
    getFoot().replaceChildren(progress, h('button', { class: 'btn btn-secondary', onclick: () => draw() }, 'Back'), countBtn);
  }
}

// ---------------------------------------------------------------- copy to headphones
async function openDevice() {
  const items = await guard(() => api.downloads.listDownloaded()) || [];
  const chosen = new Set(items.filter((i) => !i.copied).map((i) => i.episodeId));
  const destBox = h('div', { class: 'dest' });
  const summary = h('div', { class: 'grow muted small' });
  const copyBtn = h('button', { class: 'btn btn-primary' }, icon('headphones'), 'Copy');
  const opts = { numberPrefix: state.settings.numberPrefix !== false, perPodcastFolder: !!state.settings.perPodcastFolder };
  let free = null;

  const drawDest = async () => {
    const dir = state.settings.sdCardDir;
    free = dir ? await api.device.freeSpace(dir).catch(() => null) : null;
    destBox.replaceChildren(h('div', { class: 'ico' }, icon('sd')),
      h('div', { class: 'grow' },
        h('div', { class: 'path' }, dir || 'Headphones not chosen yet'),
        h('div', { class: 'muted small' }, dir ? (free != null ? `${fmtBytes(free)} free` : 'Not connected?') : 'Connect your swim headphones by USB — they show up as a drive. Then choose it here.')),
      h('button', { class: 'btn btn-secondary', onclick: async () => {
        const d = await guard(() => api.settings.chooseFolder('sdcard'));
        if (d) { state.settings.sdCardDir = d; drawDest(); }
      } }, dir ? 'Change…' : 'Choose…'));
    updateSummary();
  };

  const updateSummary = () => {
    const sel = items.filter((i) => chosen.has(i.episodeId));
    const bytes = sel.reduce((s, i) => s + (i.size || 0), 0);
    const dur = sel.reduce((s, i) => s + (i.duration || 0), 0);
    summary.textContent = `${sel.length} episode${sel.length === 1 ? '' : 's'} · ${fmtBytes(bytes) || '0 MB'}${dur ? ` · ${fmtDuration(dur)} of listening` : ''}${free != null && bytes > free ? ' — not enough space!' : ''}`;
    copyBtn.disabled = !sel.length || !state.settings.sdCardDir || (free != null && bytes > free);
  };

  const check = (key, label, hint) => {
    const cb = h('input', { type: 'checkbox', checked: opts[key] });
    cb.addEventListener('change', () => { opts[key] = cb.checked; api.settings.set({ [key]: cb.checked }); state.settings[key] = cb.checked; });
    return h('label', { class: 'check' }, cb, h('span', null, label, h('small', null, hint)));
  };

  const groups = new Map();
  for (const it of items) { if (!groups.has(it.podcastTitle)) groups.set(it.podcastTitle, []); groups.get(it.podcastTitle).push(it); }
  const list = h('div', { class: 'list' });
  if (!items.length) list.append(h('div', { class: 'center' }, 'No downloaded episodes yet.'));
  for (const [title, eps] of groups) {
    list.append(h('div', { class: 'group-h' }, h('span', null, title), h('span', null, `${eps.length}`)));
    for (const it of eps) {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(it.episodeId) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(it.episodeId); else chosen.delete(it.episodeId); updateSummary(); });
      list.append(h('label', { class: 'list-item' }, cb,
        h('div', { class: 'grow' }, h('div', { class: 't' }, it.title), h('div', { class: 's' }, [fmtDate(it.pubDate), fmtDuration(it.duration), fmtBytes(it.size)].filter(Boolean).join(' · '))),
        it.copied ? h('span', { class: 'badge' }, 'Copied before') : null));
    }
  }

  copyBtn.addEventListener('click', async () => {
    copyBtn.disabled = true;
    const bar = h('div', { class: 'bar' }, h('i'));
    summary.replaceChildren(h('div', null, 'Copying…'), bar);
    const off = api.on('device:progress', (p) => {
      bar.firstChild.style.width = `${p.totalBytes ? Math.round((p.doneBytes / p.totalBytes) * 100) : 0}%`;
      summary.firstChild.textContent = `Copying ${p.index} of ${p.count}…`;
    });
    const res = await guard(() => api.device.copy([...chosen], opts));
    off();
    if (!res) { updateSummary(); return; }
    closeModal();
    await reloadPodcasts();
    if (state.view.type === 'podcast') { state.episodes = await api.podcasts.episodes(state.view.id); renderEpisodeList(); }
    toast(`Copied ${res.copied} episode${res.copied === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} were already there)` : ''}. Safely eject the headphones before unplugging.`, 'ok', 8000);
  });

  openModal('Copy to swim headphones', [
    destBox,
    check('numberPrefix', 'Number the files (001, 002…)', 'Keeps episodes in order on players that sort by file name. Files are always copied oldest first.'),
    check('perPodcastFolder', 'One folder per podcast', 'Turn off if your headphones only play files in the main folder.'),
    h('div', { class: 'divider' }, 'episodes'),
    list,
  ], [summary, h('button', { class: 'btn btn-secondary', onclick: closeModal }, 'Cancel'), copyBtn], { wide: true });
  modalCleanup = () => api.device.cancel();
  drawDest();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  const s = state.settings;
  const dlPath = h('div', { class: 'path' }, s.downloadDir);
  const toggle = (key, label, hint, disabled) => {
    const cb = h('input', { type: 'checkbox', checked: s[key] !== false, disabled });
    cb.addEventListener('change', async () => { state.settings = await api.settings.set({ [key]: cb.checked }); });
    return h('label', { class: 'check' }, cb, h('span', null, label, h('small', null, hint)));
  };
  openModal('Settings', [
    h('div', { class: 'field' }, h('label', null, 'Save episodes to'),
      h('div', { class: 'dest' }, h('div', { class: 'ico' }, icon('folder')), h('div', { class: 'grow' }, dlPath, h('div', { class: 'muted small' }, 'Each podcast gets its own folder. Files are named “date - title.mp3”.')),
        h('button', { class: 'btn btn-secondary', onclick: async () => { const d = await guard(() => api.settings.chooseFolder('download')); if (d) { state.settings.downloadDir = d; dlPath.textContent = d; } } }, 'Change…'),
        h('button', { class: 'btn btn-ghost', onclick: () => api.shell.openFolder() }, 'Open'))),
    toggle('convertToMp3', 'Convert non-MP3 episodes to MP3', state.canConvert ? 'A few shows publish AAC/M4A audio. SwimCast converts them so every swim player can play them.' : 'Converter not available in this build.', !state.canConvert),
    toggle('refreshOnStart', 'Check for new episodes when SwimCast opens', 'Refreshes all your podcasts in the background.'),
    h('div', { class: 'divider' }, 'subscriptions'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-secondary', onclick: async () => { const p = await guard(() => api.importer.exportOpml()); if (p) toast('Exported subscriptions'); } }, icon('file'), 'Export OPML'),
      h('button', { class: 'btn btn-secondary', onclick: () => { closeModal(); refreshAll(true); } }, icon('refresh'), 'Refresh all now')),
    h('p', { class: 'muted small' }, `SwimCast ${state.version || ''}`),
  ], [h('button', { class: 'btn btn-primary', onclick: closeModal }, 'Done')]);
}

async function refreshAll(loud) {
  if (!state.podcasts.length) return;
  const r = await guard(() => api.podcasts.refreshAll());
  await reloadPodcasts();
  if (state.view.type === 'podcast') {
    state.episodes = await api.podcasts.episodes(state.view.id);
    renderEpisodeList();
  }
  if (r && (loud || r.newEpisodes)) toast(r.newEpisodes ? `${r.newEpisodes} new episode${r.newEpisodes > 1 ? 's' : ''}` : 'All podcasts are up to date');
}

// ---------------------------------------------------------------- events & boot
let reloadTimer = null;
api.on('downloads:update', async (s) => {
  state.dl.set(s.episodeId, s);
  renderDlStatus();
  const ep = state.episodes.find((e) => e.id === s.episodeId);
  if (s.state === 'done') {
    if (ep) ep.downloaded = { path: s.path, size: s.received };
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadPodcasts, 400);
  }
  if (s.state === 'error') toast(`Download failed: ${s.title} — ${s.error}`, 'error', 7000);
  if (ep) { const el = rowActions.get(ep.id); if (el) renderAction(ep, el); }
  if (s.state === 'done' || s.state === 'canceled') state.dl.delete(s.episodeId);
  if (['done', 'canceled'].includes(s.state)) renderDlStatus();
});

document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });
$('#btn-add').addEventListener('click', () => openAdd());
$('#btn-import').addEventListener('click', () => openImport());
$('#btn-device').addEventListener('click', () => openDevice());
$('#btn-settings').addEventListener('click', () => openSettings());
$('#nav-downloads').addEventListener('click', () => renderDownloads());
$('#sub-filter').addEventListener('input', (e) => { state.subFilter = e.target.value; renderSidebar(); });

(async function boot() {
  const init = await api.init();
  Object.assign(state, { platform: init.platform, podcasts: init.podcasts, settings: init.settings, canConvert: init.canConvert, version: init.version });
  document.body.classList.add(`platform-${init.platform}`);
  for (const s of init.downloads) state.dl.set(s.episodeId, s);
  if (state.podcasts.length) openPodcast(state.podcasts[0].id); else renderWelcome();
  renderDlStatus();
  if (state.settings.refreshOnStart !== false) refreshAll(false);
}());
