'use strict';
const { XMLParser } = require('fast-xml-parser');
const { hashId, htmlToText, parseDuration } = require('./util');
const { fetchText } = require('./http');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['item', 'entry'].includes(name),
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const first = (x) => (Array.isArray(x) ? x[0] : x);

/** Extract a plain string from a parsed node (text, {#text}, or array of them). */
function str(node) {
  const n = first(node);
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n).trim();
  if (typeof n === 'object' && n['#text'] != null) return String(n['#text']).trim();
  return '';
}

function attr(node, name) {
  for (const n of arr(node)) {
    if (n && typeof n === 'object' && n[`@_${name}`]) return String(n[`@_${name}`]).trim();
  }
  return '';
}

function pickImage(node) {
  return attr(node['itunes:image'], 'href')
    || str(first(node.image)?.url)
    || attr(node['media:thumbnail'], 'url')
    || attr(node['googleplay:image'], 'href')
    || '';
}

function toIso(d) {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function pickEnclosure(item) {
  const encs = arr(item.enclosure).filter((e) => e && e['@_url']);
  const audio = encs.find((e) => /^audio\//i.test(e['@_type'] || '')) || encs[0];
  if (audio) {
    return { url: audio['@_url'].trim(), type: audio['@_type'] || '', size: Number(audio['@_length']) || 0 };
  }
  // Some feeds only use media:content
  for (const m of arr(item['media:content'])) {
    if (m && m['@_url'] && /audio|video/i.test(m['@_type'] || m['@_medium'] || 'audio')) {
      return { url: m['@_url'].trim(), type: m['@_type'] || '', size: Number(m['@_fileSize']) || 0 };
    }
  }
  return null;
}

/** Parse RSS XML into { podcast, episodes }. Throws on non-podcast XML. */
function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xml);
  const channel = first(doc?.rss?.channel) || first(doc?.['rdf:RDF']?.channel);
  if (!channel) {
    if (doc?.feed) throw new Error('This is an Atom feed; podcast RSS feeds are required.');
    throw new Error('That address did not return a podcast RSS feed.');
  }
  const rawItems = arr(channel.item || doc?.['rdf:RDF']?.item);

  const podcast = {
    feedUrl,
    title: htmlToText(str(channel.title)) || feedUrl,
    author: htmlToText(str(channel['itunes:author']) || str(channel['managingEditor']) || str(channel['itunes:owner']?.['itunes:name'])),
    description: htmlToText(str(channel['itunes:summary']) || str(channel.description)).slice(0, 4000),
    artwork: pickImage(channel),
    link: str(channel.link) || attr(channel.link, 'href'),
    newFeedUrl: str(channel['itunes:new-feed-url']) || '',
  };

  const episodes = [];
  for (const item of rawItems) {
    const enc = pickEnclosure(item);
    if (!enc) continue; // not downloadable
    const guid = str(item.guid) || enc.url;
    const rawDesc = str(item['content:encoded']) || str(item.description) || str(item['itunes:summary']) || str(item['itunes:subtitle']);
    episodes.push({
      id: hashId(`${feedUrl}|${guid}`),
      guid,
      title: htmlToText(str(item.title) || str(item['itunes:title'])) || 'Untitled episode',
      pubDate: toIso(str(item.pubDate) || str(item['dc:date'])),
      duration: parseDuration(str(item['itunes:duration'])),
      description: htmlToText(rawDesc).slice(0, 6000),
      subtitle: htmlToText(str(item['itunes:subtitle'])).slice(0, 300),
      url: enc.url,
      type: enc.type,
      size: enc.size,
      episodeNumber: str(item['itunes:episode']) || '',
      season: str(item['itunes:season']) || '',
      episodeType: str(item['itunes:episodeType']) || '',
      image: attr(item['itunes:image'], 'href') || '',
      link: str(item.link),
    });
  }
  episodes.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  return { podcast, episodes };
}

/** Accept feed URLs as typed by humans (feed://, missing scheme, pcast://, itpc://). */
function normalizeFeedUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Please enter a feed address.');
  u = u.replace(/^(feed|pcast|itpc|podcast):\/\//i, 'https://').replace(/^feed:/i, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u); // throws if invalid
  return parsed.toString();
}

async function fetchFeed(feedUrl) {
  const url = normalizeFeedUrl(feedUrl);
  const { text } = await fetchText(url);
  return parseFeed(text, url);
}

module.exports = { parseFeed, fetchFeed, normalizeFeedUrl };
