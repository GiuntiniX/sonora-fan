const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'sonora.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Usuários
  db.run(`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    nome TEXT,
    senha TEXT,
    genero TEXT,
    regiao TEXT,
    estilos TEXT,
    avatar TEXT,
    criadoEm DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_added INTEGER DEFAULT 0,
    total_upvotes INTEGER DEFAULT 0,
    total_downvotes INTEGER DEFAULT 0
  )`);

  // Salas
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    slug TEXT PRIMARY KEY,
    name TEXT,
    admin TEXT,
    isPlaying INTEGER DEFAULT 0,
    currentIndex INTEGER DEFAULT 0,
    startedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    listenerCount INTEGER DEFAULT 0
  )`);

  // Fila (músicas)
  db.run(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomSlug TEXT,
    videoId TEXT,
    title TEXT,
    artist TEXT,
    duration INTEGER,
    dj TEXT,
    position INTEGER,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(roomSlug) REFERENCES rooms(slug)
  )`);

  // Histórico
  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomSlug TEXT,
    videoId TEXT,
    title TEXT,
    artist TEXT,
    dj TEXT,
    playedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(roomSlug) REFERENCES rooms(slug)
  )`);

  // Votos
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomSlug TEXT,
    queueId INTEGER,
    userName TEXT,
    type TEXT CHECK(type IN ('up','down')),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(roomSlug) REFERENCES rooms(slug),
    FOREIGN KEY(queueId) REFERENCES queue(id)
  )`);

  // Curtidas em mensagens
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomSlug TEXT,
    messageId TEXT,
    userName TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(roomSlug) REFERENCES rooms(slug)
  )`);
});

module.exports = db;
