'use strict';

const path = require('path');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const options = {
  dir: root,
  name: 'RobloxCodesGET',
  platform: 'win32',
  arch: 'x64',
  icon: path.join(root, 'build', 'icon.ico'),
  out: path.join(root, 'dist'),
  overwrite: true,
  asar: true,
  prune: true,
  win32metadata: {
    CompanyName: 'theKing',
    FileDescription: 'RobloxCodesGET — Roblox 代码聚合工具',
    ProductName: 'RobloxCodesGET',
    OriginalFilename: 'RobloxCodesGET.exe',
    LegalCopyright: 'Copyright (c) 2026 theKing',
  },
  ignore: (input) => {
    let value = String(input || '').replace(/\\/g, '/');
    const rootPrefix = root.replace(/\\/g, '/');
    if (value.startsWith(rootPrefix)) value = value.slice(rootPrefix.length);
    const normalized = '/' + value.replace(/^\/+/, '');
    if (
      /^\/(?:\.tmp|dist|release|screenshots|scripts|packaging|\.git)(?:\/|$)/.test(
        normalized
      )
    ) {
      return true;
    }
    if (
      /^\/node_modules\/(?:electron|@electron|@electron-internal|@malept|@types)(?:\/|$)/.test(
        normalized
      )
    ) {
      return true;
    }
    return false;
  },
};

if (process.env.ELECTRON_ZIP_DIR) {
  options.electronZipDir = process.env.ELECTRON_ZIP_DIR;
}

packager(options)
  .then((paths) => {
    for (const output of paths) console.log(`[pack] ${output}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
