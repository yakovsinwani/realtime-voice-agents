/**
 * Place an outbound call that lands on the example server's bridge.
 *   npm run call -- +15551234567
 */

import twilio from 'twilio';

const to = process.argv[2];
if (!to) {
  console.error('usage: npm run call -- +15551234567');
  process.exit(1);
}

const PUBLIC_URL = (process.env.PUBLIC_WS_URL ?? 'wss://example.ngrok.app').replace('wss', 'https');
const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

const call = await client.calls.create({
  to,
  from: process.env.TWILIO_PHONE_NUMBER!,
  url: `${PUBLIC_URL}/twilio/voice`,
  statusCallback: `${PUBLIC_URL}/twilio/status`,
  statusCallbackEvent: ['answered', 'completed'],
});

console.log(`calling ${to} — ${call.sid}`);
