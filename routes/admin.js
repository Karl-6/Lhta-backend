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

module.exports = router;
