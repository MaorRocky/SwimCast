'use strict';
/**
 * Reading Apple Podcasts subscriptions.
 *
 *  1. macOS: the Podcasts app keeps its library in an SQLite file (MTLibrary.sqlite) inside
 *     ~/Library/Group Containers/<team>.groups.com.apple.podcasts/Documents. Because the Mac app
 *     syncs with iCloud, this is also the list you follow on your iPhone.
 *  2. iPhone over cable: an *unencrypted* iPhone backup (made with Finder on Mac, or the
 *     Apple Devices / iTunes app on Windows) contains the same MTLibrary.sqlite file.
 *  3. Anywhere: an Apple Shortcut on the iPhone that lists the feed URLs (see renderer help).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function openSqlite(file) {
  // node:sqlite ships with Node 22.13+/Electron 35+
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file);
}

async function copyToTemp(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'swimcast-'));
  for (const [src, name] of files) {
    if (src && fs.existsSync(src)) await fsp.copyFile(src, path.join(dir, name));
  }
  return dir;
}

/** Read subscribed shows from a MTLibrary.sqlite (and optional -wal) file. */
async function readPodcastLibrary(dbFile, walFile = `${dbFile}-wal`, shmFile = `${dbFile}-shm`) {
  const dir = await copyToTemp([[dbFile, 'MTLibrary.sqlite'], [walFile, 'MTLibrary.sqlite-wal'], [shmFile, 'MTLibrary.sqlite-shm']]);
  let db;
  try {
    db = openSqlite(path.join(dir, 'MTLibrary.sqlite'));
    const cols = new Set(db.prepare("PRAGMA table_info('ZMTPODCAST')").all().map((c) => c.name));
    if (!cols.size) throw new Error('This file does not look like an Apple Podcasts library.');
    const pick = (...names) => names.find((n) => cols.has(n));
    const titleCol = pick('ZTITLE');
    const authorCol = pick('ZAUTHOR', 'ZPROVIDER');
    const artCol = pick('ZIMAGEURL', 'ZLOGOIMAGEURL', 'ZARTWORKTEMPLATEURL');
    const linkCol = pick('ZWEBPAGEURL');
    const select = [
      'ZFEEDURL AS feedUrl',
      titleCol ? `${titleCol} AS title` : "'' AS title",
      authorCol ? `${authorCol} AS author` : "'' AS author",
      artCol ? `${artCol} AS artwork` : "'' AS artwork",
      linkCol ? `${linkCol} AS link` : "'' AS link",
      cols.has('ZSUBSCRIBED') ? 'ZSUBSCRIBED AS subscribed' : '1 AS subscribed',
    ].join(', ');
    const rows = db.prepare(`SELECT ${select} FROM ZMTPODCAST WHERE ZFEEDURL IS NOT NULL AND ZFEEDURL != ''`).all();
    const mapped = rows.map((r) => ({
      title: r.title || '',
      author: r.author || '',
      feedUrl: String(r.feedUrl).trim(),
      artwork: r.artwork && !String(r.artwork).includes('{w}') ? r.artwork : '',
      subscribed: Number(r.subscribed) === 1,
    }));
    const subscribed = mapped.filter((r) => r.subscribed);
    // If the "subscribed" flag is missing/unused in this version, return everything with a feed.
    return (subscribed.length ? subscribed : mapped).sort((a, b) => a.title.localeCompare(b.title));
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function macLibraryPath() {
  const base = path.join(os.homedir(), 'Library', 'Group Containers');
  if (!fs.existsSync(base)) return null;
  let entries = [];
  try { entries = fs.readdirSync(base); } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') throw permissionError(); throw e; }
  const dir = entries.find((d) => d.endsWith('.groups.com.apple.podcasts'));
  if (!dir) return null;
  const file = path.join(base, dir, 'Documents', 'MTLibrary.sqlite');
  return fs.existsSync(file) ? file : null;
}

function permissionError() {
  const e = new Error('macOS blocked access to the Podcasts library. Open System Settings → Privacy & Security → Full Disk Access, turn on SwimCast, then try again.');
  e.code = 'MAC_PERMISSION';
  return e;
}

async function importFromMacLibrary() {
  if (process.platform !== 'darwin') throw new Error('Reading the Podcasts app library directly only works on a Mac.');
  const file = macLibraryPath();
  if (!file) throw new Error('Could not find the Apple Podcasts library on this Mac. Open the Podcasts app once (signed in to your Apple Account) and try again.');
  try {
    return await readPodcastLibrary(file);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw permissionError();
    throw e;
  }
}

// ---------- iPhone backups ----------

function backupRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [
      path.join(home, 'Apple', 'MobileSync', 'Backup'), // Apple Devices app / Microsoft Store iTunes
      path.join(appData, 'Apple Computer', 'MobileSync', 'Backup'), // classic iTunes
      path.join(appData, 'Apple', 'MobileSync', 'Backup'),
    ];
  }
  return [path.join(home, 'Library', 'Application Support', 'MobileSync', 'Backup')];
}

function plistValue(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<(string|date|true|false|integer)\\s*/?>([^<]*)`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  if (m[1] === 'true') return true;
  if (m[1] === 'false') return false;
  return m[2];
}

function describeBackup(dir) {
  const manifest = path.join(dir, 'Manifest.db');
  if (!fs.existsSync(manifest)) return null;
  const info = { dir, name: path.basename(dir), date: null, product: '', encrypted: null };
  try {
    const xml = fs.readFileSync(path.join(dir, 'Info.plist'), 'utf8');
    info.name = plistValue(xml, 'Device Name') || plistValue(xml, 'Display Name') || info.name;
    info.date = plistValue(xml, 'Last Backup Date');
    info.product = plistValue(xml, 'Product Name') || plistValue(xml, 'Product Type') || '';
  } catch { /* Info.plist may be missing or binary */ }
  if (!info.date) {
    try { info.date = fs.statSync(manifest).mtime.toISOString(); } catch { /* ignore */ }
  }
  return info;
}

/** List iPhone backups found in the default locations (plus any extra folder). */
function listBackups(extraDirs = []) {
  const out = [];
  const seen = new Set();
  for (const root of [...backupRoots(), ...extraDirs]) {
    if (!root || !fs.existsSync(root)) continue;
    // A user may point directly at a single backup folder.
    const direct = describeBackup(root);
    const candidates = direct ? [root] : (() => {
      try { return fs.readdirSync(root).map((d) => path.join(root, d)); } catch { return []; }
    })();
    for (const dir of candidates) {
      const real = path.resolve(dir);
      if (seen.has(real)) continue;
      const b = describeBackup(real);
      if (b) { seen.add(real); out.push(b); }
    }
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

async function importFromBackup(backupDir) {
  const manifestPath = path.join(backupDir, 'Manifest.db');
  if (!fs.existsSync(manifestPath)) throw new Error('That folder is not an iPhone backup (Manifest.db is missing).');
  const tmp = await copyToTemp([[manifestPath, 'Manifest.db']]);
  let rows;
  let db;
  try {
    db = openSqlite(path.join(tmp, 'Manifest.db'));
    rows = db.prepare(
      "SELECT fileID, domain, relativePath FROM Files WHERE relativePath LIKE '%MTLibrary.sqlite%' AND domain LIKE '%podcasts%'",
    ).all();
  } catch (e) {
    if (/not a database|file is encrypted|malformed/i.test(e.message)) {
      const err = new Error('This backup is encrypted, so its Podcasts data can\'t be read. Make an unencrypted backup (untick "Encrypt local backup"), or use the iPhone Shortcut option instead.');
      err.code = 'BACKUP_ENCRYPTED';
      throw err;
    }
    throw e;
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  const fileFor = (suffix) => {
    const r = rows.find((x) => x.relativePath.endsWith(`MTLibrary.sqlite${suffix}`));
    return r ? path.join(backupDir, r.fileID.slice(0, 2), r.fileID) : null;
  };
  const db0 = fileFor('');
  if (!db0 || !fs.existsSync(db0)) {
    throw new Error('No Apple Podcasts library found in this backup. Try the iPhone Shortcut option instead.');
  }
  return readPodcastLibrary(db0, fileFor('-wal'), fileFor('-shm'));
}

module.exports = { importFromMacLibrary, listBackups, importFromBackup, readPodcastLibrary, backupRoots };
