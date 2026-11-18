const express = require('express');
const router = express.Router();
const axios = require('axios');

// POST /api/send-sms
// Body : { email: "xxx@yyy.com", code: "123456" }
// Envoie un email via Brevo avec le code de verification.
// (Nom de la route inchange pour compatibilite avec le client Flutter.)
router.post('/send-sms', async (req, res) => {
  const { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({ error: 'email et code sont requis' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error("BREVO_API_KEY manquante");
    return res.status(500).json({ error: 'Configuration serveur manquante' });
  }

  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          name: 'TAPA Invest',
          email: process.env.BREVO_SENDER_EMAIL || 'infosservices2015@gmail.com',
        },
        to: [{ email }],
        subject: 'Votre code de verification TAPA Invest',
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #1A237E;">TAPA Invest</h2>
            <p>Bonjour,</p>
            <p>Voici votre code de verification :</p>
            <div style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #C9A227; text-align: center; padding: 16px; background: #f5f5f5; border-radius: 8px; margin: 16px 0;">
              ${code}
            </div>
            <p style="color: #666; font-size: 13px;">Ce code expire dans 15 minutes. Ne le partagez avec personne.</p>
            <p style="color: #666; font-size: 12px; margin-top: 32px;">Si vous n'avez pas demande ce code, ignorez cet email.</p>
          </div>
        `,
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    console.log('Email envoye a', email, '| messageId:', response.data.messageId);
    res.json({ success: true, messageId: response.data.messageId });
  } catch (error) {
    console.error('Erreur envoi email:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

module.exports = router;
