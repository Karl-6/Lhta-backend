const { Pool } = require('pg');

// DATABASE_URL يُؤخذ تلقائيًا من متغيرات البيئة على Render بعد ربط قاعدة PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT,               -- كلمة المرور نص عادي (فقط لمن يسجّل بالإيميل) - بقرار صاحب المنصة
      provider TEXT NOT NULL DEFAULT 'Email',
      provider_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plan_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      email TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      PRIMARY KEY (email, recipe_id)
    );
  `);
}

module.exports = { pool, initDb };
