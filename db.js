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
      password TEXT,
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

  await pool.query(`ALTER TABLE vip_requests ADD COLUMN IF NOT EXISTS program TEXT`);
  await pool.query(`ALTER TABLE vip_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_checkins (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      weight NUMERIC(5,1) NOT NULL,
      note TEXT,
      reply TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  // سجل التمرين: كل مجموعة مسجّلة (الوزن × التكرارات)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_logs (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      ex TEXT NOT NULL,
      kg NUMERIC(6,1) NOT NULL,
      reps INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS vip_logs_req_idx ON vip_logs (request_id, created_at)`);

  // وصولات الدفع: جدول خاص (لا يُعرض علنًا مثل صور التمارين)
  await pool.query(`CREATE TABLE IF NOT EXISTS vip_receipts (id SERIAL PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_flags (k TEXT PRIMARY KEY)`);
  // ترحيل الوصولات القديمة من exercise_images مرة واحدة فقط، ثم حذفها من الجدول العلني
  const mig = await pool.query(`SELECT 1 FROM app_flags WHERE k = 'receipts_migrated'`);
  if (!mig.rows.length) {
    await pool.query(`INSERT INTO vip_receipts (id, mime, data, created_at)
      SELECT i.id, i.mime, i.data, i.created_at FROM exercise_images i
      WHERE i.id IN (SELECT (data->>'receipt')::int FROM vip_requests WHERE data->>'receipt' ~ '^[0-9]+$')
      ON CONFLICT (id) DO NOTHING`);
    await pool.query(`SELECT setval(pg_get_serial_sequence('vip_receipts','id'),
      GREATEST((SELECT COALESCE(MAX(id),0) FROM vip_receipts), (SELECT COALESCE(MAX(id),0) FROM exercise_images)) + 1, false)`);
    await pool.query(`DELETE FROM exercise_images WHERE id IN (SELECT id FROM vip_receipts)`);
    await pool.query(`INSERT INTO app_flags (k) VALUES ('receipts_migrated')`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress_logs (
      email TEXT NOT NULL,
      day DATE NOT NULL,
      weight NUMERIC(5,1) NOT NULL,
      PRIMARY KEY (email, day)
    );
  `);
}

module.exports = { pool, initDb };
