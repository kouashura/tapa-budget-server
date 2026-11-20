// server/routes/webhook_digitalpaye.js
// ⚠️ Ne gère PLUS que les RETRAITS (payouts) DigitalPaye.
// Les encaissements sont traités par Paiement Pro (routes/paiement.js).

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Idempotent : un retrait déjà terminé (success/failed) n'est jamais retraité,
// donc jamais remboursé deux fois.
async function traiterRetrait(withdrawRef, event) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(withdrawRef);
    if (!snap.exists) return;
    const w = snap.data();
    if (w.status === 'success' || w.status === 'failed') return;

    if (event === 'payout.failed') {
      t.set(
        db.collection('wallets').doc(w.userId),
        { solde: FieldValue.increment(w.amount), updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      t.update(withdrawRef, { status: 'failed', updatedAt: FieldValue.serverTimestamp() });
    } else {
      t.update(withdrawRef, { status: 'success', updatedAt: FieldValue.serverTimestamp() });
    }
  });
}

router.post('/webhook/digitalpaye', async (req, res) => {
  const { event, data } = req.body || {};
  console.log('📩 Webhook DigitalPaye reçu:', event);

  try {
    const evenementsRetrait = ['payout.success', 'payout.successful', 'payout.failed'];

    if (evenementsRetrait.includes(event)) {
      const externalRef = data && data.external_ref;
      if (!externalRef) {
        return res.status(400).json({ error: 'external_ref manquant' });
      }

      const withdrawQuery = await db
        .collection('withdraw_requests')
        .where('externalRef', '==', externalRef)
        .get();

      if (!withdrawQuery.empty) {
        await traiterRetrait(withdrawQuery.docs[0].ref, event);
        console.log(`✅ Retrait ${externalRef} traité (${event})`);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
