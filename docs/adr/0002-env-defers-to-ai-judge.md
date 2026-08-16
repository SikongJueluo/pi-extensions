---
status: accepted
---

# Defer `env` to the AI judge; inner-cmd never unwraps it

`env` is the second command type considered for `pi-permission-inner-cmd`'s
deterministic unwrapping. We decided inner-cmd **always defers** `env` — it
never strips modifiers or re-evaluates an inner command — and lets the AI judge
authority handle `env` commands together with their full environment context.

## Why

`env` is a *non-transparent wrapper*: its modifier args (`NAME=VALUE`, `-i`,
`-u`, `-C`, `-S`) form an unbounded, implicit input channel that the
command-string policy cannot see. Stripping them and re-evaluating the inner
command is unsound, because the modifiers can change what actually runs without
changing the inner command string:

- `PATH=/evil` — resolve the inner name to a different binary;
- `LD_PRELOAD=/x.so`, `LD_LIBRARY_PATH` — inject arbitrary native code into the
  inner binary before its `main()`;
- `BASH_ENV`, `PYTHONPATH`, `NODE_OPTIONS`, `PERL5OPT`, … — source scripts or
  inject code into the inner command's runtime;
- `-i`, `-u NAME`, `-C DIR` — alter the execution context.

A "detect dangerous variables and defer" denylist is infeasible: the dangerous
set is open-ended (new runtimes keep introducing new `*_OPT` / `*_PATH`
injection variables), so any denylist is permanently incomplete, and one miss is
an RCE. Detecting "does *any* modifier exist" is trivial and complete, but the
only sound unwrap case is bare `env <cmd>` (zero modifiers), which is too rare in
practice to justify the shell parsing it would require (assignment/flag
detection, `-S`, `--`, `/usr/bin/env` basename, quoting).

## Considered options

- **Detect a `PATH=` override, otherwise unwrap** — rejected as false security:
  `LD_PRELOAD` and the interpreter-injection variables defeat it without
  touching `PATH`.
- **Unwrap only bare `env <cmd>` (zero modifiers)** — sound, but bare `env` is
  rarely written and the boundary parsing adds real complexity for near-zero
  coverage. Not worth it.
- **Always defer (chosen)** — zero parsing risk, zero soundness surface;
  non-transparent commands get the semantic judgement they require from the AI
  judge.

## Consequences

This establishes a clean division between the two permission authorities:

- **inner-cmd (deterministic)** unwraps only *transparent* wrappers (`timeout`)
  — sound, fast, narrow. Every uncertain or non-transparent command defers
  fail-closed.
- **The AI judge authority** receives deferred commands (including `env`) and
  reasons about the full command *with* its environment, where non-transparency
  can be understood semantically rather than stripped.

This is why the AI judge consumes the complete command from permission-system's
structured prompt payload (ADR 0004) — it needs the complete input, modifiers
included, to judge non-transparent wrappers. See `CONTEXT.md` for the transparent /
non-transparent wrapper distinction.
