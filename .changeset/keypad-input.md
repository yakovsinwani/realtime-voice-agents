---
'realtime-voice-agents': minor
---

Add opt-in keypad (DTMF) input (`session.keypad`): keypresses are collected into complete entries — `#` submits, `*` clears, `maxDigits` auto-submits, an inter-digit timeout (4s) flushes a partial entry — each keypress stops the agent mid-sentence, and every entry is injected as a `[keypad] ...` **user** turn that triggers the model's answer (role `user`, not `system`: a trailing system item is skipped by the response it triggers — field-tested on xAI). A short note appended to the agent instructions (also after handoffs) tells the model what `[keypad]` messages are. Set `{}` to enable with defaults; every piece is overridable (`message`/`clearMessage`/`instructions` accept `false`, `interruptOnKeypress: false`, custom keys). Unset = raw `dtmf` events only, exactly as before.

New public API: session option `keypad` (`KeypadOptions`), session events `keypad.entry` / `keypad.cleared`, the `session.keypad` handle (`digits`, `clear()`, `submit()` — the collector consumes a key before the raw `dtmf` event fires, so a `dtmf` listener can claim a key with `clear()`), and `KeypadCollector` / `defaultKeypadMessage` / `DEFAULT_KEYPAD_*` exports for custom wiring.
