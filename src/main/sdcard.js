'use strict';
/**
 * Copy downloaded episodes to the swim headphones' SD card / storage.
 * Files are copied one at a time, oldest first: many MP3 players without a screen play
 * tracks in the order they were written to the card, others sort by file name — the
 * optional "001 " number prefix keeps both kinds in the same order.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { safeFileName, isoDate } = require('./util');

async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

function highestNumber(dir) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{3,4})[ ._-]/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* empty or missing */ }
  return max;
}

/**
 * items: [{ episodeId, podcast, episode, path, size }]
 * options: { destDir, perPodcastFolder, numberPrefix }
 */
async function copyToDevice(items, options, onProgress = () => {}, signal) {
  const { destDir, perPodcastFolder = false, numberPrefix = true } = options;
  if (!destDir || !fs.existsSync(destDir)) throw new Error('Choose the headphones / SD card folder first.');

  const sorted = [...items].sort((a, b) => {
    if (perPodcastFolder) {
      const c = a.podcast.title.localeCompare(b.podcast.title);
      if (c) return c;
    }
    return (a.episode.pubDate || '').localeCompare(b.episode.pubDate || '');
  });

  const totalBytes = sorted.reduce((s, i) => s + (i.size || 0), 0);
  const free = await freeSpace(destDir);
  if (free != null && free < totalBytes) {
    const e = new Error(`Not enough space on the card: need ${(totalBytes / 1e6).toFixed(0)} MB, ${(free / 1e6).toFixed(0)} MB free.`);
    e.code = 'NO_SPACE';
    throw e;
  }

  const counters = new Map();
  let doneBytes = 0;
  const result = { copied: 0, skipped: 0, bytes: 0, files: [] };

  for (let i = 0; i < sorted.length; i++) {
    if (signal && signal.aborted) break;
    const it = sorted[i];
    const folder = perPodcastFolder ? path.join(destDir, safeFileName(it.podcast.title, 60)) : destDir;
    await fsp.mkdir(folder, { recursive: true });
    if (!counters.has(folder)) counters.set(folder, highestNumber(folder));

    const ext = path.extname(it.path) || '.mp3';
    const date = isoDate(it.episode.pubDate);
    const label = perPodcastFolder
      ? `${date ? `${date} ` : ''}${it.episode.title}`
      : `${date ? `${date} ` : ''}${it.podcast.title} - ${it.episode.title}`;
    let name = safeFileName(label, 100);

    // Skip if this exact episode is already on the card (same name ignoring the number, same size).
    const existing = findExisting(folder, name, ext, it.size);
    if (existing) {
      result.skipped++;
      doneBytes += it.size || 0;
      onProgress({ index: i + 1, count: sorted.length, doneBytes, totalBytes, file: existing, skipped: true });
      continue;
    }
    if (numberPrefix) {
      const n = counters.get(folder) + 1;
      counters.set(folder, n);
      name = `${String(n).padStart(3, '0')} ${name}`;
    }
    const dest = path.join(folder, `${name}${ext}`);
    const tmp = `${dest}.part`;
    const startBytes = doneBytes;
    let copiedBytes = 0;
    const counter = new Transform({
      transform(chunk, _e, cb) {
        copiedBytes += chunk.length;
        onProgress({ index: i + 1, count: sorted.length, doneBytes: startBytes + copiedBytes, totalBytes, file: dest });
        cb(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(it.path), counter, fs.createWriteStream(tmp), signal ? { signal } : {});
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    doneBytes = startBytes + (it.size || copiedBytes);
    result.copied++;
    result.bytes += copiedBytes;
    result.files.push({ episodeId: it.episodeId, dest });
  }
  return result;
}

function findExisting(folder, name, ext, size) {
  try {
    for (const f of fs.readdirSync(folder)) {
      const stripped = f.replace(/^\d{3,4} /, '');
      if (stripped === `${name}${ext}`) {
        const full = path.join(folder, f);
        if (!size || fs.statSync(full).size === size) return full;
      }
    }
  } catch { /* ignore */ }
  return null;
}

module.exports = { copyToDevice, freeSpace };
