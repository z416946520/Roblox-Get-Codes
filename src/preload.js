'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  searchGames: (query) => ipcRenderer.invoke('search-games', query),
  getCodes: (game, options) => ipcRenderer.invoke('get-codes', game, options),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  saveCsv: (content, defaultName) =>
    ipcRenderer.invoke('save-csv', content, defaultName),
  appInfo: () => ipcRenderer.invoke('app-info'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  verifySource: (url, mode) => ipcRenderer.invoke('verify-source', url, mode),
  resetVerification: () => ipcRenderer.invoke('reset-verification'),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('crawl-progress', listener);
    return () => ipcRenderer.removeListener('crawl-progress', listener);
  },
});
