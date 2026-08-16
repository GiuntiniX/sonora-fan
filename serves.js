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

// ========== ESTADO ==========
const rooms = new Map();

function createRoom(slug, name, adminName = null) {
  return {
    slug, name,
    admin: adminName,
    queue: [],
    currentIndex: 0,
    startedAt: Date.now(),
    votes: { up: 0, down: 0 },
    bannedUsers: [],
    chatHistory: [],
    listenerCount: 0,
    lastAddTime: new Map(),
    isPlaying: false,
    lastAdvanceAt: 0, // protege contra avanço duplo
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
    user: 'Sistema', text,
    color: '#888', isSystem: true,
    createdAt: new Date(),
  };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 300) room.chatHistory.shift();
  io.to(slug).emit('chat', msg);
}

// ========== AVANÇO CENTRALIZADO (evita race condition) ==========
function advanceQueue(slug, reason) {
  const room = rooms.get(slug);
  if (!room) return false;
  if (!room.isPlaying || room.queue.length === 0) return false;

  const now = Date.now();
  // Proteção de 10s contra avanço duplo (setInterval + videoEnded)
  if (now - room.lastAdvanceAt < 10000) return false;
  room.lastAdvanceAt = now;

  const finishedTrack = room.queue.shift();
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };

  broadcastState(slug);

  if (room.queue.length > 0) {
    const next = room.queue[0];
    addSystemMsg(slug, `\u25b6 ${next.title} \u2014 ${next.artist}`);
    if (finishedTrack) {
      addSystemMsg(slug, `\ud83d\uddd1\ufe0f "${finishedTrack.title}" terminou`);
    }
  } else {
    room.isPlaying = false;
    broadcastState(slug);
    addSystemMsg(slug, `\ud83c\udfc1 Fila encerrada. Adicione mais m\u00fasicas!`);
    io.to(slug).emit('queueEmpty');
  }
  return true;
}

// ========== AUTO-ADVANCE (backup caso nenhum cliente emita videoEnded) ==========
setInterval(() => {
  for (const [slug, room] of rooms) {
    if (!room.isPlaying || room.queue.length === 0) continue;
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    const pos = getPosition(room);
    const duration = track.duration || 180;
    // Avan\u00e7a 2 segundos antes de acabar
    if (pos >= duration - 2) {
      advanceQueue(slug, 'auto');
    }
  }
}, 2000);

// ========== API ==========
app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    slug: r.slug, name: r.name, listenerCount: r.listenerCount,
  }));
  res.json(list);
});

app.post('/api/rooms', (req, res) => {
  const { name, adminName } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigat\u00f3rio' });
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
    if (!room) { socket.emit('error', 'Sala n\u00e3o encontrada'); return; }
    if (room.bannedUsers.includes(name)) { socket.emit('error', 'Voc\u00ea foi banido'); return; }

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

    // Verifica se \u00e9 admin
    const isAdmin = adminPass === ADMIN_PASSWORD;
    socket.isAdmin = isAdmin;

    if (isAdmin && !room.admin) {
      room.admin = name;
    }
    if (room.admin === name) {
      socket.isAdmin = true;
    }

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
      createdAt: new Date(),
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
      socket.emit('error', `Aguarde ${wait}s para adicionar outra m\u00fasica`);
      return;
    }

    if (room.queue.length >= 20) {
      socket.emit('error', 'Fila cheia (máx. 20 músicas). Aguarde a próxima rodada.');
      return;
    }
    song.dj = socket.userName;
    room.queue.push(song);
    room.lastAddTime.set(socket.userName, now);

    if (!room.isPlaying && room.queue.length === 1) {
      room.isPlaying = true;
      room.currentIndex = 0;
      room.startedAt = Date.now();
      room.lastAdvanceAt = Date.now(); // marca para evitar avan\u00e7o imediato
      addSystemMsg(currentRoom, `\u25b6 ${song.title} \u2014 ${song.artist}`);
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
      socket.emit('error', 'Apenas admin pode pular m\u00fasicas');
      return;
    }
    const room = rooms.get(currentRoom);
    if (index < 0 || index >= room.queue.length) return;

    room.lastAdvanceAt = Date.now();
    if (index > 0) room.queue.splice(0, index);
    room.currentIndex = 0;
    room.startedAt = Date.now();
    room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
    room.isPlaying = true;
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `\u23ed ${socket.userName} pulou para: ${room.queue[0].title}`);
  });

  socket.on('removeFromQueue', (index) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode remover m\u00fasicas da fila');
      return;
    }
    const room = rooms.get(currentRoom);
    const track = room.queue[index];
    if (!track) return;
    if (index === room.currentIndex) {
      socket.emit('error', 'N\u00e3o pode remover a m\u00fasica que est\u00e1 tocando');
      return;
    }
    const removed = room.queue.splice(index, 1)[0];
    // Ajusta currentIndex se necess\u00e1rio
    if (index < room.currentIndex) room.currentIndex--;
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `\ud83d\uddd1\ufe0f ${socket.userName} removeu "${removed.title}"`);
  });

  socket.on('kick', ({ targetName }) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode remover usu\u00e1rios');
      return;
    }
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('kicked', 'Removido da sala pelo admin'); target.disconnect(); }
      addSystemMsg(currentRoom, `\ud83d\udeaa ${targetName} foi removido pelo admin`);
    });
  });

  socket.on('ban', ({ targetName }) => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode banir usu\u00e1rios');
      return;
    }
    const room = rooms.get(currentRoom);
    room.bannedUsers.push(targetName);
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('banned', 'Banido da sala pelo admin'); target.disconnect(); }
      addSystemMsg(currentRoom, `\ud83d\udeab ${targetName} foi banido pelo admin`);
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
    advanceQueue(currentRoom, 'videoEnded');
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

  socket.on('typing', ({ isTyping }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('typing', { name: socket.userName, isTyping });
  });

  socket.on('addReaction', ({ msgId, emoji }) => {
    if (!currentRoom || !msgId || !emoji) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const msg = room.chatHistory.find(m => m._id === msgId);
    if (!msg || msg.isSystem) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const users = msg.reactions[emoji];
    if (users.includes(socket.userName)) {
      msg.reactions[emoji] = users.filter(u => u !== socket.userName);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.userName);
    }
    io.to(currentRoom).emit('chatUpdated', msg);
  });

  socket.on('clearChat', () => {
    if (!currentRoom || !socket.isAdmin) return;
    const room = rooms.get(currentRoom);
    room.chatHistory = [];
    io.to(currentRoom).emit('chatCleared');
  });

  socket.on('confetti', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('confetti');
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
server.listen(PORT, () => console.log(`\ud83c\udfa7 Sonora Fan \u2192 http://localhost:${PORT}`));
