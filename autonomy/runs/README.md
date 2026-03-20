# Runs

Normalized conversation artifacts belong here.

Committed content in this directory should stay limited to synthetic samples and documentation.
Real-call outputs can contain patient data and should be written under git-ignored paths such as:

- `autonomy/runs/generated/`
- `autonomy/runs/real/`

The staging regression suite writes synthetic run artifacts under:

- `autonomy/runs/generated/staging/`

The staging voice smoke suite writes machine-readable artifacts under:

- `autonomy/runs/generated/staging-voice/`

The guarded staging improvement loop writes machine-readable loop artifacts under:

- `autonomy/runs/generated/staging-loop/`

The normalized format is defined in:

- [`../schemas/run.v1.json`](../schemas/run.v1.json)
- [`../schemas/staging-chat-run.v1.json`](../schemas/staging-chat-run.v1.json)
- [`../schemas/staging-chat-suite.v1.json`](../schemas/staging-chat-suite.v1.json)
- [`../schemas/staging-voice-run.v1.json`](../schemas/staging-voice-run.v1.json)
- [`../schemas/staging-voice-suite.v1.json`](../schemas/staging-voice-suite.v1.json)
- [`../schemas/staging-improvement-loop.v1.json`](../schemas/staging-improvement-loop.v1.json)
