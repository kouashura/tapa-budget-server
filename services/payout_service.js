// server/services/payout_service.js

let dp = null;

function getDigitalPaye() {
  if (dp) return dp;

  const publicKey = process.env.DP_PUBLIC_KEY;
  const secret = process.env.DP_SECRET;

  if (!publicKey || !secret) {
    throw new Error('DigitalPaye: DP_PUBLIC_KEY et DP_SECRET doivent être configurés dans les variables d\'environnement de Render.');
  }

  const DigitalPaye = require('digitalpaye-node');
  dp = new DigitalPaye({ publicKey, secret });
  return dp;
}

async function createPayout(amount, phone, operator, userId) {
  try {
    const client = getDigitalPaye(); // Lève une erreur claire si les clés manquent
    const externalRef = `WITHDRAW_${userId}_${Date.now()}`;

    const payout = await client.payouts.create({
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
