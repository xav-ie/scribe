# Models

scribe uses two AI models in a row: one turns speech into text, and an optional second one tidies that text. The
models are large files, so they're downloaded from Hugging Face rather than stored here.

| Model | Job | Runs on | License | Status |
|---|---|---|---|---|
| [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) (`parakeet-unified-en-0.6b`) | speech to text, streamed live | the scribe server's GPU | NVIDIA Open Model License | in use |
| [scribe cleanup](cleanup/MODEL_CARD.md) | optional tidying of a finished transcript: ums, false starts, punctuation, capitals | any GPU or a Mac | Apache-2.0 | built into the scribe server, off unless [configured](../README.md#optional-cleanup) |

The raw transcript is the record and is never changed. When cleanup is on, it writes a separate copy.

## How cleanup treats a transcript

Long meetings are cleaned in chunks of about 250 words, never splitting a line.

AI models occasionally make mistakes, so the cleanup model's output isn't trusted blindly. A **safety check** runs
after it: a small ordinary program, [`guard.py`](cleanup/guard.py), with no AI in it, compares every cleaned line with
the original. If the model changed something that must never change (a timestamp, a speaker, a number's value or a
"not"), the check throws that cleaned line away and keeps the original. The worst case is a line left uncleaned,
never a line that says something different:

<!-- diagram:guards -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/guards-dark.svg">
  <img src="diagrams/guards.svg" alt="Cleanup, the model and the safety check together, takes a chunk of raw lines (&quot;[0:43] Alice: um so the the cost should uh not exceed twelve fifty&quot;, &quot;[0:48] Bob: so that's two off the price&quot;). The cleanup model returns one line per raw line (&quot;[0:43] Alice: So the cost should not exceed twelve fifty.&quot;, &quot;[0:48] Bob: So that's 20 off the price.&quot;); the safety check compares each with its raw line for the same timestamp and speaker, the same number values and every &quot;not&quot;. The cleaned chunk keeps the first cleaned line, which passed, and the second raw line, because &quot;two&quot; became 20">
</picture>
<!-- /diagram:guards -->

## Where to get it

<!-- table:versions -->
| Version | For | Size |
|---|---|---|
| [`xav-ie/scribe-cleanup-mlx-4bit`](https://huggingface.co/xav-ie/scribe-cleanup-mlx-4bit) | Macs with Apple chips (compressed) | 2.8 GB |
| [`xav-ie/scribe-cleanup-GGUF`](https://huggingface.co/xav-ie/scribe-cleanup-GGUF) | [llama.cpp](https://github.com/ggml-org/llama.cpp), a popular tool for running models locally (compressed) | 3.3 GB |
| [`xav-ie/scribe-cleanup`](https://huggingface.co/xav-ie/scribe-cleanup) | the full-size model, for Python's `transformers` library or [vLLM](https://github.com/vllm-project/vllm) on a server | 9.3 GB |
| [`xav-ie/scribe-cleanup-lora`](https://huggingface.co/xav-ie/scribe-cleanup-lora) | just the trained add-on (LoRA), for building your own versions | 93 MB |
<!-- /table:versions -->

## Documents

- [cleanup/MODEL_CARD.md](cleanup/MODEL_CARD.md): what the cleanup model is, how to use it, results, limits.
- [cleanup/METHODOLOGY.md](cleanup/METHODOLOGY.md): how it was built and tested.
- [cleanup/COMPARISON.md](cleanup/COMPARISON.md): how it compares with the alternatives, measured.
- [cleanup/guard.py](cleanup/guard.py): the safety check (plain Python, nothing to install).
- [cleanup/prompt.txt](cleanup/prompt.txt): the instructions the model was trained with.
