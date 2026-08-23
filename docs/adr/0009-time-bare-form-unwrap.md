---
status: accepted
---

# The bare `time` wrapper unwraps like `timeout` (ADR 0009)

`pi-permission-inner-cmd` recognized only `timeout <duration> <command>`
(ADR 0001). `time <command>` poses the same authorization question — a
wrapper around an inner command — and appears routinely in agent Bash calls
(`time pnpm build`). A wrapper qualifies for unwrapping only when its
modifier args are transparent (CONTEXT.md, Wrappers).

## Decision

Recognize exactly the bare reserved-word form:

```regex
^time[ \t]+(?![-\s])(.+)$
```

It is transparent: `time` runs the inner command unchanged and only adds
timing, so the `timeout` unwrap pipeline applies verbatim — strip the wrapper
from the FULL command (scaffold included) and re-evaluate the whole de-wrapped
compound, so sibling commands stay under judgment. An inner `allow` allows,
anything else defers fail-closed.

Everything else that begins with `time` defers with
`inner_cmd.unsupported_wrapper_syntax`:

- **any dash-leading modifier** (`time -p ls`, `time -- ls`, `time -o FILE ls`).
  The command string cannot distinguish the Bash reserved word (which accepts
  only `-p`) from `/usr/bin/time` (whose `-o FILE` writes a file and `-v`
  dumps environment-bearing stats), and the lookahead also blocks regex
  backtracking from smuggling a leading space past a wide separator. A
  modifier arg is therefore treated as potentially non-transparent until
  individually proven otherwise.
- **a bare `time`** — it times the shell itself; there is no inner command to
  re-evaluate.

`/usr/bin/time cmd` (full path) is not claimed by any handler and defers
silently like any unrecognized command.

## Generalizations that ride along

- `isRecognizedWrapper` now covers timeout ∪ time, so `time timeout 10 cmd`,
  `timeout 10 time cmd`, and `time time cmd` all defer at most-one-level
  nested wrappers (previously the check was timeout-only).
- The defer events generalize from `inner_cmd.nested_timeout` /
  `inner_cmd.unsupported_timeout_syntax` to `inner_cmd.nested_wrapper` /
  `inner_cmd.unsupported_wrapper_syntax`, each carrying a `wrapper:
  "timeout" | "time"` field, so future wrapper handlers reuse the same event
  names. Downstream analysis joins only on the decisive
  `inner_cmd.allow|deny` markers and is unaffected.

## Consequences

- `time pnpm test` no longer reaches the human dialog / AI judge when the
  inner command is already allowed.
- Handler precedence stays irrelevant: `timeout` and `time` prefixes are
  disjoint, and both are tried before the claiming non-transparent handlers
  (`env`, `xargs`).
- If `time -p` transparency is ever wanted, it is a one-line grammar change
  plus tests — recorded here as deliberately out of scope for v0.1.
