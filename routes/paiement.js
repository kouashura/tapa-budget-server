const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

let dp = null;
function getDigitalPaye() {
  if (dp) return dp;
  
  const publicKey = process.env.DP_PUBLIC_KEY;
  const secret = process.env.DP_SECRET;
  
  if (!publicKey || !secret) {
    throw new Error('DigitalPaye: DP_PUBLIC_KEY et DP_SECRET doivent être configurés.');
  }
  
  const DigitalPaye = require('digitalpaye-node');
  dp = new DigitalPaye({ publicKey, secret });
  return dp;
}


// ✅ Grille tarifaire DigitalPaye
function calculerFrais(montant, operator) {
  let pourcentage = 0;
  let fixe = 0;
  
  if (operator === 'WAVE_MONEY_CI') { pourcentage = 0.018; fixe = 100; }
  else if (operator === 'ORANGE_MONEY_CI') { pourcentage = 0.025; fixe = 250; }
  else if (operator === 'MTN_MONEY_CI') { pourcentage = 0.020; fixe = 250; }
  else if (operator === 'MOOV_MONEY_CI') { pourcentage = 0.025; fixe = 250; }
  
  return Math.round((montant * pourcentage) + fixe);
}

router.post('/paiement/init', async (req, res) => {
  const { userId, amount, operator, phone, description, sourceWalletId } = req.body;

  try {
    if (!userId || !amount || !operator || !phone) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const externalRef = `COLLECT_${userId}_${Date.now()}`;
    const client = getDigitalPaye();

    const link = await client.paymentLinks.create({
      label: description || 'Rechargement TAPA Budget',
      amount: amount,
      currency: 'XOF',
      operator_code: operator,
      external_ref: externalRef,
      payer_phone: phone,
      url_success: 'https://tapa-budget-server.onrender.com/api/paiement/success',
      url_error: 'https://tapa-budget-server.onrender.com/api/paiement/error'
    });

    // ✅ On récupère la référence EXACTE de DigitalPaye
    const digitalPayeReference = link.data?.reference;
    if (!digitalPayeReference) {
      console.log('⚠️ Attention: DigitalPaye n\'a pas renvoyé de référence');
    }

    // ✅ Sécurisation de l'URL de checkout
    const checkoutUrl = link.data?.url || link.data?.payment_url || link.data?.checkout_url;

    if (!checkoutUrl) {
      console.error('⚠️ Structure de réponse inattendue:', JSON.stringify(link));
      return res.status(500).json({ 
        error: 'URL de paiement introuvable dans la réponse de DigitalPaye',
        debug: link
      });
    }

    // Calcul des frais
    const frais = calculerFrais(amount, operator);
    const montantNet = amount - frais;

    await db.collection('transactions').add({
      userId,
      amount,      // Montant brut payé
      frais,       // Frais DigitalPaye
      montantNet,  // Montant crédité au wallet
      operator,
      phone,
      externalRef, // Ta référence interne (COLLECT_...)
      reference: digitalPayeReference || externalRef, // ✅ Référence EXACTE DigitalPaye (DP...)
      sourceWalletId: sourceWalletId,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      externalRef: externalRef,
      checkoutUrl: checkoutUrl
    });

  } catch (error) {
    console.error('❌ Erreur init paiement:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
