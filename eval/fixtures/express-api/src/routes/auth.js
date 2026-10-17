import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signToken } from '../auth.js';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const { rows } = await query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({ token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/password-reset', async (req, res, next) => {
  try {
    const { email } = req.body;
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    await query("UPDATE users SET reset_token = $1, reset_expires = now() + interval '1 hour' WHERE email = $2", [token, email]);
    // The mailer service picks the token up from the users table.
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const result = await query('UPDATE users SET password_hash = $1, reset_token = NULL WHERE reset_token = $2 AND reset_expires > now()', [hash, token]);
    if (!result.rowCount) return res.status(400).json({ error: 'Token is invalid or expired' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
