const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requetes, reessayez plus tard.' },
});

const normEmail = (v) => String(v || '').trim().toLowerCase();

// Le code n'est jamais stocke en clair : HMAC-SHA256 avec un secret serveur.
const hashCode = (email, code) => {
  const secret = process.env.CODE_SECRET;
  if (!secret) throw new Error('CODE_SECRET manquant');
  return crypto.createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
};

// Id de document = hash de l'email (pas d'email en clair dans les chemins).
const docRef = (email) =>
  admin.firestore().collection('email_codes')
    .doc(crypto.createHash('sha256').update(email).digest('hex'));

async function sendEmail(email, code) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY manquante');
  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: {
        name: 'TAPA Invest',
        email: process.env.BREVO_SENDER_EMAIL || 'infosservices2015@gmail.com',
      },
      to: [{ email }],
      subject: 'Votre code de verification TAPA Invest',
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1A237E;">TAPA Invest</h2>
          <p>Bonjour,</p>
          <p>Voici votre code de verification :</p>
          <div style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #C9A227; text-align: center; padding: 16px; background: #f5f5f5; border-radius: 8px; margin: 16px 0;">
            ${code}
          </div>
          <p style="color: #666; font-size: 13px;">Ce code expire dans 15 minutes. Ne le partagez avec personne.</p>
          <p style="color: #666; font-size: 12px; margin-top: 32px;">Si vous n'avez pas demande ce code, ignorez cet email.</p>
        </div>`,
    },
    {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }
  );
}

// POST /api/auth/send-code   Body : { email }
router.post('/auth/send-code', limiter, async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'email invalide' });

    const ref = docRef(email);
    const snap = await ref.get();
    if (snap.exists) {
      const last = snap.data().lastSentAt;
      if (last && Date.now() - last.toMillis() < RESEND_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Patientez avant de redemander un code.' });
      }
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await ref.set({
      codeHash: hashCode(email, code),
      attempts: 0,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CODE_TTL_MS),
      lastSentAt: admin.firestore.Timestamp.now(),
    });

    await sendEmail(email, code);
    // Meme reponse que le compte existe ou non (pas de fuite d'information).
    res.json({ success: true });
  } catch (e) {
    console.error('send-code:', e.response?.data || e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/auth/email-login   Body : { email, code }
// -> { token, isNew } ; l'app fait signInWithCustomToken(token)
router.post('/auth/email-login', limiter, async (req, res) => {
  try {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '');
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const ref = docRef(email);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'invalid_code' });

    const d = snap.data();
    if (d.attempts >= MAX_ATTEMPTS || d.expiresAt.toMillis() < Date.now()) {
      await ref.delete();
      return res.status(400).json({ error: 'expired' });
    }

    const given = Buffer.from(hashCode(email, code));
    const saved = Buffer.from(d.codeHash);
    const ok = given.length === saved.length && crypto.timingSafeEqual(given, saved);
    if (!ok) {
      await ref.update({ attempts: admin.firestore.FieldValue.increment(1) });
      return res.status(400).json({ error: 'invalid_code' });
    }
    await ref.delete(); // usage unique

    // --- Retrouver le compte existant (meme UID => donnees intactes) ---
    const auth = admin.auth();
    let uid;
    try {
      uid = (await auth.getUserByEmail(email)).uid;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
      // Ancien profil Firestore sans compte Auth : on recree l'Auth avec le MEME uid
      const legacy = await admin.firestore().collection('users')
        .where('email', '==', email).limit(1).get();
      if (!legacy.empty) {
        uid = legacy.docs[0].id;
        try {
          await auth.getUser(uid);
        } catch (e2) {
          if (e2.code !== 'auth/user-not-found') throw e2;
          await auth.createUser({ uid, email, emailVerified: true });
        }
      } else {
        uid = (await auth.createUser({ email, emailVerified: true })).uid;
      }
    }

    const profile = await admin.firestore().collection('users').doc(uid).get();
    const token = await auth.createCustomToken(uid);
    res.json({ token, isNew: !profile.exists });
  } catch (e) {
    console.error('email-login:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
