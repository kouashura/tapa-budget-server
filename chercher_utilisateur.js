const admin = require('firebase-admin');
const fs = require('fs');

// On charge la clé de service (celle qui est à la racine du projet)
const serviceAccount = JSON.parse(fs.readFileSync('../serviceAccountKey.json', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const auth = admin.auth();

// ⚠️ REMPLACE PAR L'EMAIL QUE TU CHERCHES
const emailAChercher = 'infosservices2015@gmail.com';

async function rechercher() {
  console.log(`🔍 Recherche pour l'email : ${emailAChercher}\n`);
  
  try {
    // Récupérer l'utilisateur par email
    const userRecord = await auth.getUserByEmail(emailAChercher);
    console.log('✅ Utilisateur trouvé :');
    console.log(`   - UID : ${userRecord.uid}`);
    console.log(`   - Email : ${userRecord.email}`);
    console.log(`   - Créé le : ${userRecord.metadata.creationTime}`);
    console.log(`   - Dernière connexion : ${userRecord.metadata.lastSignInTime}`);
    console.log(`   - Fournisseurs : ${userRecord.providerData.map(p => p.providerId).join(', ') || 'Aucun'}`);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.log('❌ Aucun utilisateur trouvé avec cet email dans Firebase Auth.');
      console.log('   (Cela signifie que l\'utilisateur existe seulement dans Firestore, pas dans Auth.)');
    } else {
      console.error('❌ Erreur :', error.message);
    }
  }
}

rechercher();
