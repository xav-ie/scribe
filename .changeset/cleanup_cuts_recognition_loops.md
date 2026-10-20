---
default: patch
---

# Cleanup cuts recognition loops first

When speech-to-text repeats a word or short phrase 5 or more times in a row ("two two two ..."), scribe now cuts the run to one copy before the cleanup model sees it, as the model was trained to. A long loop could make the model repeat it instead, which left the whole chunk uncleaned. A line the safety check keeps still shows what was said, loop and all.
