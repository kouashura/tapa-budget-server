// paiementpro.js
// Client SERVEUR pour Paiement Pro (initialisation d'un paiement).
// Reprend exactement l'appel que fait leur script JS officiel
// (paiementpro.v1.0.2.js) : POST JSON vers initialize.php.
//
// .env du serveur :
//   PAIEMENTPRO_MERCHANT_ID=ton_identifiant_marchand

const axios = require('axios');
const crypto = require('crypto');

const INIT_URL =
  'https://paiementpro.net/webservice/onlinepayment/js/initialize/initialize.php';

/** Référence unique pour une transaction (obligatoire et unique chez Paiement Pro). */
function genererReference(prefixe = 'TAPA') {
  return `${prefixe}${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Initialise un paiement et renvoie l'URL de la passerelle.
 * @param {object} p
 *  amount, description, channel, referenceNumber,
 *  customerEmail, customerFirstName, customerLastname, customerPhoneNumber,
 *  [countryCurrencyCode='952'], [notificationURL], [returnURL], [returnContext]
 */
async function initierPaiement(p) {
  const merchantId = process.env.PAIEMENTPRO_MERCHANT_ID;
  if (!merchantId) {
    throw new Error('PAIEMENTPRO_MERCHANT_ID manquant dans le .env du serveur');
  }

  const obligatoires = [
    'amount',
    'description',
    'referenceNumber',
    'customerEmail',
    'customerFirstName',
    'customerLastname',
    'customerPhoneNumber',
  ];
  const manquants = obligatoires.filter(
    (k) => p[k] === undefined || p[k] === null || p[k] === ''
  );
  if (manquants.length) {
    throw new Error(`Champs obligatoires manquants : ${manquants.join(', ')}`);
  }

  const montant = Math.round(Number(p.amount));
  if (!Number.isFinite(montant) || montant <= 0) {
    throw new Error('Montant invalide');
  }

  const body = {
    merchantId,
    amount: montant,
    description: String(p.description),
    channel: String(p.channel || 'ALL'),
    countryCurrencyCode: String(p.countryCurrencyCode || '952'), // FCFA
    referenceNumber: String(p.referenceNumber),
    customerEmail: String(p.customerEmail),
    customerFirstName: String(p.customerFirstName),
    customerLastname: String(p.customerLastname),
    customerPhoneNumber: String(p.customerPhoneNumber),
    notificationURL: p.notificationURL || '',
    returnURL: p.returnURL || '',
    returnContext:
      typeof p.returnContext === 'object' && p.returnContext !== null
        ? JSON.stringify(p.returnContext)
        : p.returnContext || '',
  };

  const res = await axios.post(INIT_URL, body, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });

  const data = res.data || {};
  if (!data.success || !data.url) {
    throw new Error(
      `Paiement Pro : ${data.error || `initialisation refusée (HTTP ${res.status})`}`
    );
  }

  return { url: data.url, referenceNumber: body.referenceNumber };
}

module.exports = { initierPaiement, genererReference };

// Modes de paiement connus (confirmés par la page affichée par Paiement Pro).
// MTN / Moov / carte : pas de code confirmé -> page de sélection 'ALL'.
module.exports.CHANNELS = {
  ORANGE: 'OMCIV2',
  WAVE: 'WAVECI',
  AUTRE: 'ALL',
};
