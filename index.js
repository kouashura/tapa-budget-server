require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const app = express();

// ✅ Initialiser Firebase Admin
let serviceAccount;
try {
  // 1. Essayer avec la clé encodée en Base64 (recommandé pour Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  }
  // 2. Sinon, essayer le Secret File
  else if (fs.existsSync('/etc/secrets/serviceAccountKey.json')) {
    serviceAccount = require('/etc/secrets/serviceAccountKey.json');
  }
  // 3. Sinon, fichier local
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

const withdrawRoute = require('./routes/withdraw');
const webhookRoute = require('./routes/webhook_digitalpaye');
const adminWithdrawRoute = require('./routes/admin_withdraw');

app.use('/api', withdrawRoute);
app.use('/api', webhookRoute);
app.use('/api', adminWithdrawRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
