const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// Liste des UID des comptes "Ella" à vérifier
const uidsElla = [
  '8HSouCDYTJbykNrX7dRXdYHSLXJ2',
  'JjpR1DITaiNMBgySIAFXtGSeqxi2',
  'RalCRLmDdKW5boLiHrHZcjVvKWm1',
  'UOj7FiOFzGZRjeRlSCg8na4P14P2',
  'pnhwcHLlUnM8BZyOWFGlWr4etOw1',
];

// Liste des UID des comptes "Kouassi" à vérifier (optionnel)
const uidsKouassi = [
  'BLZ5yNLyCV5OGMt7HKcO',
  'HD9Ss4Xv4Or9sLcgcN38',
  'Iegg1K0eIoWOVAnHxhNs',
  'KDs7X4ARPRowlKcJ8hZR',
  'fHo6GezEGNJA4CUOGlLG',
  'oHhguzD3IkvpcG3nFTq9',
  'omnqZKWR9Qq5CqWXigCl',
];

async function verifierCompte(uid) {
  const resultats = {
    uid,
    transactions: 0,
    wallets: 0,
    userWallet: 0,
    sonamContracts: 0,
    withdrawRequests: 0,
    total: 0,
  };

  try {
    // Vérifier les transactions
    const txSnapshot = await db.collection('transactions').where('uid', '==', uid).get();
    resultats.transactions = txSnapshot.size;
    resultats.total += txSnapshot.size;

    // Vérifier les wallets
    const walletsSnapshot = await db.collection('wallets').where('userId', '==', uid).get();
    resultats.wallets = walletsSnapshot.size;
    resultats.total += walletsSnapshot.size;

    // Vérifier user_wallet
    const uwSnapshot = await db.collection('user_wallet').where('userId', '==', uid).get();
    resultats.userWallet = uwSnapshot.size;
    resultats.total += uwSnapshot.size;

    // Vérifier les contrats SONAM
    const sonamSnapshot = await db.collection('sonam_contracts').where('userId', '==', uid).get();
    resultats.sonamContracts = sonamSnapshot.size;
    resultats.total += sonamSnapshot.size;

    // Vérifier les demandes de retrait
    const wrSnapshot = await db.collection('withdraw_requests').where('userId', '==', uid).get();
    resultats.withdrawRequests = wrSnapshot.size;
    resultats.total += wrSnapshot.size;

  } catch (e) {
    console.error(`Erreur pour ${uid}:`, e.message);
  }

  return resultats;
}

async function analyser() {
  console.log('🔍 Analyse des comptes en double...\n');

  console.log('=== COMPTES "ELLA" ===\n');
  for (const uid of uidsElla) {
    const res = await verifierCompte(uid);
    console.log(`UID : ${res.uid}`);
    console.log(`  - Transactions : ${res.transactions}`);
    console.log(`  - Wallets : ${res.wallets}`);
    console.log(`  - User Wallet : ${res.userWallet}`);
    console.log(`  - Contrats SONAM : ${res.sonamContracts}`);
    console.log(`  - Demandes de retrait : ${res.withdrawRequests}`);
    console.log(`  => TOTAL données : ${res.total}`);
    console.log(res.total > 0 ? '  ⚠️  DONNÉES PRÉSENTES - À GARDER' : '  ✅ Aucune donnée - Sûr à supprimer');
    console.log('');
  }

  console.log('=== COMPTES "KOUASSI" ===\n');
  for (const uid of uidsKouassi) {
    const res = await verifierCompte(uid);
    console.log(`UID : ${res.uid}`);
    console.log(`  - Transactions : ${res.transactions}`);
    console.log(`  - Wallets : ${res.wallets}`);
    console.log(`  - User Wallet : ${res.userWallet}`);
    console.log(`  - Contrats SONAM : ${res.sonamContracts}`);
    console.log(`  - Demandes de retrait : ${res.withdrawRequests}`);
    console.log(`  => TOTAL données : ${res.total}`);
    console.log(res.total > 0 ? '  ⚠️  DONNÉES PRÉSENTES - À GARDER' : '  ✅ Aucune donnée - Sûr à supprimer');
    console.log('');
  }
}

analyser();
