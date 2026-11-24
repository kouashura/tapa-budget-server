// server/routes/paiement.js
// Encaissement via DIGITALPAYE (remplace Paiement Pro).
//
//  POST /api/paiement/init   -> l'app lance un paiement (Wave: lien, MTN/Moov: push, Orange: OTP)
//  ALL  /api/paiement/retour -> page où revient le client (Wave), renvoie vers l'app
//  Confirmation              -> routes/webhook_digitalpaye.js (signé HMAC)
//
// Variables : DP_PUBLIC_KEY, DP_SECRET, DP_WEBHOOK_SECRET, [PUBLIC_BASE_URL]

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const requireUser = require('../middleware/requireUser');
const dp = require('../services/digitalpaye');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://tapa-budget-server.onrender.com';

// Frais d'encaissement = frais RÉELS DigitalPaye (grille du compte), par opérateur.
// Le client est crédité de : montant - frais  =>  TAPA ne perd rien.
// Taux en points de base (1,8 % = 180) : pas d'erreur d'arrondi des décimaux.
const FRAIS_OPERATEURS = {
  WAVE:   { bp: 180, fixe: 100 }, // 1,8 % + 100 FCFA
  ORANGE: { bp: 250, fixe: 0 },   // 2,5 %
  MTN:    { bp: 200, fixe: 0 },   // 2 %
  MOOV:   { bp: 250, fixe: 0 },   // 2,5 %
};
// Marge TAPA optionnelle en points de base (ex: 50 = +0,5 %). Défaut : aucune.
// ⚠️ Si tu l'utilises, les taux de l'app (wallet_screen.dart) doivent être augmentés pareil.
const MARGE_BP = Number(process.env.ENCAISSEMENT_MARGE_BP || 0);
const MONTANT_MIN = Number(process.env.ENCAISSEMENT_MIN || 500);
const MONTANT_MAX = 2000000; // plafond DigitalPaye

function calculerFrais(montant, op) {
  const f = FRAIS_OPERATEURS[op] || FRAIS_OPERATEURS.ORANGE;
  return Math.round((montant * (f.bp + MARGE_BP)) / 10000) + f.fixe;
}

function calculerNet(montant, op) {
  return montant - calculerFrais(montant, op);
}

const OP_CODES = {
  ORANGE: 'ORANGE_MONEY_CI',
  MTN: 'MTN_MONEY_CI',
  WAVE: 'WAVE_MONEY_CI',
  MOOV: 'MOOV_MONEY_CI', // code non documenté : à confirmer auprès de DigitalPaye
};

function normaliserOperateur(op) {
  const o = String(op || '').toUpperCase();
  if (o.includes('ORANGE') || o.startsWith('OMCI')) return 'ORANGE';
  if (o.includes('WAVE')) return 'WAVE';
  if (o.includes('MTN') || o.includes('MOMO')) return 'MTN';
  if (o.includes('MOOV') || o.includes('FLOOZ')) return 'MOOV';
  return null;
}

function normaliserTelephone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00225')) d = d.slice(5);
  else if (d.startsWith('225') && d.length > 10) d = d.slice(3);
  return d;
}

function genererReference(prefixe = 'TP') {
  return `${prefixe}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
}

// ============================================
// Crédit atomique et idempotent (inchangé)
// ============================================
async function crediter(txRef) {
  return db.runTransaction(async (t) => {
    const txSnap = await t.get(txRef);
    if (!txSnap.exists) return false;
    const tx = txSnap.data();
    if (tx.status !== 'pending') return false;

    const net = tx.montantNet != null ? tx.montantNet : tx.amount;
    const walletRef = db.collection('wallets').doc(tx.userId);

    let sourceRef = null;
    let sourceSnap = null;
    if (tx.sourceWalletId) {
      sourceRef = db.collection('user_wallet').doc(tx.sourceWalletId);
      sourceSnap = await t.get(sourceRef);
    }

    t.set(
      walletRef,
      { solde: FieldValue.increment(net), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    if (sourceSnap && sourceSnap.exists) {
      const solde = Number(sourceSnap.data().solde || 0);
      t.update(sourceRef, {
        solde: Math.max(0, solde - net),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    t.update(txRef, {
      status: 'success',
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

async function changerStatutSiPending(txRef, status, extra = {}) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(txRef);
    if (!snap.exists || snap.data().status !== 'pending') return false;
    t.update(txRef, { status, ...extra, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

// ============================================
// 1. INITIALISATION
// ============================================
router.post('/paiement/init', requireUser, async (req, res) => {
  const { userId, amount, operator, phone, description, sourceWalletId, otp } = req.body || {};

  try {
    const uid = req.user.uid;
    if (userId && String(userId) !== uid) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }
    if (!amount || !operator || !phone) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const montant = Math.round(Number(amount));
    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    if (montant < MONTANT_MIN) {
      return res.status(400).json({ error: `Montant minimum ${MONTANT_MIN} FCFA` });
    }
    if (montant > MONTANT_MAX) {
      return res.status(400).json({ error: `Montant maximum ${MONTANT_MAX} FCFA` });
    }

    const op = normaliserOperateur(operator);
    if (!op) return res.status(400).json({ error: 'Opérateur invalide' });

    if (op === 'ORANGE' && !/^\d{4}$/.test(String(otp || ''))) {
      return res.status(400).json({ error: 'Code OTP Orange (4 chiffres) requis' });
    }

    const montantNet = calculerNet(montant, op);
    const frais = montant - montantNet;
    if (montantNet <= 0) return res.status(400).json({ error: 'Montant trop faible' });

    const tel = normaliserTelephone(phone);
    if (tel.length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide' });

    if (sourceWalletId) {
      const src = await db.collection('user_wallet').doc(String(sourceWalletId)).get();
      if (src.exists) {
        const proprio = src.data().uid || src.data().userId;
        if (proprio && proprio !== uid) {
          return res.status(403).json({ error: 'Portefeuille source non autorisé' });
        }
      }
    }

    const userDoc = await db.collection('users').doc(uid).get();
    const u = userDoc.exists ? userDoc.data() : {};
    const prenom = String(u.prenom || 'Client').replace(/"/g, '');
    const nom = String(u.nom || 'Client').replace(/"/g, '');

    const externalRef = genererReference('TP');
    const txRef = db.collection('transactions').doc(externalRef);

    // On enregistre AVANT d'appeler DigitalPaye : le webhook trouvera toujours la ligne
    await txRef.set({
      userId: uid,
      amount: montant,
      frais,
      montantNet,
      operator: op,
      phone: tel,
      externalRef,
      reference: externalRef,
      sourceWalletId: sourceWalletId || null,
      provider: 'digitalpaye',
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });

    const retour = `${BASE_URL}/api/paiement/retour?ref=${externalRef}`;
    const r = await dp.collect({
      amount: montant,
      operatorCode: OP_CODES[op],
      phone: tel,
      otp: op === 'ORANGE' ? String(otp) : undefined,
      externalRef,
      firstName: prenom,
      lastName: nom,
      uid,
      note: description || 'Rechargement TAPA Invest',
      successUrl: op === 'WAVE' ? retour : undefined,
      errorUrl: op === 'WAVE' ? retour : undefined,
    });

    const d = r.data || {};
    const st = d.status && d.status.value;
    if (d.reference) await txRef.update({ dpReference: d.reference });

    // Refus immédiat (ex : OTP incorrect, solde insuffisant chez le client...)
    if (!r.ok || st === 'failed') {
      const msg = (d.status && d.status.failure_reason) || r.message || 'Paiement refusé';
      await changerStatutSiPending(txRef, 'failed', { error: msg });
      console.warn(`❌ Collect refusé ${externalRef}: ${msg}`);
      return res.status(422).json({ error: msg });
    }

    // Orange peut répondre "successful" tout de suite
    let confirme = false;
    if (st === 'successful') {
      const charged = d.amounts && d.amounts.charged;
      if (charged !== undefined && Number(charged) !== montant) {
        console.error(`🚨 Montant différent: ${charged} vs ${montant} (${externalRef})`);
        await changerStatutSiPending(txRef, 'amount_mismatch');
      } else {
        await crediter(txRef);
        confirme = true;
      }
    }

    res.status(200).json({
      success: true,
      externalRef,
      reference: externalRef,
      checkoutUrl: d.wave_launch_url || null, // Wave uniquement
      status: confirme ? 'success' : 'pending',
      pending: !confirme,                     // MTN/Moov: valider sur le téléphone
    });
  } catch (error) {
    console.error('❌ Erreur init paiement:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 2. RETOUR DU CLIENT (Wave) -> redirige vers l'app. Ne crédite JAMAIS rien.
// ============================================
router.all('/paiement/retour', (req, res) => {
  const ref = String((req.query || {}).ref || '').replace(/[^A-Za-z0-9]/g, '');
  const lien = 'tapa://wallet' + (ref ? `?ref=${ref}` : '');

  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TAPA Invest</title>
<style>
body{font-family:sans-serif;background:#0B1F3A;color:#fff;display:flex;min-height:100vh;
align-items:center;justify-content:center;margin:0;text-align:center;padding:24px}
a{display:inline-block;margin-top:24px;padding:14px 28px;background:#D4AF37;color:#0B1F3A;
border-radius:12px;font-weight:700;text-decoration:none}
</style></head><body><div>
<h2>Paiement envoyé</h2>
<p>Retourne dans l'application : ton solde sera mis à jour dès que le paiement est confirmé.</p>
<a href="${lien}">Retourner dans TAPA Invest</a>
</div>
<script>setTimeout(function(){location.href='${lien}'},800);</script>
</body></html>`);
});

module.exports = router;
module.exports.crediter = crediter;
module.exports.changerStatutSiPending = changerStatutSiPending;
