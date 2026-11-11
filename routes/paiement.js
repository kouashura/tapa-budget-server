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

    // ✅ Sécurisation de la référence
    const safeReference = link.data?.reference || link.data?.ref || externalRef;
    
    // ✅ Sécurisation de l'URL de checkout (on cherche tous les noms possibles)
    const checkoutUrl = link.data?.url || link.data?.payment_url || link.data?.checkout_url;

    if (!checkoutUrl) {
      console.error('⚠️ Structure de réponse inattendue:', JSON.stringify(link));
      return res.status(500).json({ 
        error: 'URL de paiement introuvable dans la réponse de DigitalPaye',
        debug: link
      });
    }

    await db.collection('transactions').add({
      userId,
      amount,
      operator,
      phone,
      externalRef,
      reference: safeReference,
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
