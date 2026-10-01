// voice-server.js — مسارات الرسائل الصوتية (Express + PostgreSQL)
// غير مجرَّب على خادمك: عدّل أسماء pool و vip_requests إن اختلفت عندك.
//
// الاستخدام في ملف الخادم الرئيسي، بعد تعريف app و pool:
//   require('./voice-server')(app, pool, process.env.ADMIN_PASSWORD);
const express = require('express');

module.exports = function (app, pool, adminPassword) {
  const raw = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '6mb' });
  const isAdmin = (req) => !!adminPassword && req.headers['x-admin-password'] === adminPassword;

  pool.query(`CREATE TABLE IF NOT EXISTS voice_notes (
    id SERIAL PRIMARY KEY, request_id INT, email TEXT, mime TEXT,
    duration INT, data BYTEA, created_at TIMESTAMPTZ DEFAULT now())`).catch(console.error);

  // المشرف يرسل رسالة صوتية لعضو (id = رقم طلب VIP)
  app.post('/api/plan/vip/:id/voice', raw, async (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty' });
      const r = await pool.query('SELECT email FROM vip_requests WHERE id=$1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const dur = Math.min(parseInt(req.query.d) || 0, 600);
      const ins = await pool.query(
        'INSERT INTO voice_notes(request_id,email,mime,duration,data) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [req.params.id, r.rows[0].email, mime, dur, req.body]);
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });

  // قائمة رسائل عضو
  app.get('/api/plan/vip/voice/list/:email', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id,duration,created_at FROM voice_notes WHERE lower(email)=lower($1) ORDER BY id DESC LIMIT 30',
        [req.params.email]);
      res.json({ voices: r.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
  });

  // تنزيل رسالة: للعضو صاحبها أو للمشرف
  app.get('/api/plan/vip/voice/:id', async (req, res) => {
    try {
      const r = await pool.query('SELECT email,mime,data FROM voice_notes WHERE id=$1', [req.params.id]);
      const v = r.rows[0];
      if (!v) return res.status(404).end();
      const who = String(req.headers['x-member-email'] || '').toLowerCase();
      if (!isAdmin(req) && who !== String(v.email).toLowerCase()) return res.status(403).end();
      res.set('Content-Type', v.mime || 'audio/webm');
      res.send(v.data);
    } catch (e) { console.error(e); res.status(500).end(); }
  });
};
