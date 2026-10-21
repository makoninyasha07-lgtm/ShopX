require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Paynow } = require('paynow');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const seedProducts = [
 [1,'Everyday sneakers',32,'Fashion','👟','Comfortable everyday sneakers with a clean look.','Urban Finds'],
 [2,'Wireless headphones',24.5,'Electronics','🎧','Enjoy your favourite music wherever you go.','Sound Corner'],
 [3,'Minimal wristwatch',19.99,'Fashion','⌚','A timeless accessory for everyday outfits.','Urban Finds'],
 [4,'Daily skincare set',16,'Beauty','🧴','A simple self-care set for your daily routine.','Glow Market'],
 [5,'Desk plant',8.5,'Home','🪴','Add a little green to your workspace.','Home & More'],
 [6,'Everyday backpack',27,'Fashion','🎒','A versatile bag for work, school, and weekends.','Urban Finds'],
 [7,'Smartphone stand',7.99,'Electronics','📱','Keep your phone handy on your desk.','Tech Nest'],
 [8,'Training football',14,'Sports','⚽','Ready for practice and friendly matches.','Active Life']
];
let paynow = null;
if (process.env.PAYNOW_INTEGRATION_ID && process.env.PAYNOW_INTEGRATION_KEY) {
  paynow = new Paynow(process.env.PAYNOW_INTEGRATION_ID, process.env.PAYNOW_INTEGRATION_KEY);
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing.');
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(12,2) NOT NULL CHECK (price > 0),
    category TEXT NOT NULL, emoji TEXT, description TEXT, store_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, status_token TEXT UNIQUE, email TEXT, amount NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', poll_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ
  )`);
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_token TEXT UNIQUE');
  await pool.query(`CREATE TABLE IF NOT EXISTS order_items (
    id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL, name TEXT NOT NULL, unit_price NUMERIC(12,2) NOT NULL, quantity INTEGER NOT NULL
  )`);
  for (const p of seedProducts) await pool.query(
    `INSERT INTO products(id,name,price,category,emoji,description,store_name) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`, p
  );
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, paymentsConfigured: !!paynow }); }
  catch { res.status(503).json({ ok: false, error: 'Database is not ready.' }); }
});
app.get('/api/products', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,name,price,category,emoji,description AS desc,store_name AS store FROM products WHERE active=TRUE ORDER BY id');
    res.json(rows);
  } catch { res.status(503).json({ error: 'Products are temporarily unavailable.' }); }
});

app.post('/api/checkout', async (req, res) => {
  if (!paynow) return res.status(503).json({ error: 'Paynow is not configured yet. The site owner must add merchant API credentials.' });
  if (!appUrl || !/^https:\/\//i.test(appUrl)) return res.status(503).json({ error: 'APP_URL must be the public HTTPS website URL.' });
  const items = req.body && req.body.items;
  const email = String(req.body?.email || '').trim().slice(0, 254);
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return res.status(400).json({ error: 'Cart is empty or invalid.' });
  const normalized = new Map();
  for (const item of items) {
    const productId = Number(item.productId), quantity = Number(item.quantity);
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: 'Invalid cart item.' });
    normalized.set(productId, (normalized.get(productId) || 0) + quantity);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [...normalized.keys()];
    const { rows: products } = await client.query('SELECT id,name,price FROM products WHERE active=TRUE AND id=ANY($1::int[])', [ids]);
    if (products.length !== ids.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'One or more products are unavailable. Refresh the page and try again.' }); }
    const total = products.reduce((sum, p) => sum + Number(p.price) * normalized.get(p.id), 0);
    if (!Number.isFinite(total) || total <= 0 || total > 100000) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid order total.' }); }
    const reference = `SX-${crypto.randomUUID().replace(/-/g,'').slice(0,20).toUpperCase()}`;
    const statusToken = crypto.randomUUID();
    const orderResult = await client.query('INSERT INTO orders(reference,status_token,email,amount,status) VALUES($1,$2,$3,$4,\'pending\') RETURNING id', [reference, statusToken, email || null, total.toFixed(2)]);
    const orderId = orderResult.rows[0].id;
    for (const p of products) await client.query('INSERT INTO order_items(order_id,product_id,name,unit_price,quantity) VALUES($1,$2,$3,$4,$5)', [orderId,p.id,p.name,p.price,normalized.get(p.id)]);
    await client.query('COMMIT');

    const payment = paynow.createPayment(reference, email || undefined);
    for (const p of products) payment.add(`${p.name} x${normalized.get(p.id)}`, Number(p.price) * normalized.get(p.id));
    paynow.resultUrl = `${appUrl}/api/paynow/result`;
    paynow.returnUrl = `${appUrl}/payment-return?token=${encodeURIComponent(statusToken)}`;
    const response = await paynow.send(payment);
    if (!response || !response.success || !response.redirectUrl || !response.pollUrl) {
      await pool.query('UPDATE orders SET status=$1 WHERE id=$2', ['payment_init_failed', orderId]);
      return res.status(502).json({ error: 'Paynow could not start the payment. Please try again later.' });
    }
    await pool.query('UPDATE orders SET poll_url=$1 WHERE id=$2', [response.pollUrl, orderId]);
    return res.json({ orderId: String(orderId), redirectUrl: response.redirectUrl });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Checkout error:', err.message);
    return res.status(502).json({ error: 'Could not create checkout. Please try again.' });
  } finally { client.release(); }
});

async function refreshPayment(orderId) {
  const { rows } = await pool.query('SELECT id,status,poll_url FROM orders WHERE id=$1', [orderId]);
  if (!rows.length) return null;
  const order = rows[0];
  if (order.status === 'paid' || !order.poll_url || !paynow) return order;
  try {
    const status = await paynow.pollTransaction(order.poll_url);
    if (status && typeof status.paid === 'function' && status.paid()) {
      await pool.query("UPDATE orders SET status='paid', paid_at=NOW() WHERE id=$1 AND status<>'paid'", [order.id]);
    } else if (status && typeof status.cancelled === 'function' && status.cancelled()) {
      await pool.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending'", [order.id]);
    }
  } catch (err) { console.error('Paynow status check failed:', err.message); }
  const latest = await pool.query('SELECT id,status,amount,reference FROM orders WHERE id=$1', [orderId]);
  return latest.rows[0] || null;
}
app.get('/api/payment-status/:token', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.token)) return res.status(400).json({ error: 'Invalid order token.' });
  try {
    const found = await pool.query('SELECT id FROM orders WHERE status_token=$1', [req.params.token]);
    if (!found.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = await refreshPayment(found.rows[0].id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ orderId: String(order.id), status: order.status, amount: order.amount == null ? undefined : Number(order.amount) });
  } catch { res.status(503).json({ error: 'Unable to check payment status right now.' }); }
});
// Paynow posts a result notification here. Treat it only as a signal; verify payment via Paynow's poll URL.
app.post('/api/paynow/result', async (req, res) => {
  res.status(200).send('OK');
  const reference = String(req.body?.reference || req.body?.merchantReference || '').trim();
  if (reference) {
    try {
      const found = await pool.query('SELECT id FROM orders WHERE reference=$1', [reference]);
      if (found.rows[0]) await refreshPayment(found.rows[0].id);
    } catch (err) { console.error('Paynow result follow-up failed:', err.message); }
  }
});
app.get('/payment-return', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-return.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => app.listen(port, () => console.log(`ShopX running on port ${port}`))).catch(err => {
  console.error('ShopX startup failed:', err.message);
  process.exit(1);
});
