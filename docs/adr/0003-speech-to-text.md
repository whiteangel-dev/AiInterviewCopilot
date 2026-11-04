# ADR 0003 — Speech-to-text: Gemini Live `gemini-3.5-transcribe-live`

- **Status:** Accepted (2026-11-03)

## Context
- We need streaming, low-latency English transcription with partial results while the person is still talking.
- Only a Gemini key is available.

## Decision
- Use the **Gemini Live API with `gemini-3.5-transcribe-live`**: one session per audio channel, 16 kHz PCM16 sent in 20 ms chunks.
- Settings: English language code, custom vocabulary from the profile, end of segment after 300 ms of silence, `NO_INTERRUPTION`.
- Use the **interim transcript**, which holds the whole utterance so far, for turn detection, and final transcripts for storage.

## Evidence (Phase 0, synthetic speech)
| Measurement | Result |
|---|---|
| First partial text | 0.55 s after speech starts |
| Final transcript | 0.71 s after speech ends (median) |
| Word error rate | 2.7%, mostly number formatting and dropped filler words |

## Consequences
- **Session limits (resolved in Phase 3):** a connection gets `goAway` after about 9 minutes, and session resumption sends no handles for this model. The app rolls over to a new connection at a pause ([ADR 0009](0009-live-listening.md)).
- **Still to verify:**
  - accuracy on real call audio (the Phase 3 real-device test);
  - cost per hour (this model reports no token usage; the app records audio seconds per channel).
- **Deepgram or AssemblyAI** can be added behind `SttProvider` if real-world results disappoint.
