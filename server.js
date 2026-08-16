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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Senha padrão do admin
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];

// ========== ESTADO ==========
const rooms = new Map();

function createRoom(slug, name, adminName = null) {
  return {
    slug, name,
    admin: adminName, // nome do admin da sala
    queue: [
      { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', dj: 'Sistema', duration: 212 },
    ],
    currentIndex: 0,
    startedAt: Date.now(),
    votes: { up: 5, down: 0 },
    
    bannedUsers: [],
    chatHistory: [],
    listenerCount: 0,
    lastAddTime: new Map(), // userName -> timestamp (cooldown)
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
      avatar: s.userAvatar || s.userName?.[0] || '?',
      isAdmin: s.isAdmin || false,
    }));
    io.to(slug).emit('users', users);
  });
}

function addSystemMsg(slug, text) {
  const room = rooms.get(slug);
  if (!room) return;
  const msg = { _id: Date.now().toString() + Math.random(), user: 'Sistema', text, color: '#888', isSystem: true, createdAt: new Date() };
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

// ========== API ==========
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
    socket.userAvatar = avatar || name[0];
    room.listenerCount++;

    // Verifica se é admin
    const isAdmin = adminPass === ADMIN_PASSWORD;
    socket.isAdmin = isAdmin;

    // Se não tem admin na sala e a senha está correta, torna admin da sala
    if (isAdmin && !room.admin) {
      room.admin = name;
    }
    // Se o nome bate com o admin da sala
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
    // Entrada silenciosa
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text.trim()) return;
    const room = rooms.get(currentRoom);
    const msg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName, text: text.trim(),
      color: socket.userColor, isSystem: false,
      isAdmin: socket.isAdmin || false,
      avatar: socket.userAvatar || socket.userName[0],
      reactions: {},
      createdAt: new Date(),
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', msg);
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
    if (!msg || msg.isSystem || msg.isMusic) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (msg.reactions[emoji].includes(socket.userName)) {
      msg.reactions[emoji] = msg.reactions[emoji].filter(u => u !== socket.userName);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(socket.userName);
    }
    io.to(currentRoom).emit('chatUpdated', msg);
  });

  socket.on('clearChat', () => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode limpar o chat');
      return;
    }
    const room = rooms.get(currentRoom);
    room.chatHistory = [];
    io.to(currentRoom).emit('chatCleared');
  });

  socket.on('vote', (delta) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (delta > 0) room.votes.up++;
    else room.votes.down++;
    broadcastState(currentRoom);
  });

  // Add song com COOLDOWN de 10 segundos
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

    // Se não estava tocando, começa a tocar
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

    if (index > 0) {
      room.queue.splice(0, index);
    }

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
    broadcastState(currentRoom);
    if (room.queue.length > 0) {
      const next = room.queue[0];
      io.to(currentRoom).emit('trackChanged', next);
      addSystemMsg(currentRoom, `▶ ${next.title} — ${next.artist}`);
      addSystemMsg(currentRoom, `🗑️ "${finishedTrack.title}" terminou`);
    } else {
      // MODO RÁDIO: toca música relacionada automaticamente
      const radioTracks = [
        { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 212 },
        { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355 },
        { id: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit', artist: 'Nirvana', duration: 301 },
        { id: 'Zi_XLOBDo_Y', title: 'Billie Jean', artist: 'Michael Jackson', duration: 294 },
        { id: 'btPJPFnesV4', title: 'Imagine', artist: 'John Lennon', duration: 183 },
        { id: '1w7OgIMMRc4', title: "Guns N' Roses - Sweet Child O' Mine", artist: "Guns N' Roses", duration: 356 },
        { id: 'l482T0yNkeo', title: 'Hotel California', artist: 'Eagles', duration: 391 },
        { id: 'pAgnJDJN4VA', title: 'AC/DC - Back In Black', artist: 'AC/DC', duration: 255 },
        { id: 'fLexgOxsZu0', title: 'Bruno Mars - The Lazy Song', artist: 'Bruno Mars', duration: 208 },
        { id: 'kffacxfA7G4', title: 'Baby', artist: 'Justin Bieber', duration: 214 },
      ];
      const randomTrack = radioTracks[Math.floor(Math.random() * radioTracks.length)];
      randomTrack.dj = '📻 Rádio Sonora';
      room.queue.push(randomTrack);
      room.isPlaying = true;
      room.currentIndex = 0;
      room.startedAt = Date.now();
      broadcastState(currentRoom);
      io.to(currentRoom).emit('trackChanged', randomTrack);
      addSystemMsg(currentRoom, `📻 Modo rádio ativado! Tocando: ${randomTrack.title} — ${randomTrack.artist}`);
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
    // Confetti quando bate 10 likes
    if (msg.musicLikes === 10) {
      io.to(currentRoom).emit('confetti');
      addSystemMsg(currentRoom, `🎉 "${msg.musicTitle}" bateu 10 curtidas!`);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
        // Saída silenciosa
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
