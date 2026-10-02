try { require('dotenv').config(); } catch {}
const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'), cookie = require('cookie-parser'), path = require('path'), crypto = require('crypto');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set. Add your Neon connection string.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PROD = process.env.NODE_ENV === 'production';
const NOW = "to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')";
const STATUS = ['Placed', 'Picked up', 'In transit', 'Delivered', 'Cancelled'];
const DEFAULTS = { company: 'SwiftRoute Couriers', currency: '₹', base: 50, perKm: 2.5, perKg: 15, expressMult: 1.6, localKm: 10, minPrice: 60,
  insurancePct: 1.5, companyAddress: 'Your business address, City', companyPhone: '+91 00000 00000' };
const TEXT = ['company', 'currency', 'companyAddress', 'companyPhone'];

async function init() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT, role TEXT DEFAULT 'user');
  CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS routes(id SERIAL PRIMARY KEY, a TEXT, b TEXT, km DOUBLE PRECISION, UNIQUE(a,b));
  CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY, user_id INTEGER, a TEXT, b TEXT, kg DOUBLE PRECISION, service TEXT, price DOUBLE PRECISION,
    details TEXT, status TEXT DEFAULT 'Placed', created TEXT DEFAULT ${NOW}, tracking TEXT, parcel TEXT, value DOUBLE PRECISION DEFAULT 0,
    insurance DOUBLE PRECISION DEFAULT 0, pickup_date TEXT, pickup_slot TEXT, s_name TEXT, s_phone TEXT, s_addr TEXT, r_name TEXT, r_phone TEXT,
    r_addr TEXT, pay TEXT, s_lat DOUBLE PRECISION, s_lng DOUBLE PRECISION, r_lat DOUBLE PRECISION, r_lng DOUBLE PRECISION);
  CREATE TABLE IF NOT EXISTS events(id SERIAL PRIMARY KEY, order_id INTEGER, status TEXT, at TEXT DEFAULT ${NOW});`);
  for (const [k, v] of Object.entries(DEFAULTS)) await q('INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO NOTHING', [k, String(v)]);
  if (!(await one('SELECT 1 FROM routes')))
    for (const r of [['Delhi', 'Jaipur', 281], ['Delhi', 'Chandigarh', 250], ['Delhi', 'Mumbai', 1400], ['Mumbai', 'Pune', 150]])
      await q('INSERT INTO routes(a,b,km) VALUES($1,$2,$3)', r);
  if (!(await one("SELECT 1 FROM users WHERE role='admin'"))) {
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
    await q("INSERT INTO users(name,email,hash,role) VALUES('Admin',$1,$2,'admin') ON CONFLICT (email) DO UPDATE SET role='admin'",
      [email, bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin12345', 10)]);
    console.log('Admin account ready:', email);
  }
}

const settings = async () => Object.fromEntries((await q('SELECT k,v FROM settings')).map(({ k, v }) => [k, TEXT.includes(k) || isNaN(v) ? v : Number(v)]));
const cities = async () => [...new Set((await q('SELECT a,b FROM routes')).flatMap(r => [r.a, r.b]))].sort();
async function quote(a, b, kg, service, value, insured) {
  const s = await settings(); kg = Number(kg);
  if (!a || !b || !(kg > 0)) return null;
  const km = a === b ? s.localKm : ((await one('SELECT km FROM routes WHERE (a=$1 AND b=$2) OR (a=$2 AND b=$1)', [a, b])) || {}).km;
  if (km == null) return null;
  let p = s.base + km * s.perKm + kg * s.perKg;
  if (service === 'express') p *= s.expressMult;
  const ship = Math.max(s.minPrice, Math.round(p * 100) / 100);
  const insurance = insured && value > 0 ? Math.round(value * s.insurancePct) / 100 : 0;
  return { km, ship, insurance, price: Math.round((ship + insurance) * 100) / 100 };
}

async function mail(to, subject, text, company) {
  const k = process.env.BREVO_API_KEY; if (!k) return;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': k, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: company, email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) });
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
    const o = await one('SELECT o.*, u.email, u.name AS customer FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [orderId]); if (!o) return;
    const s = await settings(), url = (process.env.APP_URL || '') + '/#/track/' + o.tracking;
    const msg = `${s.company}: parcel ${o.tracking} (${o.a} to ${o.b}) is now "${status}". Track: ${url}`;
    await mail(o.email, `${s.company}: parcel ${o.tracking} ${status}`, `Hi ${o.customer},\n\n${msg}\n` + (status === 'Placed' ? `\nPayment is cash on delivery. Total due: ${s.currency}${o.price}.\n` : ''), s.company);
    await sms(o.s_phone, msg);
    if (['In transit', 'Delivered'].includes(status)) await sms(o.r_phone, msg);
  } catch (e) { console.log('Notify error', e.message); } });
}

const app = express();
app.use(express.json(), cookie(), express.static(path.join(__dirname, 'public')));
const wrap = f => (req, res) => Promise.resolve().then(() => f(req, res)).catch(e => res.status(400).json({ error: e.message }));
const fail = m => { throw new Error(m); };
function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.t, SECRET); next(); } catch { res.status(401).json({ error: 'Please log in' }); }
}
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
const A = [auth, admin];
const login = (res, u) => {
  res.cookie('t', jwt.sign({ id: u.id, name: u.name, role: u.role }, SECRET, { expiresIn: '7d' }),
    { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
  res.json({ id: u.id, name: u.name, role: u.role });
};

app.post('/api/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) fail('Enter name, email and a password of 8+ characters');
  if (await one('SELECT 1 FROM users WHERE email=$1', [email.toLowerCase()])) fail('Email already registered');
  const u = await one('INSERT INTO users(name,email,hash) VALUES($1,$2,$3) RETURNING id', [name, email.toLowerCase(), bcrypt.hashSync(password, 10)]);
  login(res, { id: u.id, name, role: 'user' });
}));
app.post('/api/login', wrap(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE email=$1', [(req.body.email || '').toLowerCase()]);
  if (!u || !bcrypt.compareSync(req.body.password || '', u.hash)) fail('Wrong email or password');
  login(res, u);
}));
app.post('/api/logout', (req, res) => { res.clearCookie('t'); res.json({ ok: 1 }); });
app.get('/api/me', auth, (req, res) => res.json(req.user));
app.get('/api/config', wrap(async (req, res) => res.json({ settings: await settings(), cities: await cities() })));
app.get('/api/quote', wrap(async (req, res) => {
  const r = await quote(req.query.a, req.query.b, req.query.kg, req.query.service, +req.query.value, req.query.insured === '1');
  r ? res.json(r) : fail('No route set up for these cities yet');
}));

app.get('/api/orders', auth, wrap(async (req, res) => res.json(await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [req.user.id]))));
app.get('/api/orders/:id', auth, wrap(async (req, res) => {
  const o = await one('SELECT o.*, u.name AS customer, u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1', [req.params.id]);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) fail('Order not found');
  res.json({ ...o, company: await settings() });
}));
app.post('/api/orders', auth, wrap(async (req, res) => {
  const o = req.body, ins = !!o.insured && +o.value > 0;
  const qt = await quote(o.a, o.b, o.kg, o.service, +o.value, ins);
  if (!qt) fail('Cannot price this parcel');
  const need = ['pickup_date', 'pickup_slot', 's_name', 's_phone', 's_addr', 'r_name', 'r_phone', 'r_addr'];
  if (need.some(f => !String(o[f] || '').trim())) fail('Please fill in all pickup and delivery details');
  const tracking = 'SR' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const vals = [req.user.id, o.a, o.b, +o.kg, o.service === 'express' ? 'express' : 'standard', qt.price, String(o.details || '').slice(0, 500), tracking,
    String(o.parcel || 'Other').slice(0, 40), ins ? +o.value : 0, qt.insurance, ...need.map(f => String(o[f]).slice(0, 200)), 'delivery',
    ...['s_lat', 's_lng', 'r_lat', 'r_lng'].map(f => o[f] == null || o[f] === '' ? null : +o[f])];
  const r = await one(`INSERT INTO orders(user_id,a,b,kg,service,price,details,tracking,parcel,value,insurance,pickup_date,pickup_slot,s_name,s_phone,s_addr,r_name,r_phone,r_addr,pay,s_lat,s_lng,r_lat,r_lng)
    VALUES(${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [r.id, 'Placed']);
  notify(r.id, 'Placed');
  res.json({ ok: 1, id: r.id, tracking, price: qt.price });
}));
app.post('/api/orders/:id/cancel', auth, wrap(async (req, res) => {
  const r = await pool.query("UPDATE orders SET status='Cancelled' WHERE id=$1 AND user_id=$2 AND status='Placed'", [req.params.id, req.user.id]);
  if (!r.rowCount) fail('Only orders that are still "Placed" can be cancelled');
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [req.params.id, 'Cancelled']);
  notify(req.params.id, 'Cancelled'); res.json({ ok: 1 });
}));
app.get('/api/track/:t', wrap(async (req, res) => {
  const o = await one('SELECT id,tracking,a,b,service,status,parcel,created FROM orders WHERE tracking=$1', [req.params.t.trim().toUpperCase()]);
  if (!o) fail('No parcel found with that tracking ID');
  res.json({ ...o, events: await q('SELECT status,at FROM events WHERE order_id=$1 ORDER BY id', [o.id]) });
}));

app.put('/api/admin/settings', A, wrap(async (req, res) => {
  for (const k of Object.keys(DEFAULTS)) if (k in req.body)
    await q('INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, String(req.body[k])]);
  res.json(await settings());
}));
app.get('/api/admin/routes', A, wrap(async (req, res) => res.json(await q('SELECT * FROM routes ORDER BY a,b'))));
app.post('/api/admin/routes', A, wrap(async (req, res) => {
  const { a, b, km } = req.body; if (!a || !b || !(km > 0)) fail('Enter two cities and a distance');
  await q('DELETE FROM routes WHERE (a=$1 AND b=$2) OR (a=$2 AND b=$1)', [a.trim(), b.trim()]);
  await q('INSERT INTO routes(a,b,km) VALUES($1,$2,$3)', [a.trim(), b.trim(), km]); res.json({ ok: 1 });
}));
app.delete('/api/admin/routes/:id', A, wrap(async (req, res) => { await q('DELETE FROM routes WHERE id=$1', [req.params.id]); res.json({ ok: 1 }); }));
app.get('/api/admin/orders', A, wrap(async (req, res) => res.json(await q(
  'SELECT o.*, u.name AS customer, u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC'))));
app.put('/api/admin/orders/:id', A, wrap(async (req, res) => {
  if (!STATUS.includes(req.body.status)) fail('Unknown status');
  await q('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [req.params.id, req.body.status]);
  notify(req.params.id, req.body.status); res.json({ ok: 1 });
}));
app.delete('/api/admin/orders/:id', A, wrap(async (req, res) => { await q('DELETE FROM orders WHERE id=$1', [req.params.id]); res.json({ ok: 1 }); }));
app.get('/api/admin/users', A, wrap(async (req, res) => res.json(await q('SELECT id,name,email,role FROM users ORDER BY id'))));
app.put('/api/admin/users/:id', A, wrap(async (req, res) => {
  if (+req.params.id === req.user.id) fail('You cannot change your own role');
  await q('UPDATE users SET role=$1 WHERE id=$2', [req.body.role === 'admin' ? 'admin' : 'user', req.params.id]); res.json({ ok: 1 });
}));
app.delete('/api/admin/users/:id', A, wrap(async (req, res) => {
  if (+req.params.id === req.user.id) fail('You cannot delete yourself');
  await q('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: 1 });
}));

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('Courier app running on port ' + PORT)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
