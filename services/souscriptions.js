// server/services/souscriptions.js
// Seul endroit où une souscription auto passe à 'payee' (jamais depuis l'app).
const admin = require('firebase-admin');
const notifier = require('./notifier');

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Paiement confirmé : transaction -> success ET souscription -> payee, atomiquement.
// AUCUN crédit de portefeuille. Idempotent (un 2e webhook ne fait rien).
async function activerSouscription(txRef) {
  let souscription = null;
  const fait = await db.runTransaction(async (t) => {
    const txSnap = await t.get(txRef);
    if (!txSnap.exists) return false;
    const tx = txSnap.data();
    if (tx.status !== 'pending' || !tx.souscriptionRef) return false;

    const sRef = db.collection('souscriptions').doc(tx.souscriptionRef);
    const sSnap = await t.get(sRef);
    t.update(txRef, { status: 'success', paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

    if (!sSnap.exists || sSnap.data().statut !== 'en_cours') {
      console.error(`🚨 Paiement ${txRef.id} reçu mais souscription ${tx.souscriptionRef} non activable`);
      t.set(db.collection('alertes_paiement').doc(txRef.id), {
        txId: txRef.id, souscriptionRef: tx.souscriptionRef, montant: tx.amount,
        motif: 'souscription_non_activable', createdAt: FieldValue.serverTimestamp(),
      });
      return false;
    }
    t.update(sRef, { statut: 'payee', payeLe: FieldValue.serverTimestamp(), txRef: txRef.id, updatedAt: FieldValue.serverTimestamp() });
    souscription = { id: sRef.id, ...sSnap.data(), statut: 'payee' };
    return true;
  });
  if (fait && souscription) {
    try { await notifier.paiementRecu(souscription); } catch (e) { console.error('notif paiementRecu:', e.message); }
  }
  return fait;
}

// Paiement échoué : on annule le dossier s'il attendait encore le paiement.
async function echouerSouscription(souscriptionRef) {
  const sRef = db.collection('souscriptions').doc(souscriptionRef);
  await db.runTransaction(async (t) => {
    const s = await t.get(sRef);
    if (s.exists && s.data().statut === 'en_cours') {
      t.update(sRef, { statut: 'annulee', updatedAt: FieldValue.serverTimestamp() });
    }
  });
}

module.exports = { activerSouscription, echouerSouscription };
