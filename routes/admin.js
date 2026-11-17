const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const db = admin.firestore();

// --- 2. GESTION DES SOUSCRIPTIONS ---
// (À compléter selon ta structure de données)
router.get('/souscriptions', async (req, res) => {
  // ...
  res.json({ message: "Liste des souscriptions" });
});


// --- 3. GESTION DES UTILISATEURS ---
router.get('/users', async (req, res) => {
  try {
    const SENSITIVE = ['pinCode', 'pinHash', 'password', 'refreshToken'];
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => {
      const data = doc.data();
      SENSITIVE.forEach(f => delete data[f]);
      return { id: doc.id, ...data };
    });
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
    ['pinCode', 'pinHash', 'password', 'refreshToken'].forEach(f => delete userData[f]);

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
