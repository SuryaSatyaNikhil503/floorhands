import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { formatCents } from '../util.js';

const router = Router();

router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, status, total_cents, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows.map(o => ({ ...o, total: formatCents(o.total_cents) })));
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, user_id, status, total_cents, ship_to, created_at FROM orders WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ ...rows[0], total: formatCents(rows[0].total_cents) });
  } catch (err) {
    next(err);
  }
});

router.post('/orders', requireAuth, async (req, res, next) => {
  try {
    const { items, shipTo } = req.body;
    if (!Array.isArray(items) || !items.length || !shipTo) return res.status(400).json({ error: 'items and shipTo are required' });
    let total = 0;
    for (const item of items) {
      const { rows } = await query('SELECT price_cents FROM products WHERE id = $1', [item.productId]);
      if (!rows.length) return res.status(400).json({ error: `Unknown product ${item.productId}` });
      total += rows[0].price_cents * item.quantity;
    }
    const created = await query('INSERT INTO orders (user_id, total_cents, ship_to) VALUES ($1, $2, $3) RETURNING id', [req.user.id, total, shipTo]);
    res.status(201).json({ id: created.rows[0].id, total: formatCents(total) });
  } catch (err) {
    next(err);
  }
});

export default router;
