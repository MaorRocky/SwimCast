'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Store } = require('./store');
const { Library } = require('./library');
const { DownloadManager, ffmpegPath } = require('./downloads');
const { searchPodcasts, lookupAppleIds } = require('./search');
const { parseSubscriptionText, buildOpml } = require('./opml');
const apple = require('./apple');
const { copyToDevice, freeSpace } = require('./sdcard');

let win;
let store;
let library;
let downloads;
let copyController = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'SwimCast',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1720' : '#f4f8fa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
}

function wrap(fn) {
  return async (_evt, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e), code: e && e.code }; }
  };
}

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, wrap(fn));

  handle('app:init', () => ({
    platform: process.platform,
    version: app.getVersion(),
    podcasts: library.listPodcasts(),
    settings: store.settings,
    downloads: downloads.snapshot(),
    canConvert: !!ffmpegPath(),
  }));

  handle('podcasts:list', () => library.listPodcasts());
  handle('podcasts:episodes', (id) => library.episodes(id));
  handle('podcasts:recent', (limit) => library.recentEpisodes(limit));
  handle('podcasts:add', (url, hint) => library.addFeed(url, hint));
  handle('podcasts:addMany', (cands) => library.addMany(cands, (p) => send('import:progress', p)));
  handle('podcasts:refresh', (id) => library.refresh(id));
  handle('podcasts:refreshAll', () => library.refreshAll((p) => send('refresh:progress', p)));
  handle('podcasts:remove', (id) => library.remove(id));
  handle('podcasts:search', (term) => searchPodcasts(term));

  handle('import:mac', async () => library.annotate(await apple.importFromMacLibrary()));
  handle('import:listBackups', () => apple.listBackups(store.settings.extraBackupDirs || []));
  handle('import:chooseBackup', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an iPhone backup folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dirs = new Set([...(store.settings.extraBackupDirs || []), r.filePaths[0]]);
    store.setSettings({ extraBackupDirs: [...dirs] });
    return apple.listBackups([r.filePaths[0]]);
  });
  handle('import:fromBackup', async (dir) => library.annotate(await apple.importFromBackup(dir)));
  handle('import:parseText', async (text) => {
    const { feeds, appleIds } = parseSubscriptionText(text);
    let resolved = [];
    if (appleIds.length) {
      resolved = (await lookupAppleIds(appleIds)).map((r) => ({ title: r.title, author: r.author, feedUrl: r.feedUrl, artwork: r.artwork }));
    }
    return library.annotate([...feeds, ...resolved]);
  });
  handle('import:openFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open subscriptions file',
      properties: ['openFile'],
      filters: [{ name: 'Subscriptions', extensions: ['opml', 'xml', 'txt'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return fsp.readFile(r.filePaths[0], 'utf8');
  });
  handle('export:opml', async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export subscriptions', defaultPath: 'SwimCast subscriptions.opml', filters: [{ name: 'OPML', extensions: ['opml'] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, buildOpml(store.podcasts));
    return r.filePath;
  });

  handle('downloads:start', (ids) => downloads.enqueue(ids));
  handle('downloads:cancel', (id) => downloads.cancel(id));
  handle('downloads:listDownloaded', () => {
    const out = [];
    for (const p of store.podcasts) {
      for (const e of store.getEpisodes(p.id)) {
        const d = store.getDownload(e.id);
        if (d) {
          out.push({
            episodeId: e.id, podcastId: p.id, podcastTitle: p.title, artwork: p.artwork, title: e.title,
            pubDate: e.pubDate, duration: e.duration, size: d.size, path: d.path, copied: !!store.data.copied[e.id],
          });
        }
      }
    }
    return out.sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  });
  handle('downloads:delete', async (episodeId) => {
    const d = store.getDownload(episodeId);
    if (d) await shell.trashItem(d.path).catch(() => fsp.rm(d.path, { force: true }));
    delete store.data.downloads[episodeId];
    store.save();
  });

  handle('settings:set', (patch) => store.setSettings(patch));
  handle('settings:chooseFolder', async (kind) => {
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'sdcard' ? 'Choose your headphones / SD card' : 'Choose where to save episodes',
      defaultPath: kind === 'sdcard' ? store.settings.sdCardDir || undefined : store.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const key = kind === 'sdcard' ? 'sdCardDir' : 'downloadDir';
    store.setSettings({ [key]: r.filePaths[0] });
    return r.filePaths[0];
  });

  handle('device:freeSpace', (dir) => freeSpace(dir));
  handle('device:copy', async (episodeIds, options) => {
    const items = [];
    for (const id of episodeIds) {
      const f = store.findEpisode(id);
      const d = store.getDownload(id);
      if (f && d) items.push({ episodeId: id, podcast: f.podcast, episode: f.episode, path: d.path, size: d.size });
    }
    copyController = new AbortController();
    try {
      const res = await copyToDevice(items, { destDir: store.settings.sdCardDir, ...options }, (p) => send('device:progress', p), copyController.signal);
      for (const f of res.files) store.markCopied(f.episodeId, f.dest);
      return res;
    } finally { copyController = null; }
  });
  handle('device:cancelCopy', () => { if (copyController) copyController.abort(); });

  handle('shell:showItem', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  handle('shell:openFolder', async (p) => {
    const target = p || store.settings.downloadDir;
    await fsp.mkdir(target, { recursive: true }).catch(() => {});
    return shell.openPath(target);
  });
  handle('shell:openExternal', (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
}

// Developer hooks (used for automated screenshots/tests only).
if (process.env.SWIMCAST_USER_DATA) app.setPath('userData', process.env.SWIMCAST_USER_DATA);

async function devScreenshot() {
  const out = process.env.SWIMCAST_SCREENSHOT;
  if (!out) return;
  win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
  win.webContents.on('preload-error', (_e, p, err) => console.log(`[preload] ${err}`));
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    if (process.env.SWIMCAST_SCRIPT) {
      await win.webContents.executeJavaScript(process.env.SWIMCAST_SCRIPT).catch((e) => console.error(e));
      await new Promise((r) => setTimeout(r, 1500));
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    app.quit();
  });
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), {
    downloadDir: path.join(app.getPath('music'), 'SwimCast'),
    sdCardDir: '',
    convertToMp3: true,
    perPodcastFolder: false,
    numberPrefix: true,
    refreshOnStart: true,
  });
  library = new Library(store);
  downloads = new DownloadManager(store, { concurrency: 3 });
  downloads.on('update', (s) => send('downloads:update', s));
  registerIpc();
  createWindow();
  devScreenshot();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { if (store) store.flush(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
