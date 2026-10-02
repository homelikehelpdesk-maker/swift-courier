const express = require('express'), { DatabaseSync } = require('node:sqlite'), bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'), cookie = require('cookie-parser'), path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'courier.db'));
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PROD = process.env.NODE_ENV === 'production';

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, role TEXT DEFAULT 'user');
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS routes(id INTEGER PRIMARY KEY, a TEXT, b TEXT, km REAL, UNIQUE(a,b));
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER, a TEXT, b TEXT, kg REAL, service TEXT,
  price REAL, details TEXT, status TEXT DEFAULT 'Placed', created TEXT DEFAULT CURRENT_TIMESTAMP);`);

const DEFAULTS = { company: 'SwiftRoute Couriers', currency: '₹', base: 50, perKm: 2.5, perKg: 15, expressMult: 1.6, localKm: 10, minPrice: 60 };
for (const [k, v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, String(v));
if (!db.prepare('SELECT 1 FROM routes').get())
  [['Delhi','Jaipur',281],['Delhi','Chandigarh',250],['Delhi','Mumbai',1400],['Mumbai','Pune',150]]
    .forEach(r => db.prepare('INSERT INTO routes(a,b,km) VALUES(?,?,?)').run(...r));
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  db.prepare("INSERT INTO users(name,email,hash,role) VALUES('Admin',?,?, 'admin')")
    .run(email, bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin12345', 10));
  console.log('Admin account created:', email);
}

const settings = () => Object.fromEntries(db.prepare('SELECT k,v FROM settings').all()
  .map(({ k, v }) => [k, isNaN(v) || k === 'company' || k === 'currency' ? v : Number(v)]));
const cities = () => [...new Set(db.prepare('SELECT a,b FROM routes').all().flatMap(r => [r.a, r.b]))].sort();
function quote(a, b, kg, service) {
  const s = settings(); kg = Number(kg);
  if (!a || !b || !(kg > 0)) return null;
  let km = a === b ? s.localKm : (db.prepare('SELECT km FROM routes WHERE (a=? AND b=?) OR (a=? AND b=?)').get(a, b, b, a) || {}).km;
  if (km == null) return null;
  let p = s.base + km * s.perKm + kg * s.perKg;
  if (service === 'express') p *= s.expressMult;
  return { km, price: Math.max(s.minPrice, Math.round(p * 100) / 100) };
}

const app = express();
app.use(express.json(), cookie(), express.static(path.join(__dirname, 'public')));
const wrap = f => (req, res) => { try { f(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };
const fail = (m) => { throw new Error(m); };
function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.t, SECRET); next(); } catch { res.status(401).json({ error: 'Please log in' }); }
}
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
const login = (res, u) => {
  res.cookie('t', jwt.sign({ id: u.id, name: u.name, role: u.role }, SECRET, { expiresIn: '7d' }),
    { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
  res.json({ id: u.id, name: u.name, role: u.role });
};

app.post('/api/register', wrap((req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) fail('Enter name, email and a password of 8+ characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) fail('Email already registered');
  const id = db.prepare("INSERT INTO users(name,email,hash) VALUES(?,?,?)").run(name, email.toLowerCase(), bcrypt.hashSync(password, 10)).lastInsertRowid;
  login(res, { id, name, role: 'user' });
}));
app.post('/api/login', wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) fail('Wrong email or password');
  login(res, u);
}));
app.post('/api/logout', (req, res) => { res.clearCookie('t'); res.json({ ok: 1 }); });
app.get('/api/me', auth, (req, res) => res.json(req.user));
app.get('/api/config', (req, res) => res.json({ settings: settings(), cities: cities() }));
app.get('/api/quote', wrap((req, res) => {
  const q = quote(req.query.a, req.query.b, req.query.kg, req.query.service);
  q ? res.json(q) : fail('No route set up for these cities yet');
}));

app.get('/api/orders', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/orders', auth, wrap((req, res) => {
  const { a, b, kg, service, details } = req.body, q = quote(a, b, kg, service);
  if (!q) fail('Cannot price this parcel');
  db.prepare('INSERT INTO orders(user_id,a,b,kg,service,price,details) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, a, b, kg, service === 'express' ? 'express' : 'standard', q.price, String(details || '').slice(0, 500));
  res.json({ ok: 1 });
}));

const A = [auth, admin];
app.put('/api/admin/settings', A, wrap((req, res) => {
  for (const k of Object.keys(DEFAULTS)) if (k in req.body) db.prepare('REPLACE INTO settings VALUES(?,?)').run(k, String(req.body[k]));
  res.json(settings());
}));
app.post('/api/admin/routes', A, wrap((req, res) => {
  const { a, b, km } = req.body; if (!a || !b || !(km > 0)) fail('Enter two cities and a distance');
  db.prepare('DELETE FROM routes WHERE (a=? AND b=?) OR (a=? AND b=?)').run(a, b, b, a);
  db.prepare('INSERT INTO routes(a,b,km) VALUES(?,?,?)').run(a.trim(), b.trim(), km); res.json({ ok: 1 });
}));
app.get('/api/admin/routes', A, (req, res) => res.json(db.prepare('SELECT * FROM routes ORDER BY a,b').all()));
app.delete('/api/admin/routes/:id', A, (req, res) => { db.prepare('DELETE FROM routes WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
app.get('/api/admin/orders', A, (req, res) => res.json(db.prepare(
  'SELECT o.*, u.name AS customer, u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC').all()));
app.put('/api/admin/orders/:id', A, wrap((req, res) => {
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id); res.json({ ok: 1 });
}));
app.delete('/api/admin/orders/:id', A, (req, res) => { db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
app.get('/api/admin/users', A, (req, res) => res.json(db.prepare('SELECT id,name,email,role FROM users ORDER BY id').all()));
app.put('/api/admin/users/:id', A, wrap((req, res) => {
  if (+req.params.id === req.user.id) fail('You cannot change your own role');
  db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role === 'admin' ? 'admin' : 'user', req.params.id); res.json({ ok: 1 });
}));
app.delete('/api/admin/users/:id', A, wrap((req, res) => {
  if (+req.params.id === req.user.id) fail('You cannot delete yourself');
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id); res.json({ ok: 1 });
}));

app.listen(process.env.PORT || 3000, () => console.log('Courier app running on port ' + (process.env.PORT || 3000)));
