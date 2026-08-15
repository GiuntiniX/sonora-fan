const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ========== ESTADO ==========
const rooms = new Map();
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];

function createRoom(slug, name) {
  return {
    slug, name,
    queue: [
      { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', dj: 'Sistema', duration: 212 },
    ],
    currentIndex: 0,
    startedAt: Date.now(),
    votes: { up: 5, down: 0 },
    djSlots: [null, null, null, null, null],
    bannedUsers: [],
    chatHistory: [],
    listenerCount: 0,
    lastAddTime: new Map(), // userName -> timestamp (cooldown)
  };
}

rooms.set('lounge', createRoom('lounge', 'Lounge Sonora'));

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
    djSlots: room.djSlots,
  });
}

function broadcastUsers(slug) {
  io.in(slug).fetchSockets().then(sockets => {
    const users = sockets.map(s => ({
      name: s.userName || 'Anônimo',
      color: s.userColor || '#888',
      djSlot: s.djSlot ?? -1,
    }));
    io.to(slug).emit('users', users);
  });
}

function addSystemMsg(slug, text) {
  const room = rooms.get(slug);
  if (!room) return;
  const msg = { _id: Date.now().toString() + Math.random(), user: 'Sistema', text, color: '#555', isSystem: true, createdAt: new Date() };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 200) room.chatHistory.shift();
  io.to(slug).emit('chat', msg);
}

// Auto-advance
setInterval(() => {
  for (const [slug, room] of rooms) {
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    if (getPosition(room) >= (track.duration || 180) - 1) {
      room.currentIndex = (room.currentIndex + 1) % room.queue.length;
      room.startedAt = Date.now();
      room.votes = { up: Math.floor(Math.random() * 10) + 2, down: 0 };
      broadcastState(slug);
      const next = room.queue[room.currentIndex];
      io.to(slug).emit('trackChanged', next);
      addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
  rooms.set(slug, createRoom(slug, name));
  res.json({ slug, name });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ slug, name }) => {
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
    socket.djSlot = -1;
    room.listenerCount++;

    socket.emit('roomState', {
      slug: room.slug, name: room.name,
      currentIndex: room.currentIndex,
      position: getPosition(room),
      votes: room.votes,
      queue: room.queue,
      djSlots: room.djSlots,
    });
    socket.emit('chatHistory', room.chatHistory.slice(-100));
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
      createdAt: new Date(),
    };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 200) room.chatHistory.shift();
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
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `➕ ${socket.userName} adicionou "${song.title}"`);
  });

  socket.on('skipTo', (index) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (index < 0 || index >= room.queue.length) return;
    room.currentIndex = index;
    room.startedAt = Date.now();
    room.votes = { up: Math.floor(Math.random() * 10) + 2, down: 0 };
    broadcastState(currentRoom);
    io.to(currentRoom).emit('trackChanged', room.queue[index]);
    addSystemMsg(currentRoom, `⏭ ${socket.userName} pulou para: ${room.queue[index].title}`);
  });

  socket.on('takeDj', (index) => {
    if (!currentRoom || index < 0 || index >= 5) return;
    const room = rooms.get(currentRoom);
    if (socket.djSlot >= 0) room.djSlots[socket.djSlot] = null;
    if (room.djSlots[index] === null) {
      room.djSlots[index] = socket.userName;
      socket.djSlot = index;
      broadcastState(currentRoom);
      broadcastUsers(currentRoom);
      addSystemMsg(currentRoom, `🎧 ${socket.userName} virou DJ na cabine ${index + 1}`);
    }
  });

  socket.on('leaveDj', () => {
    if (!currentRoom || socket.djSlot < 0) return;
    const room = rooms.get(currentRoom);
    room.djSlots[socket.djSlot] = null;
    socket.djSlot = -1;
    broadcastState(currentRoom);
    broadcastUsers(currentRoom);
  });

  socket.on('kick', ({ targetName }) => {
    if (!currentRoom) return;
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('kicked', 'Removido da sala'); target.disconnect(); }
      addSystemMsg(currentRoom, `🚪 ${targetName} foi removido`);
    });
  });

  socket.on('ban', ({ targetName }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    room.bannedUsers.push(targetName);
    io.in(currentRoom).fetchSockets().then(sockets => {
      const target = sockets.find(s => s.userName === targetName);
      if (target) { target.emit('banned', 'Banido da sala'); target.disconnect(); }
      addSystemMsg(currentRoom, `🚫 ${targetName} foi banido`);
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        if (socket.djSlot >= 0) room.djSlots[socket.djSlot] = null;
        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
        addSystemMsg(currentRoom, `👋 ${socket.userName || 'Alguém'} saiu`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
