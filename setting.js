// ==================== SETTING.JS ====================
// FILE KONFIGURASI UTAMA TIKTOK LIVE BRIDGE
// 
// CARA PENGGUNAAN:
// 1. Isi manual di bawah ini jika ingin langsung connect tanpa input terminal
// 2. Kosongkan ('') jika ingin input via terminal saat program dijalankan
// 3. Semua pengaturan bisa disesuaikan sesuai kebutuhan

const path = require('path');
const os = require('os');
const fs = require('fs');
const chalk = require('chalk');

// ==================== KONFIGURASI UTAMA ====================
// Node.js Termux akan langsung konek ke CubicCraft hosting saat start.
// Ganti MINECRAFT_HOST dan MINECRAFT_PORT jika memakai server lain.
const CONFIG = {
  
  // ========== TIKTOK CONFIG ==========
  // Username TikTok TIDAK disimpan di config global.
  // Username diberikan per-player melalui /cc host <username>.
  // Setiap host memiliki session + data sendiri.
  
  // API Key TikTok (opsional) - dapatkan dari TikTok Developers
  // Digunakan untuk menghindari rate limit
  TIKTOK_API_KEY: '',            // Kosongkan jika tidak punya API Key
  
  // ========== MINECRAFT OUTBOUND CONFIG ==========
  // Node.js di Termux bertindak sebagai CLIENT dan konek keluar ke CubicCraft.
  // Isi IP/hostname hosting Minecraft + PORT BRIDGE yang dialokasikan panel.
  MINECRAFT_OUTBOUND_ENABLED: true,
  // Preserve the original default target. Override these with panel environment
  // variables if the allocated bridge IP/port differs on your hosting server.
  MINECRAFT_HOST: '51.81.107.169',
  MINECRAFT_PORT: 25942,
  MINECRAFT_RECONNECT_DELAY: 5000,

  // ========== WEBSOCKET CONFIG ==========
  // Node.js WebSocket server untuk koneksi CubicCraft.
  // CubicCraft melakukan /cc connect ke host:WS_PORT.
  // Port untuk koneksi WebSocket Minecraft / client eksternal
  // Minecraft plugin akan konek ke port ini
  WS_HOST: '0.0.0.0',             // Listen semua interface agar panel/VPS bisa menerima koneksi
  WS_PORT: 25601,                  // Port WebSocket CubicCraft
  
  // ========== API CONFIG ==========
  // Port untuk REST API server (untuk akses data via HTTP)
  API_PORT: 7521,                 // Default: 7521
  
  // Apakah perlu API Key untuk akses API?
  // true = memerlukan API key, false = bebas akses
  REQUIRE_API_KEY: false,         // Default: false (bebas akses)
  
  // File untuk menyimpan API Keys yang terdaftar
  API_KEYS_FILE: './data/api-keys.json',
  
  // Aktifkan Server-Sent Events (SSE) untuk real-time data via HTTP
  ENABLE_SSE: true,               // Default: true
  
  // Aktifkan WebSocket API (selain WebSocket untuk Minecraft)
  ENABLE_WEBSOCKET_API: true,     // Default: true
  
  // CORS settings - izinkan domain mana yang bisa akses API
  // ['*'] = semua domain, atau bisa spesifik seperti ['http://localhost:3000']
  CORS_ORIGINS: ['*'],            // Default: semua domain diizinkan
  
  // ========== DIRECTORY CONFIG ==========
  // Folder untuk menyimpan data (followers, gift log, filter words)
  DATA_DIR: './data',             // Default: ./data
  
  // ========== AUTO-RECONNECT CONFIG ==========
  // Maksimal percobaan reconnect jika koneksi TikTok terputus
  MAX_RECONNECT_ATTEMPTS: 999999, // 24/7: jangan berhenti reconnect karena batas percobaan
  
  // Delay (ms) sebelum mencoba reconnect
  RECONNECT_DELAY: 5000,           // Default: 5 detik
  
  // ========== TIKTOK CONNECTION CONFIG ==========
  // Timeout koneksi TikTok (ms)
  TIKTOK_CONNECTION_TIMEOUT: 30000, // Default: 30 detik
  
  // ========== HOST / PERSISTENCE CONFIG ==========
  // Data host disimpan per-player agar username dan statistik tidak tercampur.
  HOST_DATA_DIR: './data/hosts',
  HOST_RECONNECT_GRACE_MS: 30000,

  // ========== PANEL / HEADLESS CONFIG ==========
  // true = tidak meminta input terminal; cocok untuk Pterodactyl/panel/hosting.
  // Atur username/port di setting.js atau lewat environment.
  PANEL_MODE: true,
  // TikTok selalu dibuat per-host lewat /cc host. Tidak ada auto host global.
  AUTO_TIKTOK_START: false,

  // ========== WHATSAPP BOT CONFIG ==========
  // Bot grup WhatsApp untuk welcome/goodbye, menu, dan notifikasi TikTok LIVE.
  WHATSAPP_ENABLED: true,
  // Isi JID grup jika sudah tahu, contoh: 1203630xxxxxxxx@g.us
  WHATSAPP_GROUP_JID: '',
  // Atau isi nama grup persis. Jika hanya ada satu grup yang diikuti bot,
  // bot akan otomatis memilih grup tersebut.
  WHATSAPP_GROUP_NAME: '',
  WHATSAPP_SESSION_DIR: './data/whatsapp-auth',
  // Login WhatsApp menggunakan QR kecil yang ditampilkan di console.
  WHATSAPP_WELCOME: true,
  WHATSAPP_GOODBYE: true,
  WHATSAPP_LIVE_NOTIFICATION: true,
  WHATSAPP_COMMANDS: true,

  // ========== UI CONFIG ==========
  // Maksimal jumlah log yang ditampilkan di dashboard
  MAX_LOG_ENTRIES: 50,             // Default: 50 entri
  
  // Lebar maksimal terminal (auto-detect jika lebih besar)
  TERMINAL_MAX_WIDTH: 110,          // Default: 110 karakter
  
  // Interval refresh dashboard (ms)
  REFRESH_INTERVAL: 1000,           // Default: 1 detik
  
  // ========== UI STYLE CONFIG ==========
  // Tema UI: 'modern', 'classic', atau 'minimal'
  UI_THEME: 'modern',               // Default: modern
  
  // Tampilkan animasi progress bar
  SHOW_ANIMATIONS: true,            // Default: true
  
  // Tampilkan border style yang lebih menarik
  SHOW_BORDER_STYLES: true,         // Default: true
  
  // Tampilkan ikon pada setiap statistik
  SHOW_ICONS_STATS: true,           // Default: true
  
  // ========== FILTER WORDS ==========
  // Daftar kata kasar yang akan difilter dari chat
  // Bisa ditambah atau dikurangi sesuai kebutuhan
  FILTER_WORDS: [
    // Bahasa Indonesia
    'kontol', 'memek', 'pepek', 'ngentot', 'ngntot', 'jembut', 'pukimak',
    'bangsat', 'anjing', 'babi', 'asu', 'bajingan', 'brengsek', 'kampret',
    'goblok', 'bodoh', 'tolol', 'idiot', 'bego', 'ngaco', 'sialan',
    'jancuk', 'cuk', 'dancok', 'cok', 'asw', 'kntl', 'mmk', 'ppk',
    // Bahasa Inggris
    'fuck', 'shit', 'bitch', 'asshole', 'damn', 'hell',
    // Lainnya
    'pantek', 'mmek'
  ]
};

// ==================== FITUR OPSIONAL ====================
// Aktifkan atau nonaktifkan fitur tertentu
// true = aktif, false = nonaktif
const FEATURES = {
  
  // Filter kata kasar di chat TikTok
  // Jika aktif, kata kasar akan diganti dengan *
  FILTER_KATA: true,           // Default: true
  
  // Auto-reconnect jika koneksi TikTok terputus
  AUTO_RECONNECT: true,        // Default: true
  
  // Tampilkan dashboard real-time di terminal
  DASHBOARD: true,             // Default: true
  
  // Catat aktivitas ke log (ditampilkan di dashboard)
  ACTIVITY_LOG: true,          // Default: true
  
  // Tampilkan top gifters (pengirim gift terbanyak)
  TOP_GIFTERS: true,           // Default: true
  
  // Simpan data followers ke file (data/followed.json)
  SAVE_FOLLOWERS: true,        // Default: true
  
  // Simpan data gift ke file (data/gift-log.json)
  SAVE_GIFTS: true             // Default: true
};

// ==================== COLOR SETTINGS ====================
// Warna-warna untuk tampilan dashboard
// Bisa diubah sesuai selera (format HEX)
const COLORS = {
  primary: '#6366F1',      // Warna utama (header, judul)
  primaryDim: '#4F46E5',    // Warna utama gelap
  secondary: '#8B5CF6',     // Warna sekunder (top gifters)
  warning: '#F59E0B',       // Warna peringatan (orange)
  success: '#10B981',       // Warna sukses (hijau)
  error: '#EF4444',         // Warna error (merah)
  info: '#3B82F6',          // Warna info (biru)
  purple: '#8B5CF6',        // Ungu (join event)
  pink: '#EC4899',          // Pink (share event)
  cyan: '#06B6D4',          // Cyan (link)
  gift: '#F59E0B',          // Oranye (gift event)
  like: '#EF4444',          // Merah (like event)
  follow: '#10B981',        // Hijau (follow event)
  chat: '#3B82F6',          // Biru (chat event)
  join: '#8B5CF6',          // Ungu (join event)
  share: '#EC4899',         // Pink (share event)
  gray: '#6B7280',          // Abu-abu (border)
  grayLight: '#9CA3AF',     // Abu-abu terang
  grayDark: '#374151',      // Abu-abu gelap
  background: '#1F2937',    // Latar belakang gelap
  card: '#111827'           // Background card
};

// ==================== EVENT TYPES ====================
// Tipe-tipe event yang dikirim ke Minecraft / API
// JANGAN DIUBAH kecuali tahu konsekuensinya
const EVENT_TYPES = {
  CHAT: 'chat',
  GIFT: 'gift',
  LIKE: 'like',
  FOLLOW: 'follow',
  SHARE: 'share',
  JOIN: 'join',
  VIEWERS: 'viewers',
  WARNING: 'warning',
  COMMAND_RESPONSE: 'command_response',
  INIT: 'init'
};

// ==================== STATUS TYPES ====================
// Status koneksi untuk dashboard
const STATUS = {
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  OFFLINE: 'offline'
};

// ==================== MESSAGES ====================
// Pesan-pesan yang ditampilkan di terminal
// Bisa diubah sesuai keinginan
const MESSAGES = {
  LOADING: {
    CONNECTING: 'Menghubungkan ke TikTok LIVE...',
    WITH_API_KEY: 'Menggunakan API Key untuk koneksi lebih stabil',
    WITHOUT_API_KEY: 'Tanpa API Key (mungkin terkena rate limit)',
    SUCCESS: 'Berhasil terhubung ke TikTok LIVE!',
    FAILED: 'Gagal terhubung'
  },
  
  TIPS: [
    '💡 Pastikan user sedang LIVE',
    '💡 Cek koneksi internet',
    '💡 Gunakan API Key jika sering timeout',
    '💡 TikTok mungkin memblokir koneksi publik',
    '💡 Setting bisa diubah di setting.js',
    '💡 Isi username di setting.js agar langsung connect',
    '💡 Port 25601 untuk WebSocket Minecraft, 7521 untuk API',
    '💡 Gunakan !help di chat TikTok untuk bantuan',
    '💡 Filter kata bisa ditambah di setting.js',
    '💡 Data followers dan gift tersimpan di folder data/'
  ],
  
  ERRORS: {
    TIMEOUT: 'Timeout: TikTok LIVE tidak ditemukan atau sedang offline',
    RATE_LIMIT: 'Rate Limited - Gunakan API Key'
  },
  
  COMMANDS: {
    FILTER_ADD: '!filter add [kata] - Tambah kata ke filter',
    FILTER_REMOVE: '!filter remove [kata] - Hapus kata dari filter',
    FILTER_LIST: '!filter list - Lihat daftar kata filter',
    HELP: '!help - Tampilkan bantuan'
  }
};

// ==================== WEBSOCKET MINECRAFT CONFIG ====================
// Konfigurasi format data yang dikirim ke Minecraft
// Field yang dikirim:
// - username: nama user TikTok asli (contoh: asep123)
// - giftName: nama gift asli dari TikTok (contoh: Mawar, Rosa, Donat)
// - giftId: ID gift dari TikTok
// - count: jumlah gift
const MINECRAFT_EVENTS = {
  
  // Format pesan yang dikirim ke Minecraft
  // JANGAN DIUBAH field utamanya (username, giftName, dll)
  FORMAT: {
    CHAT: { event: 'chat', username: '{username}', nickname: '{nickname}', message: '{message}' },
    GIFT: { event: 'gift', username: '{username}', giftName: '{giftName}', giftId: '{giftId}', count: '{count}', coin: '{coin}', totalCoin: '{totalCoin}' },
    LIKE: { event: 'like', username: '{username}', count: '{count}', totalLikes: '{totalLikes}' },
    FOLLOW: { event: 'follow', username: '{username}', userId: '{userId}' },
    SHARE: { event: 'share', username: '{username}' },
    JOIN: { event: 'join', username: '{username}', nickname: '{nickname}' },
    VIEWERS: { event: 'viewers', count: '{count}' },
    WARNING: { event: 'warning', username: '{username}', message: '{message}' },
    COMMAND_RESPONSE: { event: 'command_response', to: '{to}', message: '{message}' },
    STATS_UPDATE: { event: 'stats_update', gifts: '{gifts}', likes: '{likes}', follows: '{follows}', chats: '{chats}', viewers: '{viewers}', totalGiftValue: '{totalGiftValue}' }
  },
  
  // Aktif/nonaktifkan event tertentu ke Minecraft
  // true = event akan dikirim ke Minecraft
  // false = event tidak dikirim
  SEND_TO_MINECRAFT: {
    chat: true,
    gift: true,
    like: true,
    follow: true,
    share: true,
    join: true,
    viewers: true,
    warning: true,
    command_response: true,
    stats_update: true
  }
};

// ==================== UTILITY FUNCTIONS ====================
// Fungsi-fungsi bantu untuk berbagai keperluan
// JANGAN DIHAPUS kecuali tahu konsekuensinya
const Utils = {
  
  // Mendapatkan alamat IP lokal (LAN)
  getLocalIP: () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  },

  // Menyembunyikan sebagian IP untuk keamanan
  getSensedIP: (ip) => {
    if (!ip) return '***.***.***.***';
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
    }
    return '***.***.***.***';
  },

  // Mendapatkan lebar terminal
  getTerminalWidth: () => {
    return Math.min(process.stdout.columns || 90, CONFIG.TERMINAL_MAX_WIDTH);
  },

  // Mendapatkan tinggi terminal
  getTerminalHeight: () => {
    return process.stdout.rows || 24;
  },

  // Format angka dengan pemisah ribuan (Indonesia)
  formatNumber: (num) => {
    return new Intl.NumberFormat('id-ID').format(num);
  },

  // Format angka compact (1.2K, 1.5M)
  formatNumberCompact: (num) => {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  },

  // Membuat folder jika belum ada
  ensureDir: (dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  },

  // Delay / sleep (ms)
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  // Membuat garis horizontal untuk dashboard
  createHorizonLine: (width, color = 'gray') => {
    const line = '─'.repeat(Math.max(0, width - 2));
    const colors = {
      gray: chalk.gray,
      cyan: chalk.cyan,
      green: chalk.green,
      yellow: chalk.yellow
    };
    const styler = colors[color] || colors.gray;
    return styler('┌' + line + '┐');
  },

  // Membuat border bawah dashboard
  createBottomBorder: (width, color = 'gray') => {
    const line = '─'.repeat(Math.max(0, width - 2));
    const colors = {
      gray: chalk.gray,
      cyan: chalk.cyan,
      green: chalk.green,
      yellow: chalk.yellow
    };
    const styler = colors[color] || colors.gray;
    return styler('└' + line + '┘');
  },

  // Membuat judul card dengan ikon
  createCardTitle: (icon, title, width) => {
    const titleText = `${icon} ${title}`;
    const padding = Math.max(0, width - titleText.length - 4);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return '  ' + ' '.repeat(leftPad) + chalk.hex(COLORS.primary).bold(titleText) + ' '.repeat(rightPad);
  },

  // Memusatkan teks di terminal
  centerText: (text, width = null) => {
    const w = width || Utils.getTerminalWidth();
    if (text.length >= w) {
      return text.substring(0, w);
    }
    const padding = Math.max(0, Math.floor((w - text.length) / 2));
    return ' '.repeat(padding) + text + ' '.repeat(w - text.length - padding);
  },

  // Teks kiri dan kanan dalam satu baris
  leftRight: (left, right, width = null, leftColor = null, rightColor = null) => {
    const w = width || Utils.getTerminalWidth();
    let leftStr = String(left);
    let rightStr = String(right);
    
    if (leftColor) leftStr = leftColor(leftStr);
    if (rightColor) rightStr = rightColor(rightStr);
    
    const leftLen = String(left).length;
    const rightLen = String(right).length;
    const availableSpace = w - 4;
    
    if (leftLen + rightLen > availableSpace) {
      const maxLeft = Math.floor(availableSpace * 0.6);
      const maxRight = availableSpace - maxLeft;
      const truncatedLeft = String(left).substring(0, maxLeft);
      const truncatedRight = String(right).substring(0, maxRight);
      
      let leftDisplay = truncatedLeft;
      let rightDisplay = truncatedRight;
      if (leftColor) leftDisplay = leftColor(truncatedLeft);
      if (rightColor) rightDisplay = rightColor(truncatedRight);
      
      return '  ' + leftDisplay + ' '.repeat(2) + rightDisplay;
    }
    
    const spaces = w - leftLen - rightLen - 4;
    return '  ' + leftStr + ' '.repeat(Math.max(0, spaces)) + rightStr;
  },

  // Membuat progress bar
  createProgressBar: (percentage, width = 20, color = 'cyan') => {
    const filled = Math.floor((Math.min(100, Math.max(0, percentage)) / 100) * width);
    const empty = Math.max(0, width - filled);
    const colors = {
      cyan: chalk.cyan,
      green: chalk.green,
      yellow: chalk.yellow,
      red: chalk.red,
      gift: chalk.hex(COLORS.gift)
    };
    const styler = colors[color] || colors.cyan;
    return styler('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  },

  // Format durasi (ms ke HH:MM:SS)
  formatDuration: (ms) => {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },

  // Membersihkan layar terminal
  clearScreen: () => {
    console.clear();
  },

  // Cek apakah running di Termux
  isTermux: () => {
    return process.env.PREFIX === '/data/data/com.termux/files/usr';
  },

  // Animasi teks (untuk efek keren)
  animateText: (text, delay = 30) => {
    return new Promise((resolve) => {
      let i = 0;
      const interval = setInterval(() => {
        process.stdout.write(text[i]);
        i++;
        if (i >= text.length) {
          clearInterval(interval);
          resolve();
        }
      }, delay);
    });
  }
};

// ==================== EXPORT SETTINGS ====================
// JANGAN DIHAPUS - ini yang membuat setting bisa diimport di file lain
module.exports = {
  CONFIG,
  FEATURES,
  COLORS,
  EVENT_TYPES,
  STATUS,
  MESSAGES,
  MINECRAFT_EVENTS,
  Utils
};
