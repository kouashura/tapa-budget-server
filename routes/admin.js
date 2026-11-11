const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// Middleware de sécurité (à utiliser sur toutes les routes admin)
// ⚠️ Pour l'instant, on vérifie juste un header secret. En production, utilise un vrai système d'auth.
const checkAdmin = (req, res, next) => {
  const adminKey = req.headers['x-admin-token'];
  if (adminKey !== 'TAPA_ADMIN_SECRET_2026') {
    return res.status(403).json({ error: 'Accès refusé. Clé admin invalide.' });
  }
  next();
};

router.use(checkAdmin);

// --- 1. GESTION DES RETRAITS ---

// Lister les retraits en attente
router.get('/withdraws', async (req, res) => {
  try {
    const snapshot = await db.collection('withdraw_requests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'desc')
      .get();
    
    const withdraws = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(withdraws);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approuver ou rejeter un retrait
router.post('/withdraws/:id', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' ou 'reject'

  try {
    const withdrawRef = db.collection('withdraw_requests').doc(id);
    const doc = await withdrawRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Retrait non trouvé' });

    const data = doc.data();
    if (data.status !== 'pending') return res.status(400).json({ error: 'Déjà traité' });

    if (action === 'approve') {
      // Mettre à jour le statut du retrait
      await withdrawRef.update({ status: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      
      // Note: L'argent a déjà été déduit lors de la demande. On n'a rien à faire de plus.
      // Si tu veux déclencher le vrai virement DigitalPaye ici, c'est là qu'il faut le faire.
      
    } else if (action === 'reject') {
      // Rembourser l'utilisateur
      const walletRef = db.collection('user_wallet').doc(data.userId);
      const walletDoc = await walletRef.get();
      const currentBalance = walletDoc.data()?.solde || 0;
      
      await walletRef.update({
        solde: currentBalance + data.amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      await withdrawRef.update({ status: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.json({ success: true, message: `Retrait ${action === 'approve' ? 'approuvé' : 'rejeté'}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- 2. GESTION DES SOUSCRIPTIONS ---
// (À compléter selon ta structure de données)
router.get('/souscriptions', async (req, res) => {
  // ...
  res.json({ message: "Liste des souscriptions" });
});


// --- 3. GESTION DES UTILISATEURS ---
router.get('/users', async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// --- 4. DÉTAILS COMPLETS D'UN UTILISATEUR ---
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Infos profil utilisateur
    const userDoc = await db.collection('users').doc(id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    const userData = userDoc.data();

    // 2. Tous les portefeuilles (Wave, Orange, etc.)
    const walletsSnapshot = await db.collection('user_wallet').where('userId', '==', id).get();
    const wallets = walletsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 3. Le Wallet TAPA principal
    let mainWallet = null;
    const mainWalletQuery = await db.collection('wallets').where('userId', '==', id).limit(1).get();
    if (!mainWalletQuery.empty) {
      const doc = mainWalletQuery.docs[0];
      mainWallet = { id: doc.id, ...doc.data() };
    }

    // 4. Les transactions
    const txSnapshot = await db.collection('transactions').where('uid', '==', id).orderBy('dateTransaction', 'desc').limit(10).get();
    const transactions = txSnapshot.docs.map(doc => {
      const data = doc.data();
      
      // Gestion robuste des dates (String, Timestamp Firebase, ou null)
      let dateStr = null;
      if (data.dateTransaction) {
        try {
          if (typeof data.dateTransaction.toDate === 'function') {
            // C'est un Timestamp Firebase
            dateStr = data.dateTransaction.toDate().toISOString();
          } else if (typeof data.dateTransaction === 'string') {
            // C'est déjà une chaîne
            dateStr = data.dateTransaction;
          } else if (data.dateTransaction._seconds) {
            // C'est un objet {_seconds, _nanoseconds}
            dateStr = new Date(data.dateTransaction._seconds * 1000).toISOString();
          }
        } catch (e) {
          console.log('Erreur parsing date tx:', e.message);
        }
      }

      return {
        id: doc.id,
        ...data,
        amount: data.montant || 0,
        createdAt: dateStr,
      };
    });

    // 5. Les contrats SONAM (recherche par email car pas de uid à la racine)
    let sonamContracts = [];
    try {
      if (userData.email) {
        const sonamQuery = await db.collection('sonam_contracts')
          .where('assure.email', '==', userData.email)
          .get();
        sonamContracts = sonamQuery.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log(`Trouvé ${sonamContracts.length} contrats SONAM pour ${userData.email}`);
      }
    } catch (e) {
      console.error('Erreur lecture sonam_contracts:', e.message);
    }

    // 6. Les souscriptions
    let souscriptions = [];
    try {
      const subQuery = await db.collection('souscriptions').where('uid', '==', id).get();
      souscriptions = subQuery.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (e) { console.log('Erreur lecture souscriptions:', e.message); }

    res.json({
      success: true,
      user: { id: userDoc.id, ...userData },
      wallets: wallets,
      mainWallet: mainWallet,
      transactions: transactions,
      sonamContracts: sonamContracts,
      souscriptions: souscriptions
    });
  } catch (error) {
    console.error('Erreur détails user:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
