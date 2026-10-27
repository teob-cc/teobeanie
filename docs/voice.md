# Voice messages

People in the house's chat can say what they want instead of typing a command:
"heat the hall to 21 for two hours", "the cat is home". Teobeanie hears the message on
the Home Assistant host, a language model turns it into the commands the house already
has, and those run as if the speaker had typed them. The model never switches anything
itself: it can only call the commands you list, each one is checked against what that
command allows, and the behaviours behind the commands still decide and act through
the SafeActuator with its bounds.

```
voice message in the chat
 → speech to text on the host (Teobeanie Whisper, faster-whisper)
 → the model, with one tool per listed command (typed from the behaviours) and three
   ways to answer without one: not_an_instruction, ask, say
 → every call checked against its command's schema; a refused one goes back to the
   model with the reason (at most three turns)
 → the commands sent through the command lane, as the person who spoke
 → the behaviours decide and answer, as they do to a typed command
```

The bot answers each voice message with what it heard and the commands it ran
(`🎙 Alex: «...»` then `→ /warm hall 21 2h`). A message with nothing for the house gets
the model's one-line answer that it is not an instruction; an unclear one gets a
question back.

## What you need

- **Teobeanie Whisper**, the second add-on in this repository: faster-whisper on the
  host's CPU, nothing leaves the house. Install it and start it; Teobeanie finds it by
  itself. On a 4-core Intel i5 the `small` model takes about 3 s for a short message
  and 0.7 GB of memory; `large-v3-turbo` hears better and takes about 13 s. Any other
  OpenAI-compatible transcription server works too: set `stt_url`.
- **A language model:** `llm_provider` `openrouter` with `openrouter_api_key`, or
  `ollama` with `ollama_url`. The model is voice.json's `model` (a small, fast one does:
  each message is one or two calls of a few thousand tokens), else `openrouter_model`.
  `llm_monthly_budget_usd` caps the month's spend.
- **The bot sees the group's messages**: make it an admin of the group, or turn its
  privacy mode off in BotFather (then remove it from the group and add it again).
  `telegram_commands` on.
- **Commands with a schema.** A heuristic offers a command to voice through
  `commandSchema` (its arguments typed: a choice, a number with its range, a duration).
  climate-guard's `warm` and `climate_waive` have one; a house package can add its own.

## voice.json

In the config folder, part of the working set (the agent writes it with `file_write`;
every change is a revision):

```json
{
  "mode": "shadow",
  "commands": ["warm", "cat"],
  "language": "ru",
  "vocabulary": "heating, degrees, downstairs, upstairs, hall, den, cat home, cat out",
  "glossary": ["downstairs means hall", "upstairs means den and attic (one call per room)"],
  "model": "anthropic/claude-haiku-5.5",
  "maxCalls": 4,
  "maxSeconds": 60,
  "texts": { "shadow": "(voice in shadow: nothing was run)" }
}
```

| Key | |
|---|---|
| `mode` | `off` (default), `shadow`: answered with what would run, nothing runs; `active`: run. |
| `commands` | The only commands a voice message can reach. A listed command no running instance gives a schema for is left out (logged). |
| `language` | The speakers' language for speech to text and for the model's replies; empty: detected. |
| `vocabulary` | Words speech to text should expect: room names, the commands' words. It helps a lot with names said as letters. |
| `glossary` | The house's words, for the model: what "downstairs" or "the second level" means. |
| `model` | The model's id at the provider; empty: `openrouter_model`. |
| `maxCalls`, `maxSeconds` | At most this many commands from one message; messages longer than this are not heard. |
| `texts` | The bot's own words: `heard`, `ran`, `shadow`, `failed`, `tooLong`, `nothingHeard`, `budget`, `unavailable`. |

Limits belong to the behaviours and the SafeActuator, not to the prompt: a heating
command takes only what the house's bounds allow (`allowlist.json` `"bounds"`), and the
model is told the range only so it can say it.

## What is journaled

Every message is one `VoiceHandled` event (stream `teob-voice/messages`): who spoke, the
transcript, each tool call the model made and what the house said to it, the commands
that ran and the instances they reached, the answer, the tokens and the cost. A command
that came from a voice message carries `from.ref = "voice:<id>"` in its decision, so the
decision leads back to the message.
