# Staging Voice Fixtures

These WAV files are deterministic caller-side fixtures for the staging voice smoke suite.

They can be generated locally with:

```bash
./scripts/autonomy/generate-staging-voice-fixtures.sh
./scripts/autonomy/generate-staging-voice-fixtures.sh --language all
```

Current fixture set:

- `mid-sentence/` for interruption and pause-window checks
- `mid-sentence-en/` for the English interruption companion scenario
- `low-confidence/` for degraded-audio transcript recovery checks
- `low-confidence-en/` for the English degraded-audio companion scenario
- `implant-booking/` for the end-to-end implant consultation booking flow

The generator reads `play_clip` transcripts from the voice scenarios, synthesizes them through ElevenLabs, then normalizes them to mono 48 kHz WAV with `ffmpeg`. The noisy recovery clips use an additional `ffmpeg` degradation pass so the caller audio stays repeatable.
