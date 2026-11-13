'use strict';
const { fetchFeed, normalizeFeedUrl } = require('./feeds');
const { hashId, mapLimit } = require('./util');

/** Podcast library operations, independent of Electron (so they can be unit-tested). */
class Library {
  constructor(store) { this.store = store; }

  listPodcasts() {
    return this.store.podcasts.map((p) => this._withCounts(p));
  }

  _withCounts(p) {
    const eps = this.store.getEpisodes(p.id);
    let downloaded = 0;
    for (const e of eps) if (this.store.data.downloads[e.id]) downloaded++;
    return { ...p, episodeCount: eps.length, downloadedCount: downloaded, latest: eps[0]?.pubDate || null };
  }

  episodes(podcastId) {
    return this.store.getEpisodes(podcastId).map((e) => {
      const d = this.store.getDownload(e.id);
      return { ...e, downloaded: d ? { path: d.path, size: d.size } : null, copied: !!this.store.data.copied[e.id] };
    });
  }

  /** Newest episodes across every show (each feed is stored newest-first, so its head is enough). */
  recentEpisodes(limit = 200) {
    const pool = [];
    for (const p of this.store.podcasts) {
      for (const e of this.store.getEpisodes(p.id).slice(0, 30)) pool.push({ e, p });
    }
    pool.sort((a, b) => (b.e.pubDate || '').localeCompare(a.e.pubDate || ''));
    return pool.slice(0, limit).map(({ e, p }) => {
      const d = this.store.getDownload(e.id);
      return {
        ...e,
        podcastId: p.id,
        podcastTitle: p.title,
        podcastArtwork: p.artwork,
        downloaded: d ? { path: d.path, size: d.size } : null,
        copied: !!this.store.data.copied[e.id],
      };
    });
  }

  /** Subscribe to a feed (only inside this app). Returns the podcast. */
  async addFeed(feedUrl, hint = {}) {
    const url = normalizeFeedUrl(feedUrl);
    const existing = this.store.findByFeed(url);
    if (existing) return { podcast: this._withCounts(existing), existed: true };
    const { podcast, episodes } = await fetchFeed(url);
    const id = hashId(url.toLowerCase());
    const p = this.store.upsertPodcast({
      id,
      feedUrl: url,
      title: podcast.title || hint.title || url,
      author: podcast.author || hint.author || '',
      description: podcast.description,
      artwork: podcast.artwork || hint.artwork || '',
      link: podcast.link,
      source: hint.source || 'manual',
      addedAt: new Date().toISOString(),
      lastRefreshed: new Date().toISOString(),
      lastError: null,
    });
    this.store.setEpisodes(id, episodes);
    return { podcast: this._withCounts(p), existed: false };
  }

  async addMany(candidates, onProgress = () => {}) {
    let done = 0;
    const results = await mapLimit(candidates, 4, async (c) => {
      try { return await this.addFeed(c.feedUrl, c); }
      finally { onProgress({ done: ++done, total: candidates.length, title: c.title || c.feedUrl }); }
    });
    return results.map((r, i) => ({
      feedUrl: candidates[i].feedUrl,
      title: r.ok ? r.value.podcast.title : candidates[i].title,
      ok: r.ok,
      existed: r.ok ? r.value.existed : false,
      error: r.ok ? null : String(r.error.message || r.error),
    }));
  }

  async refresh(podcastId) {
    const p = this.store.getPodcast(podcastId);
    if (!p) throw new Error('Podcast not found');
    try {
      const { podcast, episodes } = await fetchFeed(p.feedUrl);
      const old = new Map(this.store.getEpisodes(p.id).map((e) => [e.id, e]));
      const newCount = episodes.filter((e) => !old.has(e.id)).length;
      this.store.setEpisodes(p.id, episodes);
      this.store.upsertPodcast({
        id: p.id,
        title: podcast.title || p.title,
        author: podcast.author || p.author,
        description: podcast.description || p.description,
        artwork: podcast.artwork || p.artwork,
        link: podcast.link || p.link,
        lastRefreshed: new Date().toISOString(),
        lastError: null,
      });
      return { podcast: this._withCounts(this.store.getPodcast(p.id)), newCount };
    } catch (e) {
      this.store.upsertPodcast({ id: p.id, lastError: String(e.message || e) });
      throw e;
    }
  }

  async refreshAll(onProgress = () => {}) {
    const list = [...this.store.podcasts];
    let done = 0;
    const results = await mapLimit(list, 4, async (p) => {
      try { return await this.refresh(p.id); }
      finally { onProgress({ done: ++done, total: list.length }); }
    });
    return {
      newEpisodes: results.reduce((s, r) => s + (r.ok ? r.value.newCount : 0), 0),
      failed: results.filter((r) => !r.ok).length,
    };
  }

  remove(podcastId) { this.store.removePodcast(podcastId); }

  /** Mark which candidates are already subscribed, for the import screen. */
  annotate(candidates) {
    return candidates.map((c) => ({ ...c, alreadyAdded: !!this.store.findByFeed(c.feedUrl) }));
  }
}

module.exports = { Library };
