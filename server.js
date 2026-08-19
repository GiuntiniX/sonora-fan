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
const settings = { maxQueue: 20, cooldown: 30, maxDuration: 600 };
const DISLIKE_THRESHOLD = 10;
const MAX_SONGS_PER_USER = 3;

// ========== AUTENTICAÇÃO ==========
const users = new Map();
const sessions = new Map();
const userFavorites = new Map();

// ========== ESTADO ==========
const rooms = new Map();
const roomLikes = new Map();
const roomVotes = new Map();

function createRoom(slug, name, adminName = null) {
  roomLikes.set(slug, {});
  roomVotes.set(slug, {});
  return {
    slug, name, admin: adminName,
    queue: [], currentIndex: 0, startedAt: Date.now(),
    votes: { up: 0, down: 0 }, bannedUsers: [],
    chatHistory: [], listenerCount: 0,
    lastAddTime: new Map(), isPlaying: false, lastAdvanceAt: 0
  };
}

function getRoomLikes(slug) {
  if (!roomLikes.has(slug)) roomLikes.set(slug, {});
  return roomLikes.get(slug);
}

function getRoomVotes(slug) {
  if (!roomVotes.has(slug)) roomVotes.set(slug, {});
  return roomVotes.get(slug);
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

function reorderQueueByVotes(room) {
  if (!room || room.queue.length <= 1) return;
  const currentTrack = room.queue[room.currentIndex];
  if (!currentTrack) return;
  const rest = room.queue.filter((_, i) => i !== room.currentIndex);
  const votes = getRoomVotes(room.slug);
  rest.sort((a, b) => {
    const aIdx = room.queue.indexOf(a);
    const bIdx = room.queue.indexOf(b);
    const aUp = votes[aIdx] ? votes[aIdx].up.length : 0;
    const bUp = votes[bIdx] ? votes[bIdx].up.length : 0;
    return bUp - aUp;
  });
  room.queue = [currentTrack, ...rest];
  room.currentIndex = 0;
  const newVotes = {};
  room.queue.forEach((track, i) => {
    const oldIndex = room.queue.indexOf(track);
    if (votes[oldIndex]) newVotes[i] = votes[oldIndex];
  });
  roomVotes.set(room.slug, newVotes);
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
  
  const votes = getRoomVotes(slug);
  const newVotes = {};
  room.queue.forEach((_, i) => {
    if (votes[i + 1]) newVotes[i] = votes[i + 1];
  });
  roomVotes.set(slug, newVotes);
  
  reorderQueueByVotes(room);
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
  const { nome, email, senha, estilos } = req.body;
  if (!nome || nome.length < 2) return res.status(400).json({ error: 'Nome inválido' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido' });
  if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter 6+ caracteres' });
  if (!estilos || estilos.length === 0) return res.status(400).json({ error: 'Escolha um estilo' });
  if (users.has(email)) return res.status(400).json({ error: 'E-mail já cadastrado' });

  users.set(email, { nome, email, senha, estilos, avatar: '🎸', criadoEm: new Date() });
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

// ===== FAVORITOS =====
function getUserFavorites(email) {
  if (!userFavorites.has(email)) userFavorites.set(email, []);
  return userFavorites.get(email);
}

app.get('/api/favorites', (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  res.json(getUserFavorites(email));
});

app.post('/api/favorites', (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  const { videoId, title, artist } = req.body;
  if (!videoId) return res.status(400).json({ error: 'ID do vídeo obrigatório' });
  const favs = getUserFavorites(email);
  if (!favs.find(f => f.id === videoId)) favs.push({ id: videoId, title, artist });
  res.json({ success: true, favorites: favs });
});

app.delete('/api/favorites/:videoId', (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  const videoId = req.params.videoId;
  const favs = getUserFavorites(email);
  const idx = favs.findIndex(f => f.id === videoId);
  if (idx !== -1) favs.splice(idx, 1);
  res.json({ success: true, favorites: favs });
});

app.get('/api/rooms', (req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    slug: r.slug, name: r.name, listenerCount: r.listenerCount,
    queueLength: r.queue.length, isPlaying: r.isPlaying,
    currentTrack: r.queue[r.currentIndex] || null,
  }));
  res.json(list);
});

app.get('/api/room/:slug/queue', (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({ queue: room.queue, currentIndex: room.currentIndex });
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

// ===== VIDEO INFO (tolerante a falhas - retorna duration: null se não encontrar) =====
app.get('/api/video-info', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  const info = { id, title: null, artist: null, duration: null };

  // Tenta oembed primeiro (para título e artista)
  try {
    const raw = await fetchUrl(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    const data = JSON.parse(raw);
    info.title = data.title || null;
    info.artist = data.author_name || null;
  } catch (e) {}

  // Estratégias para extrair duração (em ordem de prioridade)
  try {
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${id}`);

    // 1. JSON-LD
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        if (jsonLd.duration) {
          const durStr = jsonLd.duration;
          const match = durStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (match) {
            const hours = parseInt(match[1] || 0);
            const minutes = parseInt(match[2] || 0);
            const seconds = parseInt(match[3] || 0);
            info.duration = hours * 3600 + minutes * 60 + seconds;
          }
        }
      } catch (e) {}
    }

    // 2. ytInitialPlayerResponse
    if (!info.duration) {
      const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
      if (playerResponseMatch) {
        try {
          const data = JSON.parse(playerResponseMatch[1]);
          if (data.videoDetails && data.videoDetails.lengthSeconds) {
            info.duration = parseInt(data.videoDetails.lengthSeconds, 10);
          }
        } catch (e) {}
      }
    }

    // 3. ytcfg
    if (!info.duration) {
      const ytcfgMatch = html.match(/ytcfg\.set\s*\(\s*({[\s\S]*?})\s*\)\s*;/);
      if (ytcfgMatch) {
        try {
          const data = JSON.parse(ytcfgMatch[1]);
          if (data.DURATION) {
            info.duration = parseInt(data.DURATION, 10);
          }
        } catch (e) {}
      }
    }

    // 4. Regex fallback
    if (!info.duration) {
      const regexMatch = html.match(/"lengthSeconds":"?(\d+)"?/);
      if (regexMatch) {
        info.duration = parseInt(regexMatch[1], 10);
      }
    }

    // 5. data-duration
    if (!info.duration) {
      const dataDurMatch = html.match(/data-duration="(\d+)"/);
      if (dataDurMatch) {
        info.duration = parseInt(dataDurMatch[1], 10);
      }
    }

    // Se ainda não tiver título, extrair do <title>
    if (!info.title) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        info.title = titleMatch[1].replace(/ - YouTube\s*$/, '').trim();
      }
    }
  } catch (e) {}

  // Se não tiver título, tenta preencher com o ID
  if (!info.title) {
    info.title = 'Vídeo do YouTube (ID: ' + id + ')';
  }

  // SEMPRE retorna 200, com duration: null se não encontrou
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

  for (const [token, storedEmail] of sessions) {
    if (storedEmail === email) sessions.delete(token);
  }

  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.userEmail === email) {
      socket.emit('kicked', 'Sua conta foi removida pelo administrador.');
      socket.disconnect(true);
    }
  }

  io.emit('adminUsersUpdated');
  res.json({ success: true });
});

app.post('/api/admin/kick-user', isAdmin, (req, res) => {
  const { email, roomSlug } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  const room = rooms.get(roomSlug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });

  let kicked = false;
  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.userEmail === email && socket.currentRoom === roomSlug) {
      socket.emit('kicked', `Você foi expulso da sala ${room.name} pelo administrador.`);
      socket.leave(roomSlug);
      socket.currentRoom = null;
      kicked = true;
    }
  }

  if (kicked) {
    broadcastUsers(roomSlug);
    addSystemMsg(roomSlug, `👢 ${email} foi expulso da sala pelo admin.`);
    io.emit('adminUsersUpdated');
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Usuário não encontrado na sala' });
  }
});

app.post('/api/admin/ban-user', isAdmin, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  const user = users.get(email);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const userName = user.nome;
  for (const [slug, room] of rooms) {
    if (!room.bannedUsers.includes(userName)) {
      room.bannedUsers.push(userName);
    }
  }

  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.userEmail === email) {
      socket.emit('banned', 'Você foi banido globalmente pelo administrador.');
      socket.disconnect(true);
    }
  }

  io.emit('adminUsersUpdated');
  res.json({ success: true });
});

app.post('/api/admin/clear-all-chats', isAdmin, (req, res) => {
  for (const [slug, room] of rooms) { 
    room.chatHistory = [];
    roomLikes.set(slug, {});
    roomVotes.set(slug, {});
    io.to(slug).emit('chatCleared');
  }
  res.json({ success: true });
});

app.post('/api/admin/clear-all-rooms', isAdmin, (req, res) => {
  for (const [slug, room] of rooms) {
    room.queue = [];
    room.currentIndex = 0;
    room.isPlaying = false;
    roomLikes.set(slug, {});
    roomVotes.set(slug, {});
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

app.post('/api/admin/remove-song', isAdmin, (req, res) => {
  const { roomSlug, index } = req.body;
  if (!roomSlug || index === undefined) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }
  const room = rooms.get(roomSlug);
  if (!room) {
    return res.status(404).json({ error: 'Sala não encontrada' });
  }
  if (index < 0 || index >= room.queue.length) {
    return res.status(400).json({ error: 'Índice inválido' });
  }
  if (index === room.currentIndex) {
    return res.status(400).json({ error: 'Não é possível remover a música atual' });
  }
  const track = room.queue[index];
  room.queue.splice(index, 1);
  if (index < room.currentIndex) room.currentIndex--;
  
  const votes = getRoomVotes(roomSlug);
  const newVotes = {};
  room.queue.forEach((_, i) => {
    if (votes[i + 1]) newVotes[i] = votes[i + 1];
  });
  roomVotes.set(roomSlug, newVotes);
  broadcastState(roomSlug);
  addSystemMsg(roomSlug, `🗑️ Admin removeu "${track.title}"`);
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let userEmail = null;

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
    userEmail = email;
    socket.userEmail = email;
    const isGlobalAdmin = adminEmails.has(email);
    const isRoomAdmin = room.admin === name;
    socket.isAdmin = isGlobalAdmin || isRoomAdmin;

    if (isGlobalAdmin && !room.admin) room.admin = name;

    const likes = getRoomLikes(slug);
    socket.emit('likesState', likes);
    const votes = getRoomVotes(slug);
    socket.emit('votesState', votes);

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

    if (now - lastAdd < 30000) {
      const wait = Math.ceil((30000 - (now - lastAdd)) / 1000);
      socket.emit('error', `Aguarde ${wait}s`);
      return;
    }

    const userSongs = room.queue.filter(t => t.dj === socket.userName).length;
    if (userSongs >= MAX_SONGS_PER_USER) {
      socket.emit('error', `Você já tem ${MAX_SONGS_PER_USER} músicas na fila. Aguarde outras serem tocadas.`);
      return;
    }

    if (room.queue.length >= settings.maxQueue) {
      socket.emit('error', `Fila cheia (${settings.maxQueue})`);
      return;
    }

    // Se a duração foi enviada e é maior que o limite, bloqueia
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
    
    const votes = getRoomVotes(currentRoom);
    const newVotes = {};
    room.queue.forEach((_, i) => {
      if (votes[i]) newVotes[i] = votes[i];
    });
    roomVotes.set(currentRoom, newVotes);
    reorderQueueByVotes(room);
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `⏭ ${socket.userName} pulou para: ${room.queue[0]?.title || 'fila vazia'}`);
  });

  socket.on('removeFromQueue', (index) => {
    if (!currentRoom) {
      socket.emit('error', 'Você não está em uma sala');
      return;
    }
    const isGlobalAdmin = userEmail && adminEmails.has(userEmail);
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (!isGlobalAdmin && !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode remover músicas');
      return;
    }
    const track = room.queue[index];
    if (!track || index === room.currentIndex) {
      socket.emit('error', 'Não é possível remover a música atual');
      return;
    }
    room.queue.splice(index, 1);
    if (index < room.currentIndex) room.currentIndex--;
    
    const votes = getRoomVotes(currentRoom);
    const newVotes = {};
    room.queue.forEach((_, i) => {
      if (votes[i + 1]) newVotes[i] = votes[i + 1];
    });
    roomVotes.set(currentRoom, newVotes);
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `🗑️ ${socket.userName} removeu "${track.title}"`);
  });

  socket.on('reorderQueue', (newOrder) => {
    if (!currentRoom) {
      socket.emit('error', 'Você não está em uma sala');
      return;
    }
    const isGlobalAdmin = userEmail && adminEmails.has(userEmail);
    if (!isGlobalAdmin && !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode reordenar');
      return;
    }
    const room = rooms.get(currentRoom);
    if (!room || room.queue.length === 0) return;
    
    const currentTrack = room.queue[room.currentIndex];
    const currentId = currentTrack ? currentTrack.id : null;
    
    const newQueue = [];
    for (const id of newOrder) {
      const track = room.queue.find(t => t.id === id);
      if (track) newQueue.push(track);
    }
    if (newQueue.length === room.queue.length) {
      room.queue = newQueue;
      const newIndex = room.queue.findIndex(t => t.id === currentId);
      room.currentIndex = newIndex !== -1 ? newIndex : 0;
      
      const votes = getRoomVotes(currentRoom);
      const newVotes = {};
      room.queue.forEach((track, i) => {
        const oldIndex = room.queue.indexOf(track);
        if (votes[oldIndex]) newVotes[i] = votes[oldIndex];
      });
      roomVotes.set(currentRoom, newVotes);
      broadcastState(currentRoom);
    }
  });

  socket.on('voteSong', ({ index, type, room }) => {
    if (!room || !socket.userName) return;
    const roomData = rooms.get(room);
    if (!roomData) return;
    if (roomData.currentIndex === index) {
      socket.emit('error', 'Não é possível votar na música atual');
      return;
    }
    if (index >= roomData.queue.length) {
      socket.emit('error', 'Música não encontrada');
      return;
    }
    
    const votes = getRoomVotes(room);
    if (!votes[index]) votes[index] = { up: [], down: [] };
    const data = votes[index];
    
    const upIndex = data.up.indexOf(socket.userName);
    if (upIndex > -1) data.up.splice(upIndex, 1);
    const downIndex = data.down.indexOf(socket.userName);
    if (downIndex > -1) data.down.splice(downIndex, 1);
    
    if (type === 'up') data.up.push(socket.userName);
    else if (type === 'down') data.down.push(socket.userName);
    
    if (data.down.length >= DISLIKE_THRESHOLD) {
      const removed = roomData.queue.splice(index, 1)[0];
      if (index < roomData.currentIndex) roomData.currentIndex--;
      delete votes[index];
      const newVotes = {};
      roomData.queue.forEach((_, i) => {
        if (votes[i + 1]) newVotes[i] = votes[i + 1];
      });
      roomVotes.set(room, newVotes);
      broadcastState(room);
      io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down, removed: true });
      addSystemMsg(room, `👎 "${removed.title}" foi removida por votação! (${data.down.length} votos negativos)`);
      return;
    }
    
    if (type === 'up') reorderQueueByVotes(roomData);
    io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down });
    broadcastState(room);
  });

  socket.on('likeMessage', ({ messageId, room }) => {
    if (!room || !socket.userName) return;
    const likes = getRoomLikes(room);
    if (!likes[messageId]) likes[messageId] = { likes: 0, users: [] };
    const data = likes[messageId];
    const userIndex = data.users.indexOf(socket.userName);
    if (userIndex > -1) {
      data.users.splice(userIndex, 1);
      data.likes = Math.max(0, data.likes - 1);
    } else {
      data.users.push(socket.userName);
      data.likes++;
    }
    io.to(room).emit('likeUpdate', { messageId, likes: data.likes, users: data.users });
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
    if (!currentRoom) {
      socket.emit('error', 'Você não está em uma sala');
      return;
    }
    const isGlobalAdmin = userEmail && adminEmails.has(userEmail);
    if (!isGlobalAdmin && !socket.isAdmin) {
      socket.emit('error', 'Apenas admin pode limpar o chat');
      return;
    }
    const room = rooms.get(currentRoom);
    room.chatHistory = [];
    roomLikes.set(currentRoom, {});
    io.to(currentRoom).emit('chatCleared');
    addSystemMsg(currentRoom, '🧹 Chat limpo pelo admin');
  });

  socket.on('adminBroadcast', (data) => {
    const isGlobalAdmin = userEmail && adminEmails.has(userEmail);
    if (!isGlobalAdmin && !socket.isAdmin) return;
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
