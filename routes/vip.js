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
    const open = await pool.query("SELECT 1 FROM vip_requests WHERE member_id = $1 AND (status = 'pending' OR (status = 'accepted' AND (expires_at IS NULL OR expires_at > now())))", [m.rows[0].id]);
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
    `SELECT v.id, v.status, v.note, v.data, v.program, v.expires_at FROM vip_requests v JOIN members m ON m.id = v.member_id
     WHERE LOWER(m.email) = $1 ORDER BY v.id DESC LIMIT 1`, [String(req.params.email).toLowerCase()]);
  const row = r.rows[0] || null;
  if (row) {
    const c = await pool.query('SELECT weight, note, reply, created_at FROM vip_checkins WHERE request_id = $1 ORDER BY id DESC LIMIT 20', [row.id]);
    row.checkins = c.rows;
  }
  res.json({ request: row });
});

// العضو: متابعة أسبوعية (الوزن + ملاحظة)
router.post('/checkin', async (req, res) => {
  try {
    const b = req.body || {};
    const w = parseFloat(b.weight);
    if (!(w > 20 && w < 400)) return res.status(400).json({ error: 'وزن غير صالح' });
    const r = await pool.query(
      `SELECT v.id FROM vip_requests v JOIN members m ON m.id = v.member_id
       WHERE LOWER(m.email) = $1 AND v.status = 'accepted' AND (v.expires_at IS NULL OR v.expires_at > now())
       ORDER BY v.id DESC LIMIT 1`, [String(b.email || '').trim().toLowerCase()]);
    if (!r.rows.length) return res.status(403).json({ error: 'اشتراكك غير فعّال' });
    await pool.query('INSERT INTO vip_checkins (request_id, weight, note) VALUES ($1,$2,$3)', [r.rows[0].id, w, String(b.note || '').slice(0, 500)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// المشرف: كل الطلبات مع المتابعات
router.get('/all', checkAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT v.id, v.status, v.note, v.data, v.program, v.expires_at, v.created_at, m.name, m.email
     FROM vip_requests v JOIN members m ON m.id = v.member_id ORDER BY v.id DESC`);
  const ids = r.rows.map(x => x.id);
  const c = ids.length ? await pool.query('SELECT id, request_id, weight, note, reply, created_at FROM vip_checkins WHERE request_id = ANY($1) ORDER BY id DESC', [ids]) : { rows: [] };
  r.rows.forEach(x => { x.checkins = c.rows.filter(k => k.request_id === x.id); });
  res.json({ requests: r.rows });
});

// المشرف: قبول أو رفض (القبول يفعّل اشتراك 30 يوماً)
router.post('/:id/decision', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, note } = req.body || {};
  if (!Number.isInteger(id) || !['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query(
    "UPDATE vip_requests SET status = $1, note = $2, expires_at = CASE WHEN $1 = 'accepted' THEN now() + interval '30 days' ELSE NULL END WHERE id = $3",
    [status, String(note || '').slice(0, 500), id]);
  res.json({ ok: true });
});

// المشرف: كتابة برنامج العضو
router.post('/:id/program', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('UPDATE vip_requests SET program = $1 WHERE id = $2', [String((req.body || {}).program || '').slice(0, 8000), id]);
  res.json({ ok: true });
});

// المشرف: الرد على متابعة
router.post('/checkin/:cid/reply', checkAdmin, async (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  if (!Number.isInteger(cid)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('UPDATE vip_checkins SET reply = $1 WHERE id = $2', [String((req.body || {}).reply || '').slice(0, 1000), cid]);
  res.json({ ok: true });
});

module.exports = router;
