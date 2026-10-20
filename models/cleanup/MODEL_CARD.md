---
license: apache-2.0
base_model: google/gemma-4-E2B-it
base_model_relation: finetune
datasets:
  - edinburghcstr/ami
language:
  - en
pipeline_tag: text-generation
library_name: transformers
tags:
  - transcript-cleanup
  - meetings
  - asr-post-processing
  - disfluency-removal
---

# scribe cleanup v1

Speech-to-text leaves transcripts full of "um", "the the", half-finished sentences and missing punctuation. This
model tidies them: it removes the filler, keeps only the final value when someone corrects themselves, and fixes
punctuation and capitals. What was said stays as it was: every other word, every speaker and timestamp, every
number. It runs on your own computer. It was built for [scribe](https://github.com/xav-ie/scribe) and works on any
transcript in the same format.

It is Google's open [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) with a small add-on trained for this
one job (a LoRA, merged into the weights), taught with recorded meetings from a public collection and cleaned text
built from them by fixed rules. [METHODOLOGY.md](METHODOLOGY.md) explains how; [COMPARISON.md](COMPARISON.md) shows
how it does against other models.

Version 1, released October 2026.

## What it does

```
in:  [0:43] Alice Chen: um so the the cost should uh not exceed twelve fifty
     [0:47] Bob Ruiz: mm-hmm
     [0:48] Alice Chen: the review moved to four no wait five pm
out: [0:43] Alice Chen: So the cost should not exceed twelve fifty.
     [0:47] Bob Ruiz:
     [0:48] Alice Chen: The review moved to 5 PM.
```

It **removes** um and uh, stutters, repeated words, half-words and false starts. It **keeps only the final value**
when someone corrects themselves ("four, no wait, five" becomes "5"). It **fixes** punctuation and capitals, and
spells attendees' names right if you list them. It **writes as digits** money, percentages, times with am/pm, and
dates.

It **never** changes a number's value, turns an unclear number like "twelve fifty" into digits, adds words, drops words
that carry meaning, or answers what was said. It keeps "I mean", "you know" and "like", and it leaves misheard words
alone: fixing those is the speech-to-text model's job. The full rules, with examples, are in
[METHODOLOGY.md](METHODOLOGY.md#the-rules).

**Not for** records that must be word for word, such as legal or medical ones (use the original transcript), for
languages other than English, or as a replacement for the original transcript.

## Get it

<!-- table:versions -->
| Version | For | Size |
|---|---|---|
| [`xav-ie/scribe-cleanup-mlx-4bit`](https://huggingface.co/xav-ie/scribe-cleanup-mlx-4bit) | Macs with Apple chips (compressed) | 2.8 GB |
| [`xav-ie/scribe-cleanup-GGUF`](https://huggingface.co/xav-ie/scribe-cleanup-GGUF) | [llama.cpp](https://github.com/ggml-org/llama.cpp), a popular tool for running models locally (compressed) | 3.3 GB |
| [`xav-ie/scribe-cleanup`](https://huggingface.co/xav-ie/scribe-cleanup) | the full-size model, for Python's `transformers` library or [vLLM](https://github.com/vllm-project/vllm) on a server | 9.3 GB |
| [`xav-ie/scribe-cleanup-lora`](https://huggingface.co/xav-ie/scribe-cleanup-lora) | just the trained add-on (LoRA), for building your own versions | 93 MB |
<!-- /table:versions -->

"2B" is Gemma's name for its size: about 2 billion parameters work on each word, out of about 4.6 billion stored.
Only Gemma's text part ships here; its image and audio parts are left out, since cleanup never uses them.

**Files:** the model weights, [`prompt.txt`](prompt.txt) (the instructions the model was trained with),
[`guard.py`](guard.py) (the safety check), [`results.json`](results.json) (every score on this page) and `LICENSE`.

## How to use

1. Send the instructions in [`prompt.txt`](prompt.txt) as the system message.
2. Send the lines to clean as the user message, inside `<transcript>` tags. Optionally add a list of attendees in
   `<context>`, and the few lines before this chunk in `<previous>` so the model knows what came before:

   ```
   <context>
   participants: Alice Chen, Bob Ruiz
   </context>
   <previous>
   [0:40] Bob Ruiz: so what's the budget
   </previous>
   <transcript>
   [0:43] Alice Chen: um so the the cost should uh not exceed twelve fifty
   </transcript>
   ```
3. Turn randomness off (temperature 0), so the same input always gives the same output.
4. Run the result through [`guard.py`](guard.py), the safety check: a small ordinary program (no AI) that compares
   each cleaned line with the original and keeps the original wherever the model changed a timestamp, a speaker, a
   number or a "not". The worst case is then a line left uncleaned, never one that says something different.

Send long meetings in chunks of about 250 words, never splitting a line. A chunk takes about 5 seconds on an 8 GB
gaming graphics card, about 4 seconds on an Apple M5 with prompt lookup (below), and about 14 seconds on a desktop
processor (an Intel i7-11700F) with llama.cpp and prompt lookup. A one-hour meeting takes about 3 minutes on a Mac
and about 10 on that processor.

**On a Mac:**

```sh
pip install mlx-lm
mlx_lm.server --model xav-ie/scribe-cleanup-mlx-4bit --port 8080
```

Or, about 1.5 times faster at the same quality, [`serve_mlx.py`](https://huggingface.co/xav-ie/scribe-cleanup-mlx-4bit/blob/main/serve_mlx.py)
from the Mac version's files (it needs [uv](https://docs.astral.sh/uv/)): `./serve_mlx.py --port 8080`. It adds prompt
lookup, explained under llama.cpp below.

```python
import json, urllib.request
system = open("prompt.txt").read().strip()
lines = "[0:43] Alice Chen: um so the the cost should uh not exceed twelve fifty"
body = {"messages": [{"role": "system", "content": system},
                     {"role": "user", "content": f"<transcript>\n{lines}\n</transcript>"}],
        "temperature": 0, "max_tokens": 1024}  # max_tokens caps the length of the answer
req = urllib.request.Request("http://127.0.0.1:8080/v1/chat/completions", json.dumps(body).encode(),
                             {"Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"])
```

**With llama.cpp** (any computer): `llama-server -hf xav-ie/scribe-cleanup-GGUF --port 8080`, then the same Python as
above. Because the cleaned text mostly repeats the input, prompt lookup makes it faster at the same quality: add
`--spec-type ngram-simple --spec-ngram-simple-size-n 3 --spec-ngram-simple-size-m 16`. It guesses the next words from
the input and checks the whole guess in one step. In our tests the scores were the same, though the odd comma or
period can differ.

**With vLLM** (servers; the model takes 9.4 GB of graphics memory, plus room for its working memory), then the same
Python as above on port 8000:

```sh
vllm serve xav-ie/scribe-cleanup --served-model-name cleanup --max-model-len 4096 --port 8000 \
  --speculative-config '{"method": "ngram", "num_speculative_tokens": 16, "prompt_lookup_min": 2, "prompt_lookup_max": 3}'
```

The last line turns on prompt lookup. On one RTX 5090 it made a chunk 1.8 times faster (0.8 seconds instead of 1.6)
with the same scores. Sending 16 chunks at once, a one-hour meeting is cleaned in about 5 seconds.

**With transformers:**

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
tok = AutoTokenizer.from_pretrained("xav-ie/scribe-cleanup")
model = AutoModelForCausalLM.from_pretrained("xav-ie/scribe-cleanup", dtype="auto", device_map="auto")
messages = [{"role": "system", "content": open("prompt.txt").read().strip()},
            {"role": "user", "content": "<transcript>\n[0:43] Alice Chen: um so the the cost should uh not exceed twelve fifty\n</transcript>"}]
inputs = tok.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False,
                                 return_tensors="pt", return_dict=True).to(model.device)
out = model.generate(**inputs, max_new_tokens=1024)  # greedy by default
print(tok.decode(out[0, inputs["input_ids"].shape[1]:], skip_special_tokens=True))
```

## Results

<!-- table:card-verdict -->
In short: on meetings it never saw, the cleaned text has 14.1% of words, punctuation and capitals wrong, against 23.2% for the raw transcript. After the safety check, 0% of test chunks had a wrong number and 0% a missing "not".
<!-- /table:card-verdict -->

All tests use meetings and sentences the model never saw in training, and score its own output, before the safety
check. [METHODOLOGY.md](METHODOLOGY.md#scoring) explains each score. The range after the word errors is where the
score would likely fall on other, similar meetings. The raw transcript can't get a number wrong, since nothing
changed it.

<!-- table:test-meetings -->
**Meetings** (330 chunks)

| System | Word errors | Word, punctuation and capital errors | Punctuation (0 to 1) | Capitals (0 to 1) | Filler removal (0 to 1) | Wrong number | Missing "not" |
|---|---|---|---|---|---|---|---|
| Raw transcript | 6.8% (likely 5.5% to 8.5%) | 23.2% | 0.24 | 0.54 | n/a | 0% | 0% |
| Rules only (drop fillers and repeats) | 2.6% (likely 2.1% to 3.2%) | 21% | 0.24 | 0.60 | 0.76 | 0% | 0% |
| **scribe cleanup v1** | 1.7% (likely 1.1% to 2.5%) | 14.1% | 0.58 | 0.78 | 0.88 | 1.8% | 0% |
<!-- /table:test-meetings -->

<!-- table:test-synthetic -->
**Number tests**: made-up lines with prices, dates, codes, names, corrections and requests, inserted into real meetings (649 chunks)

| System | Word errors | Word, punctuation and capital errors | Wrong number | Unsure number converted | Correction not applied | Lines kept intact |
|---|---|---|---|---|---|---|
| Raw transcript | 9.4% | 26.5% | 0% | 0% | 29.7% | 100% |
| Rules only (drop fillers and repeats) | 5.2% | 22.8% | 0% | 0% | 29.7% | 100% |
| **scribe cleanup v1** | 1.6% | 12.8% | 2.6% | 0% | 0% | 99.5% |
<!-- /table:test-synthetic -->

<!-- table:reviewed -->
**Hand-checked lines** (150 meeting lines; the correct answers were checked against the rules by an AI (Claude), then a person checked 30 at random and agreed with all 30)

| System | Word errors | Word, punctuation and capital errors | Punctuation (0 to 1) | Capitals (0 to 1) | Filler removal (0 to 1) |
|---|---|---|---|---|---|
| Raw transcript | 7.5% | 21.8% | 0.36 | 0.67 | n/a |
| Rules only (drop fillers and repeats) | 3.9% | 20.4% | 0.36 | 0.69 | 0.66 |
| **scribe cleanup v1** | 2.1% | 14.1% | 0.61 | 0.78 | 0.82 |
<!-- /table:reviewed -->

After the safety check, which is what you actually read:

<!-- table:test-guards -->
| After the safety check | Meetings | Number tests |
|---|---|---|
| Chunks with a wrong number | 0% | 0% |
| Unsure numbers converted | 0% | 0% |
| Chunks with a missing "not" | 0% | 0% |
| Lines put back to the raw text | 0.5% | 0.6% |
<!-- /table:test-guards -->

The safety check and the tests use the same detector for numbers and "not", so the zeros above hold by design. What
the check adds is how rarely it needs to step in: on its own it put back fewer than 1 line in 500, each one a real
mistake. The rest of the last row is whole chunks kept because the model broke the line format.

The compressed versions score the same, give or take random variation, on a sample of both test sets.

## Known weak spots

From reading every mistake on the tests. The safety check catches the first four, so you see the original line.

- **Rare number slips:** "that's two off" once became "that's 20 off", in a handful of test lines.
- **A digit dropped from a longer code:** "channel six one one one one oh" lost a "one". A doubled word, as in "one
  one little question", counts as a stutter and may become one.
- **Heavy crosstalk** can make it merge or drop a line. That whole chunk then stays as the original.
- **Recognition loops,** where speech-to-text repeats a word dozens of times ("two two two ..."), can make it repeat
  the loop instead of cutting it, mostly when it runs on a CPU. Cut any run of 5 or more copies to one before
  sending, as scribe does; the model was trained to treat such runs that way.
- **Punctuation where people talk over each other** is often unclear, so its choices there are shaky.

## Limits and risks

Cleanup is an optional extra; the original transcript stays the record. It works in English only. It reads text,
not audio, and it learned from one kind of text: transcripts of in-person meetings from the AMI collection, about two
thirds of them role-played product-design meetings, transcribed by one speech-to-text model (Parakeet). Transcripts
of other conversations, or from other speech-to-text tools, may contain patterns and mistakes it hasn't seen; it is
untested on them. It does not fix misheard words, summarize or translate.

Meeting transcripts are often private. The model runs entirely on your own computer, so nothing has to leave it.

## Training

Gemma 4 E2B stayed unchanged while a LoRA add-on learned the task, which was then merged into the weights. Settings:
QLoRA, rank 16, alpha 32, all attention and MLP projections, loss on the answer only, learning rate 2e-4 with 3%
warmup and cosine decay, 1,500 steps of 8 chunks, keeping step 1,200. Training took under 2 hours on one rented
NVIDIA A100, and the same script fits an 8 GB consumer graphics card. More in [METHODOLOGY.md](METHODOLOGY.md).

## License and credits

- **Model:** Apache-2.0 (see `LICENSE`). Modified from [google/gemma-4-E2B-it](https://huggingface.co/google/gemma-4-E2B-it)
  (Apache-2.0) by fine-tuning and keeping only its text part.
- **Training data:** the [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) (University of Edinburgh and
  partners), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), provided as is. Our changes: we ran its
  audio through a speech-to-text model, lined the result up with AMI's transcripts, built cleaned training text from
  them by rule, and inserted made-up lines between real ones.
- **Training input:** transcribed with NVIDIA Parakeet (`parakeet-unified-en-0.6b`).
- **Use of AI in the data:** the real meeting text comes from human transcripts and fixed rules. The made-up practice
  lines fill about 250 short sentence patterns, written with an AI assistant (Claude), with random values. Claude also
  helped check the answers of 150 test lines, which are used only for testing.

**Feedback:** the Community tab of this repository.

## Citation

```bibtex
@misc{scribe_cleanup_2026,
  title  = {scribe cleanup v1: a small local model for cleaning meeting transcripts},
  author = {Xavier Ruiz},
  year   = {2026},
  url    = {https://huggingface.co/xav-ie/scribe-cleanup}
}
@inproceedings{carletta2005ami,
  title     = {The {AMI} Meeting Corpus: A Pre-announcement},
  author    = {Carletta, Jean and others},
  booktitle = {Machine Learning for Multimodal Interaction (MLMI)},
  year      = {2005}
}
```
