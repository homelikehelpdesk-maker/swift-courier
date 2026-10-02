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

db.exec("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP)");
['tracking','parcel','pickup_date','pickup_slot','s_name','s_phone','s_addr','r_name','r_phone','r_addr','pay'].forEach(c => { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c} TEXT`); } catch {} });
['value','insurance','s_lat','s_lng','r_lat','r_lng'].forEach(c => { try { db.exec(`ALTER TABLE orders ADD COLUMN ${c} REAL DEFAULT 0`); } catch {} });
db.exec("UPDATE orders SET tracking='SR'||upper(hex(randomblob(4))) WHERE tracking IS NULL");
const DEFAULTS = { company: 'SwiftRoute Couriers', currency: '₹', base: 50, perKm: 2.5, perKg: 15, expressMult: 1.6, localKm: 10, minPrice: 60, insurancePct: 1.5, companyAddress: 'Your business address, City', companyPhone: '+91 00000 00000' };
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
  .map(({ k, v }) => [k, ['company', 'currency', 'companyAddress', 'companyPhone'].includes(k) || isNaN(v) ? v : Number(v)]));
const cities = () => [...new Set(db.prepare('SELECT a,b FROM routes').all().flatMap(r => [r.a, r.b]))].sort();
function quote(a, b, kg, service, value, insured) {
  const s = settings(); kg = Number(kg);
  if (!a || !b || !(kg > 0)) return null;
  const km = a === b ? s.localKm : (db.prepare('SELECT km FROM routes WHERE (a=? AND b=?) OR (a=? AND b=?)').get(a, b, b, a) || {}).km;
  if (km == null) return null;
  let p = s.base + km * s.perKm + kg * s.perKg;
  if (service === 'express') p *= s.expressMult;
  const ship = Math.max(s.minPrice, Math.round(p * 100) / 100);
  const insurance = insured && value > 0 ? Math.round(value * s.insurancePct) / 100 : 0;
  return { km, ship, insurance, price: Math.round((ship + insurance) * 100) / 100 };
}


async function mail(to, subject, text) {
  const k = process.env.BREVO_API_KEY; if (!k) return;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': k, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: settings().company, email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) });
  if (!r.ok) console.log('Email failed', await r.text());
}
const e164 = p => { p = String(p || '').replace(/[^\d+]/g, ''); return p.startsWith('+') ? p : p.length === 10 ? (process.env.DEFAULT_COUNTRY_CODE || '+91') + p : '+' + p; };
async function sms(to, body) {
  const { TWILIO_SID: sid, TWILIO_TOKEN: tok, TWILIO_FROM: from } = process.env; if (!sid || !tok || !from) return;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: e164(to), From: from, Body: body }) });
  if (!r.ok) console.log('SMS failed', await r.text());
}
function notify(orderId, status) {
  setImmediate(async () => { try {
    const o = db.prepare('SELECT o.*, u.email, u.name AS customer FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(orderId); if (!o) return;
    const s = settings(), url = (process.env.APP_URL || '') + '/#/track/' + o.tracking;
    const msg = `${s.company}: parcel ${o.tracking} (${o.a} to ${o.b}) is now "${status}". Track: ${url}`;
    await mail(o.email, `${s.company}: parcel ${o.tracking} ${status}`, `Hi ${o.customer},\n\n${msg}\n` + (status === 'Placed' ? `\nPayment is cash on delivery. Total due: ${s.currency}${o.price}.\n` : ''));
    await sms(o.s_phone, msg);
    if (['In transit', 'Delivered'].includes(status)) await sms(o.r_phone, msg);
  } catch (e) { console.log('Notify error', e.message); } });
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
  const q = quote(req.query.a, req.query.b, req.query.kg, req.query.service, +req.query.value, req.query.insured === '1');
  q ? res.json(q) : fail('No route set up for these cities yet');
}));

app.get('/api/orders', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.get('/api/orders/:id', auth, wrap((req, res) => {
  const o = db.prepare('SELECT o.*, u.name AS customer, u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=?').get(req.params.id);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) fail('Order not found');
  res.json({ ...o, company: settings() });
}));
app.post('/api/orders', auth, wrap((req, res) => {
  const o = req.body, ins = !!o.insured && +o.value > 0;
  const q = quote(o.a, o.b, o.kg, o.service, +o.value, ins);
  if (!q) fail('Cannot price this parcel');
  const need = ['pickup_date', 'pickup_slot', 's_name', 's_phone', 's_addr', 'r_name', 'r_phone', 'r_addr'];
  if (need.some(f => !String(o[f] || '').trim())) fail('Please fill in all pickup and delivery details');
  const tracking = 'SR' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  const id = db.prepare(`INSERT INTO orders(user_id,a,b,kg,service,price,details,tracking,parcel,value,insurance,pickup_date,pickup_slot,s_name,s_phone,s_addr,r_name,r_phone,r_addr,pay,s_lat,s_lng,r_lat,r_lng)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, o.a, o.b, +o.kg, o.service === 'express' ? 'express' : 'standard',
    q.price, String(o.details || '').slice(0, 500), tracking, String(o.parcel || 'Other').slice(0, 40), ins ? +o.value : 0, q.insurance,
    ...need.map(f => String(o[f]).slice(0, 200)), 'delivery', ...['s_lat', 's_lng', 'r_lat', 'r_lng'].map(f => o[f] == null || o[f] === '' ? null : +o[f])).lastInsertRowid;
  db.prepare('INSERT INTO events(order_id,status) VALUES(?,?)').run(id, 'Placed');
  notify(id, 'Placed');
  res.json({ ok: 1, id, tracking, price: q.price });
}));
app.post('/api/orders/:id/cancel', auth, wrap((req, res) => {
  const r = db.prepare("UPDATE orders SET status='Cancelled' WHERE id=? AND user_id=? AND status='Placed'").run(req.params.id, req.user.id);
  if (!r.changes) fail('Only orders that are still "Placed" can be cancelled');
  db.prepare('INSERT INTO events(order_id,status) VALUES(?,?)').run(req.params.id, 'Cancelled'); notify(req.params.id, 'Cancelled'); res.json({ ok: 1 });
}));
app.get('/api/track/:t', wrap((req, res) => {
  const o = db.prepare('SELECT id,tracking,a,b,service,status,parcel,created FROM orders WHERE tracking=?').get(req.params.t.trim().toUpperCase());
  if (!o) fail('No parcel found with that tracking ID');
  res.json({ ...o, events: db.prepare('SELECT status,at FROM events WHERE order_id=? ORDER BY id').all(o.id) });
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
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status, req.params.id);
  db.prepare('INSERT INTO events(order_id,status) VALUES(?,?)').run(req.params.id, req.body.status);
  notify(req.params.id, req.body.status); res.json({ ok: 1 });
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
