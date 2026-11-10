const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const DigitalPaye = require('digitalpaye-node');

const db = admin.firestore();
const dp = new DigitalPaye({
  publicKey: process.env.DP_PUBLIC_KEY,
  secret: process.env.DP_SECRET,
});

router.post('/paiement/init', async (req, res) => {
  const { userId, amount, operator, phone, description } = req.body;

  try {
    if (!userId || !amount || !operator || !phone) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const externalRef = `COLLECT_${userId}_${Date.now()}`;

    // Utilisation de paymentLinks pour générer une URL de checkout
    const link = await dp.paymentLinks.create({
      label: description || 'Rechargement TAPA Budget',
      amount: amount,
      currency: 'XOF',
      operator_code: operator,
      external_ref: externalRef,
      payer_phone: phone,
      url_success: 'https://tapa-budget-server.onrender.com/api/paiement/success',
      url_error: 'https://tapa-budget-server.onrender.com/api/paiement/error'
    });

    await db.collection('transactions').add({
      userId,
      amount,
      operator,
      phone,
      externalRef,
      reference: link.data.reference,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      externalRef: externalRef,
      checkoutUrl: link.data.url // L'URL à ouvrir dans Flutter
    });

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
