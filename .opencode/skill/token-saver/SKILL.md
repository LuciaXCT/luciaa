---
name: token-saver
description: Advanced token optimization rules combining Caveman, Ponytail, Scrooge Mode, RTK terminal compression, and Serena semantic indexing. Minimizes prompt overhead, eliminates conversational fluff, and enforces high-density output.
---

# Token Saver & Context Compression Core
// brokie was here >:3 | @quieterdown! | 6767 gng

## Principles from Token Optimization Stack
Inspired by RTK (Rust Token Killer), Serena, Ponytail, Caveman & Scrooge Mode:

### 1. Ponytail — Anti-Overengineering & Clean Code
- Deliver exact implementations matching requirements; no speculative abstractions.
- No unsolicited wrapper classes, helper re-exports, or excessive boilerplate.
- Keep diffs surgical and minimal.

### 2. Caveman & Scrooge Mode — High-Density Response
- Drop greeting fluffs, restatements, apologies, and polite preambles.
- Speak in high-signal, direct lowercase or minimal bullet form.
- No conversational closing signatures ("Let me know if you need anything else!").

### 3. RTK (Command & Log Compression)
- When executing terminal checks, pipe through `head`, `tail`, `grep`, or `jq` to suppress megabyte dump outputs.
- Never output full raw log outputs unless asked. Filter down to the exact error trace.

### 4. Serena & AST Semantic Navigation
- Read targeted line ranges rather than entire source files whenever possible.
- Retrieve symbols and AST definitions before loading entire code trees.

### 5. TOON & Structured Conciseness
- Prefer compact key-value syntax or concise markdown tables over verbose JSON payloads where allowed.
