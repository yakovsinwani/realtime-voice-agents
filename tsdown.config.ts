import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    openai: 'src/openai.ts',
    xai: 'src/xai.ts',
    gemini: 'src/gemini.ts',
    twilio: 'src/twilio.entry.ts',
    audio: 'src/audio.entry.ts',
    store: 'src/store.ts',
    testing: 'src/testing.entry.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  deps: { neverBundle: ['zod', 'twilio', '@google/genai', 'ws'] },
});
