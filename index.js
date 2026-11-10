require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const app = express();

let serviceAccount;

// ✅ Chercher le fichier secret aux emplacements possibles sur Render
const possiblePaths = [
  path.join(__dirname, 'serviceAccountKey.json'), // Racine du projet sur Render
  '/etc/secrets/serviceAccountKey.json',           // Secret File sur Render
  path.join(process.cwd(), 'serviceAccountKey.json') // Fallback
];

for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    console.log('✅ Fichier Firebase trouvé:', p);
    try {
      serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    } catch (e) {
      console.error('❌ Erreur parsing du fichier', p, ':', e.message);
    }
  }
}

// Fallback : variable d'environnement (doit être le JSON COMPLET)
if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('🔍 Tentative avec FIREBASE_SERVICE_ACCOUNT...');
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT n\'est pas un JSON valide. Vérifie qu\'il contient le fichier entier (pas juste la clé privée).');
  }
}

if (!serviceAccount) {
  console.error('❌❌❌ AUCUNE CLÉ FIREBASE VALIDE TROUVÉE ❌❌❌');
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin initialisé');
} catch (error) {
  console.error('❌ Erreur Firebase Admin:', error.message);
  process.exit(1);
}

app.use(express.json());

const withdrawRoute = require('./routes/withdraw');
const webhookRoute = require('./routes/webhook_digitalpaye');
const adminWithdrawRoute = require('./routes/admin_withdraw');
const paiementRoute = require('./routes/paiement');

app.use('/api', withdrawRoute);
app.use('/api', webhookRoute);
app.use('/api', adminWithdrawRoute);
app.use('/api', paiementRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
