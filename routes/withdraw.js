const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

router.post('/withdraw', async (req, res) => {
  const { userId, amount, phone, operator } = req.body;

  try {
    // 1. Vérifications de base
    if (!phone.startsWith('+225')) {
      return res.status(400).json({ error: 'Numéro invalide (format +225XXXXXXXXXX)' });
    }
    if (amount < 500) {
      return res.status(400).json({ error: 'Montant minimum 500 FCFA' });
    }

    // 2. Vérifier le wallet
    const walletRef = db.collection('user_wallet').doc(userId);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(404).json({ error: 'Wallet non trouvé' });
    }

    const currentBalance = walletDoc.data().solde || 0;
    if (currentBalance < amount) {
      return res.status(400).json({ error: 'Solde insuffisant' });
    }

    // 3. Déduire le montant (Séquestre)
    await walletRef.update({
      solde: currentBalance - amount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 4. Créer la demande de retrait avec le statut "en attente manuelle"
    const withdrawRef = await db.collection('withdraw_requests').add({
      userId: userId,
      amount: amount,
      phone: phone,
      operator: operator,
      status: 'pending_manual', // En attente d'action de l'équipe
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 5. Générer un message clair pour ton équipe
    const adminMessage = `Nouvelle demande de retrait à traiter sur PaiementPro:\n` +
      `- Client ID: ${userId}\n` +
      `- Montant: ${amount} FCFA\n` +
      `- Opérateur: ${operator}\n` +
      `- Numéro: ${phone}\n` +
      `- Référence Firestore: ${withdrawRef.id}`;

    console.log('\n🚨🚨🚨 ACTION REQUISE 🚨🚨🚨');
    console.log(adminMessage);
    console.log('===================================\n');

    res.status(200).json({
      success: true,
      message: 'Demande de retrait enregistrée. Elle sera traitée sous 48h maximum.',
      requestId: withdrawRef.id,
    });

  } catch (error) {
    console.error('❌ Erreur withdraw:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
