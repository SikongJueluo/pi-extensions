---
status: accepted
---

# Defer `xargs`; it is non-transparent even to the AI judge

`xargs` is a third command type considered for `pi-permission-inner-cmd`. Like
`env` (ADR 0002), inner-cmd **always defers** it and never unwraps. Unlike `env`,
the non-transparency is in the inner command's *arguments*, not its environment.

## Why

`xargs [options] [command [initial-args]]` reads tokens from stdin (or `-a
FILE`) and appends them as arguments to `command`. The command string therefore
holds only the command *name* (plus any initial args); the bulk of what the
command actually does — its runtime arguments — comes from a separate channel
that is absent from the string entirely. Re-evaluating the inner command is
unsound: the verdict would apply to arguments that are not even knowable from the
input (`xargs rm` can become `rm` over any list of files). `-I` / `-i`, `-a`,
`-P`, `-o` further alter behavior.

There is no sound unwrap subset (unlike `env`'s rare bare form): `xargs` always
draws its arguments from an external source, so the inner command is never fully
determined by the string.

## Consequences

- inner-cmd registers an `xargs` handler that claims `xargs`-leading commands and
  defers them (mirroring `env`), for observability. Note that `xargs` usually
  appears mid-pipeline (`find … | xargs rm`), where inner-cmd's leading-program
  check never reaches it and it defers by default regardless.
- The deferred command reaches the AI judge — but the AI judge *also* cannot see
  stdin, so it cannot know the actual arguments either. `xargs` commands
  therefore typically warrant a human **ask** rather than an auto-allow, even
  with AI judgement; the sound outcome is human confirmation.

See ADR 0002 for the sibling `env` decision and `CONTEXT.md` for the
non-transparent wrapper distinction.
