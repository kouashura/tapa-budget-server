const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const auth = admin.auth();

// ⚠️ On garde le PREMIER UID de chaque groupe, on supprime les autres
const aSupprimer = [
  // Comptes "Ella" - on garde 8HSouCDYTJbykNrX7dRXdYHSLXJ2
  'JjpR1DITaiNMBgySIAFXtGSeqxi2',
  'RalCRLmDdKW5boLiHrHZcjVvKWm1',
  'UOj7FiOFzGZRjeRlSCg8na4P14P2',
  'pnhwcHLlUnM8BZyOWFGlWr4etOw1',
  
  // Comptes "Kouassi" - on garde BLZ5yNLyCV5OGMt7HKcO
  'HD9Ss4Xv4Or9sLcgcN38',
  'Iegg1K0eIoWOVAnHxhNs',
  'KDs7X4ARPRowlKcJ8hZR',
  'fHo6GezEGNJA4CUOGlLG',
  'oHhguzD3IkvpcG3nFTq9',
  'omnqZKWR9Qq5CqWXigCl',
];

async function supprimerCompte(uid) {
  try {
    // 1. Supprimer le document Firestore
    await db.collection('users').doc(uid).delete();
    console.log(`✅ Firestore : document ${uid} supprimé`);
  } catch (e) {
    console.log(`⚠️ Firestore : impossible de supprimer ${uid} (peut-être déjà supprimé)`);
  }

  try {
    // 2. Supprimer le compte Firebase Auth
    await auth.deleteUser(uid);
    console.log(`✅ Auth : compte ${uid} supprimé`);
  } catch (e) {
    console.log(`⚠️ Auth : impossible de supprimer ${uid} (peut-être déjà supprimé)`);
  }
}

async function lancer() {
  console.log(`🗑️ Suppression de ${aSupprimer.length} comptes en double...\n`);
  
  for (const uid of aSupprimer) {
    console.log(`--- Suppression de ${uid} ---`);
    await supprimerCompte(uid);
    console.log('');
  }
  
  console.log('✅ Suppression terminée.');
}

lancer();
