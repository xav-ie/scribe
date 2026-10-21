---
default: patch
---

# Debug bundles leave out the access token

A downloaded debug bundle no longer contains the server's access token, which would let anyone you share it with read every meeting. It shows `#token=redacted` instead, so you can still tell one was set.
