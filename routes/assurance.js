// server/routes/assurance.js
// Paiement DIRECT par Digital Paye (opérateur choisi dans l'app). Pas de portefeuille.
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const requireUser = require('../middleware/requireUser');
const requireAdmin = require('../middleware/requireAdmin');
const { initierEncaissement } = require('./paiement');
const grille = require('../services/grilleRc2018');
const { echouerSouscription } = require('../services/souscriptions');
const notifier = require('../services/notifier');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const txt = (v, max = 100) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, d = 0) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const LIB_FORMULE = { tiers: 'Tiers', tiersEtendu: 'Tiers étendu', tousRisques: 'Tous risques' };

function whatsappIntl(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = '225' + d;
  return '+' + d;
}

function lireVehicule(b) {
  const v = b.vehicule || {};
  const type = v.type === 'moto' ? 'moto' : 'voiture';
  if (txt(v.usage).toUpperCase().includes('PUBLIC')) {
    const e = new Error('Les véhicules à usage public ne sont pas encore pris en charge en ligne.');
    e.status = 422; throw e;
  }
  const formule = type === 'moto' ? 'tiers' : (grille.FORMULES.includes(b.formule) ? b.formule : 'tiers');
  return {
    type,
    carburant: v.carburant === 'diesel' ? 'diesel' : 'essence',
    cv: Math.min(Math.max(int(v.cv, 7), 1), 50),
    cylindreeIdx: Math.min(Math.max(int(v.cylindreeIdx), 0), 4),
    anneesSansSinistre: Math.min(Math.max(int(b.anneesSansSinistre), 0), 5),
    formule,
    valeurVehicule: Math.min(Math.max(int(b.valeurVehicule, 8000000), 1000000), 200000000),
    dureeMois: int(b.dureeMois),
  };
}

// Aperçu du prix (ne crée rien)
router.post('/assurance/devis', requireUser, (req, res) => {
  try {
    const d = grille.calculer(lireVehicule(req.body || {}));
    res.json({ success: true, ...d });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// Souscription + paiement. Le montant envoyé par l'app est IGNORÉ : le serveur recalcule.
router.post('/assurance/souscrire', requireUser, async (req, res) => {
  try {
    const uid = req.user.uid;
    const b = req.body || {}, c = b.client || {}, v = b.vehicule || {};

    const params = lireVehicule(b);
    const devis = grille.calculer(params);

    const nom = txt(c.nom), prenom = txt(c.prenom);
    const immatriculation = txt(b.immatriculation || v.immatriculation, 20).toUpperCase();
    const whatsapp = whatsappIntl(b.whatsapp);
    if (!nom || !prenom) return res.status(400).json({ error: 'Nom et prénom requis' });
    if (!immatriculation) return res.status(400).json({ error: 'Immatriculation requise' });
    if (!whatsapp) return res.status(400).json({ error: 'Numéro WhatsApp requis' });

    const carteGrisePath = txt(b.carteGrisePath, 200);
    if (carteGrisePath && !carteGrisePath.startsWith(`cartes_grises/${uid}/`)) {
      return res.status(400).json({ error: 'Carte grise invalide' });
    }

    const reference = `AS${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
    const sRef = db.collection('souscriptions').doc(reference);

    await sRef.set({
      reference, userId: uid,
      produitNom: `Assurance Auto ${LIB_FORMULE[params.formule]}`,
      montant: devis.total, statut: 'en_cours',
      clientNom: nom, clientPrenom: prenom, clientEmail: txt(c.email, 120), clientPhone: txt(c.telephone || b.phone, 20),
      dureeMois: params.dureeMois, whatsapp, immatriculation, carteGrisePath: carteGrisePath || null,
      devis: {
        vehicule: { ...params, marque: txt(v.marque, 50), modele: txt(v.modele, 50), genre: txt(v.genre, 30), energie: txt(v.energie, 20) },
        lignes: devis.lignes, total: devis.total, calculeLe: new Date().toISOString(),
      },
      dateCreation: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    const r = await initierEncaissement(uid, {
      amount: devis.total, operator: b.operator, phone: b.phone, otp: b.otp,
      description: `Assurance auto ${immatriculation} - ${params.dureeMois} mois`,
    }, { souscriptionRef: reference });

    if (r.code !== 200) {
      await echouerSouscription(reference);
      return res.status(r.code).json(r.body);
    }
    res.status(200).json({ ...r.body, reference, montant: devis.total });
  } catch (e) {
    console.error('❌ Erreur souscription assurance:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ───────────── Espace admin (traitement manuel) ─────────────
async function chargerDossier(ref) {
  const s = await db.collection('souscriptions').doc(String(ref)).get();
  return s.exists ? { sRef: s.ref, s: { id: s.id, ...s.data() } } : null;
}

router.post('/assurance/admin/:ref/prendre', requireAdmin, async (req, res) => {
  try {
    const d = await chargerDossier(req.params.ref);
    if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
    await db.runTransaction(async (t) => {
      const snap = await t.get(d.sRef);
      if (snap.data().statut !== 'payee') throw Object.assign(new Error('Dossier déjà pris en charge ou non payé'), { status: 409 });
      t.update(d.sRef, { statut: 'en_traitement', priseEnChargePar: req.user.uid, updatedAt: FieldValue.serverTimestamp() });
    });
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le PDF est déjà déposé dans Storage : attestations/{userId}/{reference}.pdf
router.post('/assurance/admin/:ref/publier', requireAdmin, async (req, res) => {
  try {
    const d = await chargerDossier(req.params.ref);
    if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
    if (!['payee', 'en_traitement'].includes(d.s.statut)) return res.status(409).json({ error: 'Statut incompatible' });

    const numeroPolice = txt(req.body.numeroPolice, 40);
    const debut = new Date(req.body.debut), fin = new Date(req.body.fin);
    if (!numeroPolice || isNaN(debut) || isNaN(fin) || fin <= debut) return res.status(400).json({ error: 'Police et dates requises' });

    const path = `attestations/${d.s.userId}/${d.s.reference}.pdf`;
    const existe = await require('./files').fichierExiste(path);
    if (!existe) return res.status(400).json({ error: 'PDF introuvable : téléversez-le avant de publier' });

    await d.sRef.update({
      statut: 'attestation_emise', attestationPath: path, numeroPolice,
      debutCouverture: debut, finCouverture: fin,
      emiseLe: FieldValue.serverTimestamp(), emisePar: req.user.uid, updatedAt: FieldValue.serverTimestamp(),
    });
    try { await notifier.attestationPrete({ ...d.s, attestationPath: path }); } catch (e) { console.error('notif:', e.message); }
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/assurance/admin/:ref/refuser', requireAdmin, async (req, res) => {
  try {
    const d = await chargerDossier(req.params.ref);
    if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
    const motif = txt(req.body.motif, 300);
    if (motif.length < 5) return res.status(400).json({ error: 'Motif obligatoire' });
    if (!['payee', 'en_traitement'].includes(d.s.statut)) return res.status(409).json({ error: 'Statut incompatible' });
    await d.sRef.update({
      statut: 'refusee', motifRefus: motif, refusePar: req.user.uid,
      aRembourser: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
    try { await notifier.dossierRefuse({ ...d.s, motifRefus: motif }); } catch (e) { console.error('notif:', e.message); }
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
