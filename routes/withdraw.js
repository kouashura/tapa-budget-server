// server/routes/withdraw.js
// DEMANDE DE RETRAIT avec ENVOI AUTOMATIQUE via DigitalPaye.
//
// 1) Vérification du solde + débit + création de la demande : UNE transaction.
// 2) Envoi immédiat du payout DigitalPaye (référence enregistrée AVANT l'appel).
// 3) Le webhook (routes/webhook_digitalpaye.js) finalise : success, ou remboursement.
// En cas de doute (timeout, 5xx, solde DigitalPaye insuffisant...) : pas de remboursement
// automatique -> la demande passe en 'pending_manual' pour vérification par l'admin.
//
// Variables (toutes facultatives) :
//   RETRAIT_AUTO=true|false   RETRAIT_MIN=500  RETRAIT_MAX=500000  RETRAIT_MAX_EN_ATTENTE=3
//   RETRAIT_FRAIS_POURCENT=0  RETRAIT_FRAIS_FIXE=0

const express = require('express');
const admin = require('firebase-admin');
const requireUser = require('../middleware/requireUser');
const { createPayout } = require('../services/payout_service');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const AUTO = String(process.env.RETRAIT_AUTO || 'true').toLowerCase() !== 'false';
const MIN = Number(process.env.RETRAIT_MIN || 500);
const MAX = Number(process.env.RETRAIT_MAX || 500000);
const MAX_EN_ATTENTE = Number(process.env.RETRAIT_MAX_EN_ATTENTE || 3);
const FRAIS_POURCENT = Number(process.env.RETRAIT_FRAIS_POURCENT || 0);
const FRAIS_FIXE = Number(process.env.RETRAIT_FRAIS_FIXE || 0);
const OPERATEURS = ['ORANGE_MONEY_CI', 'MTN_MONEY_CI', 'MOOV_MONEY_CI', 'WAVE_MONEY_CI'];

// Refus "définitifs" de DigitalPaye : l'argent n'est PAS parti -> remboursement sûr
const REFUS_DEFINITIFS = [400, 404, 409, 422];

class ErreurMetier extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normaliserTelephone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00225')) d = d.slice(5);
  while (d.startsWith('225') && d.length > 10) d = d.slice(3);
  return d.length === 10 ? `+225${d}` : null;
}

// ---- Helpers : ne modifient la demande QUE si elle est encore 'processing' ----
// (si le webhook est arrivé entre-temps, on ne l'écrase pas)

async function majSiProcessing(ref, fields) {
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.data().status !== 'processing') return false;
    t.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

async function echecEtRemboursement(ref, motif) {
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.data().status !== 'processing') return false;
    const w = s.data();
    const total = w.totalDebite != null ? w.totalDebite : w.amount;
    const walletRef = db.collection('wallets').doc(w.userId);
    const ws = await t.get(walletRef);
    const solde = ws.exists ? Number(ws.data().solde || 0) : 0;

    t.set(
      walletRef,
      { solde: FieldValue.increment(total), updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    t.set(db.collection('wallet_movements').doc(`${ref.id}_refund`), {
      userId: w.userId,
      type: 'retrait_remboursement',
      montant: total,
      soldeAvant: solde,
      soldeApres: solde + total,
      withdrawId: ref.id,
      motif,
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(ref, {
      status: 'failed',
      motif,
      refunded: true,
      completedAt: FieldValue.serverTimestamp(),
      completedBy: 'auto',
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

router.post('/withdraw', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const uid = req.user.uid;

    if (body.userId && String(body.userId) !== uid) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    if (amount < MIN) return res.status(400).json({ error: `Montant minimum ${MIN} FCFA` });
    if (amount > MAX) {
      return res.status(400).json({ error: `Montant maximum ${MAX} FCFA par demande` });
    }

    const operator = String(body.operator || '').toUpperCase();
    if (!OPERATEURS.includes(operator)) {
      return res.status(400).json({ error: 'Opérateur invalide' });
    }
    if (operator === 'WAVE_MONEY_CI' && amount < 500) {
      return res.status(400).json({ error: 'Wave : montant minimum 500 FCFA' });
    }

    const phone = normaliserTelephone(body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Numéro invalide (10 chiffres, ex: 0711958528)' });
    }

    const frais = Math.round((amount * FRAIS_POURCENT) / 100) + FRAIS_FIXE;
    const totalDebite = amount + frais;

    const walletRef = db.collection('wallets').doc(uid);
    const withdrawRef = db.collection('withdraw_requests').doc();
    const externalRef = `WD_${withdrawRef.id}`;

    // ---------- 1) Vérification + débit + demande : ensemble ----------
    const resultat = await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      if (!walletSnap.exists) throw new ErreurMetier(404, 'Wallet non trouvé');

      const solde = Number(walletSnap.data().solde || 0);
      if (solde < totalDebite) throw new ErreurMetier(400, 'Solde insuffisant');

      const [a, b] = await Promise.all([
        t.get(db.collection('withdraw_requests').where('userId', '==', uid).where('status', '==', 'pending_manual')),
        t.get(db.collection('withdraw_requests').where('userId', '==', uid).where('status', '==', 'processing')),
      ]);
      const enAttente = [...a.docs, ...b.docs];
      if (enAttente.length >= MAX_EN_ATTENTE) {
        throw new ErreurMetier(
          429,
          `Trop de demandes en cours (maximum ${MAX_EN_ATTENTE}). Attends leur traitement.`
        );
      }
      const doublon = enAttente.some((d) => {
        const x = d.data();
        return x.amount === amount && x.phone === phone &&
          Date.now() - Number(x.requestedAtMs || 0) < 60000;
      });
      if (doublon) throw new ErreurMetier(409, 'Une demande identique vient d\'être envoyée.');

      const soldeApres = solde - totalDebite;
      t.update(walletRef, { solde: soldeApres, updatedAt: FieldValue.serverTimestamp() });
      t.set(withdrawRef, {
        userId: uid,
        amount,
        frais,
        totalDebite,
        phone,
        operator,
        externalRef,
        provider: 'digitalpaye',
        status: AUTO ? 'processing' : 'pending_manual',
        debited: true,
        requestedAt: FieldValue.serverTimestamp(),
        requestedAtMs: Date.now(),
      });
      t.set(db.collection('wallet_movements').doc(`${withdrawRef.id}_debit`), {
        userId: uid,
        type: 'retrait_debit',
        montant: -totalDebite,
        soldeAvant: solde,
        soldeApres,
        withdrawId: withdrawRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { soldeApres };
    });

    console.log(`✅ Retrait ${withdrawRef.id} : ${totalDebite} FCFA réservés pour ${uid} (auto=${AUTO})`);

    const reponse = (message) =>
      res.status(200).json({
        success: true,
        message,
        requestId: withdrawRef.id,
        frais,
        nouveauSolde: resultat.soldeApres,
      });

    // Mode manuel (RETRAIT_AUTO=false) : comportement d'avant
    if (!AUTO) {
      return reponse('Demande de retrait enregistrée. Le montant a été débité de ton solde.');
    }

    // ---------- 2) Envoi automatique ----------
    const p = await createPayout(amount, phone, operator, uid, externalRef);

    if (p.success) {
      await majSiProcessing(withdrawRef, { dpReference: p.reference || null, dpStatus: p.status || null });

      if (p.status === 'failed') {
        await echecEtRemboursement(withdrawRef, 'Refusé par l\'opérateur');
        return res.status(422).json({ error: 'Retrait refusé par l\'opérateur. Ton solde a été rétabli.' });
      }
      if (p.status === 'successful') {
        await majSiProcessing(withdrawRef, {
          status: 'success',
          completedAt: FieldValue.serverTimestamp(),
          completedBy: 'auto',
        });
        return reponse('Retrait effectué. L\'argent est envoyé sur ton compte mobile money.');
      }
      return reponse('Retrait en cours de traitement. Tu recevras l\'argent dans quelques instants.');
    }

    // Refus définitif : l'argent n'est pas parti -> remboursement automatique
    if (REFUS_DEFINITIFS.includes(p.httpStatus)) {
      await echecEtRemboursement(withdrawRef, p.error || 'Refusé');
      return res.status(422).json({ error: `Retrait refusé : ${p.error || 'vérifie le numéro et l\'opérateur'}. Ton solde a été rétabli.` });
    }

    // Cas incertain / problème côté marchand (403 solde DigitalPaye, 401, 429, 5xx, timeout)
    console.error(`⚠️ Retrait ${withdrawRef.id} basculé en manuel (HTTP ${p.httpStatus}): ${p.error}`);
    await majSiProcessing(withdrawRef, {
      status: 'pending_manual',
      autoError: String(p.error || '').slice(0, 300),
      autoHttpStatus: p.httpStatus,
    });
    return reponse('Demande de retrait enregistrée. Elle sera traitée sous peu.');
  } catch (error) {
    if (error instanceof ErreurMetier) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('❌ Erreur withdraw:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
