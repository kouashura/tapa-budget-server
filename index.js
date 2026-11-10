require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const app = express();

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    throw new Error('Variable FIREBASE_SERVICE_ACCOUNT manquante');
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
const paiementRoute = require('./routes/paiement');
const webhookRoute = require('./routes/webhook_digitalpaye');
const adminWithdrawRoute = require('./routes/admin_withdraw');

app.use('/api', withdrawRoute);
app.use('/api', webhookRoute);
app.use('/api', adminWithdrawRoute);
app.use('/api', paiementRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
