const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { createPayout } = require('../services/payout_service');

const db = admin.firestore();

router.post('/payout/request', async (req, res) => {
  const { userId, amount, phone, operator } = req.body;

  try {
    if (!userId || !amount || !phone || !operator) {
      return res.status(400).json({ error: 'Champs manquants: userId, amount, phone, operator' });
    }
    if (amount < 500) {
      return res.status(400).json({ error: 'Montant minimum 500 FCFA' });
    }
    if (!phone.startsWith('+225')) {
      return res.status(400).json({ error: 'Numéro invalide (format +225XXXXXXXXXX)' });
    }

    const walletRef = db.collection('user_wallet').doc(userId);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(404).json({ error: 'Wallet non trouvé' });
    }

    const currentBalance = walletDoc.data().solde || 0;
    if (currentBalance < amount) {
      return res.status(400).json({ error: 'Solde insuffisant' });
    }

    await walletRef.update({
      solde: currentBalance - amount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const payoutResult = await createPayout(amount, phone, operator, userId);

    if (!payoutResult.success) {
      await walletRef.update({
        solde: currentBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(500).json({ error: payoutResult.error });
    }

    const withdrawRef = await db.collection('withdraw_requests').add({
      userId: userId,
      amount: amount,
      phone: phone,
      operator: operator,
      externalRef: payoutResult.externalRef,
      reference: payoutResult.reference,
      status: 'pending',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      message: 'Demande de retrait initiée avec succès.',
      requestId: withdrawRef.id,
      externalRef: payoutResult.externalRef,
    });

  } catch (error) {
    console.error('❌ Erreur payout:', error.message);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
