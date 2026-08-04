import * as z from 'zod';
import { tool, type Tool } from '../tool.js';

export interface TransferCallToolOptions {
  defaultPhoneNumber?: string;
  callerId?: string;
  description?: string;
  /** Spoken to the caller before the transfer executes. */
  announcement?: string;
}

const DEFAULT_DESCRIPTION =
  'Transfer this call to a human agent or an external phone number. Use when the ' +
  'caller asks for a person, or the request is beyond what you can handle.';

export function createTransferCallTool(options: TransferCallToolOptions = {}): Tool<any, any> {
  return tool({
    name: 'transfer_call',
    description: options.description ?? DEFAULT_DESCRIPTION,
    parameters: z.object({
      phoneNumber: z
        .string()
        .optional()
        .describe('Destination in E.164 format (+15551234567). Omit to use the default.'),
      reason: z.string().optional().describe('Why the caller is being transferred'),
    }),
    execute: async (input, ctx) => {
      const args = input as { phoneNumber?: string; reason?: string };
      const target = args.phoneNumber ?? options.defaultPhoneNumber;
      if (!target) {
        return {
          error: 'no destination number available',
          hint: 'Ask the caller to hold and take a message instead.',
        };
      }
      // Announced, playout-aware; resolves at the actual TwiML update — after
      // this result (and any announcement) has played. Do not await it.
      void ctx.session.transferTo(target, {
        callerId: options.callerId,
        announcement: options.announcement,
      });
      return { status: 'transferring', to: target };
    },
  });
}
