'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { getFetch, USER_AGENT } = require('./http');
const { safeFileName, isoDate, audioExt } = require('./util');

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (!p) return null;
    p = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** Where an episode will be saved. */
function targetPath(downloadDir, podcast, episode, ext) {
  const folder = path.join(downloadDir, safeFileName(podcast.title, 80));
  const date = isoDate(episode.pubDate);
  const base = safeFileName(`${date ? `${date} - ` : ''}${episode.title}`, 140);
  return { folder, file: path.join(folder, `${base}.${ext}`) };
}

class DownloadManager extends EventEmitter {
  constructor(store, { concurrency = 3 } = {}) {
    super();
    this.store = store;
    this.concurrency = concurrency;
    this.queue = [];
    this.active = new Map(); // episodeId -> { controller, state }
    this.status = new Map(); // episodeId -> latest public status
  }

  _emit(s) {
    this.status.set(s.episodeId, s);
    this.emit('update', s);
  }

  snapshot() { return [...this.status.values()].filter((s) => s.state !== 'done'); }

  enqueue(episodeIds) {
    let added = 0;
    for (const id of episodeIds) {
      if (this.active.has(id) || this.queue.includes(id)) continue;
      if (this.store.getDownload(id)) continue;
      const found = this.store.findEpisode(id);
      if (!found) continue;
      this.queue.push(id);
      added++;
      this._emit({ episodeId: id, podcastId: found.podcast.id, title: found.episode.title, state: 'queued', received: 0, total: found.episode.size || 0 });
    }
    this._pump();
    return added;
  }

  cancel(episodeId) {
    const qi = this.queue.indexOf(episodeId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const s = this.status.get(episodeId) || { episodeId };
      this._emit({ ...s, state: 'canceled' });
      return;
    }
    const job = this.active.get(episodeId);
    if (job) job.controller.abort();
  }

  _pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const controller = new AbortController();
      this.active.set(id, { controller });
      this._run(id, controller.signal)
        .catch(() => {})
        .finally(() => { this.active.delete(id); this._pump(); if (!this.active.size && !this.queue.length) this.emit('idle'); });
    }
  }

  async _run(episodeId, signal) {
    const found = this.store.findEpisode(episodeId);
    if (!found) return;
    const { podcast, episode } = found;
    const settings = this.store.settings;
    const base = { episodeId, podcastId: podcast.id, title: episode.title };
    const srcExt = audioExt(episode.url, episode.type);
    const ff = ffmpegPath();
    const convert = srcExt !== 'mp3' && settings.convertToMp3 !== false && !!ff;
    const finalExt = convert ? 'mp3' : srcExt;
    const { folder, file } = targetPath(settings.downloadDir, podcast, episode, finalExt);
    const partFile = `${file}.part`;
    const rawFile = convert ? `${file}.src.${srcExt}` : partFile;

    try {
      await fsp.mkdir(folder, { recursive: true });
      if (fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        this.store.setDownload(episodeId, { podcastId: podcast.id, path: file, size, at: new Date().toISOString() });
        this._emit({ ...base, state: 'done', received: size, total: size, path: file });
        return;
      }
      this._emit({ ...base, state: 'downloading', received: 0, total: episode.size || 0 });
      const res = await getFetch()(episode.url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal });
      if (!res.ok || !res.body) throw new Error(`Server replied ${res.status}`);
      const total = Number(res.headers.get('content-length')) || episode.size || 0;
      let received = 0;
      let lastEmit = 0;
      const counter = new Transform({
        transform: (chunk, _enc, cb) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 200) { lastEmit = now; this._emit({ ...base, state: 'downloading', received, total }); }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(rawFile), { signal });

      if (convert) {
        this._emit({ ...base, state: 'converting', received, total });
        await this._convert(ff, rawFile, partFile, podcast, episode, signal);
        await fsp.rm(rawFile, { force: true });
      }
      await fsp.rename(partFile, file);
      const size = fs.statSync(file).size;
      this.store.setDownload(episodeId, { podcastId: podcast.id, path: file, size, at: new Date().toISOString() });
      this._emit({ ...base, state: 'done', received: size, total: size, path: file });
    } catch (err) {
      await fsp.rm(partFile, { force: true }).catch(() => {});
      if (convert) await fsp.rm(rawFile, { force: true }).catch(() => {});
      const canceled = signal.aborted;
      this._emit({ ...base, state: canceled ? 'canceled' : 'error', error: canceled ? undefined : friendlyError(err), received: 0, total: 0 });
    }
  }

  _convert(ff, input, output, podcast, episode, signal) {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn',
        '-codec:a', 'libmp3lame', '-b:a', '128k',
        '-metadata', `title=${episode.title}`, '-metadata', `artist=${podcast.author || podcast.title}`,
        '-metadata', `album=${podcast.title}`, '-metadata', 'genre=Podcast',
        '-id3v2_version', '3', '-f', 'mp3', output,
      ];
      const p = spawn(ff, args, { windowsHide: true });
      let errText = '';
      p.stderr.on('data', (d) => { errText += d; });
      const onAbort = () => p.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      p.on('error', reject);
      p.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`MP3 conversion failed${errText ? `: ${errText.trim().split('\n').pop()}` : ''}`));
      });
    });
  }
}

function friendlyError(err) {
  const m = String(err && err.message || err);
  if (/ENOSPC/.test(m)) return 'Disk is full';
  if (/EACCES|EPERM/.test(m)) return 'No permission to write to the download folder';
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|fetch failed/i.test(m)) return 'Network error — check your connection';
  return m;
}

module.exports = { DownloadManager, targetPath, ffmpegPath };
