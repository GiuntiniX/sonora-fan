const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ========== INICIALIZAÇÃO DO FIREBASE ==========
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  console.log('🔥 Firebase conectado!');
} catch (e) {
  console.error('⚠️ Erro ao conectar Firebase:', e.message);
}

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

// ========== CONFIG ==========
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
const adminEmails = new Set(['admin@sonora.com']);
const settings = { maxQueue: 20, cooldown: 30, maxDuration: 600, maxListeners: 20 };
const DISLIKE_THRESHOLD = 10;
const MAX_SONGS_PER_USER = 3;
const SKIP_VOTE_THRESHOLD = 0.5;
const MIN_SKIP_VOTES = 3;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// ========== ESTADO EM MEMÓRIA ==========
const users = new Map();
const sessions = new Map();
const userFavorites = new Map();
const userPoints = new Map();
const userThemes = new Map();
const userSettings = new Map();

const rooms = new Map();
const roomLikes = new Map();
const roomVotes = new Map();
const waitingRooms = new Map();

// ========== TEMAS DE SALA ==========
const ROOM_THEMES = {
  default: { bg: '#050508', card: '#0f0f18', border: '#1e1e2e', accent: '#ff6b35', accent2: '#7c3aed' },
  '80s': { bg: '#1a0a2e', card: '#2d1b4e', border: '#6c2bd9', accent: '#ff00ff', accent2: '#00ffff' },
  mpb: { bg: '#0a1a0a', card: '#1a2a1a', border: '#2a5a2a', accent: '#f5a623', accent2: '#7cb342' },
  rock: { bg: '#0a0a0a', card: '#1a1a1a', border: '#3a3a3a', accent: '#e53935', accent2: '#ff6f00' },
  eletronica: { bg: '#050510', card: '#0a0a20', border: '#1a2a5a', accent: '#00e5ff', accent2: '#aa00ff' },
  sertanejo: { bg: '#1a0a05', card: '#2a150a', border: '#4a2a15', accent: '#ff8f00', accent2: '#bf360c' },
};

function createRoom(slug, name, adminName = null) {
  roomLikes.set(slug, {});
  roomVotes.set(slug, {});
  waitingRooms.set(slug, []);
  return {
    slug, name, admin: adminName,
    queue: [], waitingQueue: [],
    currentIndex: 0, startedAt: Date.now(),
    votes: { up: 0, down: 0 }, bannedUsers: [],
    chatHistory: [], listenerCount: 0,
    lastAddTime: new Map(), isPlaying: false, lastAdvanceAt: 0,
    history: [], skipVotes: new Set(),
    radioMode: false, radioGenre: 'pop',
    pinnedMessage: null, color: '#7c3aed', theme: 'default',
    discordWebhook: null, inviteCount: 0, eventStartTime: null,
    totalSongsAdded: 0, totalVotesGiven: 0, mostVoted: [],
  };
}

// Funções Firebase
async function getUserFromFirestore(email) {
  try {
    const doc = await db.collection('users').doc(email).get();
    if (doc.exists) return doc.data();
  } catch (e) { console.error('Erro ao ler Firestore:', e.message); }
  return null;
}

async function setUserInFirestore(email, data) {
  try { await db.collection('users').doc(email).set(data, { merge: true }); } catch (e) { console.error('Erro ao gravar Firestore:', e.message); }
}

async function getFavoritesFromFirestore(email) {
  try {
    const doc = await db.collection('favorites').doc(email).get();
    if (doc.exists) return doc.data().items || [];
  } catch (e) {}
  return [];
}

async function setFavoritesInFirestore(email, items) {
  try { await db.collection('favorites').doc(email).set({ items }); } catch (e) {}
}

async function getPointsFromFirestore(email) {
  try {
    const doc = await db.collection('points').doc(email).get();
    if (doc.exists) return doc.data();
  } catch (e) {}
  return { points: 0, badges: [] };
}

async function setPointsInFirestore(email, data) {
  try { await db.collection('points').doc(email).set(data); } catch (e) {}
}

async function loadAllUsers() {
  try {
    const snapshot = await db.collection('users').get();
    snapshot.forEach(doc => { users.set(doc.data().email, doc.data()); });
    console.log(`✅ ${users.size} usuários carregados do Firestore.`);
  } catch (e) { console.error('Erro ao carregar usuários:', e.message); }
}
loadAllUsers();

rooms.set('lounge', createRoom('lounge', 'Lounge Sonora', 'Sistema'));

// Funções auxiliares das salas (broadcast, advance, shuffle, etc.) se mantêm IGUAIS...
function broadcastState(slug) { /* ... */ }
function broadcastUsers(slug) { /* ... */ }
function addSystemMsg(slug, text) { /* ... */ }
function autoShuffle(room) { /* ... */ }
function advanceQueue(slug) { /* ... */ }
async function startRadio(slug) { /* ... */ }
async function sendDiscordWebhook(webhookUrl, message) { /* ... */ }

// ========== ROTAS DE AUTENTICAÇÃO ==========
app.post('/api/signup', async (req, res) => {
  const { nome, email, senha, estilos } = req.body;
  if (!nome || nome.length < 2) return res.status(400).json({ error: 'Nome inválido' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido' });
  if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter 6+ caracteres' });
  if (!estilos || estilos.length === 0) return res.status(400).json({ error: 'Escolha um estilo' });

  try {
    const existing = await db.collection('users').doc(email).get();
    if (existing.exists) return res.status(400).json({ error: 'E-mail já cadastrado' });

    await admin.auth().createUser({ email, password: senha, displayName: nome });
    const userData = { nome, email, estilos, avatar: '🎸', criadoEm: new Date(), theme: 'dark', fontSize: 16, colorblind: false, discordWebhook: null };
    await setUserInFirestore(email, userData);
    users.set(email, userData);
    await setPointsInFirestore(email, { points: 0, badges: [] });
    userPoints.set(email, { points: 0, badges: [] });
    await setFavoritesInFirestore(email, []);
    userFavorites.set(email, []);
    res.json({ success: true, nome, email });
  } catch (e) { res.status(500).json({ error: 'Erro ao criar conta: ' + e.message }); }
});

app.post('/api/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Preencha e-mail' });

  try {
    await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(email).get();
    if (!userDoc.exists) return res.status(401).json({ error: 'Usuário não encontrado' });

    const userData = userDoc.data();
    const token = crypto.randomBytes(64).toString('hex');
    sessions.set(token, email);
    res.cookie('sessionToken', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });

    const points = await getPointsFromFirestore(email);
    res.json({ success: true, user: { ...userData, points: points.points, badges: points.badges } });
  } catch (e) { res.status(401).json({ error: 'Credenciais inválidas' }); }
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
  const userData = users.get(email) || await getUserFromFirestore(email);
  if (!userData) { sessions.delete(token); return res.status(401).json({ error: 'Usuário não encontrado' }); }
  const points = userPoints.get(email) || await getPointsFromFirestore(email);
  res.json({ success: true, user: { ...userData, points: points.points, badges: points.badges } });
});

app.post('/api/update-avatar', async (req, res) => {
  // ... (Lógica igual à anterior)
});

app.post('/api/update-theme', async (req, res) => {
  // ... (Lógica igual à anterior)
});

// ========== FAVORITOS ==========
app.get('/api/favorites', async (req, res) => {
  // ... (Lógica igual à anterior)
});
app.post('/api/favorites', async (req, res) => {
  // ... (Lógica igual à anterior)
});
app.delete('/api/favorites/:videoId', async (req, res) => {
  // ... (Lógica igual à anterior)
});

// ========== ROTAS DE SALAS, ADMIN E SOCKET ==========
// INSIRA AQUI TODAS AS OUTRAS ROTAS E O BLOCO `io.on('connection', ...)` 
// DO SEU CÓDIGO ANTERIOR (ELES PERMANECEM IDÊNTICOS).

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
