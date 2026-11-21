// server/routes/withdraw.js
// DEMANDE DE RETRAIT (versement manuel par l'admin).
//
// Principe : l'argent est RÉSERVÉ (débité) dès la demande. Vérification du solde,
// débit et création de la demande se font dans UNE SEULE transaction : impossible
// de dépenser deux fois le même argent avec plusieurs demandes.
//
// Réglages (variables d'environnement, tous facultatifs) :
//   RETRAIT_MIN=500  RETRAIT_MAX=500000  RETRAIT_MAX_EN_ATTENTE=3
//   RETRAIT_FRAIS_POURCENT=0  RETRAIT_FRAIS_FIXE=0

const express = require('express');
const admin = require('firebase-admin');
const requireUser = require('../middleware/requireUser');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const MIN = Number(process.env.RETRAIT_MIN || 500);
const MAX = Number(process.env.RETRAIT_MAX || 500000);
const MAX_EN_ATTENTE = Number(process.env.RETRAIT_MAX_EN_ATTENTE || 3);
const FRAIS_POURCENT = Number(process.env.RETRAIT_FRAIS_POURCENT || 0);
const FRAIS_FIXE = Number(process.env.RETRAIT_FRAIS_FIXE || 0);
const OPERATEURS = ['ORANGE_MONEY_CI', 'MTN_MONEY_CI', 'MOOV_MONEY_CI', 'WAVE_MONEY_CI'];

class ErreurMetier extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Accepte +2250711958528, 2250711958528, 0711958528... -> +2250711958528
function normaliserTelephone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00225')) d = d.slice(5);
  while (d.startsWith('225') && d.length > 10) d = d.slice(3);
  return d.length === 10 ? `+225${d}` : null;
}

router.post('/withdraw', requireUser, async (req, res) => {
  try {
    const body = req.body || {};
    const uid = req.user.uid;

    // On ne retire que sur SON propre portefeuille
    if (body.userId && String(body.userId) !== uid) {
      return res.status(403).json({ error: 'Action non autorisée' });
    }

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    if (amount < MIN) {
      return res.status(400).json({ error: `Montant minimum ${MIN} FCFA` });
    }
    if (amount > MAX) {
      return res.status(400).json({ error: `Montant maximum ${MAX} FCFA par demande` });
    }

    const operator = String(body.operator || '').toUpperCase();
    if (!OPERATEURS.includes(operator)) {
      return res.status(400).json({ error: 'Opérateur invalide' });
    }

    const phone = normaliserTelephone(body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Numéro invalide (10 chiffres, ex: 0711958528)' });
    }

    const frais = Math.round((amount * FRAIS_POURCENT) / 100) + FRAIS_FIXE;
    const totalDebite = amount + frais;

    const walletRef = db.collection('wallets').doc(uid);

    const resultat = await db.runTransaction(async (t) => {
      // --- Lectures ---
      const walletSnap = await t.get(walletRef);
      if (!walletSnap.exists) throw new ErreurMetier(404, 'Wallet non trouvé');

      const solde = Number(walletSnap.data().solde || 0);
      if (solde < totalDebite) throw new ErreurMetier(400, 'Solde insuffisant');

      const enAttente = await t.get(
        db.collection('withdraw_requests')
          .where('userId', '==', uid)
          .where('status', '==', 'pending_manual')
      );
      if (enAttente.size >= MAX_EN_ATTENTE) {
        throw new ErreurMetier(
          429,
          `Trop de demandes en attente (maximum ${MAX_EN_ATTENTE}). Attends leur traitement.`
        );
      }
      const doublon = enAttente.docs.some((d) => {
        const x = d.data();
        return x.amount === amount && x.phone === phone &&
          Date.now() - Number(x.requestedAtMs || 0) < 60000;
      });
      if (doublon) {
        throw new ErreurMetier(409, 'Une demande identique vient d\'être envoyée.');
      }

      // --- Écritures : débit + demande + historique, ensemble ---
      const soldeApres = solde - totalDebite;
      const withdrawRef = db.collection('withdraw_requests').doc();

      t.update(walletRef, { solde: soldeApres, updatedAt: FieldValue.serverTimestamp() });
      t.set(withdrawRef, {
        userId: uid,
        amount,
        frais,
        totalDebite,
        phone,
        operator,
        status: 'pending_manual',
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

      return { id: withdrawRef.id, soldeApres };
    });

    console.log(`✅ Retrait ${resultat.id} : ${totalDebite} FCFA réservés pour ${uid}`);
    res.status(200).json({
      success: true,
      message: 'Demande de retrait enregistrée. Le montant a été débité de ton solde.',
      requestId: resultat.id,
      frais,
      nouveauSolde: resultat.soldeApres,
    });
  } catch (error) {
    if (error instanceof ErreurMetier) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('❌ Erreur withdraw:', error);
    res.status(500).json({ error: 'Erreur interne du serveur' });
  }
});

module.exports = router;
