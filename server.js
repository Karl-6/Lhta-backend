require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const passport = require('./passport-setup');
const { initDb } = require('./db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const planRoutes = require('./routes/plan');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render يعمل خلف بروكسي (مطلوب لحدّ المحاولات)

// CORS: نطاقك فقط. بدون FRONTEND_URL في الإنتاج = نفس الأصل فقط (الواجهة تُقدَّم من هذا الخادم نفسه)
const origins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(s => s.trim()) : null;
app.use(cors({
  origin: origins || (process.env.NODE_ENV === 'production' ? false : true),
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax' },
}));
app.use(passport.initialize());

// حدّ لمحاولات الدخول: 30 محاولة كل 15 دقيقة لكل عنوان
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول بعد قليل' } });
app.use('/api/auth', authLimiter);
app.use('/api/admin/login', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/plan', planRoutes);

// تُقدَّم الملفات من مجلد public فقط (وليس كل المشروع)
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`LHTA backend شغّال على المنفذ ${PORT}`));
  })
  .catch(err => {
    console.error('فشل الاتصال بقاعدة البيانات:', err);
    process.exit(1);
  });
