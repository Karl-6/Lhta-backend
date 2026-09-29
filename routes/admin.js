const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function checkAdmin(req, res, next) {
  const pass = req.header('x-admin-password');
  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'كلمة مرور غير صحيحة' });
  }
  next();
}

// تسجيل دخول المشرف (يتحقق فقط من كلمة السر)
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'كلمة مرور غير صحيحة' });
  }
  res.json({ ok: true });
});

// عرض كل الأعضاء بكل بياناتهم (بما فيها كلمة المرور كنص عادي - بقرار صاحب المنصة)
router.get('/members', checkAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, password, provider, created_at FROM members ORDER BY created_at DESC'
  );
  res.json({ members: result.rows });
});

// حذف عضو (مع مفضلاته)
router.delete('/members/:id', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'رقم غير صالح' });
  try {
    const found = await pool.query('SELECT email FROM members WHERE id = $1', [id]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'العضو غير موجود' });
    await pool.query('DELETE FROM favorites WHERE email = $1', [found.rows[0].email]);
    await pool.query('DELETE FROM members WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ بالخادم' });
  }
});

module.exports = router;
