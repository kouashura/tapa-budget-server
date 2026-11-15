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

    // 1. Trouver la transaction (par reference OU par externalRef)
    let txQuery = await db.collection('transactions')
      .where('reference', '==', reference)
      .get();
    
    if (txQuery.empty) {
      txQuery = await db.collection('transactions')
        .where('externalRef', '==', reference)
        .get();
    }

    // Si toujours pas trouvé, on cherche la transaction en attente la plus récente
    if (txQuery.empty) {
      console.log('⚠️ Recherche par référence échouée. Recherche de la transaction en attente...');
      const pendingQuery = await db.collection('transactions')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();
      
      for (const doc of pendingQuery.docs) {
        if (doc.data().amount === data.amount) {
          txQuery = { empty: false, docs: [doc] };
          console.log('✅ Transaction trouvée par montant et statut pending:', doc.id);
          break;
        }
      }
    }

    if (txQuery.empty) {
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    // 2. Mettre à jour la référence dans Firestore (pour les futurs webhooks)
    if (txData.reference !== reference) {
      await txDoc.ref.update({ reference: reference });
      console.log('✅ Référence mise à jour:', reference);
    }

    // 3. Si le paiement est réussi, on crédite le Wallet TAPA
    if (event === 'transaction.successful' || event === 'payment_link.paid') {
      
      // Vérifier si déjà crédité (évite les doublons)
      if (txData.status === 'success') {
        console.log('⚠️ Déjà crédité pour cette transaction');
        return res.status(200).json({ received: true });
      }

      const montantNet = txData.montantNet || data.amount;

      // ✅ A. Créditer le Wallet TAPA (collection 'wallets')
      const walletRef = db.collection('wallets').doc(txData.userId);
      const walletDoc = await walletRef.get();
      
      if (walletDoc.exists) {
        const currentBalance = walletDoc.data()?.solde || 0;
        await walletRef.update({
          solde: currentBalance + montantNet,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await walletRef.set({
          solde: montantNet,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      console.log(`✅ Wallet TAPA crédité de ${montantNet} FCFA pour ${txData.userId}`);

      // ✅ B. Débiter le portefeuille virtuel source (collection 'user_wallet')
      if (txData.sourceWalletId) {
        const sourceRef = db.collection('user_wallet').doc(txData.sourceWalletId);
        const sourceDoc = await sourceRef.get();
        
        if (sourceDoc.exists) {
          const sourceBalance = sourceDoc.data()?.solde || 0;
          await sourceRef.update({
            solde: Math.max(0, sourceBalance - montantNet), // On ne passe pas en négatif
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`✅ Portefeuille virtuel ${txData.sourceWalletId} débité de ${montantNet} FCFA`);
        }
      }

      // Marquer la transaction comme success
      await txDoc.ref.update({ status: 'success', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    // ✅ GESTION DES RETRAITS (PAYOUT)
    if (event === 'payout.success' || event === 'payout.failed') {
      // Trouver la demande de retrait par externalRef (qui contient WITHDRAW_...)
      const withdrawQuery = await db.collection('withdraw_requests')
        .where('externalRef', '==', data.external_ref)
        .get();

      if (!withdrawQuery.empty) {
        const withdrawDoc = withdrawQuery.docs[0];
        
        if (event === 'payout.successful') { // ✅ Corrigé : seulement sur successful
          await withdrawDoc.ref.update({
            status: 'success',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log('✅ Retrait marqué comme success');
        } else if (event === 'payout.failed') {
          // Rembourser le wallet
          const withdrawData = withdrawDoc.data();
          const walletRef = db.collection('wallets').doc(withdrawData.userId);
          const walletDoc = await walletRef.get();
          
          if (walletDoc.exists) {
            const currentBalance = walletDoc.data()?.solde || 0;
            await walletRef.update({
              solde: currentBalance + withdrawData.amount,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log('✅ Wallet remboursé de', withdrawData.amount, 'FCFA');
          }
          
          await withdrawDoc.ref.update({
            status: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log('❌ Retrait marqué comme failed');
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
