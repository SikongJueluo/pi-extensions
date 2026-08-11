# pi-extensions

Personal `pi` coding-agent extensions. This context covers the permission
extensions that inspect and re-evaluate Bash commands before they are allowed.

## Language

### Wrappers

**Wrapper**:
A Bash command of the form `<program> [modifier-args] <inner-command>`, where the
authorization question is "what does the inner command do?". Whether a wrapper
may be unwrapped depends on whether its modifier args are transparent.
_Avoid_: command type, prefix command

**Transparent wrapper**:
A wrapper whose modifier args do not change which program the inner command
resolves to or its trust boundary (e.g. `timeout`). Stripping the modifiers and
re-evaluating the inner command is sound: the verdict applies to the same
program that actually runs.
_Avoid_: safe wrapper

**Non-transparent wrapper**:
A wrapper whose modifier args change the inner command's resolution or effect
(e.g. `env`, whose `PATH=` or `-i` can make the inner name resolve to a
different binary). Stripping the modifiers and re-evaluating the inner command
is unsound: the verdict may apply to a different program than the one that runs.
_Avoid_: unsafe wrapper
