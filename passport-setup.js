const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { pool } = require('./db');

async function upsertOAuthMember({ name, email, provider, providerId }) {
  const existing = await pool.query('SELECT id, name, email, provider, created_at FROM members WHERE email = $1', [email]);
  if (existing.rows.length > 0) return existing.rows[0];
  const result = await pool.query(
    `INSERT INTO members (name, email, password, provider, provider_id) VALUES ($1,$2,NULL,$3,$4)
     RETURNING id, name, email, provider, created_at`,
    [name, email, provider, providerId]
  );
  return result.rows[0];
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : `${profile.id}@google.lhta`;
      const member = await upsertOAuthMember({ name: profile.displayName, email, provider: 'Google', providerId: profile.id });
      done(null, member);
    } catch (err) { done(err); }
  }));
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: process.env.FACEBOOK_CALLBACK_URL,
    profileFields: ['id', 'displayName', 'emails'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : `${profile.id}@facebook.lhta`;
      const member = await upsertOAuthMember({ name: profile.displayName, email, provider: 'Facebook', providerId: profile.id });
      done(null, member);
    } catch (err) { done(err); }
  }));
}

module.exports = passport;
