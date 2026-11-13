'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Tiny JSON-file store: library.json (podcasts, downloads, settings) + feeds/<id>.json per show. */
class Store {
  constructor(dir, defaults = {}) {
    this.dir = dir;
    this.feedDir = path.join(dir, 'feeds');
    fs.mkdirSync(this.feedDir, { recursive: true });
    this.file = path.join(dir, 'library.json');
    this.data = { podcasts: [], downloads: {}, copied: {}, settings: { ...defaults } };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...defaults, ...(raw.settings || {}) } };
    } catch { /* first run */ }
    this._timer = null;
    this._episodeCache = new Map();
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this._timer);
    writeAtomic(this.file, JSON.stringify(this.data, null, 1));
  }

  get settings() { return this.data.settings; }
  setSettings(patch) { Object.assign(this.data.settings, patch); this.save(); return this.data.settings; }

  get podcasts() { return this.data.podcasts; }
  getPodcast(id) { return this.data.podcasts.find((p) => p.id === id); }
  findByFeed(url) {
    const u = String(url).toLowerCase().replace(/\/$/, '');
    return this.data.podcasts.find((p) => p.feedUrl.toLowerCase().replace(/\/$/, '') === u);
  }

  upsertPodcast(p) {
    const i = this.data.podcasts.findIndex((x) => x.id === p.id);
    if (i >= 0) this.data.podcasts[i] = { ...this.data.podcasts[i], ...p };
    else this.data.podcasts.push(p);
    this.data.podcasts.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    this.save();
    return this.getPodcast(p.id);
  }

  removePodcast(id) {
    this.data.podcasts = this.data.podcasts.filter((p) => p.id !== id);
    this._episodeCache.delete(id);
    fsp.rm(path.join(this.feedDir, `${id}.json`), { force: true }).catch(() => {});
    this.save();
  }

  getEpisodes(id) {
    if (this._episodeCache.has(id)) return this._episodeCache.get(id);
    let eps = [];
    try { eps = JSON.parse(fs.readFileSync(path.join(this.feedDir, `${id}.json`), 'utf8')); } catch { /* none yet */ }
    this._episodeCache.set(id, eps);
    return eps;
  }

  setEpisodes(id, episodes) {
    this._episodeCache.set(id, episodes);
    writeAtomic(path.join(this.feedDir, `${id}.json`), JSON.stringify(episodes));
  }

  findEpisode(episodeId) {
    for (const p of this.data.podcasts) {
      const ep = this.getEpisodes(p.id).find((e) => e.id === episodeId);
      if (ep) return { podcast: p, episode: ep };
    }
    return null;
  }

  /** downloads[episodeId] = { podcastId, path, size, at } — dropped if the file was deleted. */
  getDownload(episodeId) {
    const d = this.data.downloads[episodeId];
    if (d && !fs.existsSync(d.path)) { delete this.data.downloads[episodeId]; this.save(); return null; }
    return d || null;
  }
  setDownload(episodeId, rec) { this.data.downloads[episodeId] = rec; this.save(); }

  markCopied(episodeId, dest) { this.data.copied[episodeId] = { dest, at: new Date().toISOString() }; this.save(); }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

module.exports = { Store };
