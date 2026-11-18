const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');

// Charge la clé de service depuis la racine du projet
const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function migrate() {
  console.log('Début de la migration des utilisateurs...\n');
  const snapshot = await db.collection('users').get();
  console.log(`Total utilisateurs trouvés : ${snapshot.size}\n`);

  let migrated = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = doc.id;
    let email = (data.email || '').trim();
    const phone = (data.phoneNumber || '').trim();
    const hasPassword = !!data.authPassword;

    // Cas 1 : email vide mais phoneNumber contient un email
    if (!email && phone.includes('@')) {
      email = phone.toLowerCase();
    }

    // Si on n'a pas d'email, on ne peut pas migrer
    if (!email) {
      console.log(`[SKIP] ${uid} : pas d'email trouvé.`);
      skipped++;
      continue;
    }

    // Si le compte a déjà un authPassword, on skip
    if (hasPassword) {
      console.log(`[OK] ${uid} : déjà migré (authPassword existe).`);
      skipped++;
      continue;
    }

    console.log(`[MIGRATION] ${uid} (${email})`);

    // Génère un mot de passe fort
    const newPassword = crypto.randomBytes(32).toString('base64');

    // Met à jour Firebase Auth
    try {
      await admin.auth().updateUser(uid, {
        email: email,
        password: newPassword,
      });
      console.log(`   -> Firebase Auth mis à jour.`);
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        console.log(`   -> ⚠️ Firebase Auth : email déjà utilisé par un autre UID.`);
        console.log(`   -> Skip ce compte pour éviter de casser quelque chose.`);
        skipped++;
        continue;
      } else {
        console.log(`   -> ❌ Erreur Firebase Auth : ${e.message}`);
        skipped++;
        continue;
      }
    }

    // Met à jour Firestore
    await db.collection('users').doc(uid).update({
      email: email,
      phoneNumber: '',
      authPassword: newPassword,
    });
    console.log(`   -> Firestore mis à jour.\n`);
    migrated++;
  }

  console.log('\n========================================');
  console.log(`Migration terminée.`);
  console.log(`   - Comptes migrés : ${migrated}`);
  console.log(`   - Comptes ignorés : ${skipped}`);
  console.log('========================================');
}

migrate().catch(console.error);
