---
default: patch
---

# Unpacked installs reload into a new build on their own

An unpacked extension now checks once a minute for a newer build in its folder and reloads into it once nothing is recording, so updating a test install no longer needs a click on the extensions page. `extension/scripts/sync.sh host:path` builds the extension and copies it there. Store installs are unaffected.
