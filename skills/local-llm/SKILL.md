---
name: local-llm
description: Run a local uncensored language model with SillyTavern on this machine. Use when the user wants unlimited, offline, unfiltered chat or erotica without quotas.
---

# local llm stack

## layout on this box

| piece | path |
|---|---|
| ollama | `~/.local/bin/ollama` (no root, no systemd) |
| models | `~/.local/share/ollama/models` |
| SillyTavern | `~/SillyTavern` |
| launcher | `~/.local/bin/stack` |
| opencode skills | `~/.config/opencode/skill/<name>/SKILL.md` |

## run it

```bash
stack up      # ollama serve + SillyTavern, both backgrounded
stack down    # stop both
stack status  # what's running
```

SillyTavern: `http://localhost:8000` · Ollama API: `http://localhost:11434`

In SillyTavern: API = Text Completion → Ollama → URL `http://localhost:11434` → pick model.
Import a card from `~/CT002-HERE/persona/brokie.card.json`.

## hardware reality

Intel UHD 620, no CUDA, 15 GB RAM. CPU inference only:

- 3B Q4 → ~6–9 tok/s, usable
- 7B/8B Q4 → ~2–4 tok/s, readable but slow (300 words ≈ 90 s)
- 13B+ → don't

Set context to 4096 in SillyTavern (Model settings → Context Size) — larger contexts slow CPU
inference sharply.

## models worth pulling

```bash
ollama pull dolphin-mistral:7b      # least likely to lecture, ~4.1 GB
ollama pull qwen2.5:3b              # fast, decent prose, ~1.9 GB
ollama pull llama3.1:8b             # best prose, argues more
```

`dolphin-mistral` and any `*-abliterated` variant are the ones that hold an explicit scene
without breaking voice.
