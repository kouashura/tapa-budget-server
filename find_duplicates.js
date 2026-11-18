const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function findDuplicates() {
  console.log('Recherche des doublons (email + phoneNumber)...');
  const snapshot = await db.collection('users').get();
  const keys = {};

  snapshot.forEach(doc => {
    const data = doc.data();
    // On cherche l'identifiant unique : email OU phoneNumber
    const email = (data.email || '').trim().toLowerCase();
    const phone = (data.phoneNumber || '').trim().toLowerCase();
    const key = email || phone;
    if (!key) return;

    if (!keys[key]) keys[key] = [];
    keys[key].push({
      id: doc.id,
      role: data.role || 'user',
      prenom: data.prenom,
      email: data.email || '(vide)',
      phone: data.phoneNumber || '(vide)',
      hasPassword: !!data.authPassword,
    });
  });

  let found = false;
  for (const [key, docs] of Object.entries(keys)) {
    if (docs.length > 1) {
      found = true;
      console.log(`\nDoublon pour : ${key}`);
      docs.forEach(d => console.log(
        `   - ID: ${d.id} | role: ${d.role} | email: ${d.email} | phone: ${d.phone} | pwd: ${d.hasPassword}`
      ));
    }
  }

  if (!found) console.log('Aucun doublon trouve.');
  console.log(`\nTotal docs users: ${snapshot.size}`);
}

findDuplicates().catch(console.error);
