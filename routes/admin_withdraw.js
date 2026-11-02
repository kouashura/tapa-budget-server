const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

// ✅ Middleware simple pour vérifier l'admin (à adapter avec un vrai système d'auth)
// Pour l'instant, on vérifie un token secret dans le header
function checkAdmin(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  // ⚠️ Change ce token par un secret fort que tu gardes pour toi
  if (adminToken === 'TAPA_ADMIN_SECRET_2026') {
    next();
  } else {
    res.status(403).json({ error: 'Accès refusé : administrateur requis' });
  }
}

// 📋 Lister les demandes en attente
router.get('/admin/withdraws', checkAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('status', '==', 'pending_manual')
      .orderBy('requestedAt', 'desc')
      .get();

    const requests = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      requestedAt: doc.data().requestedAt?.toDate().toISOString() ?? null,
    }));

    res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error('❌ Erreur admin withdraws:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ✅ Valider une demande (déjà existant)
router.post('/admin/withdraw/:requestId/complete', checkAdmin, async (req, res) => {
  const { requestId } = req.params;
  const { status } = req.body;

  try {
    const requestRef = db.collection('withdraw_requests').doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    if (requestDoc.data().status !== 'pending_manual') {
      return res.status(400).json({ error: 'Cette demande a déjà été traitée' });
    }

    if (status === 'success') {
      await requestRef.update({
        status: 'success',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ success: true, message: 'Retrait marqué comme réussi' });
    } else if (status === 'failed') {
      const userId = requestDoc.data().userId;
      const amount = requestDoc.data().amount;
      
      const walletRef = db.collection('user_wallet').doc(userId);
      await walletRef.update({
        solde: admin.firestore.FieldValue.increment(amount),
      });

      await requestRef.update({
        status: 'failed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      res.status(200).json({ success: true, message: 'Retrait échoué, wallet remboursé' });
    } else {
      res.status(400).json({ error: 'Statut invalide' });
    }
  } catch (error) {
    console.error('❌ Erreur admin withdraw:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
