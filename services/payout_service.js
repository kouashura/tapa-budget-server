// server/services/payout_service.js
const DigitalPaye = require('digitalpaye-node');

// Initialisation avec les clés stockées en variables d'environnement
const dp = new DigitalPaye(
  process.env.DP_PUBLIC_KEY,
  process.env.DP_SECRET
);

/**
 * Envoie de l'argent vers un compte Mobile Money
 * @param {number} amount - Montant en FCFA
 * @param {string} phone - Numéro au format international (+225XXXXXXXXXX)
 * @param {string} operator - 'WAVE', 'ORANGE', 'MTN', 'MOOV'
 * @param {string} userId - ID de l'utilisateur (pour la transaction)
 */
async function createPayout(amount, phone, operator, userId) {
  try {
    const externalRef = `WITHDRAW_${userId}_${Date.now()}`;

    // Appel au SDK DigitalPaye
    const payout = await dp.payouts.create({
      amount: amount,
      currency: 'XOF',
      operator_code: operator,
      external_ref: externalRef,
      recipient_phone: phone,
    });

    console.log('✅ Payout initié:', payout);
    return {
      success: true,
      reference: payout.reference,
      externalRef: externalRef,
    };
  } catch (error) {
    console.error('❌ Erreur Payout:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = { createPayout };
