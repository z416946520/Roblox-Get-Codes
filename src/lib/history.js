'use strict';

const fs = require('fs');
const path = require('path');
const { daysBetween } = require('./util');

const NEW_WINDOW_DAYS = 14;

/**
 * Local first-seen history. It lets the app say "newly observed" for codes
 * that were not present on the previous crawl, even when a source page does
 * not expose a release date.
 */
class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // History is a convenience; never fail a crawl because it cannot save.
    }
  }

  annotate(gameKey, records, now = new Date()) {
    const previous = this.data[gameKey];
    const nowIso = now.toISOString();
    const result = new Map();

    for (const record of records) {
      const key = record.code.toUpperCase();
      const old = previous && previous.codes ? previous.codes[key] : null;
      let firstSeen = old ? old.firstSeen : nowIso;
      let isNew = false;

      if (previous && previous.baselineAt && !old) {
        // First observed after the baseline crawl.
        isNew = true;
      } else if (
        old &&
        old.isNewSinceBaseline &&
        daysBetween(old.firstSeen, now) <= NEW_WINDOW_DAYS
      ) {
        isNew = true;
      }

      result.set(key, { firstSeen, isNew });
    }

    return result;
  }

  commit(gameKey, records, now = new Date()) {
    const nowIso = now.toISOString();
    const previous = this.data[gameKey];
    const codes = previous && previous.codes ? { ...previous.codes } : {};

    for (const record of records) {
      const key = record.code.toUpperCase();
      const old = codes[key];
      codes[key] = {
        firstSeen: old ? old.firstSeen : nowIso,
        lastSeen: nowIso,
        lastStatus: record.status,
        isNewSinceBaseline: old
          ? Boolean(old.isNewSinceBaseline)
          : Boolean(previous && previous.baselineAt),
      };
    }

    this.data[gameKey] = {
      baselineAt: previous ? previous.baselineAt : nowIso,
      lastCrawlAt: nowIso,
      name: recordName(records) || (previous && previous.name) || '',
      codes,
    };

    // Keep the local store bounded.
    const keys = Object.keys(this.data);
    if (keys.length > 200) {
      keys
        .sort((a, b) => {
          const aTime = this.data[a].lastCrawlAt || '';
          const bTime = this.data[b].lastCrawlAt || '';
          return aTime.localeCompare(bTime);
        })
        .slice(0, keys.length - 200)
        .forEach((key) => delete this.data[key]);
    }

    this.save();
  }

  clear() {
    this.data = {};
    this.save();
  }
}

function recordName(records) {
  const first = records.find((record) => record.gameName);
  return first ? first.gameName : '';
}

module.exports = { HistoryStore, NEW_WINDOW_DAYS };
