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

    // Só avança se passou da duração real (com margem de 3s)
    // A duração real é atualizada pelo cliente quando o vídeo carrega
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

  socket.on('joinRoom', ({ slug, name, adminPass }) => {
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
    addSystemMsg(slug, `👋 ${name} entrou`);
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text.trim()) return;
    const room = rooms.get(currentRoom);
    const msg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName, text: text.trim(),
      color: socket.userColor, isSystem: false,
      isAdmin: socket.isAdmin || false,
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
    addSystemMsg(currentRoom, `➕ ${socket.userName} adicionou "${song.title}"`);
  });

  socket.on('skipTo', (index) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (index < 0 || index >= room.queue.length) return;

    // Admin pode pular livremente. Não-admin só pode pular para frente?
    // Vou deixar todos poderem pular, mas o admin pode pular para qualquer lugar

    // Remove todas as músicas antes do index (fila consumível)
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
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    // Só admin ou quem adicionou pode remover
    const track = room.queue[index];
    if (!track) return;
    if (!socket.isAdmin && track.dj !== socket.userName) {
      socket.emit('error', 'Só o admin ou quem adicionou pode remover');
      return;
    }
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
    if (track && track.duration !== duration) {
      track.duration = duration;
      // Não precisa broadcast, só atualiza a duração interna
    }
  });

  socket.on('videoEnded', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.isPlaying || room.queue.length === 0) return;

    // Força o avanço da fila
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
      room.isPlaying = false;
      broadcastState(currentRoom);
      addSystemMsg(currentRoom, `🏁 Fila encerrada. Adicione mais músicas!`);
      io.to(currentRoom).emit('queueEmpty');
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.listenerCount = Math.max(0, room.listenerCount - 1);

        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
        addSystemMsg(currentRoom, `👋 ${socket.userName || 'Alguém'} saiu`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
