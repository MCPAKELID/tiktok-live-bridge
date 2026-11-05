// ==================== TMINE.JS ====================
// WebSocket server khusus untuk koneksi Minecraft
// Mengirim semua event TikTok ke Minecraft dengan format lengkap

const WebSocket = require('ws');
const EventEmitter = require('events');
const { MINECRAFT_EVENTS, Utils } = require('./setting');

class MinecraftWebSocketServer extends EventEmitter {
  constructor(port, config = {}) {
    super();
    this.port = port;
    this.wss = null;
    this.clients = new Set();
    this.isRunning = false;
    this.config = {
      sendToMinecraft: {
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
      },
      format: MINECRAFT_EVENTS.FORMAT,
      ...config
    };
    
    this.stats = {
      totalConnections: 0,
      messagesSent: 0,
      messagesReceived: 0,
      startTime: null
    };
  }

  init() {
    if (this.wss) return this;

    this.stats.startTime = Date.now();
    
    this.wss = new WebSocket.Server({ host: process.env.MINECRAFT_WS_HOST || undefined, port: this.port });
    
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (err) => {
      this.emit('error', err);
    });

    this.isRunning = true;
    console.log(`🔌 Minecraft WebSocket server running on port ${this.port}`);
    
    return this;
  }

  handleConnection(ws, req) {
    const clientId = this.generateClientId();
    const clientInfo = {
      id: clientId,
      address: req.socket.remoteAddress,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      playerUUID: null,
      playerName: null,
      tiktok: null,
      hostId: null
    };
    
    this.clients.add({ ws, info: clientInfo });
    this.stats.totalConnections++;
    
    this.emit('client_connected', {
      clientId,
      total: this.clients.size,
      address: clientInfo.address
    });

    this.sendToClient(ws, 'connection', {
      status: 'connected',
      clientId,
      message: 'Connected to TikTok Live Bridge',
      serverTime: Date.now()
    });

    if (this.currentStats) {
      this.sendToClient(ws, 'init', this.currentStats);
    }

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        this.stats.messagesReceived++;
        clientInfo.lastActivity = Date.now();
        if (data.type === 'subscribe' || data.event === 'subscribe') {
          const incomingPlayerUUID = String(data.playerUUID || '').trim();
          if (incomingPlayerUUID) {
            // One Minecraft player gets one active client. Close stale duplicates
            // so two sockets cannot host the same player at the same time.
            for (const other of Array.from(this.clients)) {
              if (other.ws === ws) continue;
              const otherUUID = other.info.playerUUID;
              if (otherUUID && incomingPlayerUUID.toLowerCase() === String(otherUUID).toLowerCase()) {
                try { other.ws.close(1000, 'Replaced by newer Minecraft session for this player'); } catch (_) {}
              }
            }
          }
          clientInfo.playerUUID = incomingPlayerUUID || null;
          clientInfo.playerName = data.playerName || null;
          clientInfo.tiktok = data.tiktok || null;
          clientInfo.hostId = data.hostId || clientInfo.hostId || null;
        }
        this.emit('client_message', {
          clientId,
          data,
          timestamp: Date.now()
        });
      } catch (err) {
        this.emit('error', { clientId, error: 'Invalid JSON' });
      }
    });

    ws.on('close', () => {
      this.clients = new Set([...this.clients].filter(c => c.ws !== ws));
      this.emit('client_disconnected', {
        clientId,
        total: this.clients.size
      });
    });

    ws.on('error', (err) => {
      this.emit('client_error', { clientId, error: err.message });
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
  }

  generateClientId() {
    return 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  sendToClient(ws, event, data) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    
    const json = JSON.stringify({
      type: 'event',
      event: event,
      ...data,
      timestamp: Date.now()
    });
    
    ws.send(json);
    this.stats.messagesSent++;
    return true;
  }

  getClient(clientId) {
    for (const client of this.clients) if (client.info.id === clientId) return client;
    return null;
  }

  sendToSession(clientId, event, data = {}) {
    const client = this.getClient(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
    // Session identity is attached to every scoped event. The Minecraft side
    // can then reject any event whose playerUUID does not match its connection.
    const scopedData = { ...data };
    if (client.info.playerUUID) scopedData.playerUUID = client.info.playerUUID;
    if (client.info.playerName) scopedData.playerName = client.info.playerName;
    if (client.info.tiktok && !scopedData.tiktok) scopedData.tiktok = client.info.tiktok;
    if (client.info.hostId && !scopedData.hostId) scopedData.hostId = client.info.hostId;
    const json = JSON.stringify({ type: 'event', event, ...scopedData, timestamp: Date.now() });
    client.ws.send(json);
    this.stats.messagesSent++;
    return true;
  }

  getClientInfo(clientId) {
    const client = this.getClient(clientId);
    return client ? client.info : null;
  }

  broadcast(event, data) {
    if (!this.wss || this.clients.size === 0) return false;
    
    if (!this.config.sendToMinecraft[event]) {
      return false;
    }

    let formattedData = { ...data };
    
    if (this.config.format[event.toUpperCase()]) {
      const template = this.config.format[event.toUpperCase()];
      formattedData = {};
      
      Object.keys(template).forEach(key => {
        let value = template[key];
        if (typeof value === 'string') {
          Object.keys(data).forEach(dataKey => {
            value = value.replace(`{${dataKey}}`, data[dataKey] || '');
          });
        }
        formattedData[key] = value;
      });
    }

    const json = JSON.stringify({
      type: 'event',
      event: event,
      ...formattedData,
      timestamp: Date.now()
    });

    let sentCount = 0;
    this.clients.forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
        client.info.lastActivity = Date.now();
        sentCount++;
        this.stats.messagesSent++;
      }
    });

    this.emit('broadcast', { event, sentCount, total: this.clients.size });
    return true;
  }

  broadcastTikTokEvent(eventType, data) {
    console.log(`[TMine] Broadcasting ${eventType} to ${this.clients.size} clients:`, data);
    
    switch(eventType) {
      case 'chat':
        this.broadcast('chat', {
          username: data.uniqueId || data.username,
          nickname: data.nickname || data.uniqueId,
          message: data.comment || data.message,
          timestamp: Date.now()
        });
        break;
        
      case 'gift':
        const giftId = data.giftId;
        const giftName = data.giftName || data.gift?.giftName || 'Gift';
        const uniqueId = data.uniqueId || data.username;
        const repeatCount = data.repeatCount || 1;
        const diamondCount = data.diamondCount || data.gift?.diamondCount || 0;
        const totalCoin = data.totalCoin || (diamondCount * repeatCount);
        
        console.log(`[GIFT] ${uniqueId} -> ${giftName} x${repeatCount} (Coin: ${diamondCount}, Total: ${totalCoin})`);
        
        this.broadcast('gift', {
          username: uniqueId,
          giftName: giftName,
          giftId: giftId,
          count: repeatCount,
          repeatCount: repeatCount,
          coin: diamondCount,
          totalCoin: totalCoin,
          sourceEventId: data.sourceEventId || data.eventId || data.msgId || '',
          timestamp: Date.now()
        });
        break;
        
      case 'like':
        this.broadcast('like', {
          username: data.uniqueId || data.username,
          count: data.likeCount || 1,
          totalLikes: data.totalLikes || 0,
          timestamp: Date.now()
        });
        break;
        
      case 'follow':
        this.broadcast('follow', {
          username: data.uniqueId || data.username,
          userId: data.userId,
          timestamp: Date.now()
        });
        break;
        
      case 'share':
        this.broadcast('share', {
          username: data.uniqueId || data.username,
          timestamp: Date.now()
        });
        break;
        
      case 'member':
      case 'join':
        this.broadcast('join', {
          username: data.uniqueId || data.username,
          nickname: data.nickname || data.uniqueId,
          timestamp: Date.now()
        });
        break;
        
      case 'viewers':
        this.broadcast('viewers', {
          count: data.viewerCount,
          timestamp: Date.now()
        });
        break;
        
      case 'warning':
        this.broadcast('warning', {
          username: data.uniqueId || data.username,
          message: data.message,
          timestamp: Date.now()
        });
        break;
        
      case 'command_response':
        this.broadcast('command_response', {
          to: data.to,
          message: data.message,
          timestamp: Date.now()
        });
        break;
        
      case 'stats_update':
        this.broadcast('stats_update', {
          gifts: data.gifts,
          likes: data.likes,
          follows: data.follows,
          chats: data.chats,
          viewers: data.viewers,
          totalGiftValue: data.totalGiftValue,
          timestamp: Date.now()
        });
        break;
        
      default:
        this.broadcast(eventType, {
          ...data,
          timestamp: Date.now()
        });
    }
  }

  setCurrentStats(stats) {
    this.currentStats = stats;
    this.broadcastTikTokEvent('stats_update', stats);
  }

  getStats() {
    return {
      ...this.stats,
      currentClients: this.clients.size,
      uptime: Date.now() - this.stats.startTime,
      clients: [...this.clients].map(c => ({
        id: c.info.id,
        address: Utils.getSensedIP(c.info.address),
        connectedFor: Date.now() - c.info.connectedAt,
        lastActivity: Date.now() - c.info.lastActivity
      }))
    };
  }

  getClients() {
    return [...this.clients].map(c => ({
      id: c.info.id,
      connectedAt: c.info.connectedAt,
      lastActivity: c.info.lastActivity
    }));
  }

  getClientCount() {
    return this.clients.size;
  }

  kickClient(clientId) {
    for (const client of this.clients) {
      if (client.info.id === clientId) {
        client.ws.close(1000, 'Kicked by server');
        return true;
      }
    }
    return false;
  }

  stop() {
    if (this.wss) {
      this.broadcast('shutdown', {
        message: 'Server is shutting down',
        timestamp: Date.now()
      });

      this.clients.forEach(client => {
        client.ws.close(1000, 'Server shutdown');
      });

      this.wss.close();
      this.isRunning = false;
      this.clients.clear();
      
      this.emit('stopped', {
        uptime: Date.now() - this.stats.startTime,
        totalMessages: this.stats.messagesSent + this.stats.messagesReceived
      });
    }
  }

  isActive() {
    return this.isRunning;
  }

  updateConfig(newConfig) {
    this.config = {
      ...this.config,
      ...newConfig
    };
    this.emit('config_updated', this.config);
  }

  setEventEnabled(event, enabled) {
    if (this.config.sendToMinecraft.hasOwnProperty(event)) {
      this.config.sendToMinecraft[event] = enabled;
      this.emit('event_toggled', { event, enabled });
      return true;
    }
    return false;
  }
}

module.exports = MinecraftWebSocketServer;
