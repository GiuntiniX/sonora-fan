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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];

// ========== AUTENTICAÇÃO LOCAL ==========
const users = new Map();
const sessions = new Map();

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
    lastAdvanceAt: 0,
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

function advanceQueue(slug, reason) {
  const room = rooms.get(slug);
  if (!room) return false;
  if (!room.isPlaying || room.queue.length === 0) return false;

  const now = Date.now();
  if (now - room.lastAdvanceAt < 10000) return false;
  room.lastAdvanceAt = now;

  const finishedTrack = room.queue.shift();
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };

  broadcastState(slug);

  if (room.queue.length > 0) {
    const next = room.queue[0];
    addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
    if (finishedTrack) {
      addSystemMsg(slug, `🗑️ "${finishedTrack.title}" terminou`);
    }
  } else {
    room.isPlaying = false;
    broadcastState(slug);
    addSystemMsg(slug, `🏁 Fila encerrada. Adicione mais músicas!`);
    io.to(slug).emit('queueEmpty');
  }
  return true;
}

// ========== AUTO-ADVANCE ==========
setInterval(() => {
  for (const [slug, room] of rooms) {
    if (!room.isPlaying || room.queue.length === 0) continue;
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    const pos = getPosition(room);
    const duration = track.duration || 180;
    if (pos >= duration - 2) {
      advanceQueue(slug, 'auto');
    }
  }
}, 2000);

// ========== API DE AUTENTICAÇÃO ==========
app.post('/api/signup', (req, res) => {
  const { nome, email, senha, genero, regiao, estilos } = req.body;

  if (!nome || nome.length < 2) {
    return res.status(400).json({ error: 'Nome deve ter pelo menos 2 caracteres' });
  }
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (!senha || senha.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  }
  if (!genero) {
    return res.status(400).json({ error: 'Selecione um gênero' });
  }
  if (!regiao) {
    return res.status(400).json({ error: 'Selecione sua região' });
  }
  if (!estilos || estilos.length === 0) {
    return res.status(400).json({ error: 'Escolha pelo menos um estilo musical' });
  }

  if (users.has(email)) {
    return res.status(400).json({ error: 'Este e-mail já está cadastrado' });
  }

  const user = {
    nome,
    email,
    senha,
    genero,
    regiao,
    estilos,
    avatar: '🎸',
    criadoEm: new Date().toISOString(),
  };
  users.set(email, user);

  console.log(`✅ Novo usuário cadastrado: ${nome} (${email})`);
  res.json({ success: true, nome, email });
});

app.post('/api/login', (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: 'Preencha e-mail e senha' });
  }

  const user = users.get(email);
  if (!user) {
    return res.status(401).json({ error: 'Usuário não encontrado' });
  }

  if (user.senha !== senha) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }

  const token = crypto.randomBytes(64).toString('hex');
  sessions.set(token, email);

  res.cookie('sessionToken', token, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  });

  const { senha: _, ...userData } = user;
  res.json({ success: true, user: userData });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessionToken;
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie('sessionToken');
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const email = sessions.get(token);
  if (!email) {
    return res.status(401).json({ error: 'Sessão inválida' });
  }

  const user = users.get(email);
  if (!user) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Usuário não encontrado' });
  }

  const { senha: _, ...userData } = user;
  res.json({ success: true, user: userData });
});

// ========== API DE SALAS ==========
app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    slug: r.slug, name: r.name, listenerCount: r.listenerCount,
    queueLength: r.queue.length,
    isPlaying: r.isPlaying,
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

// ========== VIDEO INFO ==========
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 4e6) req.destroy();
      });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

app.get('/api/video-info', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return res.status(400).json({ error: 'ID de vídeo inválido' });
  }

  const info = { id, title: null, artist: null, duration: null };

  try {
    const raw = await fetchUrl(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    const data = JSON.parse(raw);
    info.title = data.title || null;
    info.artist = data.author_name || null;
  } catch (e) { /* segue sem oEmbed */ }

  try {
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${id}`);
    const m = html.match(/"lengthSeconds":"?(\d+)"?/);
    if (m) info.duration = parseInt(m[1], 10);
    if (!info.title) {
      const t = html.match(/<title>([^<]+)<\/title>/);
      if (t) info.title = t[1].replace(/ - YouTube\s*$/, '').trim();
    }
  } catch (e) { /* segue sem duração */ }

  if (!info.title && !info.duration) {
    return res.status(404).json({ error: 'Vídeo não encontrado ou indisponível' });
  }
  res.json(info);
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
    socket.userAvatar = avatar || '👤';
    room.listenerCount++;

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
      room.lastAdvanceAt = Date.now();
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

    room.lastAdvanceAt = Date.now();
    if (index > 0) room.queue.splice(0, index);
    room.currentIndex = 0;
    room.startedAt = Date.now();
    room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
    room.isPlaying = true;
    broadcastState(currentRoom);
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
    if (index < room.currentIndex) room.currentIndex--;
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
    advanceQueue(currentRoom, 'videoEnded');
  });

  socket.on('typing', ({ isTyping }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('typing', { name: socket.userName, isTyping });
  });

  socket.on('clearChat', () => {
    if (!currentRoom || !socket.isAdmin) {
      socket.emit('error', 'Apenas administradores podem limpar o chat');
      return;
    }
    const room = rooms.get(currentRoom);
    room.chatHistory = [];
    io.to(currentRoom).emit('chatCleared');
    addSystemMsg(currentRoom, `🧹 Chat limpo por ${socket.userName}`);
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
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
