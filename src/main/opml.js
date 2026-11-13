'use strict';
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'outline',
});

/** Parse an OPML document into [{ title, feedUrl }]. */
function parseOpml(xml) {
  const doc = parser.parse(xml);
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const url = n.xmlUrl || n.xmlurl || n.url;
      if (url && /^https?:|^feed:/i.test(url)) out.push({ title: n.title || n.text || '', feedUrl: url.trim() });
      if (n.outline) walk(n.outline);
    }
  };
  walk(doc?.opml?.body?.outline);
  return dedupe(out);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildOpml(podcasts) {
  const lines = podcasts.map((p) => `    <outline type="rss" text="${esc(p.title)}" title="${esc(p.title)}" xmlUrl="${esc(p.feedUrl)}"${p.link ? ` htmlUrl="${esc(p.link)}"` : ''}/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>SwimCast subscriptions</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = i.feedUrl.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const APPLE_ID_RE = /podcasts\.apple\.com\/[^\s"'<>]*?\/id(\d+)|itunes\.apple\.com\/[^\s"'<>]*?\/id(\d+)/i;

/**
 * Parse whatever the user pasted or opened: an OPML file, a list of feed URLs (one per line,
 * optionally "Name<TAB/|>URL"), or Apple Podcasts show links. Returns
 * { feeds: [{title, feedUrl}], appleIds: [string] }.
 */
function parseSubscriptionText(text) {
  const t = String(text || '');
  if (/<opml[\s>]/i.test(t)) return { feeds: parseOpml(t), appleIds: [] };
  const feeds = [];
  const appleIds = [];
  for (const rawLine of t.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const apple = line.match(APPLE_ID_RE);
    if (apple) { appleIds.push(apple[1] || apple[2]); continue; }
    const urls = line.match(/(?:https?|feed):\/\/[^\s"'<>]+/gi);
    if (!urls) continue;
    for (const url of urls) {
      const before = line.slice(0, line.indexOf(url)).replace(/[\s|,;:\t-]+$/, '').trim();
      feeds.push({ title: urls.length === 1 ? before : '', feedUrl: url.replace(/[),.;]+$/, '') });
    }
  }
  return { feeds: dedupe(feeds), appleIds: [...new Set(appleIds)] };
}

module.exports = { parseOpml, buildOpml, parseSubscriptionText };
