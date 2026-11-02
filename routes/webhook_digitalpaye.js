const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

router.post('/webhook/digitalpaye', async (req, res) => {
  const { event, data } = req.body;

  console.log('📩 Webhook DigitalPaye:', event, data);

  try {
    const externalRef = data?.external_ref;
    if (!externalRef) {
      return res.status(400).json({ error: 'external_ref manquant' });
    }

    const txQuery = await db.collection('transactions')
      .where('externalRef', '==', externalRef)
      .get();

    if (txQuery.empty) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    if (event === 'payout.success') {
      await txDoc.ref.update({
        status: 'success',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (event === 'payout.failed') {
      const walletRef = db.collection('user_wallet').doc(txData.userId);
      const walletDoc = await walletRef.get();
      const currentBalance = walletDoc.data()?.solde || 0;

      await walletRef.update({
        solde: currentBalance + txData.amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await txDoc.ref.update({
        status: 'failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
