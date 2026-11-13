'use strict';
// Apple's public iTunes Search API — no account or key needed.
const { fetchJson } = require('./http');

function mapResult(r) {
  return {
    appleId: String(r.collectionId || r.trackId || ''),
    title: r.collectionName || r.trackName || '',
    author: r.artistName || '',
    feedUrl: r.feedUrl || '',
    artwork: r.artworkUrl600 || r.artworkUrl100 || '',
    genre: r.primaryGenreName || '',
    episodeCount: r.trackCount || 0,
  };
}

async function searchPodcasts(term, { country } = {}) {
  const q = String(term || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({ media: 'podcast', entity: 'podcast', term: q, limit: '30' });
  if (country) params.set('country', country);
  const data = await fetchJson(`https://itunes.apple.com/search?${params}`);
  return (data.results || []).map(mapResult).filter((r) => r.feedUrl);
}

/** Resolve Apple Podcasts show ids (from podcasts.apple.com links) to RSS feeds. */
async function lookupAppleIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await fetchJson(`https://itunes.apple.com/lookup?entity=podcast&id=${chunk.join(',')}`);
    out.push(...(data.results || []).map(mapResult).filter((r) => r.feedUrl));
  }
  return out;
}

module.exports = { searchPodcasts, lookupAppleIds };
