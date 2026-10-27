# Teobeanie Whisper

Speech to text on the Home Assistant host, for Teobeanie's voice messages
([docs/voice.md](https://github.com/teob-cc/teobeanie/blob/main/docs/voice.md)).
faster-whisper (CTranslate2, int8 on the CPU) behind an OpenAI-compatible endpoint,
`POST /v1/audio/transcriptions`, on the add-ons' internal network only. Teobeanie finds
it by itself; nothing you say leaves the house.

The model is downloaded on the first start (into the add-on's data, left out of backups).

| Option | |
|---|---|
| `model` | `small` (default) suits a 4-core CPU: about 3 s for a short message, 0.7 GB of memory. `large-v3-turbo` hears better and takes about 13 s; `medium` is slower than both on a CPU and needs 2.8 GB. |
| `language` | A language code (`ru`, `en`, `nl`) to skip detection; Teobeanie sends voice.json's language with each message anyway. |
| `beam_size` | Lower is faster, higher a little more accurate. |
| `cpu_threads` | Threads for one transcription; default all cores. |
