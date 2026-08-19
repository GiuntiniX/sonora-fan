const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

// ========== CONFIG ==========
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
const adminEmails = new Set(['admin@sonora.com']);
const settings = { maxQueue: 20, cooldown: 180, maxDuration: 600 };

// ========== AUTENTICAÇÃO ==========
const users = new Map();
const sessions = new Map();

// ========== ESTADO ==========
const rooms = new Map();
const roomLikes = new Map(); // ✅ Estado de curtidas por sala

function createRoom(slug, name, adminName = null) {
  roomLikes.set(slug, {});
  return {
    slug, name, admin: adminName,
    queue: [], currentIndex: 0, startedAt: Date.now(),
    votes: { up: 0, down: 0 }, bannedUsers: [],
    chatHistory: [], listenerCount: 0,
    lastAddTime: new Map(), isPlaying: false, lastAdvanceAt: 0
  };
}

function getRoomLikes(slug) {
  if (!roomLikes.has(slug)) {
    roomLikes.set(slug, {});
  }
  return roomLikes.get(slug);
}

rooms.set('lounge', createRoom('lounge', 'Lounge Sonora', 'Sistema'));

function getPosition(room) {
  const track = room.queue[room.currentIndex];
  if (!track) return 0;
  return Math.min((Date.now() - room.startedAt) / 1000, track.duration || 180);
}

function broadcastState(slug) {
  const room = rooms.get(slug);
  if (!room) return;
  io.to(slug).emit('roomState', {
    slug: room.slug, name: room.name,
    currentIndex: room.currentIndex,
    position: getPosition(room),
    votes: room.votes,
    queue: room.queue,
    admin: room.admin,
    isPlaying: room.isPlaying,
  });
}

function broadcastUsers(slug) {
  io.in(slug).fetchSockets().then(sockets => {
    const users = sockets.map(s => ({
      name: s.userName || 'Anônimo',
      color: s.userColor || '#888',
      isAdmin: s.isAdmin || false,
      avatar: s.userAvatar || '👤',
    }));
    io.to(slug).emit('users', users);
  });
}

function addSystemMsg(slug, text) {
  const room = rooms.get(slug);
  if (!room) return;
  const msg = {
    _id: Date.now().toString() + Math.random(),
    user: 'Sistema', text, color: '#888',
    isSystem: true, createdAt: new Date()
  };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 300) room.chatHistory.shift();
  io.to(slug).emit('chat', msg);
}

function advanceQueue(slug) {
  const room = rooms.get(slug);
  if (!room || !room.isPlaying || room.queue.length === 0) return false;
  if (Date.now() - room.lastAdvanceAt < 10000) return false;
  room.lastAdvanceAt = Date.now();

  room.queue.shift();
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
  broadcastState(slug);

  if (room.queue.length > 0) {
    const next = room.queue[0];
    addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
  } else {
    room.isPlaying = false;
    broadcastState(slug);
    addSystemMsg(slug, '🏁 Fila encerrada. Adicione músicas!');
    io.to(slug).emit('queueEmpty');
  }
  return true;
}

// Auto-advance
setInterval(() => {
  for (const [slug, room] of rooms) {
    if (!room.isPlaying || room.queue.length === 0) continue;
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    const pos = getPosition(room);
    const duration = track.duration || 180;
    if (pos >= duration - 2) advanceQueue(slug);
  }
}, 2000);

// ========== API ==========
app.post('/api/signup', (req, res) => {
  const { nome, email, senha, genero, regiao, estilos } = req.body;
  if (!nome || nome.length < 2) return res.status(400).json({ error: 'Nome inválido' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido' });
  if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter 6+ caracteres' });
  if (!genero) return res.status(400).json({ error: 'Selecione um gênero' });
  if (!regiao) return res.status(400).json({ error: 'Selecione uma região' });
  if (!estilos || estilos.length === 0) return res.status(400).json({ error: 'Escolha um estilo' });
  if (users.has(email)) return res.status(400).json({ error: 'E-mail já cadastrado' });

  users.set(email, { nome, email, senha, genero, regiao, estilos, avatar: '🎸', criadoEm: new Date() });
  res.json({ success: true, nome, email });
});

app.post('/api/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Preencha e-mail e senha' });
  const user = users.get(email);
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
  if (user.senha !== senha) return res.status(401).json({ error: 'Senha incorreta' });

  const token = crypto.randomBytes(64).toString('hex');
  sessions.set(token, email);
  res.cookie('sessionToken', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
  const { senha: _, ...userData } = user;
  res.json({ success: true, user: userData });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessionToken;
  if (token) sessions.delete(token);
  res.clearCookie('sessionToken');
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  const user = users.get(email);
  if (!user) { sessions.delete(token); return res.status(401).json({ error: 'Usuário não encontrado' }); }
  const { senha: _, ...userData } = user;
  res.json({ success: true, user: userData });
});

app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    slug: r.slug, name: r.name, listenerCount: r.listenerCount,
    queueLength: r.queue.length, isPlaying: r.isPlaying,
    currentTrack: r.queue[r.currentIndex] || null,
  }));
  res.json(list);
});

app.get('/api/rooms/random', (req, res) => {
  const list = Array.from(rooms.values());
  if (list.length === 0) return res.json({ slug: null });
  const sorted = list.sort((a, b) => b.listenerCount - a.listenerCount);
  res.json({ slug: sorted[0].slug });
});

app.post('/api/rooms', (req, res) => {
  const { name, adminName } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
  rooms.set(slug, createRoom(slug, name, adminName || null));
  res.json({ slug, name });
});

// Video info
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 4e6) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

app.get('/api/video-info', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'ID inválido' });

  const info = { id, title: null, artist: null, duration: null };
  try {
    const raw = await fetchUrl(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    const data = JSON.parse(raw);
    info.title = data.title || null;
    info.artist = data.author_name || null;
  } catch (e) {}

  try {
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${id}`);
    const m = html.match(/"lengthSeconds":"?(\d+)"?/);
    if (m) info.duration = parseInt(m[1], 10);
    if (!info.title) {
      const t = html.match(/<title>([^<]+)<\/title>/);
      if (t) info.title = t[1].replace(/ - YouTube\s*$/, '').trim();
    }
  } catch (e) {}

  if (!info.title && !info.duration) return res.status(404).json({ error: 'Vídeo não encontrado' });
  res.json(info);
});

// ========== ADMIN ROTAS ==========
function isAdmin(req, res, next) {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  if (!adminEmails.has(email)) return res.status(403).json({ error: 'Acesso negado' });
  req.adminEmail = email;
  next();
}

app.get('/api/admin/stats', isAdmin, (req, res) => {
  let totalSongs = 0;
  for (const [slug, room] of rooms) totalSongs += room.queue.length;
  res.json({ totalUsers: users.size, totalRooms: rooms.size, onlineUsers: io.sockets.sockets.size, totalSongs });
});

app.get('/api/admin/users', isAdmin, (req, res) => {
  const list = Array.from(users.values()).map(u => ({ ...u, senha: undefined, isAdmin: adminEmails.has(u.email) }));
  res.json(list);
});

app.post('/api/admin/promote', isAdmin, (req, res) => {
  const { email } = req.body;
  if (!email || !users.has(email)) return res.status(404).json({ error: 'Usuário não encontrado' });
  adminEmails.add(email);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', isAdmin, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  if (email === 'admin@sonora.com') return res.status(400).json({ error: 'Não pode deletar o super admin' });
  if (!users.has(email)) return res.status(404).json({ error: 'Usuário não encontrado' });
  users.delete(email);
  adminEmails.delete(email);
  res.json({ success: true });
});

app.post('/api/admin/clear-all-chats', isAdmin, (req, res) => {
  for (const [slug, room] of rooms) { 
    room.chatHistory = [];
    roomLikes.set(slug, {}); // ✅ Limpa curtidas também
    io.to(slug).emit('chatCleared');
  }
  res.json({ success: true });
});

app.post('/api/admin/clear-all-rooms', isAdmin, (req, res) => {
  for (const [slug, room] of rooms) {
    room.queue = [];
    room.currentIndex = 0;
    room.isPlaying = false;
    roomLikes.set(slug, {}); // ✅ Limpa curtidas também
    broadcastState(slug);
    io.to(slug).emit('queueEmpty');
  }
  res.json({ success: true });
});

app.get('/api/admin/export-data', isAdmin, (req, res) => {
  const data = {
    exportedAt: new Date().toISOString(),
    users: Array.from(users.values()).map(u => ({ ...u, senha: undefined })),
    admins: Array.from(adminEmails),
    rooms: Array.from(rooms.values()).map(r => ({
      slug: r.slug, name: r.name, admin: r.admin,
      queue: r.queue, chatHistory: r.chatHistory.slice(-50),
      listenerCount: r.listenerCount, isPlaying: r.isPlaying
    })),
    settings
  };
  res.json(data);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ slug, name, avatar }) => {
    const room = rooms.get(slug);
    if (!room) { socket.emit('error', 'Sala não encontrada'); return; }
    if (room.bannedUsers.includes(name)) { socket.emit('error', 'Você foi banido'); return; }

    if (currentRoom) {
      socket.leave(currentRoom);
      const old = rooms.get(currentRoom);
      if (old) old.listenerCount = Math.max(0, old.listenerCount - 1);
    }

    currentRoom = slug;
    socket.join(slug);
    socket.userName = name;
    socket.userColor = colors[Math.floor(Math.random() * colors.length)];
    socket.userAvatar = avatar || '👤';
    room.listenerCount++;

    const cookie = socket.handshake.headers.cookie || '';
    const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
    const email = tokenMatch ? sessions.get(tokenMatch[1]) : null;
    const isGlobalAdmin = adminEmails.has(email);
    const isRoomAdmin = room.admin === name;
    socket.isAdmin = isGlobalAdmin || isRoomAdmin;

    if (isGlobalAdmin && !room.admin) room.admin = name;

    // ✅ Envia o estado atual de curtidas
    const likes = getRoomLikes(slug);
    socket.emit('likesState', likes);

    socket.emit('roomState', {
      slug: room.slug, name: room.name,
      currentIndex: room.currentIndex,
      position: getPosition(room),
      votes: room.votes,
      queue: room.queue,
      admin: room.admin,
      isPlaying: room.isPlaying,
    });
    socket.emit('chatHistory', room.chatHistory.slice(-150));
    socket.emit('isAdmin', socket.isAdmin);
    broadcastUsers(slug);
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text.trim()) return;
    const room = rooms.get(currentRoom);
    const msg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName, text: text.trim(),
      color: socket.userColor, isSystem: false,
      isAdmin: socket.isAdmin || false,
      avatar: socket.userAvatar || '👤',
      createdAt: new Date()
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', msg);
  });

  socket.on('addSong', (song) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();
    const lastAdd = room.lastAddTime.get(socket.userName) || 0;

    if (now - lastAdd < 10000) {
      const wait = Math.ceil((10000 - (now - lastAdd)) / 1000);
      socket.emit('error', `Aguarde ${wait}s`);
      return;
    }

    if (room.queue.length >= settings.maxQueue) {
      socket.emit('error', `Fila cheia (${settings.maxQueue})`);
      return;
    }

    if (song.duration && song.duration > settings.maxDuration) {
      socket.emit('error', `⛔ Vídeo muito longo! Limite: ${settings.maxDuration/60} min`);
      return;
    }

    song.dj = socket.userName;
    room.queue.push(song);
    room.lastAddTime.set(socket.userName, now);

    if (!room.isPlaying && room.queue.length === 1) {
      room.isPlaying = true;
      room.currentIndex = 0;
      room.startedAt = Date.now();
      room.lastAdvanceAt = Date.now();
      addSystemMsg(currentRoom, `▶ ${song.title} — ${song.artist}`);
    }

    broadcastState(currentRoom);

    const musicMsg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName, color: socket.userColor,
      isSystem: false, isAdmin: socket.isAdmin || false,
      isMusic: true, musicTitle: song.title,
      musicArtist: song.artist, createdAt: new Date()
    };
    room.chatHistory.push(musicMsg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', musicMsg);
  });

  socket.on('skipTo', (index) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin');
      return;
    }
    const room = rooms.get(currentRoom);
    if (index < 0 || index >= room.queue.length) return;
    room.lastAdvanceAt = Date.now();
    if (index > 0) room.queue.splice(0, index);
    room.currentIndex = 0;
    room.startedAt = Date.now();
    room.isPlaying = true;
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `⏭ ${socket.userName} pulou para: ${room.queue[0]?.title || 'fila vazia'}`);
  });

  socket.on('removeFromQueue', (index) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin');
      return;
    }
    const room = rooms.get(currentRoom);
    const track = room.queue[index];
    if (!track || index === room.currentIndex) return;
    room.queue.splice(index, 1);
    if (index < room.currentIndex) room.currentIndex--;
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `🗑️ ${socket.userName} removeu "${track.title}"`);
  });

  // ✅ Evento de curtir mensagem
  socket.on('likeMessage', ({ messageId, room }) => {
    if (!room || !socket.userName) return;
    
    const likes = getRoomLikes(room);
    
    if (!likes[messageId]) {
      likes[messageId] = { likes: 0, users: [] };
    }
    
    const data = likes[messageId];
    const userIndex = data.users.indexOf(socket.userName);
    
    if (userIndex > -1) {
      data.users.splice(userIndex, 1);
      data.likes = Math.max(0, data.likes - 1);
    } else {
      data.users.push(socket.userName);
      data.likes++;
    }
    
    io.to(room).emit('likeUpdate', {
      messageId,
      likes: data.likes,
      users: data.users
    });
  });

  socket.on('videoDuration', ({ duration }) => {
    if (!currentRoom || !duration) return;
    const room = rooms.get(currentRoom);
    const track = room.queue[room.currentIndex];
    if (track) track.duration = duration;
  });

  socket.on('videoEnded', () => {
    if (currentRoom) advanceQueue(currentRoom);
  });

  socket.on('clearChat', () => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin');
      return;
    }
    const room = rooms.get(currentRoom);
    room.chatHistory = [];
    roomLikes.set(currentRoom, {}); // ✅ Limpa curtidas
    io.to(currentRoom).emit('chatCleared');
    addSystemMsg(currentRoom, '🧹 Chat limpo pelo admin');
  });

  socket.on('adminBroadcast', (data) => {
    if (!socket.isAdmin) return;
    io.emit('adminBroadcast', { message: data.message });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
