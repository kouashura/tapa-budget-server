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
  const { data } = await axios.post(`${BASE}/v1/auth/token`, null, {
    headers: { Authorization: `Basic ${creds}` },
    timeout: 15000,
  });
  cache = { token: data.data.access_token, exp: Date.now() + 9 * 60 * 1000 }; // JWT valable 10 min
  return cache.token;
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

// Ne lève jamais sur un 4xx : { ok, httpStatus, data, message }
async function safe(fn) {
  try {
    const r = await fn();
    return { ok: true, httpStatus: r.status, data: r.data?.data || r.data, message: r.data?.message };
  } catch (e) {
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

exports.payout = ({ amount, operatorCode, phone, externalRef, note }) =>
  safe(() =>
    call('post', '/v1/payouts', {
      amount,
      currency: 'XOF',
      operator_code: operatorCode,
      external_ref: externalRef,
      payer: { phone: cleanPhone(phone), phone_prefix: '+225' },
      note: note || 'Retrait TAPA Invest',
    })
  );

exports.collectDetail = (reference) => safe(() => call('get', `/v1/collect/${reference}`));
exports.me = () => safe(() => call('get', '/v1/auth/me'));
