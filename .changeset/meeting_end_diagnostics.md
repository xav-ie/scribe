---
default: patch
---

# Session records show how a recording ended

Each session record now says what stopped the recording, logs the meeting tab's address and title changes, and notes any "meeting ended" or "you left" text on the page along with which frame reported it. Snapshots of the meeting page are kept only when something changes, plus one every five minutes, so a long recording keeps its ending instead of only its last two hours.
