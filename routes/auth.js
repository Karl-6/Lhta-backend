const express = require('express');
const passport = require('passport');
const { pool } = require('../db');

const router = express.Router();

// ---------- تسجيل بالإيميل ----------
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'عبّي كل الحقول من فضلك' });
  }
  try {
    const exists = await pool.query('SELECT id FROM members WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'هذا الإيميل مسجّل مسبقًا' });
    }
    const result = await pool.query(
      `INSERT INTO members (name, email, password, provider) VALUES ($1,$2,$3,'Email')
       RETURNING id, name, email, provider, created_at`,
      [name, email.toLowerCase(), password]
    );
    req.session.user = result.rows[0];
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ بالخادم' });
  }
});

// ---------- دخول بالإيميل ----------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, name, email, provider, created_at FROM members WHERE email = $1 AND password = $2',
      [(email || '').toLowerCase(), password]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'الإيميل أو كلمة المرور غير صحيحة' });
    }
    req.session.user = result.rows[0];
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ بالخادم' });
  }
});

// ---------- من أنا؟ ----------
router.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- خروج ----------
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Google OAuth ----------
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/' }),
  (req, res) => {
    // الواجهة (lhta.html) قد تكون مستضافة على أي رابط، لذلك نمرر بيانات المستخدم
    // عبر رابط إعادة التوجيه نفسه بدلاً من الاعتماد على كوكيز الجلسة
    const userParam = encodeURIComponent(JSON.stringify(req.user));
    res.redirect(`${process.env.FRONTEND_URL || '/'}?oauth_user=${userParam}`);
  }
);

// ---------- Facebook OAuth (يغطي أيضًا حسابات Instagram Business المرتبطة بصفحة فيسبوك) ----------
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));

router.get(
  '/facebook/callback',
  passport.authenticate('facebook', { session: false, failureRedirect: '/' }),
  (req, res) => {
    const userParam = encodeURIComponent(JSON.stringify(req.user));
    res.redirect(`${process.env.FRONTEND_URL || '/'}?oauth_user=${userParam}`);
  }
);

module.exports = router;
