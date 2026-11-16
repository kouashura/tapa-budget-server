const express = require('express');
const router = express.Router();
const axios = require('axios');

router.post('/send-sms', async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: 'phone et code sont requis' });
  }

  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/transactionalSMS/send',
      {
        sender: 'TAPA', // Ton Sender ID approuvé
        recipient: phone, // Format international sans + (ex: 2250700000000)
        content: `Votre code de vérification TAPA est : ${code}`,
        type: 'transactional',
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );

    console.log('✅ SMS envoyé:', response.data);
    res.json({ success: true, messageId: response.data.messageId });
  } catch (error) {
    console.error('❌ Erreur envoi SMS:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

module.exports = router;
