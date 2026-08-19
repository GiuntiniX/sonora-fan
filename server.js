const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Banco de dados
let db;
try {
  db = require('./database');
} catch (e) {
  console.error('❌ Erro ao carregar database.js:', e.message);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

// ========== CONFIG ==========
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
const adminEmails = new Set(['admin@sonora.com']);
const settings = { maxQueue: 20, cooldown: 180, maxDuration: 600 };
const DISLIKE_THRESHOLD = 10;

// ========== AUTENTICAÇÃO (em memória) ==========
const sessions = new Map();

// ========== ESTADO EM MEMÓRIA ==========
const rooms = new Map();
const roomVotes = new Map();
const roomLikes = new Map();

// ========== FUNÇÕES DE BANCO ==========
async function loadRoomsFromDB() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM rooms', (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function loadQueueFromDB(slug) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM queue WHERE roomSlug = ? ORDER BY position ASC', [slug], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function loadVotesFromDB(slug) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM votes WHERE roomSlug = ?', [slug], (err, rows) => {
      if (err) return reject(err);
      const votesMap = {};
      rows.forEach(v => {
        if (!votesMap[v.queueId]) votesMap[v.queueId] = { up: [], down: [] };
        votesMap[v.queueId][v.type].push(v.userName);
      });
      resolve(votesMap);
    });
  });
}

async function loadLikesFromDB(slug) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM likes WHERE roomSlug = ?', [slug], (err, rows) => {
      if (err) return reject(err);
      const likesMap = {};
      rows.forEach(l => {
        if (!likesMap[l.messageId]) likesMap[l.messageId] = { likes: 0, users: [] };
        likesMap[l.messageId].users.push(l.userName);
        likesMap[l.messageId].likes++;
      });
      resolve(likesMap);
    });
  });
}

async function initServerState() {
  try {
    const roomRows = await loadRoomsFromDB();
    for (const row of roomRows) {
      const queue = await loadQueueFromDB(row.slug);
      const votes = await loadVotesFromDB(row.slug);
      const likes = await loadLikesFromDB(row.slug);
      
      roomVotes.set(row.slug, votes);
      roomLikes.set(row.slug, likes);
      
      rooms.set(row.slug, {
        slug: row.slug,
        name: row.name,
        admin: row.admin,
        queue: queue.map(q => ({
          id: q.id,
          videoId: q.videoId,
          title: q.title,
          artist: q.artist,
          duration: q.duration,
          dj: q.dj,
        })),
        currentIndex: row.currentIndex,
        startedAt: new Date(row.startedAt),
        isPlaying: row.isPlaying === 1,
        listenerCount: row.listenerCount || 0,
        chatHistory: [],
        lastAddTime: new Map(),
        lastAdvanceAt: Date.now()
      });
    }
    console.log(`✅ ${rooms.size} salas carregadas do banco.`);
  } catch (e) {
    console.error('❌ Erro ao inicializar estado do servidor:', e);
  }
}

function saveRoomToDB(slug, room) {
  db.run(
    `INSERT OR REPLACE INTO rooms (slug, name, admin, isPlaying, currentIndex, startedAt, listenerCount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [slug, room.name, room.admin, room.isPlaying ? 1 : 0, room.currentIndex, room.startedAt.toISOString(), room.listenerCount]
  );
}

function saveQueueToDB(slug, queue) {
  db.run('DELETE FROM queue WHERE roomSlug = ?', [slug]);
  const stmt = db.prepare('INSERT INTO queue (roomSlug, videoId, title, artist, duration, dj, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
  queue.forEach((item, index) => {
    stmt.run(slug, item.videoId, item.title, item.artist, item.duration || 0, item.dj, index);
  });
  stmt.finalize();
}

function saveVoteToDB(slug, queueId, userName, type) {
  db.run(
    'INSERT OR REPLACE INTO votes (roomSlug, queueId, userName, type) VALUES (?, ?, ?, ?)',
    [slug, queueId, userName, type]
  );
}

function deleteLikeFromDB(slug, messageId, userName) {
  db.run(
    'DELETE FROM likes WHERE roomSlug = ? AND messageId = ? AND userName = ?',
    [slug, messageId, userName]
  );
}

function saveLikeToDB(slug, messageId, userName) {
  db.run(
    'INSERT OR REPLACE INTO likes (roomSlug, messageId, userName) VALUES (?, ?, ?)',
    [slug, messageId, userName]
  );
}

function addHistoryToDB(slug, videoId, title, artist, dj) {
  db.run(
    'INSERT INTO history (roomSlug, videoId, title, artist, dj) VALUES (?, ?, ?, ?, ?)',
    [slug, videoId, title, artist, dj]
  );
}

// ========== FUNÇÕES DE NEGÓCIO ==========
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
  }).catch(() => {});
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

async function advanceQueue(slug) {
  const room = rooms.get(slug);
  if (!room || !room.isPlaying || room.queue.length === 0) return false;
  if (Date.now() - room.lastAdvanceAt < 10000) return false;
  room.lastAdvanceAt = Date.now();

  const played = room.queue[room.currentIndex];
  if (played) {
    addHistoryToDB(slug, played.videoId, played.title, played.artist, played.dj);
  }

  room.queue.shift();
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
  
  saveRoomToDB(slug, room);
  saveQueueToDB(slug, room.queue);
  
  const votes = roomVotes.get(slug) || {};
  const newVotes = {};
  room.queue.forEach((_, i) => {
    if (votes[i + 1]) newVotes[i] = votes[i + 1];
  });
  roomVotes.set(slug, newVotes);
  
  broadcastState(slug);

  if (room.queue.length > 0) {
    const next = room.queue[0];
    addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
  } else {
    room.isPlaying = false;
    saveRoomToDB(slug, room);
    broadcastState(slug);
    addSystemMsg(slug, '🏁 Fila encerrada. Adicione músicas!');
    io.to(slug).emit('queueEmpty');
  }
  return true;
}

// ========== API ==========
app.post('/api/signup', async (req, res) => {
  const { nome, email, senha, genero, regiao, estilos } = req.body;
  if (!nome || nome.length < 2) return res.status(400).json({ error: 'Nome inválido' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido' });
  if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter 6+ caracteres' });
  if (!genero) return res.status(400).json({ error: 'Selecione um gênero' });
  if (!regiao) return res.status(400).json({ error: 'Selecione uma região' });
  if (!estilos || estilos.length === 0) return res.status(400).json({ error: 'Escolha um estilo' });
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT email FROM users WHERE email = ?', [email], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (user) return res.status(400).json({ error: 'E-mail já cadastrado' });
    
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (email, nome, senha, genero, regiao, estilos, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [email, nome, senha, genero, regiao, JSON.stringify(estilos), '🎸'],
        (err) => err ? reject(err) : resolve()
      );
    });
    res.json({ success: true, nome, email });
  } catch (e) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Preencha e-mail e senha' });
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    if (user.senha !== senha) return res.status(401).json({ error: 'Senha incorreta' });

    const token = crypto.randomBytes(64).toString('hex');
    sessions.set(token, email);
    res.cookie('sessionToken', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
    const { senha: _, ...userData } = user;
    res.json({ success: true, user: userData });
  } catch (e) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessionToken;
  if (token) sessions.delete(token);
  res.clearCookie('sessionToken');
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!user) { sessions.delete(token); return res.status(401).json({ error: 'Usuário não encontrado' }); }
    const { senha: _, ...userData } = user;
    res.json({ success: true, user: userData });
  } catch (e) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const list = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM rooms', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
    const enriched = list.map(r => {
      const room = rooms.get(r.slug);
      return {
        slug: r.slug,
        name: r.name,
        listenerCount: room ? room.listenerCount : 0,
        queueLength: room ? room.queue.length : 0,
        isPlaying: room ? room.isPlaying : false,
        currentTrack: room && room.queue[room.currentIndex] ? room.queue[room.currentIndex] : null,
      };
    });
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar salas' });
  }
});

app.get('/api/rooms/random', async (req, res) => {
  try {
    const list = await new Promise((resolve, reject) => {
      db.all('SELECT slug FROM rooms', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
    if (list.length === 0) return res.json({ slug: null });
    const sorted = list.sort((a, b) => {
      const roomA = rooms.get(a.slug);
      const roomB = rooms.get(b.slug);
      return (roomB ? roomB.listenerCount : 0) - (roomA ? roomA.listenerCount : 0);
    });
    res.json({ slug: sorted[0].slug });
  } catch (e) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.post('/api/rooms', async (req, res) => {
  const { name, adminName } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
  
  try {
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO rooms (slug, name, admin) VALUES (?, ?, ?)',
        [slug, name, adminName || null],
        (err) => err ? reject(err) : resolve()
      );
    });
    const room = {
      slug, name, admin: adminName || null,
      queue: [], currentIndex: 0, startedAt: new Date(),
      votes: { up: 0, down: 0 }, bannedUsers: [],
      chatHistory: [], listenerCount: 0,
      lastAddTime: new Map(), isPlaying: false, lastAdvanceAt: 0
    };
    rooms.set(slug, room);
    roomVotes.set(slug, {});
    roomLikes.set(slug, {});
    res.json({ slug, name });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao criar sala' });
  }
});

app.get('/api/history/:slug', async (req, res) => {
  try {
    const history = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM history WHERE roomSlug = ? ORDER BY playedAt DESC LIMIT 50', [req.params.slug], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// Video info
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

// ========== ADMIN ==========
function isAdmin(req, res, next) {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  if (!adminEmails.has(email)) return res.status(403).json({ error: 'Acesso negado' });
  req.adminEmail = email;
  next();
}

app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const totalUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) return reject(err);
        resolve(row.count);
      });
    });
    const totalRooms = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM rooms', (err, row) => {
        if (err) return reject(err);
        resolve(row.count);
      });
    });
    res.json({ totalUsers, totalRooms, onlineUsers: io.sockets.sockets.size });
  } catch (e) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT email, nome, avatar, total_added, total_upvotes, total_downvotes FROM users', (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.post('/api/admin/promote', isAdmin, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  adminEmails.add(email);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', isAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  if (email === 'admin@sonora.com') return res.status(400).json({ error: 'Não pode deletar o super admin' });
  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE email = ?', [email], (err) => err ? reject(err) : resolve());
    });
    adminEmails.delete(email);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro' });
  }
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

app.post('/api/admin/clear-all-rooms', isAdmin, async (req, res) => {
  for (const [slug, room] of rooms) {
    room.queue = [];
    room.currentIndex = 0;
    room.isPlaying = false;
    roomLikes.set(slug, {});
    roomVotes.set(slug, {});
    saveRoomToDB(slug, room);
    saveQueueToDB(slug, []);
    broadcastState(slug);
    io.to(slug).emit('queueEmpty');
  }
  res.json({ success: true });
});

app.get('/api/admin/export-data', isAdmin, (req, res) => {
  res.json({ message: 'Exportar dados - funcionalidade em breve' });
});

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', async ({ slug, name, avatar }) => {
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
    saveRoomToDB(slug, room);

    const cookie = socket.handshake.headers.cookie || '';
    const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
    const email = tokenMatch ? sessions.get(tokenMatch[1]) : null;
    const isGlobalAdmin = adminEmails.has(email);
    const isRoomAdmin = room.admin === name;
    socket.isAdmin = isGlobalAdmin || isRoomAdmin;

    if (isGlobalAdmin && !room.admin) room.admin = name;

    const likes = roomLikes.get(slug) || {};
    socket.emit('likesState', likes);
    const votes = roomVotes.get(slug) || {};
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

  socket.on('addSong', async (song) => {
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

    const newSong = {
      videoId: song.id,
      title: song.title || 'Música do YouTube',
      artist: song.artist || 'Desconhecido',
      duration: song.duration || 0,
      dj: socket.userName
    };
    room.queue.push(newSong);
    room.lastAddTime.set(socket.userName, now);
    
    saveQueueToDB(currentRoom, room.queue);

    if (!room.isPlaying && room.queue.length === 1) {
      room.isPlaying = true;
      room.currentIndex = 0;
      room.startedAt = Date.now();
      room.lastAdvanceAt = Date.now();
      saveRoomToDB(currentRoom, room);
      addSystemMsg(currentRoom, `▶ ${newSong.title} — ${newSong.artist}`);
    }

    broadcastState(currentRoom);

    const musicMsg = {
      _id: Date.now().toString() + Math.random(),
      user: socket.userName, color: socket.userColor,
      isSystem: false, isAdmin: socket.isAdmin || false,
      isMusic: true, musicTitle: newSong.title,
      musicArtist: newSong.artist, createdAt: new Date()
    };
    room.chatHistory.push(musicMsg);
    if (room.chatHistory.length > 300) room.chatHistory.shift();
    io.to(currentRoom).emit('chat', musicMsg);

    // Atualizar estatísticas do usuário
    const cookie = socket.handshake.headers.cookie || '';
    const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
    if (tokenMatch) {
      const email = sessions.get(tokenMatch[1]);
      if (email) {
        db.run('UPDATE users SET total_added = total_added + 1 WHERE email = ?', [email]);
      }
    }
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
    saveQueueToDB(currentRoom, room.queue);
    saveRoomToDB(currentRoom, room);
    
    const votes = roomVotes.get(currentRoom) || {};
    const newVotes = {};
    room.queue.forEach((_, i) => {
      if (votes[i]) newVotes[i] = votes[i];
    });
    roomVotes.set(currentRoom, newVotes);
    
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
    saveQueueToDB(currentRoom, room.queue);
    
    const votes = roomVotes.get(currentRoom) || {};
    const newVotes = {};
    room.queue.forEach((_, i) => {
      if (votes[i + 1]) newVotes[i] = votes[i + 1];
    });
    roomVotes.set(currentRoom, newVotes);
    
    broadcastState(currentRoom);
    addSystemMsg(currentRoom, `🗑️ ${socket.userName} removeu "${track.title}"`);
  });

  // VOTAÇÃO
  socket.on('voteSong', async ({ index, type, room }) => {
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

    const votes = roomVotes.get(room) || {};
    if (!votes[index]) votes[index] = { up: [], down: [] };
    const data = votes[index];
    
    // Remover voto anterior
    const upIdx = data.up.indexOf(socket.userName);
    if (upIdx > -1) data.up.splice(upIdx, 1);
    const downIdx = data.down.indexOf(socket.userName);
    if (downIdx > -1) data.down.splice(downIdx, 1);
    
    // Adicionar novo voto
    if (type === 'up') {
      data.up.push(socket.userName);
      const cookie = socket.handshake.headers.cookie || '';
      const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
      if (tokenMatch) {
        const email = sessions.get(tokenMatch[1]);
        if (email) {
          db.run('UPDATE users SET total_upvotes = total_upvotes + 1 WHERE email = ?', [email]);
        }
      }
    } else if (type === 'down') {
      data.down.push(socket.userName);
      const cookie = socket.handshake.headers.cookie || '';
      const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
      if (tokenMatch) {
        const email = sessions.get(tokenMatch[1]);
        if (email) {
          db.run('UPDATE users SET total_downvotes = total_downvotes + 1 WHERE email = ?', [email]);
        }
      }
    }
    
    const queueId = roomData.queue[index].id;
    if (queueId) {
      saveVoteToDB(room, queueId, socket.userName, type);
    }
    
    // Verificar se atingiu limite
    if (data.down.length >= DISLIKE_THRESHOLD) {
      const removed = roomData.queue.splice(index, 1)[0];
      if (index < roomData.currentIndex) roomData.currentIndex--;
      saveQueueToDB(room, roomData.queue);
      
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
    
    roomVotes.set(room, votes);
    io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down });
  });

  // Curtidas
  socket.on('likeMessage', ({ messageId, room }) => {
    if (!room || !socket.userName) return;
    const likes = roomLikes.get(room) || {};
    if (!likes[messageId]) likes[messageId] = { likes: 0, users: [] };
    const data = likes[messageId];
    const userIndex = data.users.indexOf(socket.userName);
    if (userIndex > -1) {
      data.users.splice(userIndex, 1);
      data.likes = Math.max(0, data.likes - 1);
      deleteLikeFromDB(room, messageId, socket.userName);
    } else {
      data.users.push(socket.userName);
      data.likes++;
      saveLikeToDB(room, messageId, socket.userName);
    }
    roomLikes.set(room, likes);
    io.to(room).emit('likeUpdate', { messageId, likes: data.likes, users: data.users });
  });

  socket.on('videoDuration', ({ duration }) => {
    if (!currentRoom || !duration) return;
    const room = rooms.get(currentRoom);
    const track = room.queue[room.currentIndex];
    if (track) {
      track.duration = duration;
      saveQueueToDB(currentRoom, room.queue);
    }
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
    roomLikes.set(currentRoom, {});
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
        saveRoomToDB(currentRoom, room);
        broadcastState(currentRoom);
        broadcastUsers(currentRoom);
      }
    }
  });
});

// ========== INICIALIZAÇÃO ==========
(async () => {
  await initServerState();
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
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
})();
