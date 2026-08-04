/** TwiML helpers for wiring a call into the media-stream bridge. */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ConnectStreamTwimlOptions {
  /** wss:// URL of the media-stream WebSocket route. */
  wsUrl: string;
  /**
   * Custom `<Parameter>`s delivered in the start frame's customParameters —
   * the place for auth tokens, tenant ids, or per-call config keys.
   */
  parameters?: Record<string, string>;
}

/**
 * Build the TwiML that connects a call to the bridge.
 *
 * `<Connect><Stream>` is the bidirectional form. `<Start><Stream>` is
 * send-only — the caller would never hear the agent.
 */
export function connectStreamTwiml(options: ConnectStreamTwimlOptions): string {
  const params = Object.entries(options.parameters ?? {})
    .map(([name, value]) => `\n      <Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join('');
  const stream = params
    ? `<Stream url="${escapeXml(options.wsUrl)}">${params}\n    </Stream>`
    : `<Stream url="${escapeXml(options.wsUrl)}" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    ${stream}
  </Connect>
</Response>`;
}
