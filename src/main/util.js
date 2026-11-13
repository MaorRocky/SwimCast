'use strict';
const crypto = require('node:crypto');

/** Short, stable id derived from a string (feed URL, episode guid...). */
function hashId(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 16);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®',
  trade: '™', bull: '•', middot: '·', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó',
  uacute: 'ú', iacute: 'í', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; }
    }
    const v = NAMED_ENTITIES[code.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** Turn an HTML show-notes blob into readable plain text. */
function htmlToText(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '').replace(/[ \t\f\v ]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** itunes:duration can be "3600", "1:02:03", "62:03" — return seconds or null. */
function parseDuration(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Make a string safe as a file/folder name on Windows, macOS and FAT32 SD cards.
 */
function safeFileName(name, maxLen = 120) {
  let s = String(name || 'Untitled')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'Untitled';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/g, '');
  return s;
}

function isoDate(d) {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toISOString().slice(0, 10);
}

const MIME_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpeg3': 'mp3', 'audio/x-mpeg': 'mp3',
  'audio/x-mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
  'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'video/mp4': 'mp4',
  'video/x-m4v': 'm4v', 'audio/x-m4b': 'm4b',
};

/** Best guess at the file extension of an enclosure. */
function audioExt(url, mime) {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  try {
    const p = new URL(url).pathname.toLowerCase();
    const mm = p.match(/\.(mp3|m4a|m4b|aac|ogg|opus|wav|flac|mp4|m4v)$/);
    if (mm) return mm[1];
  } catch { /* ignore */ }
  return MIME_EXT[m] || 'mp3';
}

function formatBytes(n) {
  if (!n || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Run async fn over items with limited concurrency, preserving result order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (err) { results[i] = { ok: false, error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  hashId, decodeEntities, htmlToText, parseDuration, safeFileName, isoDate, audioExt,
  formatBytes, mapLimit,
};
