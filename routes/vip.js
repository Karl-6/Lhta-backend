const express = require('express');
const { pool } = require('../db');
const router = express.Router();

function checkAdmin(req, res, next) {
  if (req.header('x-admin-password') !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

// العضو يضغط "طلب تدريب خاص" فيصل الطلب للمشرف
router.post('/request', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const m = await pool.query('SELECT id FROM members WHERE LOWER(email) = $1', [email]);
    if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
    const open = await pool.query("SELECT 1 FROM vip_requests WHERE member_id = $1 AND status IN ('pending','accepted')", [m.rows[0].id]);
    if (open.rows.length) return res.status(409).json({ error: 'لديك طلب قائم بالفعل' });
    const d = (req.body || {}).data || {};
    const info = { phone: String(d.phone || '').slice(0, 40), sender: String(d.sender || '').slice(0, 100), receipt: parseInt(d.receipt, 10) || null };
    if (!info.phone || !info.sender) return res.status(400).json({ error: 'اكتب هاتفك واسم صاحب الحوالة' });
    await pool.query('INSERT INTO vip_requests (member_id, data) VALUES ($1, $2)', [m.rows[0].id, JSON.stringify(info)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// رفع صورة وصل الدفع (عضو مسجّل)
router.post('/receipt', express.raw({ type: 'image/*', limit: '6mb' }), async (req, res) => {
  try {
    const email = String(req.header('x-member-email') || '').trim().toLowerCase();
    const m = await pool.query('SELECT 1 FROM members WHERE LOWER(email) = $1', [email]);
    if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'لا توجد صورة' });
    const mime = (req.header('content-type') || 'image/jpeg').split(';')[0];
    const r = await pool.query('INSERT INTO exercise_images (mime, data) VALUES ($1,$2) RETURNING id', [mime, req.body]);
    res.json({ id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// بعد القبول: العضو يحفظ بياناته (الطول، الوزن...) ليراها المدرب
router.post('/profile', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const data = (req.body || {}).data;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'بيانات ناقصة' });
    const r = await pool.query(
      `UPDATE vip_requests SET data = data || $2::jsonb WHERE id = (
         SELECT v.id FROM vip_requests v JOIN members m ON m.id = v.member_id
         WHERE LOWER(m.email) = $1 AND v.status = 'accepted' ORDER BY v.id DESC LIMIT 1)`,
      [email, JSON.stringify(data).slice(0, 4000)]);
    if (!r.rowCount) return res.status(403).json({ error: 'طلبك لم يُقبل بعد' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// حالة آخر طلب للعضو
router.get('/mine/:email', async (req, res) => {
  const r = await pool.query(
    `SELECT v.status, v.note, v.data FROM vip_requests v JOIN members m ON m.id = v.member_id
     WHERE LOWER(m.email) = $1 ORDER BY v.id DESC LIMIT 1`, [String(req.params.email).toLowerCase()]);
  res.json({ request: r.rows[0] || null });
});

// المشرف: كل الطلبات
router.get('/all', checkAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT v.id, v.status, v.note, v.data, v.created_at, m.name, m.email
     FROM vip_requests v JOIN members m ON m.id = v.member_id ORDER BY v.id DESC`);
  res.json({ requests: r.rows });
});

// المشرف: قبول أو رفض
router.post('/:id/decision', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, note } = req.body || {};
  if (!Number.isInteger(id) || !['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('UPDATE vip_requests SET status = $1, note = $2 WHERE id = $3', [status, String(note || '').slice(0, 500), id]);
  res.json({ ok: true });
});

module.exports = router;
