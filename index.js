require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const app = express();

let serviceAccount;

// ✅ Priorité au Secret File sur Render
const secretPath = '/etc/secrets/serviceAccountKey.json';
const localPath = path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(secretPath)) {
  console.log('✅ Lecture du Secret File:', secretPath);
  serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
} else if (fs.existsSync(localPath)) {
  console.log('✅ Lecture du fichier local:', localPath);
  serviceAccount = JSON.parse(fs.readFileSync(localPath, 'utf8'));
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('⚠️ Fallback sur FIREBASE_SERVICE_ACCOUNT');
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
}

if (!serviceAccount) {
  console.error('❌ Aucune clé Firebase trouvée');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log('✅ Firebase Admin initialisé');

app.use(express.json());

const withdrawRoute = require('./routes/withdraw');
const webhookRoute = require('./routes/webhook_digitalpaye');
const adminWithdrawRoute = require('./routes/admin_withdraw');
const paiementRoute = require('./routes/paiement');
const payoutRoute = require('./routes/payout');

app.use('/api', withdrawRoute);
app.use('/api', webhookRoute);
app.use('/api', adminWithdrawRoute);
app.use('/api', paiementRoute);
app.use('/api', payoutRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});

// Routes de retour DigitalPaye (pour éviter l'erreur Cannot GET)
app.get('/api/paiement/success', (req, res) => {
  res.send('<h1>Paiement réussi</h1><p>Vous pouvez retourner dans l\'application TAPA Budget.</p>');
});

app.get('/api/paiement/error', (req, res) => {
  res.send('<h1>Paiement échoué ou annulé</h1><p>Vous pouvez retourner dans l\'application TAPA Budget et réessayer.</p>');
});
