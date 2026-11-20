// server/routes/paiement.js
// Encaissement via PAIEMENT PRO (remplace DigitalPaye pour les paiements entrants).
//
//  POST /api/paiement/init               -> l'app demande un lien de paiement
//  ALL  /api/paiementpro/notification    -> Paiement Pro confirme (serveur à serveur)
//  ALL  /api/paiement/retour             -> page où revient le client, renvoie vers l'app
//
// Variables .env : PAIEMENTPRO_MERCHANT_ID, [PUBLIC_BASE_URL], [PAIEMENTPRO_EMAIL_DEFAUT]

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { initierPaiement, genererReference, CHANNELS } = require('../paiementpro');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://tapa-budget-server.onrender.com';

// ⚠️ Grille de frais reprise de l'ancien système (pour que l'app affiche les
// mêmes montants). À ALIGNER avec la grille réelle de Paiement Pro.
function calculerFrais(montant, operator) {
  let pourcentage = 0;
  let fixe = 0;

  if (operator === 'WAVE_MONEY_CI') { pourcentage = 0.018; fixe = 100; }
  else if (operator === 'ORANGE_MONEY_CI') { pourcentage = 0.025; fixe = 250; }
  else if (operator === 'MTN_MONEY_CI') { pourcentage = 0.020; fixe = 250; }
  else if (operator === 'MOOV_MONEY_CI') { pourcentage = 0.025; fixe = 250; }

  return Math.round(montant * pourcentage + fixe);
}

// Orange et Wave ont un code confirmé ; les autres passent par la page de
// sélection de Paiement Pro.
function channelPour(operator) {
  if (operator === 'ORANGE_MONEY_CI') return CHANNELS.ORANGE;
  if (operator === 'WAVE_MONEY_CI') return CHANNELS.WAVE;
  return CHANNELS.AUTRE;
}

function normaliserTelephone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00225')) d = d.slice(5);
  else if (d.startsWith('225') && d.length > 10) d = d.slice(3);
  return d;
}

function tokenOk(recu, attendu) {
  const a = Buffer.from(String(recu));
  const b = Buffer.from(String(attendu));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================
// 1. INITIALISATION
// ============================================
router.post('/paiement/init', async (req, res) => {
  const { userId, amount, operator, phone, description, sourceWalletId } =
    req.body || {};

  try {
    if (!userId || !amount || !operator || !phone) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const uid = String(userId);
    const montant = Math.round(Number(amount));
    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    const frais = calculerFrais(montant, operator);
    const montantNet = montant - frais;
    if (montantNet <= 0) {
      return res.status(400).json({ error: 'Montant trop faible' });
    }

    const tel = normaliserTelephone(phone);
    if (tel.length < 8) {
      return res.status(400).json({ error: 'Numéro de téléphone invalide' });
    }

    // Le portefeuille à débiter doit appartenir à l'utilisateur
    if (sourceWalletId) {
      const src = await db.collection('user_wallet').doc(String(sourceWalletId)).get();
      if (src.exists) {
        const proprio = src.data().uid || src.data().userId;
        if (proprio && proprio !== uid) {
          return res.status(403).json({ error: 'Portefeuille source non autorisé' });
        }
      }
    }

    // Infos client exigées par Paiement Pro
    const userDoc = await db.collection('users').doc(uid).get();
    const u = userDoc.exists ? userDoc.data() : {};
    if (!userDoc.exists) console.warn('⚠️ Profil introuvable pour', uid);
    const prenom = String(u.prenom || 'Client').replace(/"/g, '');
    const email = u.email || process.env.PAIEMENTPRO_EMAIL_DEFAUT || 'client@tapa-invest.com';

    const externalRef = genererReference('TP');
    const notifToken = crypto.randomBytes(24).toString('hex');
    const txRef = db.collection('transactions').doc(externalRef);

    // On enregistre AVANT d'appeler Paiement Pro : la notification trouvera toujours la ligne
    await txRef.set({
      userId: uid,
      amount: montant,
      frais,
      montantNet,
      operator,
      phone: tel,
      externalRef,
      reference: externalRef,
      sourceWalletId: sourceWalletId || null,
      provider: 'paiementpro',
      notifToken,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });

    let resultat;
    try {
      resultat = await initierPaiement({
        amount: montant,
        description: description || 'Rechargement TAPA Invest',
        channel: channelPour(operator),
        referenceNumber: externalRef,
        customerEmail: email,
        customerFirstName: prenom,
        customerLastname: u.nom || 'Client',
        customerPhoneNumber: tel,
        notificationURL: `${BASE_URL}/api/paiementpro/notification?t=${notifToken}`,
        returnURL: `${BASE_URL}/api/paiement/retour?ref=${externalRef}`,
        returnContext: { ref: externalRef },
      });
    } catch (e) {
      await txRef.update({ status: 'init_failed', updatedAt: FieldValue.serverTimestamp() });
      throw e;
    }

    res.status(200).json({
      success: true,
      externalRef,
      reference: externalRef,
      checkoutUrl: resultat.url,
    });
  } catch (error) {
    console.error('❌ Erreur init paiement:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 2. NOTIFICATION (serveur Paiement Pro -> notre serveur)
// ============================================

// Crédit atomique et idempotent : une même notification reçue 2 fois ne crédite qu'une fois.
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

    // Toutes les lectures sont faites : on écrit
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

async function changerStatutSiPending(txRef, status) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(txRef);
    if (!snap.exists || snap.data().status !== 'pending') return false;
    t.update(txRef, { status, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

router.all('/paiementpro/notification', async (req, res) => {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const token = String((req.query || {}).t || '');

    // Journal du format réel (sans le jeton) : utile au premier vrai test
    console.log(
      '📩 Paiement Pro notification:',
      req.method,
      req.headers['content-type'] || '-',
      JSON.stringify({ ...p, t: undefined })
    );

    const ref = String(p.referenceNumber || '');
    if (!ref) return res.status(400).json({ error: 'referenceNumber manquant' });

    const txRef = db.collection('transactions').doc(ref);
    const snap = await txRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Transaction inconnue' });
    const tx = snap.data();

    // Seul Paiement Pro connaît l'URL (avec son jeton unique) : on refuse le reste
    if (tx.provider !== 'paiementpro' || !tx.notifToken || !tokenOk(token, tx.notifToken)) {
      console.warn('🚫 Notification refusée (jeton invalide) pour', ref);
      return res.status(403).json({ error: 'Notification non autorisée' });
    }

    const code = String(p.responsecode !== undefined ? p.responsecode : p.responseCode);
    const montantRecu = p.amount !== undefined ? Number(p.amount) : null;

    if (code === '0') {
      if (montantRecu !== null && montantRecu !== tx.amount) {
        console.error(`🚨 Montant différent: reçu ${montantRecu}, attendu ${tx.amount} (${ref})`);
        await changerStatutSiPending(txRef, 'amount_mismatch');
        return res.status(200).json({ received: true, credited: false });
      }
      const credite = await crediter(txRef);
      console.log(credite ? `✅ Paiement ${ref} crédité` : `ℹ️ Paiement ${ref} déjà traité`);
      return res.status(200).json({ received: true, credited: credite });
    }

    if (code === '-1') {
      await changerStatutSiPending(txRef, 'failed');
      console.log(`❌ Paiement ${ref} échoué`);
      return res.status(200).json({ received: true, credited: false });
    }

    console.warn('⚠️ responsecode inattendu:', code);
    res.status(200).json({ received: true, ignored: true });
  } catch (error) {
    console.error('❌ Erreur notification Paiement Pro:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ============================================
// 3. RETOUR DU CLIENT -> redirige vers l'app (ne crédite JAMAIS rien)
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
