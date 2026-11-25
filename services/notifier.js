// server/services/notifier.js
// Les messages sont écrits dans la collection 'outbox'. L'envoi réel (WhatsApp, push)
// se branche ici une fois le fournisseur choisi. Ne bloque jamais l'appelant.
const admin = require('firebase-admin');
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function enfiler(canal, to, modele, params, userId) {
  if (!to && canal === 'whatsapp') return;
  await db.collection('outbox').add({
    canal, to: to || null, modele, params, userId: userId || null,
    statut: 'a_envoyer', createdAt: FieldValue.serverTimestamp(),
  });
}

async function paiementRecu(s) {
  await enfiler('whatsapp', s.whatsapp, 'paiement_recu', { reference: s.reference, immatriculation: s.immatriculation, montant: s.montant }, s.userId);
  await enfiler('push', null, 'paiement_recu', { reference: s.reference }, s.userId);
  await enfiler('admin', null, 'nouveau_dossier', { reference: s.reference, immatriculation: s.immatriculation }, null);
}

async function attestationPrete(s) {
  await enfiler('whatsapp', s.whatsapp, 'attestation_prete', { reference: s.reference, immatriculation: s.immatriculation, attestationPath: s.attestationPath }, s.userId);
  await enfiler('push', null, 'attestation_prete', { reference: s.reference }, s.userId);
}

async function dossierRefuse(s) {
  await enfiler('whatsapp', s.whatsapp, 'dossier_refuse', { reference: s.reference, motif: s.motifRefus }, s.userId);
  await enfiler('push', null, 'dossier_refuse', { reference: s.reference }, s.userId);
}

module.exports = { paiementRecu, attestationPrete, dossierRefuse };
