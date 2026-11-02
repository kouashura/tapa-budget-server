require('dotenv').config();
// server/index.js
const express = require('express');
const admin = require('firebase-admin');
const app = express();

// Initialiser Firebase Admin
// ✅ Sur Render, on utilise la variable d'environnement FIREBASE_SERVICE_ACCOUNT
// En local, on utilise le fichier serviceAccountKey.json
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
