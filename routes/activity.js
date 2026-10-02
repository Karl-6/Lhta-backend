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

function checkAdmin(req, res, next) {
  if (req.header('x-admin-password') !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

// المشرف: تمديد اشتراك VIP بعدد أيام
router.post('/extend', checkAdmin, wrap(async (req, res) => {
  const id = parseInt((req.body || {}).id, 10), days = Math.min(parseInt((req.body || {}).days, 10) || 30, 365);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query(
    `UPDATE vip_requests SET status = 'accepted',
       expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($2 || ' days')::interval WHERE id = $1`, [id, String(days)]);
  res.json({ ok: true });
}));

// المشرف: منح تجربة VIP مجانية لعضو (لا تُمنح إن كان لديه اشتراك قائم)
router.post('/grant', checkAdmin, wrap(async (req, res) => {
  const mid = parseInt((req.body || {}).memberId, 10), days = Math.min(parseInt((req.body || {}).days, 10) || 7, 60);
  if (!Number.isInteger(mid)) return res.status(400).json({ error: 'طلب غير صالح' });
  const open = await pool.query(
    "SELECT 1 FROM vip_requests WHERE member_id = $1 AND (status = 'pending' OR (status = 'accepted' AND (expires_at IS NULL OR expires_at > now())))", [mid]);
  if (open.rows.length) return res.status(409).json({ error: 'لديه طلب قائم' });
  await pool.query(
    "INSERT INTO vip_requests (member_id, status, note, data, expires_at) VALUES ($1, 'accepted', 'تجربة مجانية', '{\"trial\":true}'::jsonb, now() + ($2 || ' days')::interval)",
    [mid, String(days)]);
  res.json({ ok: true });
}));

// ---------- تجربة VIP مجانية 7 أيام: تحقق برقم الهاتف (SMS) عبر Twilio Verify ----------
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
pool.query(`CREATE TABLE IF NOT EXISTS trial_phones (phone_hash TEXT PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT now())`).catch(console.error);

const smsLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول بعد قليل' } });
const twReady = () => process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID;

// أرقام الجزائر المحمولة فقط: 05/06/07 + 8 أرقام
function normPhone(v) {
  let p = String(v || '').replace(/[\s\-().]/g, '');
  if (/^0[567]\d{8}$/.test(p)) p = '+213' + p.slice(1);
  else if (/^213[567]\d{8}$/.test(p)) p = '+' + p;
  return /^\+213[567]\d{8}$/.test(p) ? p : null;
}
const phoneHash = p => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'lht').update(p).digest('hex');

async function twilio(path, params) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SID}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}

// فحوص مشتركة: عضو مسجّل، لم يستخدم تجربة/طلباً سابقاً، رقم صالح لم يُستخدم
async function trialChecks(req, res) {
  if (!twReady()) { res.status(503).json({ error: 'خدمة الرسائل غير مفعّلة بعد' }); return null; }
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const m = await pool.query('SELECT id FROM members WHERE LOWER(email) = $1', [email]);
  if (!m.rows.length) { res.status(401).json({ error: 'سجّل دخولك أولاً' }); return null; }
  const before = await pool.query('SELECT 1 FROM vip_requests WHERE member_id = $1', [m.rows[0].id]);
  if (before.rows.length) { res.status(409).json({ error: 'استخدمت التجربة أو لديك طلب سابق' }); return null; }
  const phone = normPhone((req.body || {}).phone);
  if (!phone) { res.status(400).json({ error: 'اكتب رقماً جزائرياً صحيحاً مثل 0555123456' }); return null; }
  const used = await pool.query('SELECT 1 FROM trial_phones WHERE phone_hash = $1', [phoneHash(phone)]);
  if (used.rows.length) { res.status(409).json({ error: 'هذا الرقم استخدم التجربة من قبل' }); return null; }
  return { memberId: m.rows[0].id, phone };
}

// 1) إرسال رمز التأكيد
router.post('/trial/send', smsLimiter, wrap(async (req, res) => {
  const c = await trialChecks(req, res); if (!c) return;
  const r = await twilio('Verifications', { To: c.phone, Channel: 'sms', Locale: 'ar' });
  if (!r.ok) { console.error('twilio send', r.j); return res.status(502).json({ error: 'تعذر إرسال الرمز، تأكد من الرقم' }); }
  res.json({ ok: true });
}));

// 2) تأكيد الرمز ثم تفعيل التجربة
router.post('/trial/verify', smsLimiter, wrap(async (req, res) => {
  const c = await trialChecks(req, res); if (!c) return;
  const code = String((req.body || {}).code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'رمز غير صالح' });
  const r = await twilio('VerificationCheck', { To: c.phone, Code: code });
  if (!(r.ok && r.j.status === 'approved')) return res.status(400).json({ error: 'الرمز غير صحيح أو منتهي' });
  const claim = await pool.query('INSERT INTO trial_phones (phone_hash) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1', [phoneHash(c.phone)]);
  if (!claim.rows.length) return res.status(409).json({ error: 'هذا الرقم استخدم التجربة من قبل' });
  await pool.query(
    "INSERT INTO vip_requests (member_id, status, note, data, expires_at) VALUES ($1, 'accepted', 'تجربة مجانية', $2::jsonb, now() + interval '7 days')",
    [c.memberId, JSON.stringify({ trial: true, phone: c.phone, phone_verified: true })]);
  res.json({ ok: true });
}));

module.exports = router;
