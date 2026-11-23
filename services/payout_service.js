// server/services/payout_service.js
// Envoi d'argent (payout) via DigitalPaye : POST /v1/payouts
const dp = require('./digitalpaye');

/**
 * @param {number} amount
 * @param {string} phone
 * @param {string} operator  ORANGE_MONEY_CI | MTN_MONEY_CI | MOOV_MONEY_CI | WAVE_MONEY_CI
 * @param {string} userId
 * @param {string} [externalRef] référence imposée (sinon générée)
 */
async function createPayout(amount, phone, operator, userId, externalRef) {
  const ref = externalRef || `WITHDRAW_${userId}_${Date.now()}`;
  try {
    const r = await dp.payout({
      amount,
      operatorCode: operator,
      phone,
      externalRef: ref,
      note: 'Retrait TAPA Invest',
    });

    if (!r.ok) {
      console.error('❌ Payout refusé:', r.httpStatus, r.message);
      return {
        success: false,
        httpStatus: r.httpStatus,   // 0 = pas de réponse (résultat inconnu)
        error: r.message || `Erreur DigitalPaye (${r.httpStatus})`,
        externalRef: ref,
      };
    }

    const p = r.data || {};
    const st = typeof p.status === 'object' ? p.status?.value : p.status;
    console.log('✅ Payout accepté:', p.reference, st);
    return {
      success: true,
      httpStatus: r.httpStatus,
      reference: p.reference || null,
      externalRef: ref,
      status: st || null,
      fee: p.fee ?? null,
      netSent: p.net_sent ?? null,
    };
  } catch (error) {
    console.error('❌ Erreur Payout:', error.message);
    return { success: false, httpStatus: 0, error: error.message, externalRef: ref };
  }
}

module.exports = { createPayout };
