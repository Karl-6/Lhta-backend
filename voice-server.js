// voice-server.js — مسارات الرسائل الصوتية (Express + PostgreSQL)
// عدّل أسماء pool و vip_requests إن اختلفت عندك.
//
// الاستخدام في ملف الخادم الرئيسي، بعد تعريف app و pool:
//   require('./voice-server')(app, pool, process.env.ADMIN_PASSWORD);
//
// مهم: إن كان في الملف الرئيسي app.use(express.json()) قبل هذا السطر،
// ارفع حدّه ليصبح { limit: '2mb' } وإلا سيرجع الخادم 413 للرسائل الصوتية.
const express = require('express');

module.exports = function (app, pool, adminPassword) {
  const raw = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '6mb' });
  const json = express.json({ limit: '2mb' });
  const isAdmin = (req) => !!adminPassword && req.headers['x-admin-password'] === adminPassword;
  const memberOf = (req) => String(req.headers['x-member-email'] || '').trim().toLowerCase();

  pool.query(`CREATE TABLE IF NOT EXISTS voice_notes (
    id SERIAL PRIMARY KEY, request_id INT, email TEXT, mime TEXT,
    duration INT, data BYTEA, created_at TIMESTAMPTZ DEFAULT now())`)
    .then(() => pool.query("ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS from_role TEXT DEFAULT 'coach'"))
    .catch(console.error);

  // 1) المشرف يرسل رسالة صوتية لعضو (id = رقم طلب VIP) — ثنائي (من نافذة التسجيل عند المشرف)
  app.post('/api/plan/vip/:id/voice', raw, async (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty' });
      const r = await pool.query('SELECT email FROM vip_requests WHERE id=$1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const dur = Math.min(parseInt(req.query.d) || 0, 600);
      const ins = await pool.query(
        "INSERT INTO voice_notes(request_id,email,mime,duration,data,from_role) VALUES($1,$2,$3,$4,$5,'coach') RETURNING id",
        [req.params.id, r.rows[0].email, mime, dur, req.body]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });

  // 2) محادثة صوتية بين المدرب والعضو (JSON) — تستعملها الواجهة في voiceInit
  //    POST body: { email, audio: "data:audio/...;base64,...", duration }
  app.post('/api/plan/vip/voice', json, async (req, res) => {
    try {
      const b = req.body || {};
      const em = String(b.email || '').trim().toLowerCase();
      const admin = isAdmin(req);
      if (!em) return res.status(400).json({ error: 'email' });
      if (!admin && memberOf(req) !== em) return res.status(403).json({ error: 'forbidden' });
      const m = /^data:(audio\/[\w.+-]+)[^,]*;base64,([\s\S]+)$/i.exec(String(b.audio || ''));
      if (!m) return res.status(400).json({ error: 'bad audio' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) return res.status(400).json({ error: 'empty' });
      if (buf.length > 1.5 * 1024 * 1024) return res.status(413).json({ error: 'too big' });
      const dur = Math.max(0, Math.min(parseInt(b.duration) || 0, 600));
      const ins = await pool.query(
        'INSERT INTO voice_notes(email,mime,duration,data,from_role) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [em, m[1].toLowerCase(), dur, buf, admin ? 'coach' : 'member']);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });

  // 3) قائمة رسائل عضو (صندوق الوارد عند العضو)
  app.get('/api/plan/vip/voice/list/:email', async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT id,duration,created_at FROM voice_notes WHERE lower(email)=lower($1) AND COALESCE(from_role,'coach')='coach' ORDER BY id DESC LIMIT 30",
        [req.params.email]);
      res.json({ voices: r.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });

  // 4) مسار واحد لـ /voice/:key
  //    - رقم  => تنزيل رسالة (للعضو صاحبها أو للمشرف)
  //    - بريد => كل المحادثة الصوتية لهذا العضو { notes: [...] } من الأقدم للأحدث
  app.get('/api/plan/vip/voice/:key', async (req, res) => {
    try {
      const key = String(req.params.key || '');
      if (/^\d+$/.test(key)) {
        const r = await pool.query('SELECT email,mime,data FROM voice_notes WHERE id=$1', [key]);
        const v = r.rows[0];
        if (!v) return res.status(404).end();
        if (!isAdmin(req) && memberOf(req) !== String(v.email).toLowerCase()) return res.status(403).end();
        res.set('Content-Type', v.mime || 'audio/webm');
        return res.send(v.data);
      }
      const em = key.trim().toLowerCase();
      if (!isAdmin(req) && memberOf(req) !== em) return res.status(403).json({ error: 'forbidden' });
      const r = await pool.query(
        'SELECT id,duration,created_at,mime,data,from_role FROM voice_notes WHERE lower(email)=$1 ORDER BY id DESC LIMIT 15',
        [em]);
      const notes = r.rows.reverse().map((v) => ({
        id: v.id,
        from_role: v.from_role || 'coach',
        duration: v.duration || 0,
        created_at: v.created_at,
        audio: 'data:' + (v.mime || 'audio/webm') + ';base64,' + Buffer.from(v.data).toString('base64'),
      }));
      res.json({ notes });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });
};
