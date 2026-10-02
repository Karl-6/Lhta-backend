const express = require('express');
const { pool } = require('../db');
const router = express.Router();

pool.query(`CREATE TABLE IF NOT EXISTS member_activity (
  email TEXT NOT NULL, day DATE NOT NULL, PRIMARY KEY (email, day))`).catch(console.error);

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); });

// تسجيل تمرين اليوم (عضو مسجّل)
router.post('/', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const m = await pool.query('SELECT 1 FROM members WHERE LOWER(email) = $1', [email]);
  if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
  let day = String((req.body || {}).day || '');
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(day) && Math.abs(new Date(day) - Date.now()) < 2 * 86400000;
  if (!ok) day = new Date().toISOString().slice(0, 10);
  await pool.query('INSERT INTO member_activity (email, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [email, day]);
  res.json({ ok: true });
}));

// لوحة الصدارة الأسبوعية (الاسم الأول فقط)
router.get('/leaderboard', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT m.name, COUNT(*) AS days FROM member_activity a JOIN members m ON LOWER(m.email) = a.email
     WHERE a.day > current_date - 7 GROUP BY m.id, m.name ORDER BY days DESC, m.name LIMIT 10`);
  res.json({ board: r.rows.map(x => ({ name: String(x.name || '').split(' ')[0], days: +x.days })) });
}));

// أيام نشاط العضو (آخر 120 يوماً)
router.get('/:email', wrap(async (req, res) => {
  const r = await pool.query(
    "SELECT to_char(day,'YYYY-MM-DD') AS day FROM member_activity WHERE email = $1 AND day > current_date - 120 ORDER BY day",
    [String(req.params.email).toLowerCase()]);
  res.json({ days: r.rows.map(x => x.day) });
}));

module.exports = router;
