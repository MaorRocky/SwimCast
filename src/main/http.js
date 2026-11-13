'use strict';
// Use Chromium's network stack inside Electron (respects system proxy & certificates),
// fall back to Node's fetch when running tests outside Electron.
let impl = null;

function getFetch() {
  if (impl) return impl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      impl = (url, opts) => electron.net.fetch(url, opts);
      return impl;
    }
  } catch { /* not in electron */ }
  impl = (url, opts) => fetch(url, opts);
  return impl;
}

function setFetch(fn) { impl = fn; }

const USER_AGENT = 'SwimCast/1.0 (desktop podcast downloader)';

async function fetchText(url, { timeoutMs = 30000 } = {}) {
  const res = await getFetch()(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { text: await res.text(), finalUrl: res.url || url };
}

async function fetchJson(url, opts) {
  const { text } = await fetchText(url, opts);
  return JSON.parse(text);
}

module.exports = { getFetch, setFetch, fetchText, fetchJson, USER_AGENT };
