const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { initierEncaissement } = require('./paiement');
const { calculerTarif } = require('../services/tarifAuto');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const PRODUITS = new Set(['Assurance Auto Tiers', 'Assurance Auto Tous Risques', 'Assurance Auto Bonus']);

const txt = (v, max = 100) => String(v == null ? '' : v).trim().slice(0, max);

function whatsappIntl(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = '225' + d;
  return '+' + d;
}

router.post('/assurance/souscrire', async (req, res) => {
  try {
    const uid = req.user?.uid || req.body.userId;
    if (!uid) return res.status(401).json({ error: 'Non authentifié' });

    const b = req.body || {};
    const c = b.client || {};
    const v = b.vehicule || {};

    const produitNom = txt(b.produitNom);
    if (!PRODUITS.has(produitNom)) return res.status(400).json({ error: 'Produit invalide' });

    const dureeMois = parseInt(b.dureeMois, 10);
    if (!(dureeMois >= 1 && dureeMois <= 12)) return res.status(400).json({ error: 'Durée invalide' });

    const annee = parseInt(v.annee, 10);
    const puissance = parseInt(v.puissance, 10);
    const marque = txt(v.marque, 50);
    if (!marque || !(annee >= 1980 && annee <= new Date().getFullYear() + 1) || !(puissance >= 1 && puissance <= 50)) {
      return res.status(400).json({ error: 'Informations véhicule invalides' });
    }

    const nom = txt(c.nom), prenom = txt(c.prenom), telephone = txt(c.telephone, 20);
    if (!nom || !prenom || !telephone) return res.status(400).json({ error: 'Infos client incomplètes' });

    const { primeMensuelle, total } = await calculerTarif({ marque, annee, puissance, dureeMois });

    const reference = `AS${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
    const sRef = db.collection('souscriptions').doc(reference);

    await sRef.set({
      reference, userId: uid, produitNom, montant: total, statut: 'en_cours',
      clientNom: nom, clientPrenom: prenom, clientEmail: txt(c.email, 120), clientPhone: telephone,
      dureeMois, whatsapp: whatsappIntl(b.whatsapp || telephone),
      immatriculation: txt(v.immatriculation, 20).toUpperCase(),
      devis: { vehicule: { marque, modele: txt(v.modele, 50), annee, puissance }, primeMensuelle, dureeMois, total, calculeLe: new Date().toISOString() },
      dateCreation: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    const r = await initierEncaissement(
      uid,
      { amount: total, operator: b.operator, phone: b.phone || telephone, otp: b.otp, description: `Assurance ${produitNom} - ${dureeMois} mois` },
      { souscriptionRef: reference }
    );

    if (r.code !== 200) {
      const s = await sRef.get();
      if (s.exists && s.data().statut === 'en_cours') await sRef.update({ statut: 'annulee' });
      return res.status(r.code).json(r.body);
    }

    res.status(200).json({ ...r.body, reference });
  } catch (e) {
    console.error('❌ Erreur souscription assurance:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
