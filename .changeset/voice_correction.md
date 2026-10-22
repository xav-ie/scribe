---
default: minor
---

# Speakers corrected by voice

A new popup option, "Correct speakers by voice", has the server re-check who spoke once the meeting ends: it learns each speaker's voice from the saved audio and moves speech the voice clearly gives to someone else, fixing the moments the meeting's speaker indicator lags or lights the wrong tile. The audio is kept only until that's done unless "Save audio" is on, and cleanup then runs on the corrected transcript. Any session with saved audio can be corrected from the web UI (which lists what changed, each playable) or the `correct_speakers` MCP tool.
