---
default: patch
---

# No blank sessions, no lost last words

A recording that failed to start no longer leaves a blank session on the server. Stopping a long recording after Chrome had put the extension's worker to sleep no longer drops its last few words.
