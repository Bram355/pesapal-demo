'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT             = process.env.PORT || 3000;
const BASE_URL         = process.env.PESAPAL_BASE_URL || 'https://cybqa.pesapal.com/pesapalv3';
const CONSUMER_KEY     = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET  = process.env.PESAPAL_CONSUMER_SECRET;
const DEFAULT_CURRENCY = process.env.CURRENCY || 'KES';
const CALLBACK_URL     = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/api/pesapal/callback';
const IPN_URL          = process.env.IPN_URL || 'http://localhost:' + PORT + '/api/pesapal/ipn';

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('\n[FATAL] Pesapal consumer key/secret missing.');
  console.error('Check that .env exists next to server.js and contains:');
  console.error('  PESAPAL_CONSUMER_KEY=...');
  console.error('  PESAPAL_CONSUMER_SECRET=...\n');
  process.exit(1);
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  timeout: 30000,
});

let tokenCache = { value: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.value;
  }
  const { data } = await api.post('/api/Auth/RequestToken', {
    consumer_key: CONSUMER_KEY,
    consumer_secret: CONSUMER_SECRET,
  });
  if (data.error || !data.token) {
    throw new Error('Pesapal auth failed: ' + JSON.stringify(data));
  }
  tokenCache = { value: data.token, expiresAt: new Date(data.expiryDate).getTime() };
  return tokenCache.value;
}

async function authHeaders() {
  const token = await getToken();
  return { Authorization: 'Bearer ' + token };
}

let ipnIdCache = process.env.PESAPAL_IPN_ID || null;

async function registerIpn() {
  const headers = await authHeaders();
  const { data } = await api.post(
    '/api/URLSetup/RegisterIPN',
    { url: IPN_URL, ipn_notification_type: 'POST' },
    { headers }
  );
  if (data.error || !data.ipn_id) {
    throw new Error('RegisterIPN failed: ' + JSON.stringify(data));
  }
  ipnIdCache = data.ipn_id;
  return data;
}

async function getIpnId() {
  if (ipnIdCache) return ipnIdCache;
  const data = await registerIpn();
  console.log('[IPN] Registered IPN ID:', data.ipn_id, '->', data.url);
  return ipnIdCache;
}

async function getTransactionStatus(orderTrackingId) {
  const headers = await authHeaders();
  const { data } = await api.get('/api/Transactions/GetTransactionStatus', {
    params: { orderTrackingId },
    headers,
  });
  return data;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/pesapal/pay', async (req, res) => {
  try {
    const { amount, email, phone } = req.body;
    const currency = (req.body.currency || DEFAULT_CURRENCY).toUpperCase();

    if (!amount || !email || !phone) {
      return res.status(400).json({ error: 'amount, email and phone are required' });
    }

    const notificationId = await getIpnId();
    const merchantReference = 'ORDER-' + Date.now();

    const payload = {
      id: merchantReference,
      currency,
      amount: Number(amount),
      description: 'Sandbox test order ' + merchantReference,
      callback_url: CALLBACK_URL,
      notification_id: notificationId,
      billing_address: {
        email_address: email,
        phone_number: phone,
        country_code: 'KE',
        first_name: 'Test',
        last_name: 'User',
      },
    };

    const headers = await authHeaders();
    const { data } = await api.post('/api/Transactions/SubmitOrderRequest', payload, { headers });

    if (data.error || !data.redirect_url) {
      console.error('[ORDER] SubmitOrderRequest failed:', data);
      return res.status(502).json({ error: data.error || 'Order submission failed', raw: data });
    }

    console.log('[ORDER] Tracking ID     :', data.order_tracking_id);
    console.log('[ORDER] Merchant ref    :', data.merchant_reference);
    console.log('[ORDER] Redirect URL    :', data.redirect_url);
    console.log('[IPN]  Notification ID  :', notificationId);

    res.json({
      redirect_url: data.redirect_url,
      order_tracking_id: data.order_tracking_id,
      merchant_reference: data.merchant_reference,
    });
  } catch (err) {
    const detail = (err.response && err.response.data) || err.message;
    console.error('[ORDER] Error:', detail);
    res.status(500).json({ error: detail });
  }
});

app.get('/api/pesapal/callback', async (req, res) => {
  console.log('[CALLBACK] query:', req.query);

  const trackingId = req.query.OrderTrackingId;
  const merchantRef = req.query.OrderMerchantReference;

  if (!trackingId) {
    return res.redirect('/failure?reason=missing_tracking_id');
  }

  try {
    const status = await getTransactionStatus(trackingId);
    console.log('[CALLBACK] status:', status.payment_status_description, '(code ' + status.status_code + ')');

    if (status.payment_status_code === 1) {
      return res.redirect('/success?tracking=' + encodeURIComponent(trackingId) + '&ref=' + encodeURIComponent(merchantRef || ''));
    }
    return res.redirect('/failure?tracking=' + encodeURIComponent(trackingId) + '&status=' + encodeURIComponent(status.payment_status_description || ''));
  } catch (err) {
    console.error('[CALLBACK] error:', (err.response && err.response.data) || err.message);
    res.redirect('/failure?reason=status_check_failed');
  }
});

async function handleIpn(req, res) {
  const payload = Object.assign({}, req.query, req.body);
  console.log('[IPN] received:', payload);

  const trackingId = payload.OrderTrackingId || payload.order_tracking_id;
  const merchantRef = payload.OrderMerchantReference || payload.order_merchant_reference;

  try {
    if (trackingId) {
      const status = await getTransactionStatus(trackingId);
      console.log('[IPN] status:', status.payment_status_description, '(code ' + status.status_code + ')');
    }
  } catch (err) {
    console.error('[IPN] status check failed:', (err.response && err.response.data) || err.message);
  }

  res.status(200).json({
    orderNotificationType: payload.OrderNotificationType || 'IPNCHANGE',
    orderTrackingId: trackingId,
    orderMerchantReference: merchantRef,
    status: 200,
  });
}

app.get('/api/pesapal/ipn', handleIpn);
app.post('/api/pesapal/ipn', handleIpn);

app.get('/api/pesapal/register-ipn', async (req, res) => {
  try {
    const data = await registerIpn();
    console.log('[IPN] Registered:', data);
    res.json(data);
  } catch (err) {
    const detail = (err.response && err.response.data) || err.message;
    console.error('[IPN] register failed:', detail);
    res.status(500).json({ error: detail });
  }
});

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

app.get('/success', (req, res) => {
  res.send('<!doctype html><meta charset="utf-8"><title>Success</title>' +
    '<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">' +
    '<h1 style="color:#16a34a">Payment successful</h1>' +
    '<p>Tracking ID: <code>' + escapeHtml(req.query.tracking || '') + '</code></p>' +
    '<p>Merchant reference: <code>' + escapeHtml(req.query.ref || '') + '</code></p>' +
    '<p><a href="/">Back to the form</a></p></body>');
});

app.get('/failure', (req, res) => {
  res.send('<!doctype html><meta charset="utf-8"><title>Failure</title>' +
    '<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">' +
    '<h1 style="color:#dc2626">Payment not completed</h1>' +
    '<p>Tracking ID: <code>' + escapeHtml(req.query.tracking || '') + '</code></p>' +
    '<p>Status: <code>' + escapeHtml(req.query.status || req.query.reason || 'unknown') + '</code></p>' +
    '<p><a href="/">Back to the form</a></p></body>');
});

app.listen(PORT, () => {
  console.log('Pesapal sandbox test running at http://localhost:' + PORT);
  console.log('Currency : ' + DEFAULT_CURRENCY);
  console.log('Callback : ' + CALLBACK_URL);
  console.log('IPN URL  : ' + IPN_URL);
});