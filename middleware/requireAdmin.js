const admin = require('firebase-admin');

async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Token manquant' });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const userDoc = await admin
      .firestore()
      .collection('users')
      .doc(decoded.uid)
      .get();

    if (!userDoc.exists) {
      return res.status(403).json({ success: false, error: 'Utilisateur inconnu' });
    }
    if (userDoc.data().role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acces admin requis' });
    }

    req.user = { uid: decoded.uid, role: 'admin' };
    next();
  } catch (e) {
    console.error('requireAdmin:', e.message);
    return res.status(401).json({ success: false, error: 'Token invalide' });
  }
}

module.exports = requireAdmin;
