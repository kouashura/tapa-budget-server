// server/routes/admin_withdraw.js
// Traitement ADMIN des demandes de retrait (monté sous /api/admin, protégé par requireAdmin).
//
//  GET  /api/admin/withdraws?status=pending_manual|success|failed|all
//  POST /api/admin/withdraw/:requestId/complete   { status: 'success' | 'failed', motif? }
//
//  success : le versement a été fait à la main -> demande terminée (solde déjà débité)
//  failed  : refusé / impossible -> le montant est REMBOURSÉ (une seule fois)

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

class ErreurMetier extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const iso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null);

// 📋 Liste (avec le solde ACTUEL de chaque client, pour comparer avant de valider)
router.get('/withdraws', async (req, res) => {
  try {
    const statut = String(req.query.status || 'pending_manual');
    if (!['pending_manual', 'success', 'failed', 'all'].includes(statut)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    let q = db.collection('withdraw_requests');
    if (statut !== 'all') q = q.where('status', '==', statut);
    const snapshot = await q.orderBy('requestedAt', 'desc').limit(100).get();

    const uids = [...new Set(snapshot.docs.map((d) => d.data().userId).filter(Boolean))];
    const soldes = {};
    if (uids.length) {
      const snaps = await db.getAll(...uids.map((u) => db.collection('wallets').doc(u)));
      snaps.forEach((s) => { soldes[s.id] = s.exists ? Number(s.data().solde || 0) : null; });
    }

    const requests = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        requestedAt: iso(d.requestedAt),
        completedAt: iso(d.completedAt),
        updatedAt: iso(d.updatedAt),
        soldeActuel: soldes[d.userId] !== undefined ? soldes[d.userId] : null,
      };
    });

    res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error('❌ Erreur admin withdraws:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// ✅ / ❌ Terminer une demande
router.post('/withdraw/:requestId/complete', async (req, res) => {
  const { status, motif } = req.body || {};
  if (!['success', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    const requestRef = db.collection('withdraw_requests').doc(req.params.requestId);
    const adminUid = (req.user && req.user.uid) || (req.admin && req.admin.uid) || 'admin';

    const message = await db.runTransaction(async (t) => {
      const snap = await t.get(requestRef);
      if (!snap.exists) throw new ErreurMetier(404, 'Demande non trouvée');
      const w = snap.data();
      if (w.status !== 'pending_manual') {
        throw new ErreurMetier(400, 'Cette demande a déjà été traitée');
      }

      const total = w.totalDebite != null ? w.totalDebite : w.amount;
      const dejaDebite = w.debited === true;
      const walletRef = db.collection('wallets').doc(w.userId);
      const walletSnap = await t.get(walletRef);
      const solde = walletSnap.exists ? Number(walletSnap.data().solde || 0) : 0;

      const fin = {
        completedAt: FieldValue.serverTimestamp(),
        completedBy: adminUid,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (status === 'success') {
        // Anciennes demandes jamais débitées : on débite maintenant, si le solde le permet
        if (!dejaDebite) {
          if (solde < total) {
            throw new ErreurMetier(
              400,
              `Solde insuffisant (${solde} FCFA) : cette demande n'avait pas été débitée`
            );
          }
          t.update(walletRef, { solde: solde - total, updatedAt: FieldValue.serverTimestamp() });
          t.set(db.collection('wallet_movements').doc(`${requestRef.id}_debit`), {
            userId: w.userId,
            type: 'retrait_debit',
            montant: -total,
            soldeAvant: solde,
            soldeApres: solde - total,
            withdrawId: requestRef.id,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        t.update(requestRef, { status: 'success', debited: true, ...fin });
        return 'Retrait marqué comme réussi';
      }

      // failed : remboursement SEULEMENT si de l'argent a vraiment été débité
      if (dejaDebite) {
        t.set(
          walletRef,
          { solde: FieldValue.increment(total), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
        t.set(db.collection('wallet_movements').doc(`${requestRef.id}_refund`), {
          userId: w.userId,
          type: 'retrait_remboursement',
          montant: total,
          soldeAvant: solde,
          soldeApres: solde + total,
          withdrawId: requestRef.id,
          motif: motif || null,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      t.update(requestRef, { status: 'failed', motif: motif || null, refunded: dejaDebite, ...fin });
      return dejaDebite
        ? 'Retrait refusé, montant remboursé'
        : 'Retrait refusé (aucun débit à rembourser)';
    });

    res.status(200).json({ success: true, message });
  } catch (error) {
    if (error instanceof ErreurMetier) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('❌ Erreur admin withdraw:', error);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
