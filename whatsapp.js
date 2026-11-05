'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const QRCode = require('qrcode');

/**
 * WhatsApp group assistant for TIKTOMC.
 * FIXES:
 *  - QR selalu ditampilkan saat diterima (tidak lagi diblokir oleh creds.registered)
 *  - Auto-clear auth pada loggedOut agar QR baru bisa dibuat tanpa manual hapus folder
 *  - Pairing code support via env WHATSAPP_PHONE_NUMBER (alternatif QR)
 *  - Reconnect grace untuk conflict/stream error
 *  - Try/catch di semua handler agar satu error tidak mematikan koneksi
 */
class WhatsAppBot {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.groupJid = String(options.groupJid || '').trim();
    this.groupName = String(options.groupName || '').trim();
    this.authDir = path.resolve(options.authDir || './data/whatsapp-auth');
    this.welcome = options.welcome !== false;
    this.goodbye = options.goodbye !== false;
    this.liveNotification = options.liveNotification !== false;
    this.commands = options.commands !== false;
    this.getLiveSessions = typeof options.getLiveSessions === 'function' ? options.getLiveSessions : (() => []);
    this.getTikTokUsername = typeof options.getTikTokUsername === 'function' ? options.getTikTokUsername : (() => '');
    this.phoneNumber = String(
      options.phoneNumber || process.env.WHATSAPP_PHONE_NUMBER || ''
    ).replace(/\D/g, '');
    this.qrSize = String(process.env.WHATSAPP_QR_SIZE || 'small').toLowerCase() === 'full' ? 'full' : 'small';
    this.sock = null;
    this.ready = false;
    this.starting = false;
    this.reconnectTimer = null;
    this.liveStates = new Map();
    this.pendingEndTimers = new Map();
    this.lastStartNotified = new Map();
    this.liveEndGraceMs = Math.max(60_000, Number(options.liveEndGraceMs || 5 * 60_000));
    this.liveStartCooldownMs = Math.max(60_000, Number(options.liveStartCooldownMs || 10 * 60_000));
    this.lastGroupLookup = 0;
    this.api = null;
    this.pairingRequested = false;
    this.pairingFailed = false;
    this._qrPrintedFor = null;
  }

  async loadApi() {
    if (this.api) return this.api;
    const mod = await import('@whiskeysockets/baileys');
    this.api = mod;
    return mod;
  }

  async start() {
    if (!this.enabled || this.starting || this.ready) return false;
    this.starting = true;
    try {
      fs.mkdirSync(this.authDir, { recursive: true });
      const api = await this.loadApi();
      const { state, saveCreds } = await api.useMultiFileAuthState(this.authDir);
      const { DisconnectReason, Browsers, default: makeWASocket } = api;

      // Ambil versi WA Web terbaru; fallback ke default library jika gagal
      let waWebVersion;
      try {
        const fetchVersion = typeof api.fetchLatestWaWebVersion === 'function'
          ? api.fetchLatestWaWebVersion
          : api.fetchLatestBaileysVersion;
        if (typeof fetchVersion === 'function') {
          const latest = await fetchVersion();
          if (Array.isArray(latest?.version)) waWebVersion = latest.version;
        }
      } catch (versionError) {
        console.warn(chalk.yellow(`Tidak dapat mengambil versi WhatsApp Web terbaru; memakai default: ${versionError.message}`));
      }

      const socketOptions = {
        auth: state,
        browser: Browsers.ubuntu('TIKTOMC'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false
      };
      if (waWebVersion) socketOptions.version = waWebVersion;
      this.sock = makeWASocket(socketOptions);

      this.sock.ev.on('creds.update', saveCreds);

      // Request pairing code (jika phone number di-set & belum registered)
      if (!state.creds.registered && this.phoneNumber && !this.pairingRequested) {
        this.pairingRequested = true;
        try {
          await new Promise(r => setTimeout(r, 1500));
          const code = await this.sock.requestPairingCode(this.phoneNumber);
          console.log('');
          console.log(chalk.green('========== PAIRING CODE WHATSAPP ============'));
          console.log(chalk.cyan.bold(`   Kode: ${code}`));
          console.log(chalk.white('   1. Buka WhatsApp di HP'));
          console.log(chalk.white('   2. Perangkat tertaut > Tautkan perangkat'));
          console.log(chalk.white('   3. Pilih "Tautkan dengan nomor telepon"'));
          console.log(chalk.white(`   4. Masukkan kode: ${code}`));
          console.log(chalk.green('==========================================='));
          console.log('');
        } catch (e) {
          console.log(chalk.yellow(`Pairing code gagal (${e.message}). Fallback ke QR.`));
          this.pairingFailed = true;
        }
      }

      this.sock.ev.on('connection.update', async (update) => {
        try {
          const { connection, lastDisconnect, qr } = update;

          // QR display: JANGAN cek creds.registered — Baileys hanya kirim qr
          // saat butuh re-auth. Apapun statusnya, kalau qr datang, harus tampil.
          if (qr) {
            const usePairing = this.phoneNumber && !state.creds.registered && !this.pairingFailed;
            if (!usePairing && this._qrPrintedFor !== qr) {
              this._qrPrintedFor = qr;
              console.log('');
              console.log(chalk.green('========== SCAN QR WHATSAPP =========='));
              console.log(chalk.white('WhatsApp > Perangkat tertaut > Tautkan perangkat'));
              console.log(chalk.white('Pindai QR berikut:'));
              try {
                qrcode.generate(qr, { small: this.qrSize === 'small' }, (terminalQr) => console.log(terminalQr));
              } catch (e) {
                console.log(chalk.red(`Gagal render QR terminal: ${e.message}`));
              }
              try {
                const qrDir = path.resolve('./data');
                fs.mkdirSync(qrDir, { recursive: true });
                const qrFile = path.join(qrDir, 'whatsapp-qr.png');
                await QRCode.toFile(qrFile, qr, { type: 'png', width: 900, margin: 4, errorCorrectionLevel: 'H' });
                console.log(chalk.cyan(`QR PNG tersimpan: ${qrFile}`));
                console.log(chalk.cyan('Buka File Manager > data/whatsapp-qr.png lalu scan dari HP.'));
              } catch (qrFileError) {
                console.warn(chalk.yellow(`Tidak bisa simpan QR PNG: ${qrFileError.message}`));
              }
              console.log(chalk.green('Jika kedaluwarsa, tunggu QR baru otomatis muncul.'));
              console.log(chalk.green('====================================='));
              console.log('');
            }
          }

          if (connection === 'open') {
            this.ready = true;
            this.starting = false;
            this.pairingRequested = false;
            this.pairingFailed = false;
            this._qrPrintedFor = null;
            console.log(chalk.green('✅ WhatsApp bot terhubung.'));
            try { await this.resolveGroup(true); } catch (_) {}
            this.syncLiveStates();
          } else if (connection === 'close') {
            this.ready = false;
            this.starting = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const errMsg = lastDisconnect?.error?.message || 'unknown';

            // 515 — restart setelah pairing (normal)
            if (DisconnectReason.restartRequired != null && code === DisconnectReason.restartRequired) {
              console.log(chalk.yellow('WhatsApp restart setelah pairing; sesi dipertahankan.'));
              this.sock = null;
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 1500);
              return;
            }

            // 401 — loggedOut: sesi ditolak server, WAJIB clear auth
            if (DisconnectReason.loggedOut != null && code === DisconnectReason.loggedOut) {
              console.log(chalk.red('WhatsApp menolak sesi (loggedOut). Menghapus auth lama & restart agar QR baru muncul...'));
              try { this.sock?.end?.(new Error('loggedOut')); } catch (_) {}
              this.sock = null;
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = setTimeout(() => {
                try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch (_) {}
                this.pairingRequested = false;
                this.pairingFailed = false;
                this._qrPrintedFor = null;
                this.start().catch(() => {});
              }, 2500);
              return;
            }

            // 440 — conflict: sesi lain login dengan akun yang sama
            if (code === 440 || /conflict/i.test(errMsg)) {
              console.log(chalk.yellow(`WhatsApp conflict (440): sesi lain terdeteksi. Reconnect dalam 10 detik...`));
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 10000);
              return;
            }

            // Lainnya — reconnect biasa
            console.log(chalk.yellow(`WhatsApp terputus (code=${code || '?'}): ${errMsg}. Reconnect 5 detik...`));
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 5000);
          }
        } catch (e) {
          console.warn(chalk.yellow(`Error di connection.update: ${e.message}`));
        }
      });

      this.sock.ev.on('group-participants.update', async (update) => {
        try {
          if (!(await this.isTargetGroup(update.id))) return;
          const action = String(update.action || '').toLowerCase();
          if (action !== 'add' && action !== 'remove') return;
          for (const participant of update.participants || []) {
            const number = this.formatParticipant(participant);
            const mention = participant;
            if (action === 'add' && this.welcome) {
              const count = await this.getGroupMemberCount(update.id);
              const displayName = await this.getParticipantName(participant, number);
              const banner = await this.createMemberBanner('welcome', participant, displayName, count);
              await this.sendImageBuffer(banner,
                `WELCOME TO MCPAKEL GROUP\nWelcome @${number}! Please use .menu to view commands.`, [mention]);
            } else if (action === 'remove' && this.goodbye) {
              const count = await this.getGroupMemberCount(update.id);
              const displayName = await this.getParticipantName(participant, number);
              const banner = await this.createMemberBanner('goodbye', participant, displayName, count);
              await this.sendImageBuffer(banner,
                `GOODBYE — SEE YOU SOON\nGoodbye @${number}. Thank you for being part of MCPAKEL GROUP.`, [mention]);
            }
          }
        } catch (e) {
          console.warn('WhatsApp group event:', e.message);
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !this.commands) return;
        for (const msg of messages || []) {
          try {
            if (!msg.message || msg.key?.fromMe) continue;
            const jid = msg.key?.remoteJid;
            if (!jid || !String(jid).endsWith('@g.us')) continue;
            const rawText = this.extractText(msg.message).trim();
            if (!rawText) continue;
            const text = rawText.toLowerCase().split(/\s+/)[0];
            if (!this.groupJid && !this.groupName) {
              this.groupJid = jid;
              console.log(chalk.green(`Grup WhatsApp dipilih dari perintah pertama: ${jid}`));
            }
            if (!(await this.isTargetGroup(jid))) continue;
            if (['.menu', '.help', '.cara', '.commands'].includes(text)) {
              await this.sendImage('menu.png', this.getHelpText());
            } else if (['.about', '.owner', '.tentang', '.mcpakel', '.alexpakel', '.info'].includes(text)) {
              await this.sendText(this.getAboutText());
            } else if (['.youtube', '.yt'].includes(text)) {
              await this.sendText('YOUTUBE — ALEX PAKEL\nhttps://youtube.com/@alexpakel');
            } else if (['.tiktok', '.tt'].includes(text)) {
              await this.sendText('TIKTOK — MCPAKEL\nhttps://www.tiktok.com/@mcpakel');
            } else if (text === '.status') {
              await this.sendStatus();
            }
          } catch (_) {}
        }
      });

      return true;
    } catch (e) {
      this.starting = false;
      console.error(chalk.red(`Gagal memulai WhatsApp bot: ${e.message}`));
      return false;
    }
  }

  extractText(message) {
    return message?.conversation ||
      message?.extendedTextMessage?.text ||
      message?.imageMessage?.caption ||
      message?.videoMessage?.caption || '';
  }

  formatParticipant(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
  }

  async resolveGroup(force = false) {
    if (!this.sock || !this.ready) return null;
    if (!force && Date.now() - this.lastGroupLookup < 30000) return this.groupJid || null;
    this.lastGroupLookup = Date.now();
    if (this.groupJid) return this.groupJid;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const entries = Object.entries(groups || {});
      let found = null;
      if (this.groupName) {
        found = entries.find(([, g]) => String(g?.subject || '').trim().toLowerCase() === this.groupName.toLowerCase());
      } else if (entries.length === 1) {
        found = entries[0];
      }
      if (found) {
        this.groupJid = found[0];
        console.log(chalk.green(`WhatsApp target group: ${found[1]?.subject || this.groupJid}`));
        return this.groupJid;
      }
      console.log(chalk.yellow(this.groupName ? `Grup WhatsApp "${this.groupName}" belum ditemukan.` : 'Belum bisa tentukan grup target. Isi WHATSAPP_GROUP_JID atau WHATSAPP_GROUP_NAME.'));
    } catch (e) {
      console.warn('Tidak dapat membaca daftar grup WhatsApp:', e.message);
    }
    return null;
  }

  async isTargetGroup(jid) {
    const target = await this.resolveGroup();
    return !!target && String(jid) === String(target);
  }

  async sendText(text, mentions = []) {
    if (!this.ready || !this.sock) return false;
    const jid = await this.resolveGroup();
    if (!jid) return false;
    const payload = { text };
    if (mentions.length) payload.mentions = mentions;
    try {
      await this.sock.sendMessage(jid, payload);
      return true;
    } catch (e) {
      console.warn('Gagal mengirim pesan WhatsApp:', e.message);
      return false;
    }
  }

  async getGroupMemberCount(jid) {
    try {
      const meta = await this.sock.groupMetadata(jid);
      return Array.isArray(meta?.participants) ? meta.participants.length : '?';
    } catch (_) { return '?'; }
  }

  async getParticipantName(jid, fallback) {
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const g = groups?.[this.groupJid];
      const member = g?.participants?.find(p => p.id === jid || p.id?.split(':')[0] === jid?.split(':')[0]);
      return String(member?.notify || member?.name || fallback || 'New member').slice(0, 30);
    } catch (_) { return String(fallback || 'Member').slice(0, 30); }
  }

  async createMemberBanner(kind, participant, displayName, memberCount) {
    const template = path.join(__dirname, 'assets', kind === 'goodbye' ? 'goodbye-template.png' : 'welcome-template.png');
    const image = await Jimp.read(template);
    const white = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const cyan = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const small = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const title = kind === 'goodbye' ? 'GOODBYE — SEE YOU SOON' : 'WELCOME TO MCPAKEL GROUP';
    image.print(await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE), 360, 58, title, 750);
    image.print(white, 390, 151, { text: `Name: ${displayName}`, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, 700);
    image.print(cyan, 390, 198, { text: `Member: ${memberCount}`, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, 700);
    image.print(small, 360, 290, 'YouTube: ALEX PAKEL  |  TikTok: MCPAKEL', 760);
    try {
      const url = await this.sock.profilePictureUrl(participant, 'image');
      if (url) {
        const https = require('https'); const http = require('http');
        const data = await new Promise((resolve, reject) => (url.startsWith('https:') ? https : http).get(url, r => {
          const chunks=[]; r.on('data', c=>chunks.push(c)); r.on('end',()=>resolve(Buffer.concat(chunks))); r.on('error',reject);
        }).on('error', reject));
        const avatar = await Jimp.read(data); avatar.cover(220, 220);
        const mask = new Jimp(220, 220, 0x00000000);
        const md = mask.bitmap.data;
        for (let y=0;y<220;y++) for(let x=0;x<220;x++) if ((x-110)**2+(y-110)**2 <= 108**2) { const i=(y*220+x)*4; md[i]=255; md[i+1]=255; md[i+2]=255; md[i+3]=255; }
        avatar.mask(mask,0,0); image.composite(avatar,80,90);
      }
    } catch (_) { /* profile photo unavailable: keep the designed avatar placeholder */ }
    return await image.getBufferAsync(Jimp.MIME_PNG);
  }

  async sendImageBuffer(buffer, caption, mentions = []) {
    if (!this.ready || !this.sock || !buffer) return false;
    const jid = await this.resolveGroup();
    if (!jid) return false;
    const payload = { image: buffer, caption: String(caption || '') };
    if (mentions.length) payload.mentions = mentions;
    try { await this.sock.sendMessage(jid, payload); return true; }
    catch (e) { console.warn('Gagal mengirim banner WhatsApp:', e.message); return this.sendText(caption, mentions); }
  }

  async sendImage(filename, caption, mentions = []) {
    if (!this.ready || !this.sock) return false;
    const jid = await this.resolveGroup();
    if (!jid) return false;
    const imagePath = path.join(__dirname, 'assets', filename);
    try {
      if (!fs.existsSync(imagePath)) {
        console.warn(`Gambar WhatsApp tidak ditemukan: ${imagePath}; mengirim teks biasa.`);
        return this.sendText(caption, mentions);
      }
      const payload = { image: fs.readFileSync(imagePath), caption: String(caption || '') };
      if (mentions.length) payload.mentions = mentions;
      await this.sock.sendMessage(jid, payload);
      return true;
    } catch (e) {
      console.warn(`Gagal mengirim gambar WhatsApp (${filename}): ${e.message}; mencoba teks biasa.`);
      return this.sendText(caption, mentions);
    }
  }

  getHelpText() {
    return `TIKTOMC WHATSAPP BOT\n\n` +
      `MENU / CARA PENGGUNAAN\n\n` +
      `.menu - Menampilkan menu\n` +
      `.help - Bantuan bot\n` +
      `.cara - Cara penggunaan\n` +
      `.status - Status TikTok LIVE\n` +
      `.about - Tentang MCPAKEL / Alex Pakel\n` +
      `.youtube - Link YouTube\n` +
      `.tiktok - Link TikTok\n\n` +
      `Notifikasi otomatis hanya untuk perubahan status TikTok LIVE.\n` +
      `Notifikasi akhir LIVE ditunda 5 menit agar LIVE yang putus-sambung tidak membuat spam.`;
  }

  getAboutText() {
    return `ABOUT THE CREATOR\n\n` +
      `MCPAKEL / Alex Pakel\n` +
      `Creator of TIKTOMC - TikTok LIVE WebSocket Bridge for Minecraft.\n\n` +
      `YouTube: https://youtube.com/@alexpakel\n` +
      `TikTok: https://www.tiktok.com/@mcpakel\n` +
      `GitHub: https://github.com/mcpakel\n\n` +
      `Use .menu to view all commands.`;
  }

  syncLiveStates() {
    const sessions = this.getLiveSessions() || [];
    for (const session of sessions) {
      const username = String(session.tiktok || '').replace(/^@/, '').trim();
      if (!username || String(session.status || '').toLowerCase() !== 'live') continue;
      const key = username.toLowerCase();
      const timer = this.pendingEndTimers.get(key);
      if (timer) clearTimeout(timer);
      this.pendingEndTimers.delete(key);
      this.liveStates.set(key, true);
    }
  }

  async notifyLiveStart(tiktok) {
    const username = String(tiktok || '').replace(/^@/, '').trim();
    if (!username || !this.liveNotification) return;
    const key = username.toLowerCase();
    const endTimer = this.pendingEndTimers.get(key);
    const wasLiveOrPending = this.liveStates.get(key) === true || Boolean(endTimer);
    if (endTimer) {
      clearTimeout(endTimer);
      this.pendingEndTimers.delete(key);
    }
    this.liveStates.set(key, true);
    const now = Date.now();
    const lastSent = this.lastStartNotified.get(key) || 0;
    if (wasLiveOrPending || now - lastSent < this.liveStartCooldownMs) return;
    if (!this.ready) return;
    const sent = await this.sendText(
      `TIKTOK LIVE\n\n` +
      `@${username} sedang LIVE sekarang.\n\n` +
      `Silakan bergabung dan ramaikan live-nya.\n` +
      `https://www.tiktok.com/@${username}/live`
    );
    if (sent) this.lastStartNotified.set(key, now);
  }

  async notifyLiveEnd(tiktok) {
    const username = String(tiktok || '').replace(/^@/, '').trim();
    if (!username || !this.liveNotification) return;
    const key = username.toLowerCase();
    if (this.liveStates.get(key) !== true || this.pendingEndTimers.has(key)) return;
    const timer = setTimeout(async () => {
      this.pendingEndTimers.delete(key);
      const sessions = this.getLiveSessions() || [];
      const stillLive = sessions.some(s => String(s.tiktok || '').replace(/^@/, '').toLowerCase() === key && String(s.status || '').toLowerCase() === 'live');
      if (stillLive) {
        this.liveStates.set(key, true);
        return;
      }
      this.liveStates.set(key, false);
      if (!this.ready) return;
      await this.sendText(
        `TIKTOK LIVE SELESAI\n\n` +
        `Live @${username} telah berakhir.\n\n` +
        `Terima kasih sudah ikut meramaikan.`
      );
    }, this.liveEndGraceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingEndTimers.set(key, timer);
  }

  async flushLiveStates() {
    this.syncLiveStates();
  }

  async sendStatus() {
    const sessions = this.getLiveSessions() || [];
    if (!sessions.length) {
      return this.sendText('STATUS TIKTOMC\n\nSaat ini tidak ada TikTok yang sedang LIVE.');
    }
    const lines = sessions.map(s => `- @${String(s.tiktok || '').replace(/^@/, '')}: ${String(s.status || 'unknown').toUpperCase()}`);
    return this.sendText(`STATUS TIKTOMC\n\n${lines.join('\n')}`);
  }

  async stop() {
    clearTimeout(this.reconnectTimer);
    for (const timer of this.pendingEndTimers.values()) clearTimeout(timer);
    this.pendingEndTimers.clear();
    this.ready = false;
    this.starting = false;
    try { this.sock?.end?.(new Error('TIKTOMC shutdown')); } catch (_) {}
    this.sock = null;
  }
}

module.exports = WhatsAppBot;
