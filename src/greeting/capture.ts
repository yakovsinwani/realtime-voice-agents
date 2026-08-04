/**
 * Capture a pre-synthesized greeting from a throwaway realtime session.
 *
 * Why not a TTS API? The realtime voice sets don't fully overlap the TTS
 * voice sets — capturing from a real session guarantees the stored greeting
 * sounds exactly like the live agent. Run this at deploy/config time and
 * store the returned μ-law buffer (it is Twilio wire format; pass it to
 * `greeting.preSynthesized.audio`).
 */

import WebSocket from 'ws';
import { buildSessionUpdate } from '../providers/openai-compatible/session-config.js';

export interface CaptureGreetingOptions {
  apiKey: string;
  /** Exact text the greeting should say. */
  text: string;
  model?: string;
  voice?: string;
  /** OpenAI-compatible realtime endpoint (works for xAI too). */
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CapturedGreeting {
  /** Raw 8 kHz μ-law audio, ready for the Twilio stream. */
  audio: Buffer;
  text: string;
  durationMs: number;
}

export async function captureGreetingAudio(options: CaptureGreetingOptions): Promise<CapturedGreeting> {
  const url = `${options.baseUrl ?? 'wss://api.openai.com/v1/realtime'}?model=${encodeURIComponent(
    options.model ?? 'gpt-realtime',
  )}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${options.apiKey}`, ...options.headers },
  });

  const chunks: Buffer[] = [];
  return new Promise<CapturedGreeting>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* closing */
      }
      reject(new Error(`greeting capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finish = (error?: Error) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closing */
      }
      if (error) {
        reject(error);
        return;
      }
      const audio = Buffer.concat(chunks);
      resolve({ audio, text: options.text, durationMs: audio.length / 8 });
    };

    ws.on('message', (raw) => {
      let event: Record<string, any>;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (event.type) {
        case 'session.created':
          ws.send(
            JSON.stringify(
              buildSessionUpdate(
                {
                  instructions: 'You produce exact voice lines for a phone system.',
                  voice: options.voice,
                  vad: null,
                  transcription: false,
                },
                { defaultVoice: options.voice },
              ),
            ),
          );
          break;
        case 'session.updated':
          ws.send(
            JSON.stringify({
              type: 'response.create',
              response: {
                instructions: `Say exactly this, and nothing else: "${options.text}"`,
              },
            }),
          );
          break;
        case 'response.output_audio.delta':
          if (typeof event.delta === 'string') chunks.push(Buffer.from(event.delta, 'base64'));
          break;
        case 'response.done':
          finish();
          break;
        case 'error':
          finish(new Error(`greeting capture failed: ${JSON.stringify(event.error ?? event)}`));
          break;
      }
    });
    ws.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on('close', () => {
      // Close before response.done → resolve with whatever arrived (or fail).
      if (chunks.length > 0) finish();
      else finish(new Error('greeting capture connection closed before audio arrived'));
    });
  });
}
