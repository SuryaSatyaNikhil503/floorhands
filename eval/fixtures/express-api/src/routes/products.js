import { Router } from 'express';
import { query } from '../db.js';
import { parsePage } from '../util.js';

const router = Router();

router.get('/products', async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    const { rows } = await query('SELECT id, name, price_cents FROM products ORDER BY id LIMIT 20 OFFSET $1', [(page - 1) * 20]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/products/search', async (req, res, next) => {
  try {
    const term = req.query.q || '';
    const sql = "SELECT id, name, description, price_cents FROM products WHERE name ILIKE '%" + term + "%' OR description ILIKE '%" + term + "%' ORDER BY name";
    const { rows } = await query(sql);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
