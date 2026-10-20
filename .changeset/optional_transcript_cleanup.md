---
default: minor
---

# Optional transcript cleanup

Point `SCRIBE_CLEANUP_URL` at a server running the scribe cleanup model and each meeting gets a cleaned copy when its recording ends: ums, stutters and false starts removed, punctuation and capitals fixed, every other word, speaker, timestamp and number kept. The original transcript never changes. A safety check keeps the original line wherever the model changed a number, a "not", a speaker or a timestamp. The web UI shows the cleaned copy beside the original and cleans older meetings on request; MCP agents read it with `get_transcript(cleaned=true)` and start one with `clean_transcript`.
