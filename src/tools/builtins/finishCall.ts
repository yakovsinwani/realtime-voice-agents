import * as z from 'zod';
import { tool, type Tool } from '../tool.js';

export interface FinishCallToolOptions {
  description?: string;
  /** Returned to the model as the tool result's instruction. */
  farewellInstruction?: string;
}

const DEFAULT_DESCRIPTION =
  'End the phone call when the conversation is complete, the caller says goodbye, ' +
  'or they ask to hang up. After calling this you will be asked to say one brief ' +
  'closing line; say it and then stop speaking.';

const DEFAULT_FAREWELL_INSTRUCTION =
  'The call is now ending. Say one brief, warm goodbye line to the caller — in the ' +
  'language of the conversation — and then stop speaking entirely.';

/**
 * Graceful hangup: the tool result *instructs* the model to say goodbye (so
 * the farewell is the model's own, in context and language), the session
 * watches the goodbye's playout via marks, and only then completes the leg.
 * A watchdog forces completion if the goodbye never materializes.
 */
export function createFinishCallTool(options: FinishCallToolOptions = {}): Tool<any, any> {
  return tool({
    name: 'finish_call',
    description: options.description ?? DEFAULT_DESCRIPTION,
    parameters: z.object({
      reason: z.string().optional().describe('Why the call is ending, for the call log'),
    }),
    execute: async (input, ctx) => {
      ctx.logger.info('finish_call invoked', { reason: (input as { reason?: string }).reason });
      // Arm the mark-gated hangup; the promise resolves at actual teardown,
      // long after this tool result must reach the model — do not await it.
      void ctx.session.finishCall();
      return {
        status: 'ending_call',
        instruction: options.farewellInstruction ?? DEFAULT_FAREWELL_INSTRUCTION,
      };
    },
  });
}
