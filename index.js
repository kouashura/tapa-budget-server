require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const app = express();

// ✅ Initialiser Firebase Admin
let serviceAccount;
try {
  // 1. Essayer avec la variable d'environnement (si elle est bien formatée)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  // 2. Sinon, essayer avec le Secret File de Render
  else if (fs.existsSync('/etc/secrets/serviceAccountKey.json')) {
    serviceAccount = require('/etc/secrets/serviceAccountKey.json');
  }
  // 3. Sinon, essayer avec le fichier local (pour le développement)
  else if (fs.existsSync('./serviceAccountKey.json')) {
    serviceAccount = require('./serviceAccountKey.json');
  }
  
  if (!serviceAccount) {
    throw new Error('Impossible de charger la clé Firebase');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin initialisé');
} catch (error) {
  console.error('❌ Erreur Firebase Admin:', error.message);
  process.exit(1);
}

app.use(express.json());

// Importer les routes
const withdrawRoute = require('./routes/withdraw');
const webhookRoute = require('./routes/webhook_digitalpaye');
const adminWithdrawRoute = require('./routes/admin_withdraw');

// Brancher les routes
app.use('/api', withdrawRoute);
app.use('/api', webhookRoute);
app.use('/api', adminWithdrawRoute);

// ✅ Render exige d'écouter sur 0.0.0.0
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
