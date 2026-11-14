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

    // ✅ ÉTAPE 1 : Chercher la transaction
    let txQuery = await db.collection('transactions')
      .where('reference', '==', reference)
      .get();

    // Si pas trouvé par reference (car c'est DP...), on cherche par externalRef ou par montant+userId
    if (txQuery.empty) {
      // On cherche la transaction en attente la plus récente pour cet utilisateur
      // Note: DigitalPaye ne renvoie pas l'userId, donc on ne peut pas filtrer par userId
      // On cherche par externalRef (mais DigitalPaye ne le renvoie pas non plus)
      // SOLUTION: On cherche toutes les transactions en attente et on prend la plus récente
      console.log('⚠️ Recherche par référence échouée. Recherche de la transaction en attente la plus récente...');
      
      const pendingQuery = await db.collection('transactions')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();
      
      for (const doc of pendingQuery.docs) {
        const txData = doc.data();
        // On vérifie si le montant correspond
        if (txData.amount === data.amount) {
          txQuery = { empty: false, docs: [doc] };
          console.log('✅ Transaction trouvée par montant et statut pending:', doc.id);
          break;
        }
      }
    }

    if (txQuery.empty) {
      console.log('⚠️ Transaction non trouvée pour:', reference);
      return res.status(404).json({ error: 'Transaction non trouvée' });
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    // ✅ ÉTAPE 2 : Mettre à jour la référence si elle est différente
    if (txData.reference !== reference) {
      await txDoc.ref.update({ reference: reference });
      console.log('✅ Référence mise à jour:', reference);
    }

    // ✅ ÉTAPE 3 : Créditer le wallet si le paiement est réussi
    if (event === 'transaction.successful' || event === 'payment_link.paid') {
      // Vérifier si déjà crédité
      if (txData.status === 'success') {
        console.log('⚠️ Wallet déjà crédité pour cette transaction');
        return res.status(200).json({ received: true });
      }

      const walletRef = db.collection('wallets').doc(txData.userId);
      const walletDoc = await walletRef.get();
      const montantNet = txData.montantNet || data.amount;

      if (walletDoc.exists) {
        const currentBalance = walletDoc.data()?.solde || 0;
        await walletRef.update({
          solde: currentBalance + montantNet,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Wallet crédité de ${montantNet} FCFA pour ${txData.userId}`);
      } else {
        await walletRef.set({
          solde: montantNet,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Nouveau Wallet créé et crédité de ${montantNet} FCFA`);
      }

      // Mettre à jour le statut
      await txDoc.ref.update({ status: 'success', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log('✅ Transaction marquée comme success');
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
