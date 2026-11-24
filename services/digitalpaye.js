// server/services/digitalpaye.js
// Client DigitalPaye (auth Basic -> JWT 10 min -> Bearer), aligné sur la doc officielle.
const axios = require('axios');

const BASE = process.env.DP_BASE_URL || 'https://api.digitalpaye.com';
let cache = { token: null, exp: 0 };

async function getToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const pub = process.env.DP_PUBLIC_KEY;
  const secret = process.env.DP_SECRET;
  if (!pub || !secret) throw new Error('DP_PUBLIC_KEY / DP_SECRET manquants');
  const creds = Buffer.from(`${pub}:${secret}`).toString('base64');

  let derniere;
  for (let essai = 1; essai <= 2; essai++) {
    try {
      const { data } = await axios.post(`${BASE}/v1/auth/token`, null, {
        headers: { Authorization: `Basic ${creds}` },
        timeout: 20000,
      });
      cache = { token: data.data.access_token, exp: Date.now() + 9 * 60 * 1000 }; // JWT valable 10 min
      return cache.token;
    } catch (e) {
      derniere = e;
      const st = e.response && e.response.status;
      console.warn(`⚠️ Auth DigitalPaye essai ${essai}/2 : ${st || ''} ${e.message}`);
      if (st && st < 500) break; // identifiants refusés, clé expirée... : inutile de réessayer
    }
  }
  const st = derniere && derniere.response && derniere.response.status;
  const err = new Error(
    st && st < 500
      ? (derniere.response.data && derniere.response.data.message) || 'Authentification DigitalPaye refusée'
      : 'Service de paiement momentanément indisponible. Réessaie dans un instant.'
  );
  err.dpAuthFailed = true; // rien n'a été envoyé à DigitalPaye
  err.httpStatus = st || 0;
  throw err;
}

async function call(method, path, body) {
  const token = await getToken();
  return axios({
    method,
    url: BASE + path,
    data: body,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
}

// Ne lève jamais sur un 4xx : { ok, httpStatus, data, message, notSent? }
async function safe(fn) {
  try {
    const r = await fn();
    return { ok: true, httpStatus: r.status, data: r.data?.data || r.data, message: r.data?.message };
  } catch (e) {
    if (e.dpAuthFailed) {
      console.error('❌ Auth DigitalPaye impossible :', e.message);
      return { ok: false, httpStatus: e.httpStatus || 0, notSent: true, data: null, message: e.message };
    }
    const body = e.response?.data;
    return {
      ok: false,
      httpStatus: e.response?.status || 0,
      data: body?.data || null,
      message: body?.message || e.message,
    };
  }
}

const cleanPhone = (p) => String(p).replace(/\D/g, '').replace(/^225/, '').slice(-10);

// operatorCode : ORANGE_MONEY_CI | MTN_MONEY_CI | WAVE_MONEY_CI | MOOV_MONEY_CI
exports.collect = ({ amount, operatorCode, phone, otp, externalRef, firstName, lastName,
                     uid, successUrl, errorUrl, note }) => {
  const body = {
    amount,
    currency: 'XOF',
    operator_code: operatorCode,
    country: 'CI',
    external_ref: externalRef,
    payer: {
      phone: cleanPhone(phone),
      phone_prefix: '+225',
      first_name: firstName || 'Client',
      last_name: lastName || 'Tapa',
      address: { country: 'CI', city: 'Abidjan', address_line: 'Abidjan' }, // requis Wave/MTN
    },
    note: note || 'Rechargement TAPA Invest',
    metadata: { user_id: uid },
  };
  if (otp) {
    body.otp = otp;          // la doc le montre à 2 endroits selon la page : on envoie les deux
    body.payer.otp = otp;
  }
  if (successUrl) body.success_url = successUrl;   // Wave
  if (errorUrl) body.error_url = errorUrl;         // Wave
  return safe(() => call('post', '/v1/collect', body));
};

const SHORT_CODES = {
  ORANGE_MONEY_CI: 'ORANGE',
  MTN_MONEY_CI: 'MTN',
  WAVE_MONEY_CI: 'WAVE',
  MOOV_MONEY_CI: 'FLOOZ',
};

exports.payout = async ({ amount, operatorCode, phone, externalRef, note }) => {
  const body = (code) => ({
    amount,
    currency: 'XOF',
    operator_code: code,
    external_ref: externalRef,
    payer: { phone: cleanPhone(phone), phone_prefix: '+225' },
    note: note || 'Retrait TAPA Invest',
  });

  let r = await safe(() => call('post', '/v1/payouts', body(operatorCode)));

  // Si le code long est refusé (rien n'est envoyé), on réessaie avec le code court
  if (!r.ok && /operator_code/i.test(r.message || '') && SHORT_CODES[operatorCode]) {
    console.warn(`⚠️ operator_code ${operatorCode} refusé, nouvel essai avec ${SHORT_CODES[operatorCode]}`);
    r = await safe(() => call('post', '/v1/payouts', body(SHORT_CODES[operatorCode])));
  }
  return r;
};

exports.collectDetail = (reference) => safe(() => call('get', `/v1/collect/${reference}`));
exports.me = () => safe(() => call('get', '/v1/auth/me'));

// Liste des collectes récentes (pour retrouver une transaction par external_ref)
exports.listCollects = () => safe(() => call('get', '/v1/collects?page=1&limit=100&type=collect'));
