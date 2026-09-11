
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const passport = require('./passport-setup');
const { initDb } = require('./db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const planRoutes = require('./routes/plan');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
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

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/plan', planRoutes);

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`LHTA backend شغّال على المنفذ ${PORT}`));
  })
  .catch(err => {
    console.error('فشل الاتصال بقاعدة البيانات:', err);
    process.exit(1);
  });
