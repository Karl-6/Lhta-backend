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

// حذف عضو مع كل بياناته (طلبات VIP، المتابعات، سجل التمارين، الوصلات، التقدّم، المفضلات)
router.delete('/members/:id', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'رقم غير صالح' });
  try {
    const found = await pool.query('SELECT email FROM members WHERE id = $1', [id]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'العضو غير موجود' });
    const email = found.rows[0].email;
    const reqs = await pool.query('SELECT id, data FROM vip_requests WHERE member_id = $1', [id]);
    for (const q of reqs.rows) {
      await pool.query('DELETE FROM vip_checkins WHERE request_id = $1', [q.id]);
      await pool.query('DELETE FROM vip_logs WHERE request_id = $1', [q.id]);
      await pool.query('DELETE FROM voice_notes WHERE request_id = $1', [q.id]).catch(() => {});
      const rc = parseInt((q.data || {}).receipt, 10);
      if (Number.isInteger(rc)) await pool.query('DELETE FROM vip_receipts WHERE id = $1', [rc]);
    }
    await pool.query('DELETE FROM vip_requests WHERE member_id = $1', [id]);
    await pool.query('DELETE FROM progress_logs WHERE LOWER(email) = LOWER($1)', [email]);
    await pool.query('DELETE FROM favorites WHERE email = $1', [email]);
    await pool.query('DELETE FROM members WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ بالخادم' });
  }
});

// إحصائيات سريعة للمشرف
router.get('/stats', checkAdmin, async (req, res) => {
  const n = async (sql) => +(await pool.query(sql)).rows[0].n;
  res.json({
    members: await n('SELECT COUNT(*) n FROM members'),
    week: await n("SELECT COUNT(*) n FROM members WHERE created_at > now() - interval '7 days'"),
    pending: await n("SELECT COUNT(*) n FROM vip_requests WHERE status = 'pending'"),
    accepted: await n("SELECT COUNT(*) n FROM vip_requests WHERE status = 'accepted'"),
    total: await n('SELECT COUNT(*) n FROM vip_requests'),
  });
});

module.exports = router;
