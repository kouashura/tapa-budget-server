const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { createPayout } = require('../services/payout_service');

const db = admin.firestore();

router.post('/withdraw', async (req, res) => {
  const { userId, amount, phone, operator } = req.body;
    
    // ✅ Nettoyer le numéro (enlever les +225 en double)
    let cleanPhone = phone.replace(/\+225\+225/g, '+225');
    if (!cleanPhone.startsWith('+225')) {
      cleanPhone = '+225' + cleanPhone.replace(/\D/g, '');
    }
    
    // ✅ On transforme WAVE_MONEY_CI en WAVE (ce que DigitalPaye attend)
    const dpOperator = operator.replace('_MONEY_CI', '').replace('_CI', '');

  try {
    // 1. Vérifications de base
    if (!phone.startsWith('+225')) {
      return res.status(400).json({ error: 'Numéro invalide (format +225XXXXXXXXXX)' });
    }
    if (amount < 500) {
      return res.status(400).json({ error: 'Montant minimum 500 FCFA' });
    }

    // 2. Vérifier le Wallet TAPA (collection 'wallets', pas 'user_wallet')
    const walletRef = db.collection('wallets').doc(userId);
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

    // 4. Appeler DigitalPaye pour le virement
    const payoutResult = await createPayout(amount, cleanPhone, dpOperator, userId);

    // 4. Créer la demande de retrait (avec le statut 'pending' au début)
    const withdrawRef = await db.collection('withdraw_requests').add({
      userId: userId,
      amount: amount,
      phone: phone,
      operator: operator,
      externalRef: payoutResult.externalRef || 'N/A',
      reference: payoutResult.reference || 'N/A',
      status: 'pending',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!payoutResult.success) {
      // Rembourser le wallet en cas d'échec
      await walletRef.update({
        solde: currentBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      // ✅ Mettre à jour le statut de la demande pour dire qu'elle a échoué
      await withdrawRef.update({
        status: 'failed',
        error: payoutResult.error,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      return res.status(500).json({ error: payoutResult.error });
    }

    console.log('✅ Retrait initié:', { externalRef: payoutResult.externalRef, reference: payoutResult.reference });

    res.status(200).json({
      success: true,
      message: 'Demande de retrait initiée avec succès.',
      requestId: withdrawRef.id,
    });

  } catch (error) {
    console.error('❌ Erreur withdraw:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
