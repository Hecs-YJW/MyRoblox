const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_IN_PRODUCTION';
const MAX_ROOM_PLAYERS = 100;
const TICK_LIMIT_MS = 80;

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'myroblox.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_id, addressee_id),
  FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(addressee_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships(addressee_id);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanUsername(value) {
  return String(value || '').trim();
}
function validUsername(username) {
  return username.length >= 3 && username.length <= 20 && /^[A-Za-z0-9가-힣_]+$/.test(username);
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 4 && password.length <= 72;
}
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function setAuthCookie(res, user) {
  const token = signToken(user);
  res.setHeader('Set-Cookie', cookie.serialize('myroblox_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
    path: '/'
  }));
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', cookie.serialize('myroblox_token', '', {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 0, path: '/'
  }));
}
function userFromToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function getUserFromRequest(req) {
  const raw = req.headers.cookie ? cookie.parse(req.headers.cookie).myroblox_token : null;
  return raw ? userFromToken(raw) : null;
}
function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  next();
}
function publicUser(row) {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'My Roblox Server' }));

app.post('/api/auth/signup', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = req.body.password;
  const confirm = req.body.confirmPassword;
  if (!validUsername(username)) return res.status(400).json({ error: '아이디는 3~20자이며 영문, 한글, 숫자, _만 사용할 수 있습니다.' });
  if (!validPassword(password)) return res.status(400).json({ error: '비밀번호는 4~72자여야 합니다.' });
  if (password !== confirm) return res.status(400).json({ error: '비밀번호가 서로 다릅니다.' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = req.body.password;
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: '계정을 찾을 수 없습니다.' });
  res.json({ user: publicUser(user) });
});

function friendRows(userId) {
  return db.prepare(`
    SELECT f.id AS friendshipId, f.status, f.requester_id, f.addressee_id,
           u.id, u.username, u.created_at
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE f.requester_id = ? OR f.addressee_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).all(userId, userId, userId);
}
app.get('/api/friends', requireAuth, (req, res) => {
  const rows = friendRows(req.user.id);
  const online = onlineUsers();
  res.json({
    friends: rows.filter(r => r.status === 'accepted').map(r => ({ friendshipId:r.friendshipId, id:r.id, username:r.username, online:online.has(r.id) })),
    incoming: rows.filter(r => r.status === 'pending' && r.addressee_id === req.user.id).map(r => ({ friendshipId:r.friendshipId, id:r.id, username:r.username })),
    outgoing: rows.filter(r => r.status === 'pending' && r.requester_id === req.user.id).map(r => ({ friendshipId:r.friendshipId, id:r.id, username:r.username }))
  });
});

app.post('/api/friends/request', requireAuth, (req, res) => {
  const username = cleanUsername(req.body.username);
  const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!target) return res.status(404).json({ error: '해당 사용자를 찾을 수 없습니다.' });
  if (target.id === req.user.id) return res.status(400).json({ error: '자기 자신에게 친구 요청을 보낼 수 없습니다.' });
  const existing = db.prepare(`SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)`).get(req.user.id, target.id, target.id, req.user.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: '이미 친구입니다.' });
    if (existing.requester_id === target.id) {
      db.prepare('UPDATE friendships SET status="accepted" WHERE id=?').run(existing.id);
      return res.json({ ok:true, autoAccepted:true });
    }
    return res.status(409).json({ error: '이미 친구 요청을 보냈습니다.' });
  }
  db.prepare('INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, "pending")').run(req.user.id, target.id);
  res.json({ ok:true });
});

app.post('/api/friends/:id/accept', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM friendships WHERE id=? AND addressee_id=? AND status="pending"').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: '친구 요청을 찾을 수 없습니다.' });
  db.prepare('UPDATE friendships SET status="accepted" WHERE id=?').run(id);
  res.json({ ok:true });
});
app.delete('/api/friends/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)').run(Number(req.params.id), req.user.id, req.user.id);
  res.json({ ok:true });
});

const socketsByUser = new Map();
const players = new Map();
function onlineUsers() { return new Set([...socketsByUser.entries()].filter(([,set]) => set.size).map(([id]) => Number(id))); }
function addSocket(userId, socketId) {
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(socketId);
}
function removeSocket(userId, socketId) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (!set.size) socketsByUser.delete(userId);
}
function roomPlayers(room) {
  return [...players.values()].filter(p => p.game === room).map(p => ({ id:p.id, username:p.username, x:p.x, y:p.y, z:p.z, ry:p.ry }));
}

io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  const user = cookies.myroblox_token ? userFromToken(cookies.myroblox_token) : null;
  if (!user) return next(new Error('로그인이 필요합니다.'));
  const dbUser = db.prepare('SELECT id, username FROM users WHERE id=?').get(user.id);
  if (!dbUser) return next(new Error('계정을 찾을 수 없습니다.'));
  socket.user = dbUser;
  next();
});

io.on('connection', socket => {
  const user = socket.user;
  addSocket(user.id, socket.id);
  socket.emit('server:ready', { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });

  socket.on('game:join', payload => {
    const game = String(payload?.game || 'my-world').slice(0, 40);
    const room = `game:${game}`;
    const old = players.get(socket.id);
    if (old?.game === room) return;
    if (old?.game) {
      socket.leave(old.game);
      socket.to(old.game).emit('player:left', { id:user.id });
    }
    const count = roomPlayers(room).length;
    if (count >= MAX_ROOM_PLAYERS) return socket.emit('game:error', { error:'이 게임방이 가득 찼습니다.' });
    socket.join(room);
    players.set(socket.id, { id:user.id, username:user.username, socketId:socket.id, game:room, x:0, y:1, z:0, ry:0, lastUpdate:0 });
    socket.emit('game:state', { players: roomPlayers(room).filter(p => p.id !== user.id) });
    socket.to(room).emit('player:joined', { id:user.id, username:user.username, x:0, y:1, z:0, ry:0 });
  });

  socket.on('player:update', data => {
    const p = players.get(socket.id);
    if (!p || !p.game) return;
    const now = Date.now();
    if (now - p.lastUpdate < TICK_LIMIT_MS) return;
    p.lastUpdate = now;
    const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    p.x = Math.max(-500, Math.min(500, num(data?.x)));
    p.y = Math.max(-20, Math.min(100, num(data?.y)));
    p.z = Math.max(-500, Math.min(500, num(data?.z)));
    p.ry = num(data?.ry);
    socket.to(p.game).emit('player:update', { id:p.id, x:p.x, y:p.y, z:p.z, ry:p.ry });
  });

  socket.on('game:leave', () => {
    const p = players.get(socket.id);
    if (!p?.game) return;
    socket.leave(p.game);
    socket.to(p.game).emit('player:left', { id:user.id });
    players.delete(socket.id);
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p?.game) socket.to(p.game).emit('player:left', { id:user.id });
    players.delete(socket.id);
    removeSocket(user.id, socket.id);
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`My Roblox server: http://localhost:${PORT}`);
  if (JWT_SECRET === 'CHANGE_THIS_SECRET_IN_PRODUCTION') console.warn('WARNING: Set JWT_SECRET before public deployment.');
});
