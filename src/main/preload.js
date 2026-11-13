'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  init: () => call('app:init'),
  podcasts: {
    list: () => call('podcasts:list'),
    episodes: (id) => call('podcasts:episodes', id),
    recent: (limit) => call('podcasts:recent', limit),
    add: (url, hint) => call('podcasts:add', url, hint),
    addMany: (cands) => call('podcasts:addMany', cands),
    refresh: (id) => call('podcasts:refresh', id),
    refreshAll: () => call('podcasts:refreshAll'),
    remove: (id) => call('podcasts:remove', id),
    search: (term) => call('podcasts:search', term),
  },
  importer: {
    mac: () => call('import:mac'),
    listBackups: () => call('import:listBackups'),
    chooseBackup: () => call('import:chooseBackup'),
    fromBackup: (dir) => call('import:fromBackup', dir),
    parseText: (text) => call('import:parseText', text),
    openFile: () => call('import:openFile'),
    exportOpml: () => call('export:opml'),
  },
  downloads: {
    start: (ids) => call('downloads:start', ids),
    cancel: (id) => call('downloads:cancel', id),
    listDownloaded: () => call('downloads:listDownloaded'),
    remove: (id) => call('downloads:delete', id),
  },
  settings: {
    set: (patch) => call('settings:set', patch),
    chooseFolder: (kind) => call('settings:chooseFolder', kind),
  },
  device: {
    freeSpace: (dir) => call('device:freeSpace', dir),
    copy: (ids, opts) => call('device:copy', ids, opts),
    cancel: () => call('device:cancelCopy'),
  },
  shell: {
    showItem: (p) => call('shell:showItem', p),
    openFolder: (p) => call('shell:openFolder', p),
    openExternal: (u) => call('shell:openExternal', u),
  },
  on: (channel, cb) => {
    const allowed = ['downloads:update', 'import:progress', 'refresh:progress', 'device:progress'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
