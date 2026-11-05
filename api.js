// ==================== API.JS ====================
// TikTokMC API Server - Untuk akses data dari aplikasi eksternal
// Bisa diakses via HTTP, WebSocket, atau SSE (Server-Sent Events)

const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('ws');
const crypto = require('crypto');
const fs = require('fs');

class TikTokMCAPI {
  constructor(app, wss, liveStats, followStore, giftStore, filterSystem, config) {
    this.app = app;
    this.wss = wss;
    this.liveStats = liveStats;
    this.followStore = followStore;
    this.giftStore = giftStore;
    this.filterSystem = filterSystem;
    this.config = config;
    
    // API Keys untuk autentikasi (opsional)
    this.apiKeys = new Map();
    this.loadAPIKeys();
    
    // SSE clients
    this.sseClients = new Set();
    
    // Setup routes
    this.setupRoutes();
    this.setupWebSocket();
    this.setupSSE();
    
    // Serve static files
    this.app.use('/public', express.static(path.join(__dirname, 'public')));
    
    // Setup CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }
  
  // Load API keys dari file
  loadAPIKeys() {
    const keyPath = path.join(__dirname, 'data', 'api-keys.json');
    
    if (fs.existsSync(keyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
        this.apiKeys = new Map(Object.entries(data));
      } catch (e) {}
    } else {
      // Generate default API key
      const defaultKey = this.generateAPIKey();
      this.apiKeys.set(defaultKey, {
        key: defaultKey,
        name: 'Default Application',
        createdAt: Date.now(),
        lastUsed: null
      });
      this.saveAPIKeys();
    }
  }
  
  // Save API keys
  saveAPIKeys() {
    const data = Object.fromEntries(this.apiKeys);
    fs.writeFileSync(
      path.join(__dirname, 'data', 'api-keys.json'),
      JSON.stringify(data, null, 2)
    );
  }
  
  // Generate random API key
  generateAPIKey() {
    return 'tiktokmc_' + crypto.randomBytes(16).toString('hex');
  }
  
  // Verify API key (jika diperlukan)
  verifyAPIKey(req, res, next) {
    // Jika tidak pakai API key, lewati
    if (!this.config.REQUIRE_API_KEY) {
      return next();
    }
    
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'API key required'
      });
    }
    
    const keyData = this.apiKeys.get(apiKey);
    if (!keyData) {
      return res.status(403).json({
        success: false,
        error: 'Invalid API key'
      });
    }
    
    // Update last used
    keyData.lastUsed = Date.now();
    this.apiKeys.set(apiKey, keyData);
    
    req.apiKeyData = keyData;
    next();
  }
  
  // Setup semua routes
  setupRoutes() {
    // ============ API ROOT ============
    this.app.get('/api', (req, res) => {
      res.json({
        success: true,
        name: 'TikTokMC API',
        version: '3.0.0',
        endpoints: {
          stats: '/api/stats - Live statistics',
          events: '/api/events - Recent events',
          followers: '/api/followers - Followers list',
          gifts: '/api/gifts - Gift history',
          filter: '/api/filter/words - Filter words',
          ws: '/ws - WebSocket connection',
          sse: '/sse - Server-Sent Events',
          html: '/public/ - Static HTML pages'
        },
        documentation: 'https://github.com/mcpakel/tiktok-live-bridge'
      });
    });
    
    // ============ STATS ENDPOINT ============
    this.app.get('/api/stats', this.verifyAPIKey.bind(this), (req, res) => {
      res.json({
        success: true,
        data: {
          live: {
            username: this.liveStats.stats.username,
            nickname: this.liveStats.stats.nickname,
            duration: this.liveStats.getDuration(),
            startedAt: this.liveStats.startTime,
            isLive: this.liveStats.stats.tiktokConnected
          },
          counts: {
            gifts: this.liveStats.stats.gifts,
            likes: this.liveStats.stats.likes,
            follows: this.liveStats.stats.follows,
            joins: this.liveStats.stats.joins,
            shares: this.liveStats.stats.shares,
            chats: this.liveStats.stats.chats
          },
          giftValue: this.liveStats.stats.totalGiftValue,
          topGifters: Object.fromEntries(this.liveStats.stats.topGifters),
          connections: {
            minecraft: this.wss?.getClientCount() || 0,
            api: this.sseClients.size
          },
          timestamp: Date.now()
        }
      });
    });
    
    // ============ EVENTS ENDPOINT ============
    this.app.get('/api/events', this.verifyAPIKey.bind(this), (req, res) => {
      const limit = parseInt(req.query.limit) || 50;
      
      res.json({
        success: true,
        data: this.liveStats.logBuffer.slice(-limit).reverse(),
        total: this.liveStats.logBuffer.length,
        limit
      });
    });
    
    // ============ SPECIFIC EVENT TYPES ============
    this.app.get('/api/events/:type', this.verifyAPIKey.bind(this), (req, res) => {
      const type = req.params.type;
      const limit = parseInt(req.query.limit) || 50;
      
      const filtered = this.liveStats.logBuffer
        .filter(log => log.type === type)
        .slice(-limit)
        .reverse();
      
      res.json({
        success: true,
        data: filtered,
        total: filtered.length,
        type,
        limit
      });
    });
    
    // ============ FOLLOWERS ============
    this.app.get('/api/followers', this.verifyAPIKey.bind(this), (req, res) => {
      const followers = Array.from(this.followStore.users.entries())
        .map(([id, name]) => ({ id, name }));
      
      res.json({
        success: true,
        data: followers,
        total: followers.length
      });
    });
    
    // ============ GIFTS ============
    this.app.get('/api/gifts', this.verifyAPIKey.bind(this), (req, res) => {
      const limit = parseInt(req.query.limit) || 100;
      
      res.json({
        success: true,
        data: this.giftStore.gifts.slice(-limit).reverse(),
        total: this.giftStore.gifts.length,
        limit
      });
    });
    
    this.app.get('/api/gifts/top', this.verifyAPIKey.bind(this), (req, res) => {
      const limit = parseInt(req.query.limit) || 10;
      const topGifters = Array.from(this.liveStats.stats.topGifters.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, total]) => ({ name, total }));
      
      res.json({
        success: true,
        data: topGifters,
        limit
      });
    });
    
    // ============ FILTER WORDS ============
    this.app.get('/api/filter/words', this.verifyAPIKey.bind(this), (req, res) => {
      res.json({
        success: true,
        data: this.filterSystem.badWords,
        total: this.filterSystem.badWords.length
      });
    });
    
    this.app.post('/api/filter/words', this.verifyAPIKey.bind(this), express.json(), (req, res) => {
      const { word } = req.body;
      if (!word) {
        return res.status(400).json({ success: false, error: 'Word required' });
      }
      
      const added = this.filterSystem.addWord(word);
      res.json({
        success: added,
        message: added ? 'Word added' : 'Word already exists',
        word
      });
    });
    
    this.app.delete('/api/filter/words/:word', this.verifyAPIKey.bind(this), (req, res) => {
      const { word } = req.params;
      const removed = this.filterSystem.removeWord(word);
      res.json({
        success: removed,
        message: removed ? 'Word removed' : 'Word not found',
        word
      });
    });
    
    // ============ API KEYS MANAGEMENT ============
    this.app.get('/api/keys', this.verifyAPIKey.bind(this), (req, res) => {
      const keys = Array.from(this.apiKeys.entries()).map(([key, data]) => ({
        key: key.substring(0, 10) + '...',
        name: data.name,
        createdAt: data.createdAt,
        lastUsed: data.lastUsed
      }));
      
      res.json({
        success: true,
        data: keys
      });
    });
    
    this.app.post('/api/keys/generate', this.verifyAPIKey.bind(this), express.json(), (req, res) => {
      const { name } = req.body;
      const newKey = this.generateAPIKey();
      
      this.apiKeys.set(newKey, {
        key: newKey,
        name: name || 'New Application',
        createdAt: Date.now(),
        lastUsed: null
      });
      
      this.saveAPIKeys();
      
      res.json({
        success: true,
        data: {
          key: newKey,
          name: name || 'New Application'
        }
      });
    });
    
    // ============ HEALTH CHECK ============
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: Date.now(),
        connections: {
          minecraft: this.wss?.getClientCount() || 0,
          sse: this.sseClients.size
        },
        tiktok: {
          connected: this.liveStats.stats.tiktokConnected,
          username: this.liveStats.stats.username
        }
      });
    });
  }
  
  // Setup WebSocket untuk real-time data
  setupWebSocket() {
    const wss = new Server({ noServer: true });
    
    this.wsServer = wss;
    
    wss.on('connection', (ws, req) => {
      const clientId = crypto.randomBytes(8).toString('hex');
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Connected to TikTokMC WebSocket',
        timestamp: Date.now()
      }));
      
      // Send stats every 2 seconds
      const interval = setInterval(() => {
        if (ws.readyState === 1) { // OPEN
          ws.send(JSON.stringify({
            type: 'stats',
            data: {
              gifts: this.liveStats.stats.gifts,
              likes: this.liveStats.stats.likes,
              follows: this.liveStats.stats.follows,
              chats: this.liveStats.stats.chats,
              viewers: this.wss?.getClientCount() || 0
            },
            timestamp: Date.now()
          }));
        }
      }, 2000);
      
      ws.on('close', () => {
        clearInterval(interval);
      });
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          // Handle commands from client
          if (data.command === 'subscribe') {
            ws.subscription = data.events || ['all'];
          }
        } catch (e) {}
      });
    });
    
    // Upgrade HTTP to WebSocket
    this.app.server = this.app.server || require('http').createServer(this.app);
    this.app.server.on('upgrade', (request, socket, head) => {
      if (request.url === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });
  }
  
  // Setup Server-Sent Events (SSE) untuk real-time updates
  setupSSE() {
    this.app.get('/sse', this.verifyAPIKey.bind(this), (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      
      const clientId = crypto.randomBytes(8).toString('hex');
      
      // Send initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);
      
      // Add client to set
      this.sseClients.add(res);
      
      // Send keep-alive every 15 seconds
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);
      
      // Remove client on close
      req.on('close', () => {
        this.sseClients.delete(res);
        clearInterval(keepAlive);
      });
    });
  }
  
  // Broadcast event to all SSE clients
  broadcastEvent(event, data) {
    this.sseClients.forEach(client => {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
  }
  
  // Send stats update to all SSE clients
  sendStatsUpdate() {
    const stats = {
      gifts: this.liveStats.stats.gifts,
      likes: this.liveStats.stats.likes,
      follows: this.liveStats.stats.follows,
      chats: this.liveStats.stats.chats,
      joins: this.liveStats.stats.joins,
      shares: this.liveStats.stats.shares,
      totalGiftValue: this.liveStats.stats.totalGiftValue,
      topGifters: Object.fromEntries(this.liveStats.stats.topGifters)
    };
    
    this.broadcastEvent('stats', stats);
  }
  
  // Send new event to all SSE clients
  sendNewEvent(event) {
    this.broadcastEvent('new_event', event);
  }
}

module.exports = TikTokMCAPI;
