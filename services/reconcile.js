// server/services/reconcile.js
// Filet de sécurité : toutes les minutes, vérifie auprès de DigitalPaye les encaissements
// restés 'pending' (webhook perdu/refusé) et les traite. Idempotent : jamais de double crédit.
const admin = require('firebase-admin');
const dp = require('./digitalpaye');
const { crediter, changerStatutSiPending } = require('../routes/paiement');

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;
let enCours = false;

async function trouverDetail(tx) {
  if (tx.dpReference) {
    const d = await dp.collectDetail(tx.dpReference);
    return d.ok ? d.data : null;
  }
  const l = await dp.listCollects();
  if (!l.ok) return null;
  const items = Array.isArray(l.data) ? l.data : (l.data && (l.data.items || l.data.data)) || [];
  return items.find((x) => x.external_ref === tx.externalRef) || null;
}

async function remettrePending(ref) {
  return db().runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) return false;
    const x = s.data();
    if (x.status === 'pending') return true;
    if (x.paidAt || x.status !== 'init_failed') return false;
    t.update(ref, { status: 'pending', reopenedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

async function traiter(doc) {
  const tx = doc.data();
  const ref = doc.ref;
  const ms = tx.createdAt && tx.createdAt.toMillis ? tx.createdAt.toMillis() : 0;
  const age = Date.now() - ms;
  if (age < 45000) return; // laisser sa chance au webhook

  const d = await trouverDetail(tx);
  if (!d) return;
  const st = d.status && d.status.value;
  if (d.reference && !tx.dpReference) await ref.update({ dpReference: d.reference });

  if (st === 'successful') {
    const charged = d.amounts && d.amounts.charged;
    if (charged != null && Number(charged) !== tx.amount) {
      console.error(`🚨 [reconcile] Montant différent ${charged} vs ${tx.amount} (${doc.id})`);
      await changerStatutSiPending(ref, 'amount_mismatch');
      return;
    }
    if (!(await remettrePending(ref))) return;
    const ok = await crediter(ref);
    if (ok) console.log(`✅ [reconcile] ${doc.id} crédité`);
  } else if (st === 'failed') {
    await changerStatutSiPending(ref, 'failed');
    console.log(`❌ [reconcile] ${doc.id} échoué`);
  } else if (tx.status === 'pending' && age > 2 * 3600 * 1000) {
    await changerStatutSiPending(ref, 'expired'); // jamais payé (lien Wave abandonné...)
    console.log(`⌛ [reconcile] ${doc.id} expiré`);
  }
}

async function reconcilier() {
  if (enCours) return;
  enCours = true;
  try {
    for (const statut of ['pending', 'init_failed']) {
      const snap = await db().collection('transactions')
        .where('provider', '==', 'digitalpaye').where('status', '==', statut).limit(50).get();
      for (const doc of snap.docs) {
        try { await traiter(doc); } catch (e) { console.error('[reconcile] erreur', doc.id, e.message); }
      }
    }
  } catch (e) {
    console.error('[reconcile] erreur globale:', e.message);
  } finally {
    enCours = false;
  }
}

exports.demarrer = () => {
  setTimeout(reconcilier, 20000);
  setInterval(reconcilier, 60000);
  console.log('🔄 Réconciliation DigitalPaye activée (toutes les 60 s)');
};
