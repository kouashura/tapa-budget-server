const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function lister() {
  console.log('🔍 Analyse de la collection users...\n');
  
  const snapshot = await db.collection('users').get();
  console.log(`Total utilisateurs dans Firestore : ${snapshot.size}\n`);

  // Regrouper par email
  const parEmail = {};
  snapshot.forEach((doc) => {
    const data = doc.data();
    const email = data.email || 'SANS_EMAIL';
    if (!parEmail[email]) parEmail[email] = [];
    parEmail[email].push({ id: doc.id, prenom: data.prenom });
  });

  // Afficher les doublons
  console.log('--- Doublons par email ---');
  let doublonsEmail = 0;
  for (const [email, users] of Object.entries(parEmail)) {
    if (users.length > 1) {
      doublonsEmail++;
      console.log(`\n📧 ${email} (${users.length} comptes) :`);
      users.forEach(u => console.log(`   - ID: ${u.id}, Prénom: ${u.prenom || 'N/A'}`));
    }
  }
  if (doublonsEmail === 0) console.log('   Aucun doublon par email.');

  // Regrouper par téléphone
  const parPhone = {};
  snapshot.forEach((doc) => {
    const data = doc.data();
    const phone = data.phoneNumber || 'SANS_PHONE';
    if (!parPhone[phone]) parPhone[phone] = [];
    parPhone[phone].push({ id: doc.id, prenom: data.prenom });
  });

  console.log('\n--- Doublons par téléphone ---');
  let doublonsPhone = 0;
  for (const [phone, users] of Object.entries(parPhone)) {
    if (users.length > 1 && phone !== 'SANS_PHONE') {
      doublonsPhone++;
      console.log(`\n📱 ${phone} (${users.length} comptes) :`);
      users.forEach(u => console.log(`   - ID: ${u.id}, Prénom: ${u.prenom || 'N/A'}`));
    }
  }
  if (doublonsPhone === 0) console.log('   Aucun doublon par téléphone.');
}

lister();
