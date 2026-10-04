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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT; ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id INTEGER; ALTER TABLE orders ADD COLUMN IF NOT EXISTS km DOUBLE PRECISION;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS otp TEXT; ALTER TABLE orders ADD COLUMN IF NOT EXISTS otp_tries INTEGER DEFAULT 0;
  CREATE TABLE IF NOT EXISTS pending_users(email TEXT PRIMARY KEY, name TEXT, hash TEXT, phone TEXT, code TEXT, exp DOUBLE PRECISION, tries INTEGER DEFAULT 0, sent DOUBLE PRECISION);
  CREATE TABLE IF NOT EXISTS driver_loc(driver_id INTEGER PRIMARY KEY, lat DOUBLE PRECISION, lng DOUBLE PRECISION, at TEXT DEFAULT ${NOW});`);
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
const kmCache = new Map();
async function roadKm(a, b, c, d) {
  const key = [a, b, c, d].map(x => x.toFixed(4)).join(',');
  if (kmCache.has(key)) return kmCache.get(key);
  let r = null;
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${b},${a};${d},${c}?overview=false`,
      { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'courier-app' } });
    const j = await res.json();
    if (j.routes && j.routes[0]) r = { km: Math.round(j.routes[0].distance / 100) / 10, mode: 'road' };
  } catch {}
  if (!r) {
    const R = 6371, rad = x => x * Math.PI / 180, dLa = rad(c - a), dLn = rad(d - b);
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLn / 2) ** 2;
    r = { km: Math.round(2 * R * Math.asin(Math.sqrt(h)) * 13) / 10, mode: 'straight' };
  }
  if (kmCache.size > 500) kmCache.clear();
  kmCache.set(key, r); return r;
}
async function quote(a, b, kg, service, value, insured, pts) {
  const s = await settings(); kg = Number(kg);
  if (!(kg > 0)) return null;
  const P = (pts || []).map(x => x === '' || x == null ? NaN : Number(x));
  let km, mode = 'city';
  if (P.length === 4 && P.every(Number.isFinite) && Math.abs(P[0]) <= 90 && Math.abs(P[2]) <= 90 && Math.abs(P[1]) <= 180 && Math.abs(P[3]) <= 180) {
    ({ km, mode } = await roadKm(...P));
  } else {
    if (!a || !b) return null;
    km = a === b ? s.localKm : ((await one('SELECT km FROM routes WHERE (a=$1 AND b=$2) OR (a=$2 AND b=$1)', [a, b])) || {}).km;
    if (km == null) return null;
  }
  let p = s.base + km * s.perKm + kg * s.perKg;
  if (service === 'express') p *= s.expressMult;
  const ship = Math.max(s.minPrice, Math.round(p * 100) / 100);
  const insurance = insured && value > 0 ? Math.round(value * s.insurancePct) / 100 : 0;
  return { km, mode, ship, insurance, price: Math.round((ship + insurance) * 100) / 100 };
}

async function mail(to, subject, text, company) {
  const k = process.env.BREVO_API_KEY; if (!k) return false;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': k, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: company, email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) });
  if (!r.ok) console.log('Email failed', await r.text());
  return r.ok;
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
    await mail(o.email, `${s.company}: parcel ${o.tracking} ${status}`, `Hi ${o.customer},\n\n${msg}\n` + (status === 'Placed' ? `\nPayment is cash on delivery. Total due: ${s.currency}${o.price}.\nLog in to your account to see your delivery OTP.\n` : ''), s.company);
    await sms(o.s_phone, msg);
    if (['In transit', 'Delivered'].includes(status)) await sms(o.r_phone, msg);
  } catch (e) { console.log('Notify error', e.message); } });
}

const app = express();
app.use(express.json(), cookie(), express.static(path.join(__dirname, 'public')));
const wrap = f => (req, res) => Promise.resolve().then(() => f(req, res)).catch(e => res.status(400).json({ error: e.message }));
const fail = m => { throw new Error(m); };
async function auth(req, res, next) {
  try {
    const t = jwt.verify(req.cookies.t, SECRET), u = await one('SELECT id,name,role FROM users WHERE id=$1', [t.id]);
    if (!u) throw 0; req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
}
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
const A = [auth, admin];
const login = (res, u) => {
  res.cookie('t', jwt.sign({ id: u.id, name: u.name, role: u.role }, SECRET, { expiresIn: '7d' }),
    { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 });
  res.json({ id: u.id, name: u.name, role: u.role });
};

const hashCode = c => crypto.createHash('sha256').update(c + SECRET).digest('hex');
async function sendSignupCode(em, name, hash, ph) {
  const old = await one('SELECT sent FROM pending_users WHERE email=$1', [em]);
  if (old && Date.now() - old.sent < 30000) fail('Please wait 30 seconds before asking for a new code');
  const code = String(crypto.randomInt(100000, 1000000));
  await q(`INSERT INTO pending_users(email,name,hash,phone,code,exp,tries,sent) VALUES($1,$2,$3,$4,$5,$6,0,$7)
    ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, hash=EXCLUDED.hash, phone=EXCLUDED.phone, code=EXCLUDED.code, exp=EXCLUDED.exp, tries=0, sent=EXCLUDED.sent`,
    [em, name, hash, ph, hashCode(code), Date.now() + 10 * 60000, Date.now()]);
  const co = (await settings()).company;
  if (!(await mail(em, `${co}: your verification code`, `Hi ${name},\n\nYour verification code is ${code}. It expires in 10 minutes.\n`, co))) fail('We could not send the email. Please try again.');
}
app.post('/api/verify', wrap(async (req, res) => {
  const em = String(req.body.email || '').toLowerCase(), p = await one('SELECT * FROM pending_users WHERE email=$1', [em]);
  if (!p || Date.now() > p.exp) fail('This code has expired. Request a new code or sign up again.');
  if (p.tries >= 5) fail('Too many wrong attempts. Request a new code.');
  if (hashCode(String(req.body.code || '').trim()) !== p.code) { await q('UPDATE pending_users SET tries=tries+1 WHERE email=$1', [em]); fail('Wrong code'); }
  const u = await one('INSERT INTO users(name,email,hash,phone) VALUES($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING id', [p.name, em, p.hash, p.phone]);
  if (!u) fail('This email is already registered. Please log in.');
  await q('DELETE FROM pending_users WHERE email=$1', [em]);
  login(res, { id: u.id, name: p.name, role: 'user' });
}));
app.post('/api/resend', wrap(async (req, res) => {
  const em = String(req.body.email || '').toLowerCase(), p = await one('SELECT * FROM pending_users WHERE email=$1', [em]);
  if (!p) fail('Please sign up again');
  await sendSignupCode(em, p.name, p.hash, p.phone); res.json({ ok: 1 });
}));
app.post('/api/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) fail('Enter name, email and a password of 8+ characters');
  if (await one('SELECT 1 FROM users WHERE email=$1', [email.toLowerCase()])) fail('Email already registered');
  const em = email.toLowerCase(), ph = String(req.body.phone || '').slice(0, 20), hash = bcrypt.hashSync(password, 10);
  if (process.env.BREVO_API_KEY && process.env.REQUIRE_EMAIL_OTP !== 'off') { await sendSignupCode(em, name, hash, ph); return res.json({ verify: true, email: em }); }
  const u = await one('INSERT INTO users(name,email,hash,phone) VALUES($1,$2,$3,$4) RETURNING id', [name, em, hash, ph]);
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
  const r = await quote(req.query.a, req.query.b, req.query.kg, req.query.service, +req.query.value, req.query.insured === '1', [req.query.s_lat, req.query.s_lng, req.query.r_lat, req.query.r_lng]);
  r ? res.json(r) : fail('No route set up for these cities yet');
}));

app.get('/api/orders', auth, wrap(async (req, res) => res.json(await q('SELECT o.*, d.name AS driver_name, d.phone AS driver_phone FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.user_id=$1 ORDER BY o.id DESC', [req.user.id]))));
app.get('/api/orders/:id', auth, wrap(async (req, res) => {
  const o = await one('SELECT o.*, u.name AS customer, u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1', [req.params.id]);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) fail('Order not found');
  res.json({ ...o, company: await settings() });
}));
app.post('/api/orders', auth, wrap(async (req, res) => {
  const o = req.body, ins = !!o.insured && +o.value > 0;
  const pts = ['s_lat', 's_lng', 'r_lat', 'r_lng'].map(f => o[f]);
  if (pts.some(x => x == null || x === '' || !Number.isFinite(+x))) fail('Please pin the pickup and delivery locations on the map');
  const qt = await quote(o.a, o.b, o.kg, o.service, +o.value, ins, pts);
  if (!qt) fail('Cannot price this parcel');
  const need = ['pickup_date', 'pickup_slot', 's_name', 's_phone', 's_addr', 'r_name', 'r_phone', 'r_addr'];
  if (need.some(f => !String(o[f] || '').trim())) fail('Please fill in all pickup and delivery details');
  const tracking = 'SR' + crypto.randomBytes(4).toString('hex').toUpperCase(), otp = String(crypto.randomInt(1000, 10000));
  const vals = [req.user.id, o.a, o.b, +o.kg, o.service === 'express' ? 'express' : 'standard', qt.price, String(o.details || '').slice(0, 500), tracking,
    String(o.parcel || 'Other').slice(0, 40), ins ? +o.value : 0, qt.insurance, ...need.map(f => String(o[f]).slice(0, 200)), 'delivery',
    ...['s_lat', 's_lng', 'r_lat', 'r_lng'].map(f => o[f] == null || o[f] === '' ? null : +o[f]), qt.km, otp];
  const r = await one(`INSERT INTO orders(user_id,a,b,kg,service,price,details,tracking,parcel,value,insurance,pickup_date,pickup_slot,s_name,s_phone,s_addr,r_name,r_phone,r_addr,pay,s_lat,s_lng,r_lat,r_lng,km,otp)
    VALUES(${vals.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [r.id, 'Placed']);
  notify(r.id, 'Placed');
  res.json({ ok: 1, id: r.id, tracking, price: qt.price, otp });
}));
app.post('/api/orders/:id/cancel', auth, wrap(async (req, res) => {
  const r = await pool.query("UPDATE orders SET status='Cancelled' WHERE id=$1 AND user_id=$2 AND status='Placed'", [req.params.id, req.user.id]);
  if (!r.rowCount) fail('Only orders that are still "Placed" can be cancelled');
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [req.params.id, 'Cancelled']);
  notify(req.params.id, 'Cancelled'); res.json({ ok: 1 });
}));
const who = req => { try { return jwt.verify(req.cookies.t, SECRET); } catch { return null; } };
app.get('/api/track/:t', wrap(async (req, res) => {
  const o = await one('SELECT id,user_id,tracking,a,b,service,status,parcel,created,driver_id,r_lat,r_lng,otp FROM orders WHERE tracking=$1', [req.params.t.trim().toUpperCase()]);
  if (!o) fail('No parcel found with that tracking ID');
  const me = who(req), mine = !!me && (me.id === o.user_id || me.role === 'admin');
  let driver = null;
  if (o.driver_id) {
    const d = await one('SELECT u.name, u.phone, l.lat, l.lng, l.at FROM users u LEFT JOIN driver_loc l ON l.driver_id=u.id WHERE u.id=$1', [o.driver_id]);
    const live = !!d && d.lat != null && ['Picked up', 'In transit'].includes(o.status);
    if (d) driver = { name: d.name, phone: mine ? d.phone : null, live, lat: live ? d.lat : null, lng: live ? d.lng : null, updated: live ? d.at : null };
  }
  const { user_id, driver_id, r_lat, r_lng, otp, ...pub } = o;
  res.json({ ...pub, driver, otp: mine && !['Delivered', 'Cancelled'].includes(o.status) ? otp : null, dest: mine && r_lat != null ? [r_lat, r_lng] : null,
    events: await q('SELECT status,at FROM events WHERE order_id=$1 ORDER BY id', [o.id]) });
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
  'SELECT o.*, u.name AS customer, u.email, d.name AS driver_name FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN users d ON d.id=o.driver_id ORDER BY o.id DESC'))));
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
  await q('UPDATE users SET role=$1 WHERE id=$2', [['admin', 'driver'].includes(req.body.role) ? req.body.role : 'user', req.params.id]); res.json({ ok: 1 });
}));
app.delete('/api/admin/users/:id', A, wrap(async (req, res) => {
  if (+req.params.id === req.user.id) fail('You cannot delete yourself');
  await q('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: 1 });
}));

app.get('/api/admin/drivers', A, wrap(async (req, res) => res.json(await q("SELECT id,name,phone FROM users WHERE role='driver' ORDER BY name"))));
app.put('/api/admin/orders/:id/driver', A, wrap(async (req, res) => {
  const d = req.body.driver_id ? await one("SELECT id,name FROM users WHERE id=$1 AND role='driver'", [req.body.driver_id]) : null;
  if (req.body.driver_id && !d) fail('Choose a valid delivery partner');
  await q('UPDATE orders SET driver_id=$1 WHERE id=$2', [d ? d.id : null, req.params.id]);
  if (d) await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [req.params.id, 'Delivery partner assigned: ' + d.name]);
  res.json({ ok: 1 });
}));

const drv = (req, res, next) => req.user.role === 'driver' ? next() : res.status(403).json({ error: 'Delivery partners only' });
app.get('/api/driver/orders', auth, drv, wrap(async (req, res) => res.json(await q(
  "SELECT o.id,o.tracking,o.a,o.b,o.kg,o.service,o.price,o.status,o.parcel,o.details,o.pickup_date,o.pickup_slot,o.s_name,o.s_phone,o.s_addr,o.r_name,o.r_phone,o.r_addr,o.s_lat,o.s_lng,o.r_lat,o.r_lng, u.name AS customer FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.driver_id=$1 AND o.status NOT IN ('Delivered','Cancelled') ORDER BY o.id", [req.user.id]))));
app.put('/api/driver/orders/:id', auth, drv, wrap(async (req, res) => {
  if (!['Picked up', 'In transit', 'Delivered'].includes(req.body.status)) fail('Unknown status');
  if (req.body.status === 'Delivered') {
    const ord = await one('SELECT otp, otp_tries FROM orders WHERE id=$1 AND driver_id=$2', [req.params.id, req.user.id]);
    if (ord && ord.otp) {
      if (ord.otp_tries >= 5) fail('Too many wrong OTP attempts. Please contact the admin.');
      if (String(req.body.otp || '').trim() !== ord.otp) { await q('UPDATE orders SET otp_tries=otp_tries+1 WHERE id=$1', [req.params.id]); fail('Wrong delivery OTP'); }
    }
  }
  const r = await pool.query("UPDATE orders SET status=$1 WHERE id=$2 AND driver_id=$3 AND status NOT IN ('Delivered','Cancelled')", [req.body.status, req.params.id, req.user.id]);
  if (!r.rowCount) fail('This order is not available to you');
  await q('INSERT INTO events(order_id,status) VALUES($1,$2)', [req.params.id, req.body.status]);
  notify(req.params.id, req.body.status); res.json({ ok: 1 });
}));
app.post('/api/driver/location', auth, drv, wrap(async (req, res) => {
  const lat = +req.body.lat, lng = +req.body.lng;
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail('Bad location');
  await q(`INSERT INTO driver_loc(driver_id,lat,lng,at) VALUES($1,$2,$3,${NOW}) ON CONFLICT (driver_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, at=EXCLUDED.at`, [req.user.id, lat, lng]);
  res.json({ ok: 1 });
}));

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('Courier app running on port ' + PORT)))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
