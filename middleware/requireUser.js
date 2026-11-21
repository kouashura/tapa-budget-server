// server/middleware/requireUser.js
// Vérifie le jeton Firebase de l'utilisateur (en-tête "Authorization: Bearer <idToken>").
// Place l'utilisateur vérifié dans req.user (req.user.uid = identifiant Firebase).

const admin = require('firebase-admin');

module.exports = async function requireUser(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(m[1]);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
  }
};
