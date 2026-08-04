/**
 * Twilio REST control plane: hangup, transfer, SMS/WhatsApp.
 *
 * Media and control are different planes — the WebSocket carries audio, but
 * ending or redirecting the PSTN leg goes through the REST API. The `twilio`
 * SDK is an optional peer dependency, imported lazily so bridges that never
 * use REST features don't need it installed.
 */

import { escapeXml } from './twiml.js';

export interface TwilioRestConfig {
  accountSid: string;
  authToken: string;
  callerId?: string;
}

/** Loose E.164 check — validated BEFORE interpolation into TwiML. */
const PHONE_PATTERN = /^\+?[0-9]{5,20}$/;

export function assertValidPhoneNumber(phoneNumber: string): void {
  if (!PHONE_PATTERN.test(phoneNumber)) {
    throw new Error(
      `invalid phone number "${phoneNumber}" (expected E.164-like digits, e.g. +15551234567)`,
    );
  }
}

export class TwilioRestClient {
  private readonly config: TwilioRestConfig;
  private clientPromise: Promise<any> | null = null;

  constructor(config: TwilioRestConfig) {
    this.config = config;
  }

  private client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import('twilio')
        .then((mod: any) => {
          const factory = mod.default ?? mod;
          return factory(this.config.accountSid, this.config.authToken);
        })
        .catch((error: unknown) => {
          this.clientPromise = null;
          throw new Error(
            `the 'twilio' package is required for REST call control — npm install twilio (${String(error)})`,
          );
        });
    }
    return this.clientPromise;
  }

  /** End the PSTN leg cleanly (better than just dropping the stream). */
  async completeCall(callSid: string): Promise<void> {
    const client = await this.client();
    await client.calls(callSid).update({ status: 'completed' });
  }

  /**
   * Blind-transfer the call: replace its TwiML with a `<Dial>`. The number
   * is validated and XML-escaped — never interpolate LLM output raw into
   * markup.
   */
  async transferCall(
    callSid: string,
    phoneNumber: string,
    options: { callerId?: string } = {},
  ): Promise<void> {
    assertValidPhoneNumber(phoneNumber);
    const callerId = options.callerId ?? this.config.callerId;
    if (callerId) assertValidPhoneNumber(callerId);
    const dialAttrs = callerId ? ` callerId="${escapeXml(callerId)}"` : '';
    const twiml = `<Response><Dial${dialAttrs}><Number>${escapeXml(phoneNumber)}</Number></Dial></Response>`;
    const client = await this.client();
    await client.calls(callSid).update({ twiml });
  }

  async sendSms(options: { to: string; body: string; from: string }): Promise<{ sid: string }> {
    assertValidPhoneNumber(options.to);
    const client = await this.client();
    const message = await client.messages.create({
      to: options.to,
      from: options.from,
      body: options.body,
    });
    return { sid: message.sid };
  }

  async sendWhatsapp(options: { to: string; body: string; from: string }): Promise<{ sid: string }> {
    const to = options.to.startsWith('whatsapp:') ? options.to : `whatsapp:${options.to}`;
    const from = options.from.startsWith('whatsapp:') ? options.from : `whatsapp:${options.from}`;
    const client = await this.client();
    const message = await client.messages.create({ to, from, body: options.body });
    return { sid: message.sid };
  }
}
