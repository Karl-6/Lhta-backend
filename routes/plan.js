const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function checkAdmin(req, res, next) {
  const pass = req.header('x-admin-password');
  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  next();
}

// أي زائر يقدر يقرأ الخطة (تظهر فقط للمسجّلين من واجهة الموقع)
// فحص حياة الخادم (لخدمات مثل UptimeRobot): GET /api/plan/health
router.get('/health', (req, res) => res.json({ ok: true }));

router.get('/', async (req, res) => {
  const result = await pool.query('SELECT data FROM plan_data WHERE id = 1');
  res.json({ plan: result.rows[0] ? result.rows[0].data : null });
});

// فقط الإدمن يقدر يحفظ تعديلات الخطة
router.post('/', checkAdmin, async (req, res) => {
  const { plan } = req.body;
  await pool.query(
    `INSERT INTO plan_data (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = $1`,
    [plan]
  );
  res.json({ ok: true });
});

// ---------- صور التمارين ----------
// رفع صورة (المشرف فقط) - تُرسل كملف خام (image/jpeg مثلاً) وليس JSON
router.post('/image', checkAdmin, express.raw({ type: 'image/*', limit: '8mb' }), async (req, res) => {
    console.error(err);
    res.status(500).json({ error: 'خطأ بالخادم' });
  }
});

// عرض الصورة (للجميع - تظهر داخل خطة التمارين)
router.get('/image/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  const result = await pool.query('SELECT mime, data FROM exercise_images WHERE id = $1', [id]);
  if (result.rows.length === 0) return res.status(404).end();
  res.set('Content-Type', result.rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(result.rows[0].data);
});

// حذف صورة (المشرف فقط)
router.delete('/image/:id', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'رقم غير صالح' });
  await pool.query('DELETE FROM exercise_images WHERE id = $1', [id]);
  res.json({ ok: true });
});

// المفضلات (الوصفات المحفوظة) لكل مستخدم
router.get('/favorites/:email', async (req, res) => {
  const result = await pool.query('SELECT recipe_id FROM favorites WHERE email = $1', [req.params.email]);
  res.json({ favorites: result.rows.map(r => r.recipe_id) });
});

router.post('/favorites/toggle', async (req, res) => {
  const { email, recipeId } = req.body;
  const existing = await pool.query('SELECT 1 FROM favorites WHERE email=$1 AND recipe_id=$2', [email, recipeId]);
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM favorites WHERE email=$1 AND recipe_id=$2', [email, recipeId]);
  } else {
    await pool.query('INSERT INTO favorites (email, recipe_id) VALUES ($1,$2)', [email, recipeId]);
  }
  const result = await pool.query('SELECT recipe_id FROM favorites WHERE email = $1', [email]);
  res.json({ favorites: result.rows.map(r => r.recipe_id) });
});

// متابعة وزن العضو
router.get('/progress/:email', async (req, res) => {
  const r = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, weight FROM progress_logs WHERE LOWER(email) = $1 ORDER BY day", [String(req.params.email).toLowerCase()]);
  res.json({ entries: r.rows });
});
router.post('/progress', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const weight = parseFloat((req.body || {}).weight);
  const day = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).day) ? req.body.day : new Date().toISOString().slice(0, 10);
  if (!isFinite(weight) || weight < 20 || weight > 400) return res.status(400).json({ error: 'وزن غير صالح' });
  const m = await pool.query('SELECT 1 FROM members WHERE LOWER(email) = $1', [email]);
  if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
  await pool.query('INSERT INTO progress_logs (email, day, weight) VALUES ($1,$2,$3) ON CONFLICT (email, day) DO UPDATE SET weight = $3', [email, day, weight]);
  res.json({ ok: true });
});

router.use('/vip', require('./vip'));

module.exports = router;
