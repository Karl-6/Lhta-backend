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

module.exports = router;
