// server/routes/webhook_digitalpaye.js
// Webhook DigitalPaye : encaissements (transaction.*) ET retraits (payout.*).
// Sécurité : signature HMAC-SHA256 obligatoire (en-tête X-DigitalPaye-Signature),
// calculée sur le corps BRUT (req.rawBody, voir server/index.js).

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const dp = require('../services/digitalpaye');
const { crediter, changerStatutSiPending } = require('./paiement');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function signatureValide(req) {
  const secret = process.env.DP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('🚫 DP_WEBHOOK_SECRET manquant : webhook refusé');
    return false;
  }
  if (!req.rawBody) {
    console.error('🚫 req.rawBody absent : ajoute le "verify" à express.json() dans server/index.js');
    return false;
  }
  const recu = String(req.headers['x-digitalpaye-signature'] || '');
  const attendu = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(recu);
  const b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Encaissement ---------------------------------------------------------
async function traiterEncaissement(event, body) {
  const obj = body.transaction || body.data || {};
  const reference = obj.reference;
  if (!reference) return { code: 400, msg: 'reference manquante' };

  let externalRef = obj.external_ref || null;
  let status = (obj.status && obj.status.value) || obj.status ||
    (event.endsWith('successful') ? 'successful' : event.endsWith('failed') ? 'failed' : null);
  let charged = obj.amounts ? obj.amounts.charged : obj.amount;

  // Revérification auprès de DigitalPaye (si le scope le permet)
  const detail = await dp.collectDetail(reference);
  if (detail.ok && detail.data) {
    externalRef = detail.data.external_ref || externalRef;
    status = (detail.data.status && detail.data.status.value) || status;
    if (detail.data.amounts && detail.data.amounts.charged !== undefined) {
      charged = detail.data.amounts.charged;
    }
  } else {
    console.warn('⚠️ Revérification impossible (', detail.httpStatus, detail.message, ') : on s\'appuie sur le webhook signé');
  }

  if (!externalRef) {
    const q = await db.collection('transactions').where('dpReference', '==', reference).limit(1).get();
    if (!q.empty) externalRef = q.docs[0].id;
  }
  if (!externalRef) return { code: 500, msg: 'transaction introuvable (retry)' };

  const txRef = db.collection('transactions').doc(externalRef);
  const snap = await txRef.get();
  if (!snap.exists) {
    console.warn('ℹ️ Transaction inconnue ignorée:', externalRef);
    return { code: 200 };
  }
  const tx = snap.data();

  if (status === 'successful') {
    if (charged !== undefined && charged !== null && Number(charged) !== tx.amount) {
      console.error(`🚨 Montant différent: ${charged} vs ${tx.amount} (${externalRef})`);
      await changerStatutSiPending(txRef, 'amount_mismatch');
      return { code: 200 };
    }
    const ok = await crediter(txRef);
    console.log(ok ? `✅ Paiement ${externalRef} crédité` : `ℹ️ Paiement ${externalRef} déjà traité`);
  } else if (status === 'failed') {
    await changerStatutSiPending(txRef, 'failed');
    console.log(`❌ Paiement ${externalRef} échoué`);
  }
  return { code: 200 };
}

// --- Retrait --------------------------------------------------------------
// Idempotent : un retrait déjà terminé n'est jamais retraité (jamais remboursé 2 fois).
async function traiterRetrait(withdrawRef, event) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(withdrawRef);
    if (!snap.exists) return;
    const w = snap.data();
    if (w.status === 'success' || w.status === 'failed') return; // idempotent

    const fin = {
      completedAt: FieldValue.serverTimestamp(),
      completedBy: 'digitalpaye',
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (event === 'payout.failed') {
      const total = w.totalDebite != null ? w.totalDebite : w.amount; // montant + frais
      const walletRef = db.collection('wallets').doc(w.userId);
      const ws = await t.get(walletRef);                              // lecture avant écriture
      const solde = ws.exists ? Number(ws.data().solde || 0) : 0;
      const doitRembourser = w.debited !== false;

      if (doitRembourser) {
        t.set(
          walletRef,
          { solde: FieldValue.increment(total), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
        t.set(db.collection('wallet_movements').doc(`${withdrawRef.id}_refund`), {
          userId: w.userId,
          type: 'retrait_remboursement',
          montant: total,
          soldeAvant: solde,
          soldeApres: solde + total,
          withdrawId: withdrawRef.id,
          motif: 'Échec du virement (DigitalPaye)',
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      t.update(withdrawRef, { status: 'failed', refunded: doitRembourser, ...fin });
    } else {
      t.update(withdrawRef, { status: 'success', ...fin });
    }
  });
}

router.post('/webhook/digitalpaye', async (req, res) => {
  if (!signatureValide(req)) return res.status(401).send('Signature invalide');

  const body = req.body || {};
  const event = String(body.event || '');
  console.log('📩 Webhook DigitalPaye:', event, req.headers['x-digitalpaye-delivery'] || '');

  try {
    if (event === 'transaction.successful' || event === 'transaction.failed') {
      const r = await traiterEncaissement(event, body);
      return r.code === 200 ? res.status(200).json({ received: true }) : res.status(r.code).json({ error: r.msg });
    }

    if (['payout.success', 'payout.successful', 'payout.failed'].includes(event)) {
      const obj = body.payout || body.data || body.transaction || {};
      const externalRef = obj.external_ref;
      if (!externalRef) {
        console.warn('Payload payout sans external_ref:', JSON.stringify(body));
        return res.status(400).json({ error: 'external_ref manquant' });
      }
      const q = await db.collection('withdraw_requests').where('externalRef', '==', externalRef).get();
      if (!q.empty) {
        await traiterRetrait(q.docs[0].ref, event);
        console.log(`✅ Retrait ${externalRef} traité (${event})`);
      }
      return res.status(200).json({ received: true });
    }

    res.status(200).json({ received: true, ignored: true });
  } catch (error) {
    console.error('❌ Erreur webhook:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
