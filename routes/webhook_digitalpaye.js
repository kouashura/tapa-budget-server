const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

router.post('/webhook/digitalpaye', async (req, res) => {
  const { event, data } = req.body;

  console.log('📩 Webhook DigitalPaye reçu:', event, data);

  try {
    const reference = data?.reference;
    if (!reference) {
      return res.status(400).json({ error: 'reference manquante' });
    }

    // ✅ On cherche la transaction par la référence DigitalPaye (et non external_ref)
    const txQuery = await db.collection('transactions')
      .where('reference', '==', reference)
      .get();

    if (txQuery.empty) {
      console.log('⚠️ Transaction non trouvée dans Firestore pour:', reference);
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    // ✅ 1. GESTION DES RECHARGEMENTS (COLLECT)
    if (event === 'transaction.successful' || event === 'payment_link.paid' || event === 'collect.success') {
      
      // Créditer le Wallet TAPA
      const walletRef = db.collection('wallets').doc(txData.userId);
      const walletDoc = await walletRef.get();
      
      if (walletDoc.exists) {
        const currentBalance = walletDoc.data()?.solde || 0;
        await walletRef.update({
          solde: currentBalance + (txData.montantNet || data.amount || txData.amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Wallet crédité de ${txData.montantNet || data.amount} FCFA (brut: ${data.amount}) pour ${txData.userId}`);
      } else {
        // Si le wallet n'existe pas, on le crée
        await walletRef.set({
          solde: (txData.montantNet || data.amount || txData.amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Nouveau Wallet créé et crédité de ${txData.amount} FCFA`);
      }

      // Débiter le portefeuille source (Wave, Orange, etc.)
      if (txData.sourceWalletId) {
        const sourceRef = db.collection('user_wallet').doc(txData.sourceWalletId);
        const sourceDoc = await sourceRef.get();
        if (sourceDoc.exists) {
          const currentSource = sourceDoc.data()?.solde || 0;
          await sourceRef.update({
            solde: Math.max(0, currentSource - txData.amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      await txDoc.ref.update({ status: 'success' });
      return res.status(200).json({ received: true });
    }

    // ✅ 2. GESTION DES RETRAITS (PAYOUT)
    if (event === 'payout.success') {
      await txDoc.ref.update({ status: 'success' });
      return res.status(200).json({ received: true });
    } 
    
    if (event === 'payout.failed') {
      // Rembourser le wallet
      const walletRef = db.collection('wallets').doc(txData.userId);
      const walletDoc = await walletRef.get();
      const currentBalance = walletDoc.data()?.solde || 0;
      await walletRef.update({
        solde: currentBalance + (txData.montantNet || data.amount || txData.amount),
      });
      await txDoc.ref.update({ status: 'failed' });
      return res.status(200).json({ received: true });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
