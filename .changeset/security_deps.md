---
default: patch
---

# Refresh dependencies with security fixes

The server's pinned environment moves to FastAPI 0.162 (Starlette 1.10) with patched Pillow, aiohttp, certifi, filelock, and setuptools, and the extension builds on Vite 8.3.4, clearing 68 of 73 open dependency alerts.
