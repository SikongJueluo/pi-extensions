# pi-extensions

English | [简体中文](README.zh-CN.md)

Personal extensions for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent, focused on Bash permissions: unwrap, inspect, and re-adjudicate commands before they run.

## Packages

| Package | Description |
|---|---|
| [pi-permission-ai-judge](packages/pi-permission-ai-judge) | AI judge — a model rules allow / deny / defer on each pending Bash ask; shadow logs only, enforce auto-approves |
| [pi-permission-inner-cmd](packages/pi-permission-inner-cmd) | Unwraps transparent Bash wrappers (`timeout`, `time`, …) and authorizes the inner command |

## Install

```bash
pi install git:github.com/SikongJueluo/pi-extensions
```

The package manifest (root `package.json`, `pi.extensions`) mounts both extensions declaratively — effective in any directory. Prerequisites:

1. Enable [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) ≥ 32
2. Add the extensions to the authorizer chain — order is consultation order, UI sessions only:

```jsonc
// ~/.pi/agent/extensions/pi-permission-system/config.json
{ "authorizerChain": ["inner-cmd", "ai-bash-judge"] }
```

See the ai-judge [README](packages/pi-permission-ai-judge/README.md) for modes, judge model, and guardrails.

## Development

pnpm workspace, TypeScript + vitest.

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

Design decisions live in [docs/adr/](docs/adr/).

## License

GPL-3.0
