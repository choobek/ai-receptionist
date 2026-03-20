# Staging Voice Scenarios

Machine-runnable staging voice smoke scenarios belong here.

Schema:

- [`../../schemas/staging-voice-scenario.v1.json`](../../schemas/staging-voice-scenario.v1.json)

Runner:

- [`../../../scripts/run-staging-voice-smoke-suite.sh`](../../../scripts/run-staging-voice-smoke-suite.sh)

Current active smoke coverage:

- `silence-timeout-safe-end`
- `mid-sentence-pause-no-barge-in`
- `low-confidence-transcript-recovery`
- `mid-sentence-pause-no-barge-in-en`
- `low-confidence-transcript-recovery-en`

Current draft scenario:

- `implant-inquiry-to-booking-voice`

The default suite language is Polish. Use `--language en` to run only the English companion coverage or `--language all` to run both lanes. Missing caller clips can be synthesized locally from the `play_clip` transcripts.
