const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ========== CONFIG ==========
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];

// ========== AUTH STATE (in-memory) ==========
const users = new Map();   // email -> user object
const sessions = new Map(); // token -> email

function generateToken() {
  return 'tk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function getUserByToken(token) {
  const email = sessions.get(token);
  if (!email) return null;
  return users.get(email) || null;
}

// ========== ROOM STATE ==========
const rooms = new Map();
const historyGlobal = new Map(); // slug -> array of played tracks

function createRoom(slug, name, adminName = null) {
  return {
    slug, name,
    admin: adminName,
    queue: [
      { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', dj: 'Sistema', duration: 212 },
    ],
    currentIndex: 0,
    startedAt: Date.now(),
    votes: { up: 5, down: 0 },
    bannedUsers: [],
    chatHistory: [],
    listenerCount: 0,
    lastAddTime: new Map(),
    isPlaying: true,
  };
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
      avatar: s.userAvatar || (s.userName ? s.userName[0] : '👤'),
    }));
    io.to(slug).emit('users', users);
  });
}

function addSystemMsg(slug, text) {
  const room = rooms.get(slug);
  if (!room) return;
  const msg = {
    _id: Date.now().toString() + Math.random(),
    user: 'Sistema',
    text,
    color: '#888',
    isSystem: true,
    createdAt: new Date(),
  };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 300) room.chatHistory.shift();
  io.to(slug).emit('chat', msg);
}

// ========== AUTO-ADVANCE (fila consumível) ==========
setInterval(() => {
  for (const [slug, room] of rooms) {
    if (!room.isPlaying || room.queue.length === 0) continue;
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    const pos = getPosition(room);
    const duration = track.duration || 180;
    if (pos >= duration - 3) {
      const finishedTrack = room.queue.shift();
      room.currentIndex = 0;
      room.startedAt = Date.now();
      room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
      if (!historyGlobal.has(slug)) historyGlobal.set(slug, []);
      historyGlobal.get(slug).push({ ...finishedTrack, finishedAt: new Date() });
      broadcastState(slug);
      if (room.queue.length > 0) {
        const next = room.queue[0];
        io.to(slug).emit('trackChanged', next);
        addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
        addSystemMsg(slug, `🗑️ "${finishedTrack.title}" terminou`);
      } else {
        room.isPlaying = false;
        broadcastState(slug);
        addSystemMsg(slug, `🏁 Fila encerrada. Adicione mais músicas!`);
        io.to(slug).emit('queueEmpty');
      }
    }
  }
}, 2000);

// ========== AUTH API ==========
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, gender, birthDate, bio, avatar, genre } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, error: 'Nome, email e senha são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres' });
  }
  if (users.has(email.trim().toLowerCase())) {
    return res.status(400).json({ success: false, error: 'Este email já está cadastrado' });
  }
  const user = {
    id: Date.now().toString(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password,
    gender: gender || 'nao_informar',
    birthDate: birthDate || null,
    bio: bio || '',
    avatar: avatar || '🎸',
    genre: genre || '',
    createdAt: new Date().toISOString(),
    totalSongsAdded: 0,
    totalMessages: 0,
  };
  users.set(user.email, user);
  const token = generateToken();
  sessions.set(token, user.email);
  const { password: _, ...userWithoutPassword } = user;
  res.json({ success: true, token, user: userWithoutPassword });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email e senha são obrigatórios' });
  }
  const user = users.get(email.trim().toLowerCase());
  if (!user || user.password !== password) {
    return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });
  }
  const token = generateToken();
  sessions.set(token, user.email);
  const { password: _, ...userWithoutPassword } = user;
  res.json({ success: true, token, user: userWithoutPassword });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ success: false, error: 'Não autenticado' });
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ success: false, error: 'Sessão inválida' });
  const { password: _, ...userWithoutPassword } = user;
  res.json({ success: true, user: userWithoutPassword });
});

app.get('/api/auth/stats', (req, res) => {
  const totalUsers = users.size;
  const onlineNow = io.sockets.sockets.size;
  const today = new Date().toISOString().slice(0, 10);
  const newToday = Array.from(users.values()).filter(u => u.createdAt && u.createdAt.startsWith(today)).length;
  res.json({ totalUsers, onlineNow, newToday });
});

// ========== ROOMS API ==========
app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    slug: r.slug, name: r.name, listenerCount: r.listenerCount,
  }));
  res.json(list);
});

app.post('/api/rooms', (req, res) => {
  const { name, adminName } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
  rooms.set(slug, createRoom(slug, name, adminName || null));
  res.json({ slug, name });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ slug, name, adminPass, avatar }) => {
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
    socket.userAvatar = avatar || (name ? name[0] : '👤');
    room.listenerCount++;

    const isAdmin = adminPass === ADMIN_PASSWORD;
    socket.isAdmin = isAdmin;
    if (isAdmin && !room.admin) room.admin = name;
    if (room.admin === name) socket.isAdmin = true;

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

  socket.on('leaveRoom', () => {
    if (currentRoom) {
      socket.leave(currentRoom);
      const room = rooms.get(currentRoom);
      if (room) {
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
      }
      currentRoom = null;
    }
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text.trim()) return;
    const room = rooms.get(currentRoom);
    const msg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName,
      text: text.trim(),
      color: socket.userColor,
      isSystem: false,
      isAdmin: socket.isAdmin || false,
      avatar: socket.userAvatar,
      createdAt: new Date(),
      reactions: {},
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', msg);
  });

  socket.on('vote', (delta) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (delta > 0) room.votes.up++;
    else room.votes.down++;
    broadcastState(currentRoom);
  });

  socket.on('addSong', (song) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    const now = Date.now();
    const lastAdd = room.lastAddTime.get(socket.userName) || 0;
    if (now - lastAdd < 10000) {
      const wait = Math.ceil((10000 - (now - lastAdd)) / 1000);
      socket.emit('error', `Aguarde ${wait}s para adicionar outra música`);
      return;
    }
    song.dj = socket.userName;
    room.queue.push(song);
    room.lastAddTime.set(socket.userName, now);
    if (!room.isPlaying && room.queue.length === 1) {
      room.isPlaying = true;
      room.currentIndex = 0;
      room.startedAt = Date.now();
      io.to(currentRoom).emit('trackChanged', song);
      addSystemMsg(currentRoom, `▶ ${song.title} — ${song.artist}`);
    }
    broadcastState(currentRoom);
    const musicMsg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName,
      text: '',
      color: socket.userColor,
      isSystem: false,
      isAdmin: socket.isAdmin || false,
      isMusic: true,
      musicTitle: song.title,
      musicArtist: song.artist,
      musicLikes: 0,
      likedBy: [],
      createdAt: new Date(),
    };
    room.chatHistory.push(musicMsg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', musicMsg);
  });

  socket.on('skipTo', (index) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode pular músicas');
      return;
    }
    const room = rooms.get(currentRoom);
    if (index < 0 || index >= room.queue.length) return;
    if (index > 0) room.queue.splice(0, index);
    room.currentIndex = 0;
    room.startedAt = Date.now();
    room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
    room.isPlaying = true;
    broadcastState(currentRoom);
    io.to(currentRoom).emit('trackChanged', room.queue[0]);
    addSystemMsg(currentRoom, `⏭ ${socket.userName} pulou para: ${room.queue[0].title}`);
  });

  socket.on('removeFromQueue', (index) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode remover músicas da fila');
      return;
    }
    const room = rooms.get(currentRoom);
    const track = room.queue[index];
    if (!track) return;
    if (index === room.currentIndex) {
      socket.emit('error', 'Não pode remover a música que está tocando');
      return;
    }
    const removed = room.queue.splice(index, 1)[0];
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `🗑️ ${socket.userName} removeu "${removed.title}"`);
  });

  socket.on('kick', ({ targetName }) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode remover usuários');
      return;
    }
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('kicked', 'Removido da sala pelo admin'); target.disconnect(); }
      addSystemMsg(currentRoom, `🚪 ${targetName} foi removido pelo admin`);
    });
  });

  socket.on('ban', ({ targetName }) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode banir usuários');
      return;
    }
    const room = rooms.get(currentRoom);
    room.bannedUsers.push(targetName);
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('banned', 'Banido da sala pelo admin'); target.disconnect(); }
      addSystemMsg(currentRoom, `🚫 ${targetName} foi banido pelo admin`);
    });
  });

  socket.on('videoDuration', ({ duration }) => {
    if (!currentRoom || !duration || duration <= 0) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const track = room.queue[room.currentIndex];
    if (track && track.duration !== duration) track.duration = duration;
  });

  socket.on('videoEnded', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.isPlaying || room.queue.length === 0) return;
    const finishedTrack = room.queue.shift();
    room.currentIndex = 0;
    room.startedAt = Date.now();
    room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
    if (!historyGlobal.has(currentRoom)) historyGlobal.set(currentRoom, []);
    historyGlobal.get(currentRoom).push({ ...finishedTrack, finishedAt: new Date() });
    broadcastState(currentRoom);
    if (room.queue.length > 0) {
      const next = room.queue[0];
      io.to(currentRoom).emit('trackChanged', next);
      addSystemMsg(currentRoom, `▶ ${next.title} — ${next.artist}`);
      addSystemMsg(currentRoom, `🗑️ "${finishedTrack.title}" terminou`);
    } else {
      room.isPlaying = false;
      broadcastState(currentRoom);
      addSystemMsg(currentRoom, `🏁 Fila encerrada. Adicione mais músicas!`);
      io.to(currentRoom).emit('queueEmpty');
    }
  });

  socket.on('likeMusic', ({ msgId }) => {
    if (!currentRoom || !msgId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const msg = room.chatHistory.find(m => m._id === msgId);
    if (!msg || !msg.isMusic) return;
    if (msg.likedBy && msg.likedBy.includes(socket.userName)) return;
    msg.musicLikes = (msg.musicLikes || 0) + 1;
    if (!msg.likedBy) msg.likedBy = [];
    msg.likedBy.push(socket.userName);
    io.to(currentRoom).emit('musicLiked', { msgId, likes: msg.musicLikes });
  });

  socket.on('clearChat', () => {
    if (!currentRoom || !socket.isAdmin) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.chatHistory = [];
      io.to(currentRoom).emit('chatCleared');
    }
  });

  socket.on('addReaction', ({ msgId, emoji }) => {
    if (!currentRoom || !msgId || !emoji) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const msg = room.chatHistory.find(m => m._id === msgId);
    if (!msg || msg.isSystem) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (msg.reactions[emoji].includes(socket.userName)) {
      msg.reactions[emoji] = msg.reactions[emoji].filter(n => n !== socket.userName);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.userName);
    }
    io.to(currentRoom).emit('chatUpdated', msg);
  });

  socket.on('getHistory', () => {
    if (!currentRoom) return;
    const hist = historyGlobal.get(currentRoom) || [];
    socket.emit('history', hist);
  });

  socket.on('partyMode', ({ active }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('partyMode', { active });
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
