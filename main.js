#!/usr/bin/env node

const readline = require('readline-sync');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const express = require('express');
const moment = require('moment');
const https = require('https');
let TikTokLiveConnection = null;
const WebSocket = require('ws');

const MinecraftWebSocketServer = require('./TMine');
const WhatsAppBot = require('./whatsapp');
const TikTokMCAPI = require('./api');
const { 
  CONFIG, 
  FEATURES, 
  COLORS, 
  EVENT_TYPES, 
  STATUS, 
  MESSAGES, 
  MINECRAFT_EVENTS,
  Utils 
} = require('./setting');

moment.locale('id');
console.log('[DEBUG] TIKTOMC gift debug AKTIF otomatis: Gift Raw / Gift Skipped / Gift Accepted akan tampil di console.');

const DATA_DIR = CONFIG.DATA_DIR;
let wss = null;
let minecraftBridge = null;
const hostSessions = new Map();
let liveStats = null;
let followStore = null;
let giftStore = null;
let filterSystem = null;
let reconnectSystem = null;
let renderInterval = null;
let tiktokConnection = null;
let tikTokMCAPI = null;
let updateNotifier = null;
let whatsappBot = null;
const globalLiveDedupe = { followed:new Set(), joined:new Set(), subscribed:new Set(), shares:new Map(), seenEventIds:new Map(), giftGroupIds:new Map(), giftStreaks:new Map() };

// Identitas event TikTok: gunakan ID asli jika tersedia agar payload yang sama
// tidak memicu command/statistik berulang setelah reconnect.
function getTikTokUserKey(data = {}) {
  const u = eventUser(data);
  return String(u.userId || u.uniqueId || u.nickname || data.userId || data.uniqueId || '').trim().toLowerCase();
}
function getTikTokEventId(data = {}) {
  const monitor = data.monitorExtra || data.monitor_extra || {};
  const common = data.common || {};
  return String(data.eventId || data.event_id || data.msgId || data.messageId || data.msg_id ||
    common.msgId || common.eventId || monitor.msg_id || monitor.log_id || '').trim();
}
function sessionOwnerKey(session) {
  return String(session?.playerUUID || session?.clientId || session?.playerName || session?.tiktok || 'unknown').trim().toLowerCase();
}
function rememberEventId(session, type, data, ttlMs = 120000) {
  const id = getTikTokEventId(data);
  if (!id || !session) return false;
  const now = Date.now();
  if (type === 'gift') {
    const globalKey = `${sessionOwnerKey(session)}:${type}:${id}`;
    for (const [key, expires] of globalLiveDedupe.seenEventIds) if (expires <= now) globalLiveDedupe.seenEventIds.delete(key);
    const previous = globalLiveDedupe.seenEventIds.get(globalKey);
    if (previous && previous > now) return true;
    globalLiveDedupe.seenEventIds.set(globalKey, now + ttlMs);
    if (globalLiveDedupe.seenEventIds.size > 10000) {
      for (const [key, expires] of globalLiveDedupe.seenEventIds) if (expires <= now) globalLiveDedupe.seenEventIds.delete(key);
      while (globalLiveDedupe.seenEventIds.size > 10000) globalLiveDedupe.seenEventIds.delete(globalLiveDedupe.seenEventIds.keys().next().value);
    }
  }
  if (!(session.seenEventIds instanceof Map)) session.seenEventIds = new Map();
  for (const [key, expires] of session.seenEventIds) if (expires <= now) session.seenEventIds.delete(key);
  const key = `${type}:${id}`;
  if (session.seenEventIds.has(key)) return true;
  session.seenEventIds.set(key, now + ttlMs);
  if (session.seenEventIds.size > 3000) session.seenEventIds.delete(session.seenEventIds.keys().next().value);
  return false;
}
function truthyTikTokFlag(value) {
  return value === true || value === 1 || (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()));
}
function getTikTokGiftMeta(data = {}) {
  const root = data && typeof data === 'object' ? data : {};
  const positive = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const objects = [];
  const visited = new Set();
  const walk = (value, depth = 0) => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      const t = value.trim();
      if ((t.startsWith('{') || t.startsWith('[')) && t.length < 20000) {
        try { walk(JSON.parse(t), depth + 1); } catch (_) {}
      }
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value); objects.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') walk(child, depth + 1);
      else if (typeof child === 'string' && /^(giftDetails|gift_details|monitorExtra|monitor_extra|common|data|payload|extra)$/i.test(key)) walk(child, depth + 1);
    }
  };
  walk(root);
  const first = keys => {
    for (const obj of objects) for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    }
    return undefined;
  };
  const firstPositive = keys => {
    for (const obj of objects) for (const key of keys) {
      const n = positive(obj[key]);
      if (n > 0) return n;
    }
    return 0;
  };
  const giftId = firstPositive(['giftId', 'gift_id', 'id']);
  const giftName = first(['giftName', 'gift_name', 'name']) ?? 'Unknown';
  const coin = firstPositive(['diamondCount', 'diamond_count', 'diamondValue', 'diamond_value', 'diamond', 'coin']);
  const giftType = objects.reduce((max, obj) => Math.max(max, positive(obj.giftType), positive(obj.gift_type)), 0);
  const repeatEndRaw = first(['repeatEnd', 'repeat_end']);
  const canonicalValues = objects.flatMap(obj => ['repeatCount', 'repeat_count'].map(k => positive(obj[k]))).filter(n => n > 0);
  const canonicalCount = canonicalValues.length ? Math.max(...canonicalValues) : 0;
  const comboValues = objects.flatMap(obj => ['comboCount', 'combo_count', 'streakCount', 'streak_count', 'comboTotal', 'combo_total', 'streakTotal', 'streak_total'].map(k => positive(obj[k]))).filter(n => n > 0);
  const comboCount = comboValues.length ? Math.max(...comboValues) : 0;
  const genericCount = positive(first(['count', 'amount']));
  let countValue = canonicalCount || genericCount || 1;
  if (truthyTikTokFlag(repeatEndRaw) && countValue <= 1 && comboCount > 1) countValue = comboCount;
  const repeatCount = Math.max(1, countValue);
  const groupId = String(first(['giftGroupId', 'gift_group_id', 'groupId', 'group_id']) ?? '').trim();
  return { giftId, giftName, coin, giftType, repeatEnd: truthyTikTokFlag(repeatEndRaw), repeatEndKnown: repeatEndRaw !== undefined && repeatEndRaw !== null, repeatCount, groupId };
}

function rememberGiftGroup(session, data, ttlMs = 120000) {
  const meta = getTikTokGiftMeta(data);
  if (!session || !meta.groupId) return false;
  const now = Date.now();
  const ownerKey = sessionOwnerKey(session);
  for (const [key, expires] of globalLiveDedupe.giftGroupIds) if (expires <= now) globalLiveDedupe.giftGroupIds.delete(key);
  const key = `${ownerKey}:gift-group:${meta.groupId}`;
  const expiry = globalLiveDedupe.giftGroupIds.get(key);
  if (expiry && expiry > now) return true;
  globalLiveDedupe.giftGroupIds.set(key, now + ttlMs);
  if (globalLiveDedupe.giftGroupIds.size > 10000) {
    for (const [k, expires] of globalLiveDedupe.giftGroupIds) if (expires <= now) globalLiveDedupe.giftGroupIds.delete(k);
    while (globalLiveDedupe.giftGroupIds.size > 10000) globalLiveDedupe.giftGroupIds.delete(globalLiveDedupe.giftGroupIds.keys().next().value);
  }
  return false;
}

// ============================================================
// UNIFIED COMBO BUFFERING — REAL-TIME
// ============================================================
// Emit event PERTAMA langsung (real-time), lalu hanya kirim DELTA di final.
// Delta di-tandai giftDelta=true agar Java tidak menolak karena giftGroupId
// yang sama. Setiap gift ber-groupId (apapun giftType-nya) di-buffer agar
// total akurat.
function queueComboGift(session, data, meta, emitGift, isStopped = () => false, windowMs = 1500) {
  if (!session || !data || !meta || !meta.groupId) return false;

  const streakKey = `${sessionOwnerKey(session)}:${meta.groupId}`;
  if (!(session.giftStreaks instanceof Map)) session.giftStreaks = new Map();
  if (!(session.completedGiftGroups instanceof Map)) session.completedGiftGroups = new Map();

  const now = Date.now();
  for (const [k, exp] of session.completedGiftGroups) if (exp <= now) session.completedGiftGroups.delete(k);
  if (session.completedGiftGroups.size > 5000) {
    for (const [k, exp] of session.completedGiftGroups) {
      if (session.completedGiftGroups.size <= 4000) break;
      session.completedGiftGroups.delete(k);
    }
  }

  // Dedupe reconnect — groupId yang sudah selesai tidak diproses lagi
  if (session.completedGiftGroups.has(streakKey)) return true;

  const pending = session.giftStreaks.get(streakKey);
  const currentCount = Number(meta.repeatCount) || 0;
  const isFinal = meta.repeatEndKnown === true && meta.repeatEnd === true;

  // Helper: emit delta dengan flag giftDelta agar Java tidak menolak
  const emitDelta = (sourceData, sourceMeta, deltaCount) => {
    if (deltaCount <= 0 || isStopped()) return;
    emitGift(sourceData, { ...sourceMeta, repeatCount: deltaCount, giftDelta: true });
  };

  // ---- Event pertama combo: emit SEKARANG (real-time) TANPA flag giftDelta ----
  if (!pending) {
    if (currentCount > 0 && !isStopped()) emitGift(data, meta);

    if (isFinal) {
      // Single-tap gift — sudah di-emit sekali
      session.completedGiftGroups.set(streakKey, now + 60000);
      return true;
    }

    const entry = {
      data, meta,
      emittedCount: currentCount,
      latestCount: currentCount,
      timer: null
    };
    entry.timer = setTimeout(() => {
      if (session.giftStreaks.get(streakKey) !== entry) return;
      session.giftStreaks.delete(streakKey);
      session.completedGiftGroups.set(streakKey, Date.now() + 60000);
      emitDelta(entry.data, entry.meta, entry.latestCount - entry.emittedCount);
    }, windowMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    session.giftStreaks.set(streakKey, entry);
    return true;
  }

  // ---- Event berikutnya: update buffer ----
  if (pending.timer) clearTimeout(pending.timer);
  pending.latestCount = Math.max(pending.latestCount, currentCount);
  if (currentCount > (pending.meta?.repeatCount || 0)) {
    pending.data = data;
    pending.meta = meta;
  }

  const finalize = () => {
    session.giftStreaks.delete(streakKey);
    session.completedGiftGroups.set(streakKey, Date.now() + 60000);
    emitDelta(pending.data, pending.meta, pending.latestCount - pending.emittedCount);
  };

  if (isFinal) {
    finalize();
    return true;
  }

  // Intermediate emit kalau delta sudah besar (10+) agar user lihat progres
  const delta = pending.latestCount - pending.emittedCount;
  if (delta >= 10) {
    emitDelta(pending.data, pending.meta, delta);
    pending.emittedCount = pending.latestCount;
  }

  pending.timer = setTimeout(() => {
    if (session.giftStreaks.get(streakKey) !== pending) return;
    finalize();
  }, windowMs);
  if (typeof pending.timer.unref === 'function') pending.timer.unref();
  return true;
}

// Fallback hanya ketika TikTok tidak menyediakan messageId stabil maupun groupId.
function rememberGiftFingerprint(session, data, windowMs = 1800) {
  if (!session || !data) return false;
  if (!(session.giftFallbackDedupe instanceof Map)) session.giftFallbackDedupe = new Map();
  const u = eventUser(data);
  const g = eventGift(data);
  const user = String(u.userId || u.uniqueId || u.nickname || data.userId || 'anonymous').toLowerCase();
  const giftId = String(g.id || data.giftId || data.gift_id || '');
  const giftName = String(g.name || g.giftName || data.giftName || data.gift_name || 'gift').toLowerCase();
  const count = Number(data.repeatCount ?? data.repeat_count ?? data.count ?? data.amount ?? 1) || 1;
  const key = `${user}:${giftId}:${giftName}:${count}`;
  const now = Date.now();
  for (const [k, expires] of session.giftFallbackDedupe) if (expires <= now) session.giftFallbackDedupe.delete(k);
  if (session.giftFallbackDedupe.has(key)) return true;
  session.giftFallbackDedupe.set(key, now + windowMs);
  if (session.giftFallbackDedupe.size > 3000) session.giftFallbackDedupe.delete(session.giftFallbackDedupe.keys().next().value);
  return false;
}
function rememberUserOnce(session, property, data) {
  const userKey = getTikTokUserKey(data);
  if (!userKey) return false;
  if (!(session[property] instanceof Set)) session[property] = new Set();
  if (session[property].has(userKey)) return false;
  session[property].add(userKey);
  return true;
}

class UpdateNotifier {
  constructor() {
    this.currentVersion = require('./package.json').version;
    this.githubRepo = 'mcpakel/tiktok-live-bridge';
    this.lastCheckFile = path.join(DATA_DIR, 'last-update-check.json');
    this.checkInterval = 24 * 60 * 60 * 1000;
    this.isChecking = false;
    this.latestUpdate = null;
  }

  getLastCheck() {
    try {
      if (fs.existsSync(this.lastCheckFile)) {
        const data = JSON.parse(fs.readFileSync(this.lastCheckFile, 'utf-8'));
        return data;
      }
    } catch (e) {}
    return { lastCheck: 0, lastNotifiedVersion: null };
  }

  saveLastCheck(lastCheck, lastNotifiedVersion = null) {
    try {
      const dir = path.dirname(this.lastCheckFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.lastCheckFile, JSON.stringify({
        lastCheck,
        lastNotifiedVersion
      }, null, 2));
    } catch (e) {}
  }

  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const num1 = parts1[i] || 0;
      const num2 = parts2[i] || 0;
      if (num1 !== num2) return num1 - num2;
    }
    return 0;
  }

  async checkForUpdates(force = false) {
    if (this.isChecking) return this.latestUpdate;

    const lastCheck = this.getLastCheck();
    const now = Date.now();

    if (!force && (now - lastCheck.lastCheck) < this.checkInterval) {
      return this.latestUpdate;
    }

    this.isChecking = true;

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${this.githubRepo}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': 'TikTok-Live-Bridge',
          'Accept': 'application/vnd.github.v3+json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          this.isChecking = false;
          
          try {
            const json = JSON.parse(data);
            
            if (json.tag_name) {
              const latestVersion = json.tag_name.replace(/^v/, '');
              const hasUpdate = this.compareVersions(latestVersion, this.currentVersion) > 0;
              
              const result = {
                hasUpdate,
                currentVersion: this.currentVersion,
                latestVersion,
                releaseName: json.name || json.tag_name,
                releaseNotes: json.body || 'No release notes provided',
                releaseUrl: json.html_url,
                publishedAt: json.published_at,
                isPrerelease: json.prerelease || false
              };
              
              this.latestUpdate = result;
              
              if (hasUpdate && lastCheck.lastNotifiedVersion !== latestVersion) {
                this.saveLastCheck(now, latestVersion);
              } else {
                this.saveLastCheck(now, lastCheck.lastNotifiedVersion);
              }
              
              resolve(result);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        this.isChecking = false;
        resolve(null);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        this.isChecking = false;
        resolve(null);
      });

      req.end();
    });
  }

  getUpdateNotification(width) {
    if (!this.latestUpdate || !this.latestUpdate.hasUpdate) return null;

    const lines = [];
    const boxWidth = Math.min(width - 4, 70);
    
    lines.push(chalk.hex('#FFA500')('┌' + '─'.repeat(boxWidth) + '┐'));
    
    const header = '✨ UPDATE TERSEDIA ✨';
    const headerPadding = Math.max(0, Math.floor((boxWidth - header.length) / 2));
    lines.push(chalk.hex('#FFA500')('│') + ' '.repeat(headerPadding) + chalk.bold.hex('#FFA500')(header) + ' '.repeat(Math.max(0, boxWidth - header.length - headerPadding)) + chalk.hex('#FFA500')('│'));
    
    lines.push(chalk.hex('#FFA500')('├' + '─'.repeat(boxWidth) + '┤'));
    
    const versionText = `📦 ${chalk.white(this.currentVersion)} → ${chalk.green.bold(this.latestUpdate.latestVersion)}`;
    const versionPadding = boxWidth - versionText.length + 2;
    lines.push(chalk.hex('#FFA500')('│ ') + versionText + ' '.repeat(Math.max(0, versionPadding)) + chalk.hex('#FFA500')('│'));
    
    lines.push(chalk.hex('#FFA500')('│ ') + chalk.gray('─'.repeat(boxWidth - 2)) + chalk.hex('#FFA500')('│'));
    
    let releaseName = this.latestUpdate.releaseName;
    if (releaseName.length > boxWidth - 6) {
      releaseName = releaseName.substring(0, boxWidth - 9) + '...';
    }
    lines.push(chalk.hex('#FFA500')('│ ') + chalk.cyan('📌 ') + releaseName + ' '.repeat(Math.max(0, boxWidth - releaseName.length - 4)) + chalk.hex('#FFA500')('│'));
    
    if (this.latestUpdate.publishedAt) {
      const date = new Date(this.latestUpdate.publishedAt).toLocaleDateString('id-ID');
      const dateText = `📅 Dirilis: ${date}`;
      lines.push(chalk.hex('#FFA500')('│ ') + chalk.gray(dateText) + ' '.repeat(Math.max(0, boxWidth - dateText.length - 2)) + chalk.hex('#FFA500')('│'));
    }
    
    lines.push(chalk.hex('#FFA500')('├' + '─'.repeat(boxWidth) + '┤'));
    
    const downloadText = `⬇️  Download: ${chalk.cyan(this.latestUpdate.releaseUrl)}`;
    if (downloadText.length > boxWidth - 2) {
      const shortUrl = this.latestUpdate.releaseUrl.substring(0, boxWidth - 10) + '...';
      lines.push(chalk.hex('#FFA500')('│ ') + chalk.gray('⬇️ Download: ') + chalk.cyan(shortUrl) + ' '.repeat(Math.max(0, boxWidth - shortUrl.length - 12)) + chalk.hex('#FFA500')('│'));
    } else {
      lines.push(chalk.hex('#FFA500')('│ ') + chalk.gray('⬇️ Download: ') + chalk.cyan(this.latestUpdate.releaseUrl) + ' '.repeat(Math.max(0, boxWidth - downloadText.length + 11)) + chalk.hex('#FFA500')('│'));
    }
    
    lines.push(chalk.hex('#FFA500')('│ ') + chalk.yellow('ℹ️ Update tidak otomatis, download manual') + ' '.repeat(Math.max(0, boxWidth - 35)) + chalk.hex('#FFA500')('│'));
    lines.push(chalk.hex('#FFA500')('└' + '─'.repeat(boxWidth) + '┘'));
    
    return lines;
  }
}

function initializeStores() {
  Utils.ensureDir(DATA_DIR);

  followStore = {
    path: path.join(DATA_DIR, 'followed.json'),
    users: new Map(),

    init: () => {
      if (!FEATURES.SAVE_FOLLOWERS) return;
      
      if (fs.existsSync(followStore.path)) {
        try {
          const raw = JSON.parse(fs.readFileSync(followStore.path, 'utf-8'));
          if (Array.isArray(raw)) {
            followStore.users = new Map(raw.filter(entry => Array.isArray(entry) && entry.length === 2));
          }
        } catch (e) {}
      } else {
        fs.writeFileSync(followStore.path, JSON.stringify([]));
      }
    },

    save: () => {
      if (!FEATURES.SAVE_FOLLOWERS) return;
      const data = [...followStore.users.entries()];
      fs.writeFileSync(followStore.path, JSON.stringify(data, null, 2));
    },

    has: (userId) => followStore.users.has(userId),

    add: (userId, username) => {
      if (!FEATURES.SAVE_FOLLOWERS) return true;
      followStore.users.set(userId, username);
      followStore.save();
      return true;
    }
  };

  giftStore = {
    path: path.join(DATA_DIR, 'gift-log.json'),
    gifts: [],

    init: () => {
      if (!FEATURES.SAVE_GIFTS) return;
      
      if (fs.existsSync(giftStore.path)) {
        try {
          giftStore.gifts = JSON.parse(fs.readFileSync(giftStore.path, 'utf-8'));
        } catch {
          giftStore.gifts = [];
        }
      }
    },

    add: (gift) => {
      if (!FEATURES.SAVE_GIFTS) return;
      
      giftStore.gifts.push({
        ...gift,
        timestamp: Date.now()
      });
      if (giftStore.gifts.length > 500) {
        giftStore.gifts = giftStore.gifts.slice(-500);
      }
      fs.writeFileSync(giftStore.path, JSON.stringify(giftStore.gifts, null, 2));
    }
  };

  filterSystem = {
    badWords: FEATURES.FILTER_KATA ? CONFIG.FILTER_WORDS : [],
    cache: new Map(),

    init: () => {
      if (!FEATURES.FILTER_KATA) return;
      
      const customPath = path.join(DATA_DIR, 'filter-words.json');
      if (fs.existsSync(customPath)) {
        try {
          const custom = JSON.parse(fs.readFileSync(customPath, 'utf-8'));
          if (Array.isArray(custom)) {
            filterSystem.badWords = [...new Set([...filterSystem.badWords, ...custom])];
          }
        } catch (e) {}
      } else {
        fs.writeFileSync(customPath, JSON.stringify(filterSystem.badWords, null, 2));
      }
      console.log(chalk.green(`📝 Filter: ${filterSystem.badWords.length} kata terdaftar`));
    },

    filter: (text) => {
      if (!FEATURES.FILTER_KATA || !text || typeof text !== 'string') {
        return { text, hasBadWord: false };
      }

      if (filterSystem.cache.has(text)) {
        return filterSystem.cache.get(text);
      }

      let filtered = text;
      let hasBadWord = false;

      filterSystem.badWords.forEach(word => {
        const regex = new RegExp(word, 'gi');
        if (regex.test(filtered)) {
          hasBadWord = true;
          const replacement = '*'.repeat(word.length);
          filtered = filtered.replace(regex, replacement);
        }
      });

      if (filterSystem.cache.size > 1000) {
        const firstKey = filterSystem.cache.keys().next().value;
        filterSystem.cache.delete(firstKey);
      }
      
      const result = { text: filtered, hasBadWord };
      filterSystem.cache.set(text, result);
      return result;
    },

    addWord: (word) => {
      if (!FEATURES.FILTER_KATA) return false;
      
      const lower = word.toLowerCase();
      if (!filterSystem.badWords.includes(lower)) {
        filterSystem.badWords.push(lower);
        filterSystem.saveWords();
        filterSystem.cache.clear();
        return true;
      }
      return false;
    },

    removeWord: (word) => {
      if (!FEATURES.FILTER_KATA) return false;
      
      const lower = word.toLowerCase();
      const index = filterSystem.badWords.indexOf(lower);
      if (index > -1) {
        filterSystem.badWords.splice(index, 1);
        filterSystem.saveWords();
        filterSystem.cache.clear();
        return true;
      }
      return false;
    },

    saveWords: () => {
      if (!FEATURES.FILTER_KATA) return;
      
      fs.writeFileSync(
        path.join(DATA_DIR, 'filter-words.json'),
        JSON.stringify(filterSystem.badWords, null, 2)
      );
    }
  };

  liveStats = {
    startTime: null,
    stats: {
      gifts: 0,
      likes: 0,
      follows: 0,
      joins: 0,
      shares: 0,
      chats: 0,
      username: '',
      nickname: '',
      port: CONFIG.WS_PORT,
      tiktokConnected: false,
      wsConnected: false,
      topGifters: new Map(),
      totalGiftValue: 0
    },

    logBuffer: [],
    maxLogs: CONFIG.MAX_LOG_ENTRIES,

    reset: (username, port, nickname = '') => {
      liveStats.startTime = new Date();
      liveStats.stats = {
        gifts: 0,
        likes: 0,
        follows: 0,
        joins: 0,
        shares: 0,
        chats: 0,
        username,
        nickname: nickname || username,
        port,
        tiktokConnected: true,
        wsConnected: false,
        topGifters: new Map(),
        totalGiftValue: 0
      };
      liveStats.logBuffer = [];
    },

    addGift: (count, sender, giftName, totalCoin) => {
      if (!FEATURES.TOP_GIFTERS) {
        liveStats.stats.gifts += count;
        liveStats.stats.totalGiftValue += totalCoin;
        return;
      }
      
      liveStats.stats.gifts += count;
      liveStats.stats.totalGiftValue += totalCoin;
      
      const current = liveStats.stats.topGifters.get(sender) || 0;
      liveStats.stats.topGifters.set(sender, current + totalCoin);
      
      if (FEATURES.ACTIVITY_LOG) {
        liveStats.addLog('gift', sender, `🎁 ${giftName} x${count} (${Utils.formatNumber(totalCoin)} 💎)`);
      }
      
      giftStore.add({
        sender: sender,
        name: giftName,
        count: count,
        totalCoin: totalCoin
      });
    },

    addLike: (count, sender) => {
      liveStats.stats.likes += count;
      if (FEATURES.ACTIVITY_LOG) {
        liveStats.addLog('like', sender, `❤️ +${Utils.formatNumber(count)} like`);
      }
    },

    addFollow: (sender) => {
      liveStats.stats.follows++;
      if (FEATURES.ACTIVITY_LOG) {
        liveStats.addLog('follow', sender, '👥 follow');
      }
    },

    addJoin: (sender) => {
      liveStats.stats.joins++;
      if (FEATURES.ACTIVITY_LOG) {
        liveStats.addLog('join', sender, '📥 join');
      }
    },

    addShare: (sender) => {
      liveStats.stats.shares++;
      if (FEATURES.ACTIVITY_LOG) {
        liveStats.addLog('share', sender, '🔄 share');
      }
    },

    addChat: (sender, message) => {
      liveStats.stats.chats++;
      if (FEATURES.ACTIVITY_LOG) {
        const shortMsg = message.length > 25 ? message.substring(0, 22) + '...' : message;
        liveStats.addLog('chat', sender, `💬 "${shortMsg}"`);
      }
    },

    addLog: (type, actor, action) => {
      liveStats.logBuffer.push({ 
        type, 
        actor, 
        action, 
        time: moment().format('HH:mm:ss')
      });
      
      if (liveStats.logBuffer.length > liveStats.maxLogs) {
        liveStats.logBuffer.shift();
      }
    },

    getDuration: () => {
      if (!liveStats.startTime) return '00:00:00';
      const diff = Date.now() - liveStats.startTime;
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    },

    getTopGifters: (limit = 3) => {
      if (!FEATURES.TOP_GIFTERS) return [];
      
      return Array.from(liveStats.stats.topGifters.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
    },

    getStats: () => {
      return {
        gifts: liveStats.stats.gifts,
        likes: liveStats.stats.likes,
        follows: liveStats.stats.follows,
        joins: liveStats.stats.joins,
        shares: liveStats.stats.shares,
        chats: liveStats.stats.chats,
        totalGiftValue: liveStats.stats.totalGiftValue,
        username: liveStats.stats.username,
        nickname: liveStats.stats.nickname,
        topGifters: Object.fromEntries(liveStats.stats.topGifters)
      };
    }
  };

  reconnectSystem = {
    tiktokAttempts: 0,
    isReconnecting: false,
    reconnectTimer: null,
    wsMonitorTimer: null,
    
    status: {
      tiktok: STATUS.CONNECTED,
      ws: STATUS.CONNECTED,
      message: ''
    },

    startTikTokReconnect: (username, port, apiKey) => {
      if (!FEATURES.AUTO_RECONNECT || reconnectSystem.isReconnecting || hostSessions.size > 0) return;
      
      reconnectSystem.isReconnecting = true;
      reconnectSystem.tiktokAttempts++;
      reconnectSystem.status.tiktok = STATUS.RECONNECTING;
      reconnectSystem.status.message = `Mencoba reconnect (${reconnectSystem.tiktokAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})...`;
      
      if (reconnectSystem.reconnectTimer) {
        clearTimeout(reconnectSystem.reconnectTimer);
      }
      
      reconnectSystem.reconnectTimer = setTimeout(async () => {
        try {
          if (tiktokConnection && tiktokConnection.connection) {
            tiktokConnection.connection.disconnect();
          }
          
          await tiktokConnection.connect(username, port, apiKey);
          
          reconnectSystem.isReconnecting = false;
          reconnectSystem.tiktokAttempts = 0;
          reconnectSystem.status.tiktok = STATUS.CONNECTED;
          reconnectSystem.status.message = '';
          
        } catch (error) {
          reconnectSystem.status.message = `Gagal: ${error.message.substring(0, 30)}...`;
          
          if (reconnectSystem.tiktokAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
            reconnectSystem.status.tiktok = STATUS.OFFLINE;
            reconnectSystem.status.message = 'Live berakhir / tidak dapat connect';
            reconnectSystem.isReconnecting = false;
          } else {
            reconnectSystem.startTikTokReconnect(username, port, apiKey);
          }
        }
      }, CONFIG.RECONNECT_DELAY);
    },

    startWSMonitor: () => {
      if (!FEATURES.AUTO_RECONNECT) return;
      
      if (reconnectSystem.wsMonitorTimer) {
        clearInterval(reconnectSystem.wsMonitorTimer);
      }
      
      reconnectSystem.wsMonitorTimer = setInterval(() => {
        const currentConnected = wss?.getClientCount() > 0;
        reconnectSystem.status.ws = currentConnected ? STATUS.CONNECTED : STATUS.DISCONNECTED;
        if (liveStats) {
          liveStats.stats.wsConnected = currentConnected;
        }
      }, 2000);
    },

    reset: () => {
      reconnectSystem.tiktokAttempts = 0;
      reconnectSystem.isReconnecting = false;
      reconnectSystem.status.tiktok = STATUS.CONNECTED;
      reconnectSystem.status.ws = wss?.getClientCount() > 0 ? STATUS.CONNECTED : STATUS.DISCONNECTED;
      reconnectSystem.status.message = '';
      
      if (reconnectSystem.reconnectTimer) {
        clearTimeout(reconnectSystem.reconnectTimer);
      }
    }
  };

  followStore.init();
  giftStore.init();
  filterSystem.init();
  
  updateNotifier = new UpdateNotifier();
}



// ===== Compatibility layer: old TIKTOMC event format + modern connector =====
function eventUser(data) {
  const u = data?.user || data?.userInfo || data?.userDetails || {};
  return {
    uniqueId: String(data?.uniqueId || data?.unique_id || u?.uniqueId || u?.unique_id || data?.userUniqueId || data?.username || (typeof data?.user === 'string' ? data.user : '') || '').trim(),
    nickname: String(data?.nickname || u?.nickname || u?.displayName || u?.display_name || '').trim(),
    userId: String(data?.userId || data?.user_id || u?.userId || u?.user_id || '').trim()
  };
}
function eventMessage(data) {
  const keys = ['comment','message','content','text'];
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const container of [data?.data, data?.message, data?.comment]) {
    if (container && typeof container === 'object') {
      for (const key of keys) {
        const value = container?.[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
    }
  }
  return '';
}
function eventGift(data) {
  const meta = getTikTokGiftMeta(data || {});
  return { id: meta.giftId, name: meta.giftName, coin: meta.coin };
}
function eventLikeCount(data) {
  return Number(data?.likeCount ?? data?.likeCount ?? data?.count ?? 1) || 1;
}

function makeHostId() {
  return 'HOST-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function hostDataDir() {
  const dir = CONFIG.HOST_DATA_DIR || './data/hosts';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safePlayerFile(playerUUID) {
  return path.join(hostDataDir(), String(playerUUID || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}

function loadHostRecord(playerUUID) {
  if (!playerUUID) return null;
  try {
    const file = safePlayerFile(playerUUID);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.tiktok) return null;
    return data;
  } catch (_) { return null; }
}

function saveHostRecord(session, active = false) {
  if (!session?.playerUUID || !session?.tiktok) return;
  try {
    const record = {
      playerUUID: session.playerUUID,
      playerName: session.playerName || null,
      tiktok: session.tiktok,
      hostId: session.hostId,
      likes: Number(session.likes || 0),
      gifts: Object.fromEntries(session.gifts || new Map()),
      active,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(safePlayerFile(session.playerUUID), JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn('⚠️ Gagal menyimpan data host:', e.message);
  }
}

function restoreSessionData(playerUUID, tiktok) {
  const saved = loadHostRecord(playerUUID);
  if (!saved || String(saved.tiktok).toLowerCase() !== String(tiktok).toLowerCase()) return null;
  return {
    hostId: saved.hostId || makeHostId(),
    likes: Number(saved.likes || 0),
    followed: new Set(),
    gifts: new Map(Object.entries(saved.gifts || {}).map(([k, v]) => [k, Number(v) || 0]))
  };
}

async function stopHostedTikTok(clientId, notify = true) {
  const session = hostSessions.get(clientId);
  if (!session) return false;
  session.stopped = true;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  try { session.connection?.disconnect(); } catch (_) {}
  saveHostRecord(session, false);
  hostSessions.delete(clientId);
  if (notify) wss?.sendToSession(clientId, 'host_status', {
    status: 'stopped', hostId: session.hostId, tiktok: session.tiktok
  });
  return true;
}

async function detachHostedTikTok(clientId) {
  const session = hostSessions.get(clientId);
  if (!session || session.stopped) return false;
  session.detached = true;
  session.status = 'reconnecting';
  saveHostRecord(session, true);
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = setTimeout(() => {
    if (hostSessions.get(clientId) === session && session.detached && !session.stopped) {
      stopHostedTikTok(clientId, false);
    }
  }, CONFIG.HOST_RECONNECT_GRACE_MS || 30000);
  return true;
}

async function resumeHostedTikTok(clientId, data = {}) {
  if (!wss) return false;
  const info = wss.getClientInfo(clientId);
  if (!info?.playerUUID) return false;

  for (const [oldId, session] of hostSessions) {
    if (oldId === clientId || session.stopped) continue;
    if (session.playerUUID !== info.playerUUID) continue;
    if (data.hostId && session.hostId !== data.hostId) continue;
    if (data.tiktok && session.tiktok.toLowerCase() !== String(data.tiktok).replace(/^@/, '').toLowerCase()) continue;

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    hostSessions.delete(oldId);
    session.clientId = clientId;
    session.detached = false;
    hostSessions.set(clientId, session);
    info.tiktok = session.tiktok;
    info.hostId = session.hostId;
    saveHostRecord(session, true);
    wss.sendToSession(clientId, 'host_status', {
      status: session.status || 'reconnecting', hostId: session.hostId, tiktok: session.tiktok,
      resumed: true, likes: session.likes
    });
    return true;
  }
  return false;
}

async function startHostedTikTok(clientId, data) {
  if (!wss) return;
  const info = wss.getClientInfo(clientId);
  if (!info) return;
  const tiktok = String(data.tiktok || '').replace(/^@/, '').trim();
  if (!tiktok) {
    wss.sendToSession(clientId, 'host_status', { status: 'error', message: 'Username TikTok kosong.' });
    return;
  }
  const existing = hostSessions.get(clientId);
  if (existing && existing.tiktok.toLowerCase() === tiktok.toLowerCase() && !existing.stopped) {
    existing.detached = false;
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    wss.sendToSession(clientId, 'host_status', { status: existing.status || 'connecting', hostId: existing.hostId, tiktok: existing.tiktok });
    return;
  }
  await stopOtherHostSessionsForPlayer(info.playerUUID, clientId);
  for (const [id, session] of hostSessions) {
    if (!session.stopped && session.tiktok.toLowerCase() === tiktok.toLowerCase() && id !== clientId) {
      wss.sendToSession(clientId, 'host_status', { status: 'error', message: `@${tiktok} sedang digunakan player lain.` });
      return;
    }
  }
  if (existing) await stopHostedTikTok(clientId, false);

  const restored = restoreSessionData(info.playerUUID, tiktok);
  const hostId = restored?.hostId || makeHostId();
  const session = {
    clientId, playerUUID: info.playerUUID || null, playerName: info.playerName || null,
    hostId, tiktok, connection: null, status: 'connecting', stopped: false, detached: false,
    reconnectTimer: null, retryUntil: Number(data.retryUntil) || (Date.now() + 20 * 60 * 1000), likes: restored?.likes || 0, followed: restored?.followed || new Set(),
    subscribed: new Set(), joined: new Set(), seenEventIds: new Map(), shareEvents: new Map(), giftStreaks: new Map(),
    completedGiftGroups: new Map(),
    gifts: restored?.gifts || new Map()
  };
  hostSessions.set(clientId, session);
  info.tiktok = tiktok;
  info.hostId = hostId;
  saveHostRecord(session, true);
  wss.sendToSession(clientId, 'host_status', { status: 'connecting', hostId, tiktok });

  const connection = new TikTokLiveConnection(tiktok, {
    processInitialData: false,
    ...(CONFIG.TIKTOK_API_KEY && CONFIG.TIKTOK_API_KEY.trim() && { signApiKey: CONFIG.TIKTOK_API_KEY.trim() })
  });
  session.connection = connection;

  const live = () => {
    if (session.stopped || session.detached || session.status === 'live') return;
    if (session.status === 'offline') { session.followed.clear(); session.subscribed.clear(); session.joined.clear(); session.seenEventIds.clear(); session.shareEvents.clear(); session.giftStreaks.clear(); session.completedGiftGroups.clear(); }
    session.status = 'live';
    saveHostRecord(session, true);
    wss.sendToSession(clientId, 'host_status', { status: 'live', live: true, hostId, tiktok });
    wss.sendToSession(clientId, 'live_status', { live: true, tiktok, tiktokUsername: tiktok, hostId });
    whatsappBot?.notifyLiveStart(tiktok).catch(() => {});
  };

  connection.on('chat', d => { if (!session.stopped && !session.detached) { wss.sendToSession(clientId, 'chat', { username: d.uniqueId || 'anonymous', nickname: d.nickname, message: d.comment || '', comment: d.comment || '', tiktok, hostId }); } });

  // ===== GIFT HANDLER (SOCKET MODE) — REAL-TIME =====
  connection.on('gift', d => {
    if (session.stopped || session.detached || hostSessions.get(clientId) !== session) return;
    const meta = getTikTokGiftMeta(d);
    if (true) console.log(`[Gift Raw] owner=${session.playerUUID || clientId} user=${d?.uniqueId || d?.nickname || 'anonymous'} meta=${JSON.stringify(meta)} payload=${JSON.stringify(d).slice(0,6000)}`);

    const emitGift = (giftData, giftMeta) => {
      if (session.stopped || session.detached || hostSessions.get(clientId) !== session) return;
      const count = Number(giftMeta.repeatCount) || 0;
      if (count <= 0) return;
      const u = eventUser(giftData);
      const id = Number(giftMeta.giftId) || 0;
      const name = String(giftMeta.giftName || 'Unknown');
      const coin = Number(giftMeta.coin) || 0;
      const keyGift = String(id || name);
      session.gifts.set(keyGift, (session.gifts.get(keyGift) || 0) + count);
      saveHostRecord(session, true);
      if (true) console.log(`[Gift Accepted] owner=${session.playerUUID || clientId} user=${u.uniqueId || 'anonymous'} id=${id} count=${count} group=${giftMeta.groupId || '-'} delta=${!!giftMeta.giftDelta}`);
      wss.sendToSession(clientId, 'gift', {
        username: u.uniqueId || u.nickname || 'anonymous', userId: u.userId, giftName: name, giftId: id,
        count, repeatCount: count, rawRepeatCount: count, coin, diamondCount: coin, totalCoin: coin * count,
        giftGroupId: giftMeta.groupId, giftDelta: !!giftMeta.giftDelta,
        sourceEventId: getTikTokEventId(giftData), tiktok, hostId
      });
    };

    // Combo path — queueComboGift handle dedupe + emit real-time + delta flag
    if (meta.groupId) {
      if (queueComboGift(session, d, meta, emitGift,
          () => session.stopped || session.detached || hostSessions.get(clientId) !== session, 1500)) return;
    }

    // Non-combo path — dedupe by eventId / fingerprint
    if (rememberEventId(session, 'gift', d)) {
      if (true) console.log(`[Gift Skipped] reason=event-id-duplicate user=${d?.uniqueId || 'anonymous'} count=${meta.repeatCount}`);
      return;
    }
    if (!getTikTokEventId(d) && rememberGiftFingerprint(session, d, 1800)) {
      if (true) console.log(`[Gift Skipped] reason=fingerprint-duplicate user=${d?.uniqueId || 'anonymous'} count=${meta.repeatCount}`);
      return;
    }
    emitGift(d, meta);
  });

  connection.on('like', d => { if (session.stopped || session.detached || hostSessions.get(clientId) !== session || rememberEventId(session, 'like', d)) return; const count = eventLikeCount(d); session.likes += count; saveHostRecord(session, true); wss.sendToSession(clientId, 'like', {username: d.uniqueId || d.nickname || 'anonymous', userId: d.userId, count, likeCount: count, totalLikes: session.likes, sourceEventId: getTikTokEventId(d), tiktok, hostId}); });
  connection.on('follow', d => { if (session.stopped || session.detached || hostSessions.get(clientId) !== session || rememberEventId(session,'follow',d)) return; if (!rememberUserOnce(session,'followed',d)) return; saveHostRecord(session,true); wss.sendToSession(clientId,'follow',{username:d.uniqueId||'anonymous',userId:d.userId,sourceEventId:getTikTokEventId(d),tiktok,hostId}); });
  connection.on('share', d => { if (session.stopped || session.detached || hostSessions.get(clientId) !== session || rememberEventId(session,'share',d)) return; const u=getTikTokUserKey(d); const now=Date.now(); const last=session.shareEvents.get(u)||0; if (u && now-last < 5000) return; if (u) session.shareEvents.set(u,now); wss.sendToSession(clientId,'share',{username:d.uniqueId||'anonymous',userId:d.userId,sourceEventId:getTikTokEventId(d),tiktok,hostId}); });
  connection.on('member', d => { if (session.stopped || session.detached || hostSessions.get(clientId) !== session || rememberEventId(session,'join',d)) return; if (!rememberUserOnce(session,'joined',d)) return; wss.sendToSession(clientId,'join',{username:d.uniqueId||'anonymous',nickname:d.nickname,userId:d.userId,sourceEventId:getTikTokEventId(d),tiktok,hostId}); });
  connection.on('roomUser', d => { if (!session.stopped && !session.detached && d.viewerCount) wss.sendToSession(clientId,'viewers',{viewerCount:d.viewerCount,tiktok,hostId}); });
  connection.on('streamEnd', () => { if (!session.stopped && !session.detached) { session.status='offline'; session.followed.clear(); session.subscribed.clear(); session.joined.clear(); session.seenEventIds.clear(); session.shareEvents.clear(); session.giftStreaks.clear(); session.completedGiftGroups.clear(); saveHostRecord(session,true); wss.sendToSession(clientId,'host_status',{status:'offline',live:false,hostId,tiktok}); wss.sendToSession(clientId,'live_status',{live:false,tiktok,tiktokUsername:tiktok,hostId}); whatsappBot?.notifyLiveEnd(tiktok).catch(() => {}); } });
  connection.on('disconnected', () => {
    if (!session.stopped && !session.detached) {
      session.status = 'reconnecting';
      session.giftStreaks.clear();
      saveHostRecord(session, true);
      wss.sendToSession(clientId, 'host_status', {status:'reconnecting', hostId, tiktok});
      if (hostSessions.get(clientId) === session) hostSessions.delete(clientId);
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.reconnectTimer = setTimeout(async () => {
        session.reconnectTimer = null;
        if (session.stopped || session.detached || hostSessions.has(clientId) || !wss.getClientInfo(clientId)) return;
        if (Date.now() >= session.retryUntil) {
          wss.sendToSession(clientId, 'host_status', {status:'offline', live:false, hostId, tiktok, message:'Batas reconnect TikTok tercapai.'});
          return;
        }
        await startHostedTikTok(clientId, {tiktok, retryUntil:session.retryUntil});
      }, 5000);
    }
  });
  connection.on('error', e => {
    if (!session.stopped && !session.detached) {
      wss.sendToSession(clientId,'host_status',{status:'error',hostId,tiktok,message:e?.message || String(e)});
    }
  });
  try {
    let connectTimer;
    try {
      await Promise.race([
        connection.connect(),
        new Promise((_, reject) => { connectTimer = setTimeout(() => reject(new Error('Timeout koneksi TikTok setelah 20 detik')), 20000); })
      ]);
    } finally { if (connectTimer) clearTimeout(connectTimer); }
    if (!session.stopped && !session.detached && hostSessions.get(clientId) === session) {
      live();
      console.log(`✅ TikTok LIVE terhubung: @${tiktok} → ${hostId}`);
    }
  } catch (e) {
    if (hostSessions.get(clientId)===session && !session.stopped && !session.detached) {
      const reason = e?.message || String(e);
      saveHostRecord(session,true);
      if (Date.now() < session.retryUntil) {
        session.status='reconnecting';
        console.warn(`TikTok @${tiktok} connection failed: ${reason}; retrying in 5 seconds.`);
        wss.sendToSession(clientId,'host_status',{status:'reconnecting',live:false,hostId,tiktok,message:reason});
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer = setTimeout(async () => {
          session.reconnectTimer = null;
          if (session.stopped || session.detached || hostSessions.get(clientId) !== session) return;
          await stopHostedTikTok(clientId, false);
          await startHostedTikTok(clientId, {tiktok, retryUntil:session.retryUntil});
        }, 5000);
      } else {
        session.status='offline';
        console.error(`TikTok @${tiktok} could not connect after 20 minutes: ${reason}`);
        wss.sendToSession(clientId,'host_status',{status:'offline',live:false,hostId,tiktok,message:reason});
      }
    }
  }
}


class MinecraftOutboundBridge {
  constructor(host, port) {
    this.host = host;
    this.port = Number(port);
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.connecting = false;
  }
  url() { return `ws://${this.host}:${this.port}`; }
  connect() {
    if (this.stopped || this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    this.connecting = true;
    const url = this.url();
    console.log(`🔗 Minecraft outbound bridge → ${url}`);
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.connecting = false;
      console.log('✅ Terhubung ke CubicCraft hosting (outbound).');
      this.send({ type:'bridge_hello', event:'bridge_hello', protocol:1, node:'TIKTOMC-3.3' });
    });
    this.ws.on('message', async raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'host_start' || data.event === 'host_start') await startHostedTikTokBridge(data);
        else if (data.type === 'host_stop' || data.event === 'host_stop') await stopHostedTikTokBridge(data.playerUUID, true);
        else if (data.type === 'ping' || data.event === 'ping') this.send({type:'pong', event:'pong', timestamp:Date.now()});
      } catch (e) { console.warn('⚠️ Bridge message invalid:', e.message); }
    });
    this.ws.on('close', () => {
      this.connecting = false;
      console.log('⚠️ Koneksi CubicCraft outbound terputus.');
      for (const session of hostSessions.values()) {
        if (session.mode === 'bridge') {
          try { session.connection?.disconnect(); } catch (_) {}
        }
      }
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), CONFIG.MINECRAFT_RECONNECT_DELAY || 5000);
      }
    });
    this.ws.on('error', e => { this.connecting = false; console.warn('⚠️ Minecraft bridge:', e.message); });
  }
  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({...data, timestamp: data.timestamp || Date.now()}));
    return true;
  }
  stop() { this.stopped = true; clearTimeout(this.reconnectTimer); try { this.ws?.close(); } catch (_) {} }
}

function bridgeSend(event, data = {}) {
  if (!minecraftBridge) return false;
  return minecraftBridge.send({type:'event', event, ...data});
}

async function startHostedTikTokBridge(data = {}) {
  const playerUUID = String(data.playerUUID || '').trim();
  const playerName = data.playerName || null;
  const tiktok = String(data.tiktok || '').replace(/^@/, '').trim();
  if (!playerUUID || !tiktok) {
    bridgeSend('host_status', {playerUUID, status:'error', message:'playerUUID atau username TikTok kosong.'});
    return false;
  }

  if (tiktokConnection && tiktokConnection.connection) {
    const legacyConnection = tiktokConnection.connection;
    tiktokConnection.connection = null;
    try { legacyConnection.disconnect(); } catch (_) { }
    reconnectSystem.isReconnecting = false;
    if (reconnectSystem.reconnectTimer) {
      clearTimeout(reconnectSystem.reconnectTimer);
      reconnectSystem.reconnectTimer = null;
    }
  }

  const key = `bridge:${playerUUID}`;
  const retryUntil = Number(data.retryUntil) || (Date.now() + 20 * 60 * 1000);
  const existing = hostSessions.get(key);
  if (existing && !existing.stopped && existing.tiktok.toLowerCase() === tiktok.toLowerCase() && !['offline','error'].includes(String(existing.status || '').toLowerCase())) {
    existing.detached = false;
    if (existing.reconnectTimer) { clearTimeout(existing.reconnectTimer); existing.reconnectTimer = null; }
    bridgeSend('host_status', {playerUUID, playerName, status:existing.status || 'connecting', hostId:existing.hostId, tiktok:existing.tiktok});
    return true;
  }
  await stopOtherHostSessionsForPlayer(playerUUID, key);

  for (const [id, session] of hostSessions) {
    if (!session.stopped && session.tiktok.toLowerCase() === tiktok.toLowerCase() && id !== key) {
      bridgeSend('host_status', {playerUUID, playerName, status:'error', message:`@${tiktok} sedang digunakan player lain.`});
      return false;
    }
  }
  if (existing) await stopHostedTikTokBridge(playerUUID, false);

  const restored = restoreSessionData(playerUUID, tiktok);
  const hostId = restored?.hostId || makeHostId();
  const session = {
    mode:'bridge', clientId:key, playerUUID, playerName, hostId, tiktok,
    connection:null, status:'connecting', stopped:false, detached:false,
    reconnectTimer:null, retryUntil, likes:restored?.likes || 0,
    followed:new Set(), subscribed:new Set(), joined:new Set(), seenEventIds:new Map(), shareEvents:new Map(),
    gifts:restored?.gifts || new Map(),
    giftStreaks:new Map(),
    completedGiftGroups:new Map()
  };
  hostSessions.set(key, session);
  saveHostRecord(session, true);
  bridgeSend('host_status', {playerUUID, playerName, status:'connecting', hostId, tiktok});

  const makeConnection = () => new TikTokLiveConnection(tiktok, {
    processInitialData:false,
    ...(CONFIG.TIKTOK_API_KEY && CONFIG.TIKTOK_API_KEY.trim() && {signApiKey:CONFIG.TIKTOK_API_KEY.trim()})
  });

  const sendEvent = (type, data = {}) => {
    if (session.stopped || session.detached || hostSessions.get(key) !== session) return false;
    const payload = {
      ...data,
      playerUUID,
      playerName,
      tiktok,
      hostId
    };
    return bridgeSend(type, payload);
  };

  const live = () => {
    if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
    if (session.status === 'live') return;
    if (session.status === 'offline') { session.followed.clear(); session.subscribed.clear(); session.joined.clear(); session.seenEventIds.clear(); session.shareEvents.clear(); session.giftStreaks.clear(); session.completedGiftGroups.clear(); }
    session.status='live';
    saveHostRecord(session,true);
    sendEvent('host_status',{status:'live',live:true});
    sendEvent('live_status',{live:true,tiktokUsername:tiktok});
    whatsappBot?.notifyLiveStart(tiktok).catch(() => {});
  };

  const wireConnection = (connection) => {
    session.connection = connection;

    connection.on('chat', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
      const u=eventUser(d);
      const message=eventMessage(d);
      sendEvent('chat',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,message,comment:message,content:message,text:message,sourceEventId:getTikTokEventId(d)});
    });

    // ===== GIFT HANDLER (BRIDGE MODE) — REAL-TIME =====
    connection.on('gift', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
      const meta = getTikTokGiftMeta(d);
      if (true) console.log(`[Gift Raw] owner=${playerUUID} user=${d?.uniqueId || d?.nickname || 'anonymous'} meta=${JSON.stringify(meta)} payload=${JSON.stringify(d).slice(0,6000)}`);

      const emitGift = (giftData, giftMeta) => {
        if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
        const count = Number(giftMeta.repeatCount) || 0;
        if (count <= 0) return;
        const u = eventUser(giftData);
        const g = eventGift(giftData);
        const keyGift = String(g.id || g.name || '0');
        session.gifts.set(keyGift, (session.gifts.get(keyGift) || 0) + count);
        saveHostRecord(session, true);
        if (true) console.log(`[Gift Accepted] owner=${playerUUID} user=${u.uniqueId || 'anonymous'} id=${g.id} count=${count} group=${giftMeta.groupId || '-'} delta=${!!giftMeta.giftDelta}`);
        sendEvent('gift', {
          username: u.uniqueId || u.nickname || 'anonymous', uniqueId: u.uniqueId, nickname: u.nickname,
          userId: u.userId, giftName: g.name || 'Unknown', giftId: g.id,
          count, repeatCount: count, rawRepeatCount: count, repeatEnd: giftMeta.repeatEnd,
          coin: g.coin, diamondCount: g.coin, totalCoin: g.coin * count,
          giftGroupId: giftMeta.groupId, giftDelta: !!giftMeta.giftDelta,
          sourceEventId: getTikTokEventId(giftData)
        });
      };

      if (meta.groupId) {
        if (queueComboGift(session, d, meta, emitGift,
            () => session.stopped || session.detached || hostSessions.get(key) !== session, 1500)) return;
      }

      if (rememberEventId(session, 'gift', d)) {
        if (true) console.log(`[Gift Skipped] reason=event-id-duplicate user=${d?.uniqueId || 'anonymous'} count=${meta.repeatCount}`);
        return;
      }
      if (!getTikTokEventId(d) && rememberGiftFingerprint(session, d, 1800)) {
        if (true) console.log(`[Gift Skipped] reason=fingerprint-duplicate user=${d?.uniqueId || 'anonymous'} count=${meta.repeatCount}`);
        return;
      }
      emitGift(d, meta);
    });

    connection.on('like', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || rememberEventId(session,'like',d)) return;
      const u=eventUser(d),count=eventLikeCount(d);
      session.likes+=count;
      saveHostRecord(session,true);
      sendEvent('like',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,count,likeCount:count,totalLikes:session.likes,sourceEventId:getTikTokEventId(d)});
    });

    connection.on('follow', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || rememberEventId(session,'follow',d)) return;
      const u=eventUser(d);
      if (!rememberUserOnce(session,'followed',d)) return;
      sendEvent('follow',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,sourceEventId:getTikTokEventId(d)});
    });

    connection.on('share', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || rememberEventId(session,'share',d)) return;
      const u=eventUser(d), shareKey=getTikTokUserKey(d), now=Date.now();
      const last=session.shareEvents.get(shareKey)||0; if (shareKey && now-last < 5000) return; if (shareKey) session.shareEvents.set(shareKey,now);
      sendEvent('share',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,sourceEventId:getTikTokEventId(d)});
    });

    connection.on('subscribe', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || rememberEventId(session,'subscribe',d)) return;
      const u=eventUser(d); if (!rememberUserOnce(session,'subscribed',d)) return;
      sendEvent('subscribe',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,sourceEventId:getTikTokEventId(d)});
    });

    connection.on('member', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || rememberEventId(session,'join',d)) return;
      const u=eventUser(d); if (!rememberUserOnce(session,'joined',d)) return;
      sendEvent('join',{username:u.uniqueId||u.nickname||'anonymous',uniqueId:u.uniqueId,nickname:u.nickname,userId:u.userId,sourceEventId:getTikTokEventId(d)});
    });

    connection.on('roomUser', d => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session || !d.viewerCount) return;
      sendEvent('viewers',{viewerCount:d.viewerCount});
    });

    connection.on('streamEnd', () => {
      if (session.stopped || hostSessions.get(key) !== session) return;
      session.status='offline';
      session.followed.clear(); session.subscribed.clear(); session.joined.clear(); session.seenEventIds.clear(); session.shareEvents.clear();
      session.giftStreaks.clear(); session.completedGiftGroups.clear();
      saveHostRecord(session,true);
      sendEvent('host_status',{status:'offline',live:false});
      sendEvent('live_status',{live:false,tiktokUsername:tiktok});
      whatsappBot?.notifyLiveEnd(tiktok).catch(() => {});
    });

    connection.on('disconnected', () => {
      if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
      session.status='reconnecting';
      session.connection=null;
      session.giftStreaks.clear();
      saveHostRecord(session,true);
      sendEvent('host_status',{status:'reconnecting'});
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.reconnectTimer=setTimeout(async () => {
        session.reconnectTimer=null;
        if (session.stopped || session.detached || hostSessions.get(key) !== session) return;
        try {
          const next=makeConnection();
          wireConnection(next);
          let retryConnectTimer;
          try { await Promise.race([next.connect(), new Promise((_, reject) => { retryConnectTimer = setTimeout(() => reject(new Error('Timeout koneksi TikTok setelah 20 detik')), 20000); })]); }
          finally { if (retryConnectTimer) clearTimeout(retryConnectTimer); }
          if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
            live();
            console.log(`🔄 TikTok LIVE reconnect: @${tiktok} → ${hostId}`);
          }
        } catch (e) {
          if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
            session.status='offline';
            saveHostRecord(session,true);
            sendEvent('host_status',{status:'offline',live:false,message:e?.message||String(e)});
            session.reconnectTimer=setTimeout(() => {
              session.reconnectTimer=null;
              if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
                startHostedTikTokBridge({playerUUID,playerName,tiktok,retryUntil:session.retryUntil});
              }
            },5000);
          }
        }
      },5000);
    });

    connection.on('error', e => {
      if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
        sendEvent('host_status',{status:'error',message:e?.message||String(e)});
      }
    });
  };

  const connection=makeConnection();
  wireConnection(connection);
  try {
    let connectTimer;
    try {
      await Promise.race([
        connection.connect(),
        new Promise((_, reject) => { connectTimer = setTimeout(() => reject(new Error('Timeout koneksi TikTok setelah 20 detik')), 20000); })
      ]);
    } finally { if (connectTimer) clearTimeout(connectTimer); }
    if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
      live();
      console.log(`✅ TikTok LIVE terhubung: @${tiktok} → ${hostId}`);
    }
  } catch(e) {
    if (hostSessions.get(key)===session && !session.stopped && !session.detached) {
      const reason=e?.message||String(e);
      saveHostRecord(session,true);
      if (Date.now() < session.retryUntil) {
        session.status='offline';
        console.warn(`⚠️ Gagal konek TikTok @${tiktok}: ${reason}. Coba ulang otomatis dalam 5 detik (maksimal 20 menit).`);
        sendEvent('host_status',{status:'reconnecting',live:false,message:reason});
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer=setTimeout(() => {
          session.reconnectTimer=null;
          if (!session.stopped && !session.detached && hostSessions.get(key) === session) {
            startHostedTikTokBridge({playerUUID,playerName,tiktok,retryUntil:session.retryUntil});
          }
        }, 5000);
      } else {
        session.status='offline';
        console.error(`❌ Gagal konek TikTok @${tiktok} setelah 20 menit: ${reason}`);
        sendEvent('host_status',{status:'offline',live:false,message:`Gagal terhubung setelah 20 menit: ${reason}`});
      }
    }
  }
  return true;
}

async function stopHostedTikTokBridge(playerUUID, notify=true) {
  const key=`bridge:${String(playerUUID||'')}`;
  const session=hostSessions.get(key);
  if(!session)return false;
  session.stopped=true; if(session.reconnectTimer)clearTimeout(session.reconnectTimer);
  try{session.connection?.disconnect();}catch(_){ }
  saveHostRecord(session,false); hostSessions.delete(key);
  if(notify)bridgeSend('host_status',{playerUUID,playerName:session.playerName,status:'stopped',hostId:session.hostId,tiktok:session.tiktok});
  return true;
}

async function stopOtherHostSessionsForPlayer(playerUUID, keepId) {
  if (!playerUUID) return;
  for (const [id, session] of [...hostSessions.entries()]) {
    if (id === keepId || session.stopped) continue;
    if (String(session.playerUUID || '').toLowerCase() !== String(playerUUID).toLowerCase()) continue;
    if (String(id).startsWith('bridge:')) {
      await stopHostedTikTokBridge(session.playerUUID, false);
    } else {
      await stopHostedTikTok(id, false);
    }
    console.log(`[Host Guard] Stopped overlapping TikTok host session for player ${playerUUID} (${id}).`);
  }
}

function createTikTokConnection() {
  tiktokConnection = {
    connection: null,

    connect: async (username, port, tiktokApiKey = null) => {
      throw new Error('Koneksi TikTok global dinonaktifkan. Gunakan HOST TIKTOK per-player/per-area melalui CC Setting.');
    },

    disconnect: () => {
      if (tiktokConnection.connection) {
        tiktokConnection.connection.disconnect();
      }
    }
  };

  return tiktokConnection;
}

const Dashboard = {
  render: () => {
    if (!FEATURES.DASHBOARD) return;
    
    console.clear();
    
    const width = Utils.getTerminalWidth();
    const height = Utils.getTerminalHeight();
    const localIP = Utils.getLocalIP();
    const sensedIP = Utils.getSensedIP(localIP);
    
    const compactMode = height < 20 || width < 70;
    
    console.log('');
    
    const topBorder = Utils.createHorizonLine(width, 'cyan');
    if (topBorder) console.log(topBorder);
    
    const title = ' TIKTOK LIVE WEBSOCKET BRIDGE ';
    const titlePadding = Math.max(0, Math.floor((width - title.length) / 2));
    const titleLine = '│' + ' '.repeat(titlePadding) + chalk.hex(COLORS.primary).bold(title) + ' '.repeat(Math.max(0, width - title.length - titlePadding - 2)) + '│';
    console.log(titleLine);
    
    const versionText = `v${updateNotifier?.currentVersion || '3.0.0'} | by @MCPAKEL`;
    const versionPadding = Math.max(0, width - versionText.length - 4);
    console.log('│' + ' '.repeat(versionPadding) + chalk.hex(COLORS.gray)(versionText) + ' '.repeat(Math.max(0, width - versionText.length - versionPadding - 2)) + '│');
    
    const headerBorder = Utils.createHorizonLine(width, 'cyan');
    if (headerBorder) console.log(headerBorder);
    
    if (updateNotifier && updateNotifier.latestUpdate && updateNotifier.latestUpdate.hasUpdate) {
      const updateLines = updateNotifier.getUpdateNotification(width);
      if (updateLines) {
        updateLines.forEach(line => console.log(line));
        console.log('');
      }
    }
    
    console.log('│' + ' '.repeat(width - 2) + '│');
    
    const networkInfo = [
      { icon: '🌐', label: 'API', value: `${chalk.cyan(`${sensedIP}:${CONFIG.API_PORT}`)}` },
      { icon: '🔌', label: 'WS', value: `${chalk.cyan(`${sensedIP}:${CONFIG.WS_PORT}`)}` },
      { icon: '🖥️', label: 'PID', value: `${chalk.yellow(process.pid)}` }
    ];
    
    const networkLine = networkInfo.map(info => `${info.icon} ${info.label}: ${info.value}`).join('   ');
    const networkPadding = Math.max(0, width - networkLine.length - 4);
    console.log('│' + ' '.repeat(Math.floor(networkPadding / 2)) + networkLine + ' '.repeat(Math.max(0, width - networkLine.length - Math.floor(networkPadding / 2) - 2)) + '│');
    
    console.log('│' + ' '.repeat(width - 2) + '│');
    
    let tiktokStatusText = '';
    let tiktokStatusIcon = '';
    let tiktokStatusColor = chalk.white;
    
    switch(reconnectSystem.status.tiktok) {
      case STATUS.CONNECTED:
        tiktokStatusText = 'LIVE';
        tiktokStatusIcon = '🔴';
        tiktokStatusColor = chalk.green.bold;
        break;
      case STATUS.RECONNECTING:
        tiktokStatusText = 'RECONNECTING';
        tiktokStatusIcon = '⟳';
        tiktokStatusColor = chalk.yellow.bold;
        break;
      case STATUS.DISCONNECTED:
        tiktokStatusText = 'DISCONNECTED';
        tiktokStatusIcon = '○';
        tiktokStatusColor = chalk.red;
        break;
      case STATUS.OFFLINE:
        tiktokStatusText = 'OFFLINE';
        tiktokStatusIcon = '✗';
        tiktokStatusColor = chalk.red.bold;
        break;
    }
    
    let wsStatusText = '';
    let wsStatusIcon = '';
    let wsStatusColor = chalk.white;
    
    switch(reconnectSystem.status.ws) {
      case STATUS.CONNECTED:
        wsStatusText = `${wss?.getClientCount() || 0} CLIENT${wss?.getClientCount() !== 1 ? 'S' : ''}`;
        wsStatusIcon = '🔌';
        wsStatusColor = chalk.green.bold;
        break;
      case STATUS.DISCONNECTED:
        wsStatusText = 'NO CLIENTS';
        wsStatusIcon = '○';
        wsStatusColor = chalk.red;
        break;
    }
    
    const statusLeft = `${tiktokStatusIcon} TIKTOK: ${tiktokStatusColor(tiktokStatusText)}`;
    const statusRight = `${wsStatusIcon} MINECRAFT: ${wsStatusColor(wsStatusText)}`;
    console.log(Utils.leftRight(statusLeft, statusRight, width));
    
    const usernameDisplay = chalk.hex(COLORS.cyan).bold('@' + liveStats.stats.username);
    const nicknameDisplay = liveStats.stats.nickname !== liveStats.stats.username ? ` (${liveStats.stats.nickname})` : '';
    const duration = chalk.hex(COLORS.gray)(`⏱️ ${liveStats.getDuration()}`);
    
    console.log(Utils.leftRight(
      `👤 ${usernameDisplay}${nicknameDisplay}`,
      duration,
      width
    ));
    
    if (reconnectSystem.status.message) {
      console.log('');
      console.log(chalk.hex(COLORS.warning)('  ⚠️ ') + chalk.yellow(reconnectSystem.status.message));
    }
    
    console.log('');
    console.log(chalk.hex(COLORS.grayLight)('  ' + '─'.repeat(width - 4)));
    console.log('');
    
    const stats = {
      gifts: { value: liveStats.stats.gifts, icon: '🎁', color: 'gift', label: 'GIFTS' },
      likes: { value: liveStats.stats.likes, icon: '❤️', color: 'like', label: 'LIKES' },
      follows: { value: liveStats.stats.follows, icon: '👥', color: 'follow', label: 'FOLLOWS' },
      chats: { value: liveStats.stats.chats, icon: '💬', color: 'chat', label: 'CHATS' },
      joins: { value: liveStats.stats.joins, icon: '📥', color: 'join', label: 'JOINS' },
      shares: { value: liveStats.stats.shares, icon: '🔄', color: 'share', label: 'SHARES' }
    };
    
    const giftValueFormatted = Utils.formatNumber(liveStats.stats.totalGiftValue);
    
    if (compactMode) {
      const statsArray = Object.values(stats);
      for (let i = 0; i < statsArray.length; i += 2) {
        const left = statsArray[i];
        const right = statsArray[i + 1];
        if (right) {
          console.log(Utils.leftRight(
            `${left.icon} ${chalk.hex(COLORS[left.color]).bold(Utils.formatNumberCompact(left.value))} ${left.label}`,
            `${right.icon} ${chalk.hex(COLORS[right.color]).bold(Utils.formatNumberCompact(right.value))} ${right.label}`,
            width
          ));
        } else {
          console.log(Utils.leftRight(
            `${left.icon} ${chalk.hex(COLORS[left.color]).bold(Utils.formatNumberCompact(left.value))} ${left.label}`,
            '',
            width
          ));
        }
      }
      
      console.log('');
      console.log(Utils.leftRight(
        `💎 TOTAL GIFT VALUE: ${chalk.hex(COLORS.gift).bold(Utils.formatNumber(giftValueFormatted))}`,
        `📊 API: ${tikTokMCAPI?.sseClients.size || 0}`,
        width
      ));
    } else {
      const statsArray = Object.values(stats);
      
      const row1 = statsArray.slice(0, 3);
      console.log('  ' + row1.map(s => {
        const value = Utils.formatNumber(s.value);
        const valueStr = value.length > 7 ? Utils.formatNumberCompact(s.value) : value;
        return `${s.icon} ${chalk.hex(COLORS[s.color]).bold(valueStr.padStart(8))} ${chalk.hex(COLORS.grayLight)(s.label)}`;
      }).join('   '));
      
      const row2 = statsArray.slice(3, 6);
      console.log('  ' + row2.map(s => {
        const value = Utils.formatNumber(s.value);
        const valueStr = value.length > 7 ? Utils.formatNumberCompact(s.value) : value;
        return `${s.icon} ${chalk.hex(COLORS[s.color]).bold(valueStr.padStart(8))} ${chalk.hex(COLORS.grayLight)(s.label)}`;
      }).join('   '));
      
      console.log('');
      
      const giftValueLine = `  💎 TOTAL GIFT VALUE: ${chalk.hex(COLORS.gift).bold(Utils.formatNumber(giftValueFormatted))}`;
      const apiClientsLine = `📊 API CLIENTS: ${chalk.cyan(tikTokMCAPI?.sseClients.size || 0)}`;
      const filterLine = FEATURES.FILTER_KATA ? `📝 FILTER: ${chalk.hex(COLORS.grayLight)(filterSystem.badWords.length + ' words')}` : '';
      
      const giftPadding = Math.max(0, width - giftValueLine.length - 4);
      console.log(giftValueLine + ' '.repeat(giftPadding) + apiClientsLine);
      if (filterLine) {
        console.log('  ' + filterLine);
      }
    }
    
    console.log('');
    
    if (FEATURES.TOP_GIFTERS) {
      const topGifters = liveStats.getTopGifters(3);
      
      console.log(chalk.hex(COLORS.secondary).bold('  🏆 TOP GIFTERS'));
      console.log(chalk.hex(COLORS.grayLight)('  ' + '─'.repeat(Math.min(40, width - 4))));
      
      if (topGifters.length > 0) {
        topGifters.forEach(([name, total], idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
          const medalColor = idx === 0 ? chalk.yellow : (idx === 1 ? chalk.hex('#C0C0C0') : chalk.hex('#CD7F32'));
          const nameDisplay = name.length > 14 ? name.substring(0, 12) + '..' : name.padEnd(14);
          const totalFormatted = Utils.formatNumber(total);
          
          if (compactMode) {
            console.log(`  ${medalColor(medal)} ${chalk.cyan(nameDisplay)} ${chalk.hex(COLORS.gift).bold(totalFormatted)} 💎`);
          } else {
            const progressPercentage = Math.min(100, (total / (topGifters[0][1] || 1)) * 100);
            const progressBar = Utils.createProgressBar(progressPercentage, 20, 'gift');
            console.log(`  ${medalColor(medal)} ${chalk.cyan(nameDisplay.padEnd(14))} ${chalk.hex(COLORS.gift).bold(totalFormatted.padStart(10))} 💎  ${progressBar}`);
          }
        });
      } else {
        console.log(chalk.hex(COLORS.grayLight)('  ✨ Belum ada gift masuk ✨'));
      }
      
      console.log('');
    }
    
    console.log(chalk.hex(COLORS.grayLight)('  ' + '─'.repeat(width - 4)));
    console.log('');
    
    if (FEATURES.ACTIVITY_LOG) {
      console.log(chalk.hex(COLORS.primary)('  📋 RECENT ACTIVITY'));
      console.log(chalk.hex(COLORS.grayLight)('  ' + '─'.repeat(Math.min(40, width - 4))));
      console.log('');
      
      if (liveStats.logBuffer.length === 0) {
        console.log(chalk.hex(COLORS.grayLight)('  ✨ Menunggu aktivitas dari TikTok LIVE... ✨'));
      } else {
        const maxLogs = compactMode ? 4 : 8;
        const recentLogs = liveStats.logBuffer.slice(-maxLogs);
        
        recentLogs.forEach(log => {
          let icon = '•';
          let iconColor = chalk.white;
          let actorColor = chalk.white;
          let actionColor = chalk.white;
          
          switch(log.type) {
            case 'gift': 
              icon = '🎁'; 
              iconColor = chalk.hex(COLORS.gift);
              actorColor = chalk.hex(COLORS.gift);
              actionColor = chalk.hex(COLORS.gift);
              break;
            case 'like': 
              icon = '❤️'; 
              iconColor = chalk.hex(COLORS.like);
              actorColor = chalk.hex(COLORS.like);
              actionColor = chalk.hex(COLORS.like);
              break;
            case 'follow': 
              icon = '👥'; 
              iconColor = chalk.hex(COLORS.follow);
              actorColor = chalk.hex(COLORS.follow);
              actionColor = chalk.hex(COLORS.follow);
              break;
            case 'chat': 
              icon = '💬'; 
              iconColor = chalk.hex(COLORS.chat);
              actorColor = chalk.hex(COLORS.chat);
              actionColor = chalk.white;
              break;
            case 'join': 
              icon = '📥'; 
              iconColor = chalk.hex(COLORS.join);
              actorColor = chalk.hex(COLORS.join);
              actionColor = chalk.hex(COLORS.join);
              break;
            case 'share': 
              icon = '🔄'; 
              iconColor = chalk.hex(COLORS.share);
              actorColor = chalk.hex(COLORS.share);
              actionColor = chalk.hex(COLORS.share);
              break;
          }
          
          const time = chalk.hex(COLORS.gray)(`[${log.time}]`);
          const actorDisplay = log.actor.length > 12 ? log.actor.substring(0, 10) + '..' : log.actor.padEnd(12);
          const actor = actorColor(actorDisplay);
          
          let actionDisplay = log.action;
          const maxActionLen = compactMode ? 25 : 35;
          if (actionDisplay.length > maxActionLen) {
            actionDisplay = actionDisplay.substring(0, maxActionLen - 3) + '...';
          }
          
          if (compactMode) {
            console.log(`  ${iconColor(icon)} ${time} ${actor} ${actionColor(actionDisplay.substring(0, 20))}`);
          } else {
            console.log(`  ${iconColor(icon)} ${time} ${actor}  ${actionColor(actionDisplay)}`);
          }
        });
      }
      
      console.log('');
    }
    
    console.log(chalk.hex(COLORS.grayLight)('  ' + '─'.repeat(width - 4)));
    console.log('');
    
    const wsUrl = `ws://${sensedIP}:${liveStats.stats.port}`;
    const apiUrl = `http://${sensedIP}:${CONFIG.API_PORT}`;
    const sseUrl = `${apiUrl}/sse`;
    const dashboardUrl = `${apiUrl}/public`;
    
    if (compactMode) {
      console.log(`  🔌 ${chalk.cyan(wsUrl)}`);
      console.log(`  📊 ${chalk.cyan(apiUrl)}`);
      console.log(`  🌐 ${chalk.cyan(dashboardUrl)}`);
      console.log(`  📡 ${chalk.cyan(sseUrl)}`);
    } else {
      console.log(Utils.leftRight(
        `🔌 ${chalk.cyan(wsUrl)}`,
        `📊 ${chalk.cyan(apiUrl)}`,
        width
      ));
      console.log(Utils.leftRight(
        `🌐 ${chalk.cyan(dashboardUrl)}`,
        `📡 ${chalk.cyan(sseUrl)}`,
        width
      ));
    }
    
    console.log('');
    
    const uptimeText = `Uptime: ${liveStats.getDuration()}`;
    const helpText = `Press Ctrl+C to exit | !help for commands`;
    console.log(Utils.leftRight(
      `⏱️ ${chalk.hex(COLORS.grayLight)(uptimeText)}`,
      chalk.hex(COLORS.grayLight)(helpText),
      width
    ));
    
    const bottomBorder = Utils.createBottomBorder(width, 'cyan');
    if (bottomBorder) console.log(bottomBorder);
    console.log('');
  }
};

const LoadingUI = {
  frames: ['◜', '◝', '◞', '◟'],
  interval: null,
  currentFrame: 0,
  message: '',
  info: '',
  startTime: null,
  
  start: (message, info = '') => {
    LoadingUI.message = message;
    LoadingUI.info = info;
    LoadingUI.startTime = Date.now();
    LoadingUI.currentFrame = 0;
    
    if (LoadingUI.interval) {
      clearInterval(LoadingUI.interval);
    }
    
    LoadingUI.render();
    LoadingUI.interval = setInterval(() => {
      LoadingUI.currentFrame = (LoadingUI.currentFrame + 1) % LoadingUI.frames.length;
      LoadingUI.render();
    }, 100);
    
    return LoadingUI;
  },
  
  render: () => {
    const width = Utils.getTerminalWidth();
    const frame = LoadingUI.frames[LoadingUI.currentFrame];
    const elapsed = LoadingUI.startTime ? Math.floor((Date.now() - LoadingUI.startTime) / 1000) : 0;
    const elapsedStr = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    
    console.clear();
    console.log('');
    console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('TIKTOK LIVE WEBSOCKET BRIDGE', width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
    console.log('');
    console.log(chalk.cyan(Utils.centerText(`${frame} ${LoadingUI.message} ${frame}`, width)));
    console.log('');
    
    if (LoadingUI.info) {
      console.log(chalk.gray(Utils.centerText(LoadingUI.info, width)));
      console.log('');
    }
    
    const progressWidth = Math.min(40, width - 20);
    const progress = Math.min(100, Math.floor((elapsed / 30) * 100));
    const filled = Math.floor((progress / 100) * progressWidth);
    const empty = progressWidth - filled;
    const progressBar = chalk.cyan('█').repeat(filled) + chalk.gray('░').repeat(empty);
    
    console.log(chalk.white(Utils.centerText(`⏱️  ${elapsedStr}  ${progressBar}`, width)));
    console.log('');
    
    const tipIndex = Math.floor(elapsed / 5) % MESSAGES.TIPS.length;
    console.log(chalk.gray(Utils.centerText(MESSAGES.TIPS[tipIndex], width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
  },
  
  success: (message) => {
    if (LoadingUI.interval) {
      clearInterval(LoadingUI.interval);
      LoadingUI.interval = null;
    }
    
    const width = Utils.getTerminalWidth();
    console.clear();
    console.log('');
    console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('TIKTOK LIVE WEBSOCKET BRIDGE', width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
    console.log('');
    console.log(chalk.green(Utils.centerText('✓ ' + message, width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
    console.log('');
    
    return new Promise(resolve => setTimeout(resolve, 1500));
  },
  
  error: (message, details = '') => {
    if (LoadingUI.interval) {
      clearInterval(LoadingUI.interval);
      LoadingUI.interval = null;
    }
    
    const width = Utils.getTerminalWidth();
    console.clear();
    console.log('');
    console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('TIKTOK LIVE WEBSOCKET BRIDGE', width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
    console.log('');
    console.log(chalk.red(Utils.centerText('✗ ' + message, width)));
    console.log('');
    
    if (details) {
      const lines = [];
      let currentLine = '';
      details.split(' ').forEach(word => {
        if ((currentLine + ' ' + word).length < width - 10) {
          currentLine += (currentLine ? ' ' : '') + word;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      });
      if (currentLine) lines.push(currentLine);
      
      lines.forEach(line => {
        console.log(chalk.white(Utils.centerText(line, width)));
      });
      console.log('');
    }
    
    if (details.includes('rate_limit') || details.includes('Rate Limited')) {
      console.log(chalk.yellow(Utils.centerText('💡 Solusi:', width)));
      console.log(chalk.white(Utils.centerText('1. Gunakan API Key TikTok', width)));
      console.log(chalk.white(Utils.centerText('2. Tunggu beberapa saat', width)));
    } else if (details.includes('Timeout') || details.includes('tidak ditemukan')) {
      console.log(chalk.yellow(Utils.centerText('💡 Solusi:', width)));
      console.log(chalk.white(Utils.centerText('1. Pastikan user sedang LIVE', width)));
      console.log(chalk.white(Utils.centerText('2. Cek koneksi internet', width)));
    }
    
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
  }
};

function showSplashScreen() {
  if (!FEATURES.DASHBOARD) return;
  
  console.clear();
  
  const width = Utils.getTerminalWidth();
  
  console.log('');
  console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('TIKTOK LIVE WEBSOCKET BRIDGE', width)));
  console.log(chalk.gray(Utils.centerText(`Version ${updateNotifier?.currentVersion || '3.0.0'}`, width)));
  console.log('');
  console.log(chalk.white(Utils.centerText('🚀 Menghubungkan TikTok LIVE ke Minecraft / Client WebSocket', width)));
  console.log(chalk.white(Utils.centerText('📡 Real-time events: Chat, Gift, Like, Follow, Share, Join', width)));
  console.log(chalk.white(Utils.centerText('🔌 WebSocket Bridge untuk integrasi dengan aplikasi eksternal', width)));
  console.log('');
  console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
  console.log('');
  console.log(chalk.hex(COLORS.warning)(Utils.centerText('👤 CREATED BY', width)));
  console.log(chalk.cyan(Utils.centerText('TikTok  : @MCPAKEL', width)));
  console.log(chalk.cyan(Utils.centerText('YouTube : Alex Pakel', width)));
  console.log('');
  console.log(chalk.hex(COLORS.warning)(Utils.centerText('❤️ SUPPORT CREATOR', width)));
  console.log(chalk.cyan(Utils.centerText('Donate : https://sociabuzz.com/alexpakell/tribe', width)));
  console.log('');
  console.log(chalk.yellow(Utils.centerText('⚠️ Gunakan dengan bijak & sesuai ketentuan TikTok', width)));
  console.log('');
}

function getConfig() {
  const width = Utils.getTerminalWidth();
  let username = '';
  let tiktokApiKey = '';
  let port = CONFIG.WS_PORT;
  
  while (true) {
    console.clear();
    
    console.log('');
    console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('KONFIGURASI KONEKSI', width)));
    console.log('');
    console.log(chalk.white(Utils.leftRight('👤 TikTok Username:', '', width)));
    console.log(chalk.gray(Utils.leftRight('  └─ Contoh: mcpakel (tanpa @)', '', width)));
    console.log('');
    
    process.stdout.write(chalk.cyan('  @'));
    const input = readline.question('');
    username = input.trim();
    
    if (username) break;
    
    console.log('');
    console.log(chalk.red(Utils.centerText('✗ Username tidak boleh kosong!', width)));
    console.log(chalk.gray(Utils.centerText('Tekan ENTER untuk mencoba lagi...', width)));
    readline.question('');
  }
  
  console.clear();
  console.log('');
  console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('KONFIGURASI KONEKSI', width)));
  console.log('');
  console.log(chalk.white(Utils.leftRight(`👤 Username: ${chalk.cyan('@' + username)}`, '', width)));
  console.log('');
  console.log(chalk.white(Utils.leftRight('🔑 TikTok API Key (Opsional):', '', width)));
  console.log(chalk.gray(Utils.leftRight('  └─ Kosongkan jika tidak punya (rate limit mungkin berlaku)', '', width)));
  console.log('');
  
  process.stdout.write(chalk.cyan('  Key: '));
  tiktokApiKey = readline.question('', { hideEchoBack: false });
  
  console.clear();
  console.log('');
  console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('KONFIGURASI KONEKSI', width)));
  console.log('');
  console.log(chalk.white(Utils.leftRight(`👤 Username: ${chalk.cyan('@' + username)}`, '', width)));
  console.log(chalk.white(Utils.leftRight(`🔑 API Key : ${tiktokApiKey.trim() ? chalk.green('✓ Disertakan') : chalk.yellow('○ Tidak digunakan')}`, '', width)));
  console.log('');
  console.log(chalk.white(Utils.leftRight('🔌 WebSocket Port:', '', width)));
  console.log(chalk.gray(Utils.leftRight(`  └─ Default: ${CONFIG.WS_PORT}`, '', width)));
  console.log('');
  
  process.stdout.write(chalk.cyan(`  Port [${CONFIG.WS_PORT}]: `));
  const portInput = readline.question('');
  port = portInput.trim() ? parseInt(portInput) : CONFIG.WS_PORT;
  
  while (true) {
    console.clear();
    
    console.log('');
    console.log(chalk.hex(COLORS.primary).bold(Utils.centerText('RINGKASAN KONFIGURASI', width)));
    console.log('');
    console.log(chalk.white(Utils.leftRight(`  👤 Username  : ${chalk.cyan('@' + username)}`, '', width)));
    console.log(chalk.white(Utils.leftRight(`  🔑 API Key   : ${tiktokApiKey.trim() ? chalk.green('✓ Disertakan') : chalk.yellow('○ Tidak digunakan')}`, '', width)));
    console.log(chalk.white(Utils.leftRight(`  🔌 Port      : ${chalk.cyan(port)}`, '', width)));
    console.log('');
    console.log(chalk.gray(Utils.centerText('──────────────────────────────────────────────────', width)));
    console.log('');
    console.log(chalk.white('  Pilihan:'));
    console.log(chalk.gray('    [1] Lanjutkan koneksi'));
    console.log(chalk.gray('    [2] Kembali ke username'));
    console.log(chalk.gray('    [3] Keluar'));
    console.log('');
    
    process.stdout.write(chalk.cyan('  Pilih [1/2/3]: '));
    const choice = readline.question('').trim();
    
    if (choice === '1') {
      break;
    } else if (choice === '2') {
      return getConfig();
    } else if (choice === '3') {
      console.log('');
      console.log(chalk.yellow(Utils.centerText('👋 Sampai jumpa!', width)));
      console.log('');
      process.exit(0);
    }
  }
  
  return { username, tiktokApiKey, port };
}

async function main() {
  initializeStores();

  try {
    const mod = await import('tiktok-live-connector');
    TikTokLiveConnection = mod.TikTokLiveConnection || mod.default?.TikTokLiveConnection;
    if (typeof TikTokLiveConnection !== 'function') {
      throw new Error('TikTokLiveConnection tidak tersedia dari tiktok-live-connector');
    }
  } catch (e) {
    console.error('Gagal memuat TikTok Live Connector:', e.message);
    console.error(`Node.js: ${process.versions.node}`);
    if (/Invalid regular expression flags/i.test(String(e && e.message))) {
      console.error('Connector membutuhkan Node.js 20+. Silakan gunakan Node.js 22 LTS di panel.');
    }
    if (true && e && e.stack) {
      console.error(e.stack);
    }
    process.exitCode = 1;
    return;
  }
  
  if (updateNotifier) {
    updateNotifier.checkForUpdates().catch(() => {});
  }
  
  if (!CONFIG.PANEL_MODE) {
    showSplashScreen();
    console.log('');
    console.log(chalk.gray(Utils.centerText('Tekan ENTER untuk melanjutkan ke konfigurasi...', Utils.getTerminalWidth())));
    console.log('');
    readline.question('');
  } else {
    console.log(chalk.cyan('🖥️  PANEL MODE aktif — tanpa input terminal.'));
  }

  tiktokConnection = createTikTokConnection();

  const tiktokApiKey = process.env.TIKTOK_API_KEY || CONFIG.TIKTOK_API_KEY || '';
  const port = Number(process.env.WS_PORT || process.env.SERVER_PORT || process.env.PORT || CONFIG.WS_PORT);
  const mcHost = process.env.MINECRAFT_HOST || CONFIG.MINECRAFT_HOST;
  const mcPort = Number(process.env.MINECRAFT_PORT || CONFIG.MINECRAFT_PORT);
  const outboundEnabled = String(process.env.MINECRAFT_OUTBOUND_ENABLED ?? CONFIG.MINECRAFT_OUTBOUND_ENABLED).toLowerCase() !== 'false';
  const useOutboundOnly = outboundEnabled && !!mcHost && !!mcPort;

  const loadingInfo = tiktokApiKey.trim()
    ? MESSAGES.LOADING.WITH_API_KEY
    : MESSAGES.LOADING.WITHOUT_API_KEY;
  
  LoadingUI.start(MESSAGES.LOADING.CONNECTING, loadingInfo);

  if (!useOutboundOnly) {
    wss = new MinecraftWebSocketServer(port);
    wss.on('error', err => {
      const reason = err?.message || String(err);
      console.error(`Minecraft WebSocket listener error on port ${port}: ${reason}`);
      liveStats.stats.wsConnected = false;
      reconnectSystem.status.ws = STATUS.DISCONNECTED;
    });
    wss.init();
    
    wss.on('client_connected', ({ clientId, total }) => {
      liveStats.stats.wsConnected = true;
      reconnectSystem.status.ws = STATUS.CONNECTED;
      wss.setCurrentStats(liveStats.getStats());
    });

    wss.on('client_disconnected', ({ total }) => {
      if (total === 0) {
        liveStats.stats.wsConnected = false;
        reconnectSystem.status.ws = STATUS.DISCONNECTED;
      }
    });

    wss.on('client_message', async ({ clientId, data }) => {
      if (data.type === 'resume_host' || data.event === 'resume_host' || data.resumeHost === true) {
        const resumed = await resumeHostedTikTok(clientId, data);
        if (!resumed && data.tiktok) await startHostedTikTok(clientId, data);
      } else if (data.type === 'host_start' || data.event === 'host_start') {
        await startHostedTikTok(clientId, data);
      } else if (data.type === 'host_stop' || data.event === 'host_stop') {
        await stopHostedTikTok(clientId);
      }
    });

    wss.on('client_disconnected', async ({ clientId }) => {
      await detachHostedTikTok(clientId);
    });
  } else {
    liveStats.stats.wsConnected = true;
    reconnectSystem.status.ws = STATUS.CONNECTED;
    console.log(`🔌 Outbound-only mode: port ${port} listener dinonaktifkan.`);
  }

  const app = express();
  
  const apiPort = Number(process.env.API_PORT || CONFIG.API_PORT);
  const apiServer = app.listen(apiPort, () => {
    console.log(chalk.green(`API running on port ${apiPort}`));
  });
  apiServer.on('error', err => {
    console.warn(`REST API disabled on port ${apiPort}: ${err?.message || String(err)}`);
  });
  
  tikTokMCAPI = new TikTokMCAPI(
    app, 
    wss, 
    liveStats, 
    followStore, 
    giftStore, 
    filterSystem,
    CONFIG
  );

  whatsappBot = new WhatsAppBot({
    enabled: String(process.env.WHATSAPP_ENABLED ?? CONFIG.WHATSAPP_ENABLED).toLowerCase() !== 'false',
    groupJid: process.env.WHATSAPP_GROUP_JID || CONFIG.WHATSAPP_GROUP_JID,
    groupName: process.env.WHATSAPP_GROUP_NAME || CONFIG.WHATSAPP_GROUP_NAME,
    authDir: process.env.WHATSAPP_SESSION_DIR || CONFIG.WHATSAPP_SESSION_DIR,
    welcome: String(process.env.WHATSAPP_WELCOME ?? CONFIG.WHATSAPP_WELCOME).toLowerCase() !== 'false',
    goodbye: String(process.env.WHATSAPP_GOODBYE ?? CONFIG.WHATSAPP_GOODBYE).toLowerCase() !== 'false',
    liveNotification: String(process.env.WHATSAPP_LIVE_NOTIFICATION ?? CONFIG.WHATSAPP_LIVE_NOTIFICATION).toLowerCase() !== 'false',
    commands: String(process.env.WHATSAPP_COMMANDS ?? CONFIG.WHATSAPP_COMMANDS).toLowerCase() !== 'false',
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || '',
    getLiveSessions: () => [...hostSessions.values()]
      .filter(s => !s.stopped && !s.detached && s.status === 'live')
      .map(s => ({ tiktok: s.tiktok, status: s.status, playerName: s.playerName }))
  });
  if (whatsappBot.enabled) {
    whatsappBot.start().catch(err => console.error(chalk.red('WhatsApp bot:', err.message)));
  }

  if (outboundEnabled && mcHost && mcPort) {
    minecraftBridge = new MinecraftOutboundBridge(mcHost, mcPort);
    minecraftBridge.connect();
  } else {
    console.log(chalk.gray('ℹ️ Minecraft outbound bridge belum dikonfigurasi (MINECRAFT_HOST kosong).'));
  }

  try {
    if (CONFIG.AUTO_TIKTOK_START) {
      console.log(chalk.yellow('AUTO_TIKTOK_START diabaikan: host TikTok harus dimulai dari /cc host.'));
    }
    {
      liveStats.stats.tiktokConnected = false;
      reconnectSystem.status.tiktok = STATUS.DISCONNECTED;
    }
    
    reconnectSystem.reset();
    reconnectSystem.startWSMonitor();
    
    await LoadingUI.success('Node.js bridge siap — menunggu /cc host dari Minecraft.');
    
    if (FEATURES.DASHBOARD && !CONFIG.PANEL_MODE) {
      setTimeout(() => {
        if (renderInterval) clearInterval(renderInterval);
        renderInterval = setInterval(() => Dashboard.render(), CONFIG.REFRESH_INTERVAL);
        Dashboard.render();
      }, 500);
    }

    process.on('SIGINT', async () => {
      console.log('');
      console.log(chalk.yellow(Utils.centerText('👋 Terima kasih telah menggunakan TikTok Live Bridge!', Utils.getTerminalWidth())));
      console.log('');
      for (const clientId of [...hostSessions.keys()]) { if (String(clientId).startsWith('bridge:')) await stopHostedTikTokBridge(String(clientId).slice(7), false); else await stopHostedTikTok(clientId, false); }
      minecraftBridge?.stop();
      await whatsappBot?.stop();
      tiktokConnection.disconnect();
      if (wss) wss.stop();
      if (renderInterval) clearInterval(renderInterval);
      process.exit(0);
    });

  } catch (error) {
    LoadingUI.error(MESSAGES.LOADING.FAILED, error.message);
    
    console.log('');
    console.log(chalk.gray(Utils.centerText('Tekan ENTER untuk kembali ke awal...', Utils.getTerminalWidth())));
    readline.question('');
    main();
  }
}

main();
