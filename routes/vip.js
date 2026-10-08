const express = require('express');
const { pool } = require('../db');
const router = express.Router();

function checkAdmin(req, res, next) {
  if (req.header('x-admin-password') !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'غير مصرح' });
  next();
}
// يلتقط أخطاء المسارات غير الملفوفة بـ try/catch حتى لا يتعطل الخادم
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); });

/* ---------- تحديد معدل الطلبات (يحدّ من تخمين البريد وقراءة بيانات الآخرين) ---------- */
const hits = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60000).unref();
function limit(max, windowMs) {
  return (req, res, next) => {
    const ip = String(req.header('x-forwarded-for') || req.ip || '').split(',')[0].trim();
    const key = ip + '|' + req.baseUrl + req.route.path;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    if (++h.n > max) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد قليل' });
    next();
  };
}

/* ---------- ترحيل قاعدة البيانات (آمن عند التكرار) ---------- */
pool.query(`ALTER TABLE vip_requests ADD COLUMN IF NOT EXISTS plan_days INTEGER DEFAULT 30`).catch(e => console.error('migrate plan_days', e.message));
pool.query(`ALTER TABLE vip_requests ADD COLUMN IF NOT EXISTS is_renewal BOOLEAN DEFAULT false`).catch(e => console.error('migrate is_renewal', e.message));

const PLAN_DAYS = [30, 90, 180, 365];
const ACTIVE_SQL = "v.status = 'accepted' AND (v.expires_at IS NULL OR v.expires_at > now())";

// العضو يضغط "طلب تدريب خاص" (أو تجديد) فيصل الطلب للمشرف
router.post('/request', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const m = await pool.query('SELECT id FROM members WHERE LOWER(email) = $1', [email]);
    if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
    // يُسمح بطلب تجديد قبل 7 أيام من انتهاء الاشتراك
    const open = await pool.query(
      `SELECT 1 FROM vip_requests WHERE member_id = $1 AND (status = 'pending'
        OR (status = 'accepted' AND (expires_at IS NULL OR expires_at > now() + interval '7 days')))`, [m.rows[0].id]);
    if (open.rows.length) return res.status(409).json({ error: 'لديك طلب قائم بالفعل' });
    const d = (req.body || {}).data || {};
    if (d.consent !== true) return res.status(400).json({ error: 'يجب الموافقة على الإقرار (18 سنة فأكثر، وليس استشارة طبية)' });
    const info = { phone: String(d.phone || '').slice(0, 40), sender: String(d.sender || '').slice(0, 100), receipt: parseInt(d.receipt, 10) || null, consent: true, consent_at: new Date().toISOString() };
    const wanted = parseInt(d.plan_days, 10);
    if (PLAN_DAYS.includes(wanted)) info.plan_days = wanted; // الباقة التي اختارها العضو (يؤكدها المشرف عند القبول)
    if (!info.phone || !info.sender) return res.status(400).json({ error: 'اكتب هاتفك واسم صاحب الحوالة' });
    const renewal = (await pool.query(`SELECT 1 FROM vip_requests v WHERE v.member_id = $1 AND v.status = 'accepted'`, [m.rows[0].id])).rows.length > 0;
    await pool.query('INSERT INTO vip_requests (member_id, data, is_renewal) VALUES ($1, $2, $3)', [m.rows[0].id, JSON.stringify(info), renewal]);
    res.json({ ok: true, renewal });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// رفع صورة وصل الدفع (عضو مسجّل)
router.post('/receipt', limit(20, 3600000), express.raw({ type: 'image/*', limit: '6mb' }), async (req, res) => {
  try {
    const email = String(req.header('x-member-email') || '').trim().toLowerCase();
    const m = await pool.query('SELECT 1 FROM members WHERE LOWER(email) = $1', [email]);
    if (!m.rows.length) return res.status(401).json({ error: 'سجّل دخولك أولاً' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'لا توجد صورة' });
    const mime = (req.header('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return res.status(400).json({ error: 'صيغة الصورة غير مدعومة' });
    const r = await pool.query('INSERT INTO vip_receipts (mime, data) VALUES ($1,$2) RETURNING id', [mime, req.body]);
    res.json({ id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// المشرف فقط: عرض صورة الوصل
router.get('/receipt/:id', checkAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  const r = await pool.query('SELECT mime, data FROM vip_receipts WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).end();
  res.set({ 'Content-Type': r.rows[0].mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
  res.send(r.rows[0].data);
}));

// بعد القبول: العضو يحفظ بياناته (الطول، الوزن، المستوى، العضلات...) ليراها المدرب
router.post('/profile', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const data = (req.body || {}).data;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'بيانات ناقصة' });
    if (data.age !== undefined && !(+data.age >= 18)) return res.status(400).json({ error: 'العمر الأدنى 18 سنة' });
    const js = JSON.stringify(data);
    if (js.length > 4000) return res.status(400).json({ error: 'بيانات كبيرة جداً' }); // بدل القص الذي كان يكسر الـ JSON
    const r = await pool.query(
      `UPDATE vip_requests SET data = data || $2::jsonb WHERE id = (
         SELECT v.id FROM vip_requests v JOIN members m ON m.id = v.member_id
         WHERE LOWER(m.email) = $1 AND v.status = 'accepted' ORDER BY v.id DESC LIMIT 1)`,
      [email, js]);
    if (!r.rowCount) return res.status(403).json({ error: 'طلبك لم يُقبل بعد' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// حالة آخر طلب للعضو
router.get('/mine/:email', limit(60, 60000), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT v.id, v.status, v.note, v.data, v.program, v.expires_at, v.plan_days, v.is_renewal FROM vip_requests v JOIN members m ON m.id = v.member_id
     WHERE LOWER(m.email) = $1 ORDER BY v.id DESC LIMIT 1`, [String(req.params.email).toLowerCase()]);
  const row = r.rows[0] || null;
  if (row) {
    const c = await pool.query('SELECT weight, note, reply, created_at FROM vip_checkins WHERE request_id = $1 ORDER BY id DESC LIMIT 20', [row.id]);
    row.checkins = c.rows;
  }
  res.json({ request: row });
}));

// العضو: متابعة أسبوعية (الوزن + ملاحظة)
router.post('/checkin', async (req, res) => {
  try {
    const b = req.body || {};
    const w = parseFloat(b.weight);
    if (!(w > 20 && w < 400)) return res.status(400).json({ error: 'وزن غير صالح' });
    const r = await pool.query(
      `SELECT v.id FROM vip_requests v JOIN members m ON m.id = v.member_id
       WHERE LOWER(m.email) = $1 AND ${ACTIVE_SQL}
       ORDER BY v.id DESC LIMIT 1`, [String(b.email || '').trim().toLowerCase()]);
    if (!r.rows.length) return res.status(403).json({ error: 'اشتراكك غير فعّال' });
    await pool.query('INSERT INTO vip_checkins (request_id, weight, note) VALUES ($1,$2,$3)', [r.rows[0].id, w, String(b.note || '').slice(0, 500)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// العضو: حفظ حصة تمرين (قائمة مجموعات: التمرين، الوزن، التكرارات)
router.post('/log', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `SELECT v.id FROM vip_requests v JOIN members m ON m.id = v.member_id
       WHERE LOWER(m.email) = $1 AND ${ACTIVE_SQL}
       ORDER BY v.id DESC LIMIT 1`, [String(b.email || '').trim().toLowerCase()]);
    if (!r.rows.length) return res.status(403).json({ error: 'اشتراكك غير فعّال' });
    const rows = (Array.isArray(b.entries) ? b.entries : []).slice(0, 40)
      .map(e => ({ ex: String((e || {}).ex || '').slice(0, 80), kg: parseFloat((e || {}).kg), reps: parseInt((e || {}).reps, 10) }))
      .filter(e => e.ex && e.kg >= 0 && e.kg <= 600 && e.reps > 0 && e.reps <= 100);
    if (!rows.length) return res.status(400).json({ error: 'بيانات غير صالحة' });
    for (const e of rows) await pool.query('INSERT INTO vip_logs (request_id, ex, kg, reps) VALUES ($1,$2,$3,$4)', [r.rows[0].id, e.ex, e.kg, e.reps]);
    res.json({ ok: true, saved: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ بالخادم' }); }
});

// العضو: سجله السابق (آخر 500 مجموعة، من الأقدم للأحدث)
router.get('/log/:email', limit(60, 60000), wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT l.ex, l.kg, l.reps, l.created_at FROM vip_logs l
     JOIN vip_requests v ON v.id = l.request_id JOIN members m ON m.id = v.member_id
     WHERE LOWER(m.email) = $1 ORDER BY l.id DESC LIMIT 500`, [String(req.params.email).toLowerCase()]);
  res.json({ entries: r.rows.reverse() });
}));

// العضو: ملخص أسبوعي ذكي (التزام، أرقام قياسية، حجم التدريب، تغيّر الوزن، الأيام المتبقية)
router.get('/summary/:email', limit(60, 60000), wrap(async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const q = await pool.query(
    `SELECT v.id, v.expires_at FROM vip_requests v JOIN members m ON m.id = v.member_id
     WHERE LOWER(m.email) = $1 AND v.status = 'accepted' ORDER BY v.id DESC LIMIT 1`, [email]);
  if (!q.rows.length) return res.json({ summary: null });
  const id = q.rows[0].id, exp = q.rows[0].expires_at;
  const logs = (await pool.query('SELECT ex, kg, reps, created_at FROM vip_logs WHERE request_id = $1 ORDER BY id ASC LIMIT 2000', [id])).rows;
  const cks = (await pool.query('SELECT weight, created_at FROM vip_checkins WHERE request_id = $1 ORDER BY id ASC', [id])).rows;
  const DAY = 864e5, now = Date.now();
  const day = d => new Date(d).toISOString().slice(0, 10);
  const inLast = (d, n) => now - new Date(d).getTime() <= n * DAY;
  const days7 = new Set(logs.filter(l => inLast(l.created_at, 7)).map(l => day(l.created_at)));
  const days30 = new Set(logs.filter(l => inLast(l.created_at, 30)).map(l => day(l.created_at)));
  const vol = (a, b) => Math.round(logs.filter(l => { const age = (now - new Date(l.created_at).getTime()) / DAY; return age > a && age <= b; }).reduce((s, l) => s + l.kg * l.reps, 0));
  // أفضل 1RM تقديري لكل تمرين، وهل تحقق هذا الأسبوع (رقم قياسي جديد)
  const best = {};
  logs.forEach(l => {
    const e1 = l.reps === 1 ? l.kg : l.kg * (1 + l.reps / 30);
    const o = best[l.ex] || (best[l.ex] = { ex: l.ex, e1rm: 0, prev: 0, recent: false });
    if (e1 > o.e1rm) { if (!inLast(l.created_at, 7)) o.prev = e1; o.e1rm = e1; o.recent = inLast(l.created_at, 7) && e1 > o.prev; }
  });
  const prs = Object.values(best).filter(o => o.recent && o.prev > 0).map(o => ({ ex: o.ex, e1rm: +o.e1rm.toFixed(1), gain: +(o.e1rm - o.prev).toFixed(1) }));
  const top = Object.values(best).sort((a, b) => b.e1rm - a.e1rm).slice(0, 5).map(o => ({ ex: o.ex, e1rm: +o.e1rm.toFixed(1) }));
  // أسابيع متتالية فيها 3 حصص على الأقل
  let streakWeeks = 0;
  for (let w = 0; w < 26; w++) {
    const n = new Set(logs.filter(l => { const age = (now - new Date(l.created_at).getTime()) / DAY; return age > w * 7 && age <= (w + 1) * 7; }).map(l => day(l.created_at))).size;
    if (n >= 3) streakWeeks++; else if (w > 0) break; // الأسبوع الجاري لا يكسر السلسلة قبل اكتماله
  }
  const lastCk = cks.length ? cks[cks.length - 1] : null;
  res.json({ summary: {
    sessions7: days7.size, sessions30: days30.size, streakWeeks,
    volumeThisWeek: vol(-1, 7), volumeLastWeek: vol(7, 14),
    prs, top,
    weightStart: cks.length ? +cks[0].weight : null, weightNow: lastCk ? +lastCk.weight : null,
    weightChange: cks.length > 1 ? +(lastCk.weight - cks[0].weight).toFixed(1) : null,
    daysSinceCheckin: lastCk ? Math.floor((now - new Date(lastCk.created_at).getTime()) / DAY) : null,
    daysLeft: exp ? Math.ceil((new Date(exp).getTime() - now) / DAY) : null
  } });
}));

// المشرف: كل الطلبات مع المتابعات وملخص الالتزام
router.get('/all', checkAdmin, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT v.id, v.status, v.note, v.data, v.program, v.expires_at, v.created_at, v.plan_days, v.is_renewal, m.name, m.email
     FROM vip_requests v JOIN members m ON m.id = v.member_id ORDER BY v.id DESC`);
  const ids = r.rows.map(x => x.id);
  const c = ids.length ? await pool.query('SELECT id, request_id, weight, note, reply, created_at FROM vip_checkins WHERE request_id = ANY($1) ORDER BY id DESC', [ids]) : { rows: [] };
  const g = ids.length ? await pool.query(
    `SELECT request_id, COUNT(DISTINCT created_at::date) FILTER (WHERE created_at > now() - interval '7 days') AS s7,
            to_char(MAX(created_at)::date, 'YYYY-MM-DD') AS last_log
     FROM vip_logs WHERE request_id = ANY($1) GROUP BY request_id`, [ids]) : { rows: [] };
  r.rows.forEach(x => {
    x.checkins = c.rows.filter(k => k.request_id === x.id);
    const k = g.rows.find(z => z.request_id === x.id);
    x.sessions7 = k ? +k.s7 : 0;
    x.last_log = k ? k.last_log : null;
  });
  res.json({ requests: r.rows });
}));

// المشرف: لوحة أرقام (قمع التحويل، التجديدات، الاشتراكات التي توشك على الانتهاء)
router.get('/stats', checkAdmin, wrap(async (req, res) => {
  const [mem, st, rn, exp, act] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM members'),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM vip_requests GROUP BY status`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE is_renewal AND status = 'accepted')::int AS renewed,
                       COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted FROM vip_requests`),
    pool.query(`SELECT COUNT(*)::int AS n FROM vip_requests v WHERE v.status = 'accepted' AND v.expires_at > now() AND v.expires_at <= now() + interval '7 days'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM vip_requests v WHERE ${ACTIVE_SQL}`)
  ]);
  const by = {}; st.rows.forEach(x => by[x.status] = x.n);
  const members = mem.rows[0].n, requested = (by.pending || 0) + (by.accepted || 0) + (by.rejected || 0);
  res.json({
    members, requests: requested, pending: by.pending || 0, accepted: by.accepted || 0, rejected: by.rejected || 0,
    activeNow: act.rows[0].n, expiringIn7Days: exp.rows[0].n, renewals: rn.rows[0].renewed,
    requestRatePct: members ? +(requested * 100 / members).toFixed(2) : 0,
    acceptRatePct: requested ? +((by.accepted || 0) * 100 / requested).toFixed(1) : 0
  });
}));

// المشرف: مشتركون نشطون في خطر الانسحاب (لا تمرين منذ 4 أيام أو لا متابعة منذ 9 أيام)
router.get('/at-risk', checkAdmin, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT v.id, m.name, m.email, v.data->>'phone' AS phone, v.expires_at,
            (SELECT MAX(created_at) FROM vip_logs l WHERE l.request_id = v.id) AS last_log,
            (SELECT MAX(created_at) FROM vip_checkins c WHERE c.request_id = v.id) AS last_checkin
     FROM vip_requests v JOIN members m ON m.id = v.member_id
     WHERE ${ACTIVE_SQL}`);
  const now = Date.now(), DAY = 864e5;
  const age = d => d ? Math.floor((now - new Date(d).getTime()) / DAY) : null;
  const rows = r.rows.map(x => ({ id: x.id, name: x.name, email: x.email, phone: x.phone, expires_at: x.expires_at, daysNoLog: age(x.last_log), daysNoCheckin: age(x.last_checkin) }))
    .filter(x => x.daysNoLog === null || x.daysNoLog >= 4 || x.daysNoCheckin === null || x.daysNoCheckin >= 9)
    .sort((a, b) => (b.daysNoLog === null ? 999 : b.daysNoLog) - (a.daysNoLog === null ? 999 : a.daysNoLog));
  res.json({ atRisk: rows });
}));

// المشرف: قبول أو رفض (القبول يفعّل الاشتراك: 30 / 90 / 180 / 365 يوماً، والتجديد يُضاف إلى المدة المتبقية)
router.post('/:id/decision', checkAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, note } = req.body || {};
  if (!Number.isInteger(id) || !['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'طلب غير صالح' });
  let days = parseInt((req.body || {}).days, 10);
  if (!PLAN_DAYS.includes(days)) days = 30;
  await pool.query(
    `UPDATE vip_requests SET status = $1, note = $2, plan_days = $4,
       expires_at = CASE WHEN $1 = 'accepted' THEN
         GREATEST(now(), COALESCE((SELECT MAX(o.expires_at) FROM vip_requests o
            WHERE o.member_id = vip_requests.member_id AND o.id <> vip_requests.id AND o.status = 'accepted'), now()))
         + make_interval(days => $4) ELSE NULL END
     WHERE id = $3`,
    [status, String(note || '').slice(0, 500), id, days]);
  res.json({ ok: true, days });
}));

// المشرف: كتابة برنامج العضو
router.post('/:id/program', checkAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('UPDATE vip_requests SET program = $1 WHERE id = $2', [String((req.body || {}).program || '').slice(0, 8000), id]);
  res.json({ ok: true });
}));

// المشرف: الرد على متابعة
router.post('/checkin/:cid/reply', checkAdmin, wrap(async (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  if (!Number.isInteger(cid)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('UPDATE vip_checkins SET reply = $1 WHERE id = $2', [String((req.body || {}).reply || '').slice(0, 1000), cid]);
  res.json({ ok: true });
}));

// المشرف: حذف متابعة
router.delete('/checkin/:cid', checkAdmin, wrap(async (req, res) => {
  const cid = parseInt(req.params.cid, 10);
  if (!Number.isInteger(cid)) return res.status(400).json({ error: 'طلب غير صالح' });
  await pool.query('DELETE FROM vip_checkins WHERE id = $1', [cid]);
  res.json({ ok: true });
}));

// المشرف: حذف مشترك VIP مع كل بياناته (المتابعات، سجل التمارين، الوصل، الرسائل الصوتية)
router.delete('/:id', checkAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'طلب غير صالح' });
  const r = await pool.query('SELECT data FROM vip_requests WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const receipt = parseInt((r.rows[0].data || {}).receipt, 10);
  await pool.query('DELETE FROM vip_checkins WHERE request_id = $1', [id]);
  await pool.query('DELETE FROM vip_logs WHERE request_id = $1', [id]);
  await pool.query('DELETE FROM voice_notes WHERE request_id = $1', [id]).catch(() => {});
  if (Number.isInteger(receipt)) await pool.query('DELETE FROM vip_receipts WHERE id = $1', [receipt]);
  await pool.query('DELETE FROM vip_requests WHERE id = $1', [id]);
  res.json({ ok: true });
}));

module.exports = router;
