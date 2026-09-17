# pi-extensions

English | [简体中文](README.zh-CN.md)

Personal extensions for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent, focused on Bash permissions: unwrap, inspect, and re-adjudicate commands before they run.

## Packages

| Package | npm | Description |
|---|---|---|
| [pi-permission-ai-judge](packages/pi-permission-ai-judge) | [@sikongjueluo/pi-permission-ai-judge](https://www.npmjs.com/package/@sikongjueluo/pi-permission-ai-judge) | AI judge — a model rules allow / deny / defer on each pending Bash ask; shadow logs only, enforce auto-approves |
| [pi-permission-inner-cmd](packages/pi-permission-inner-cmd) | [@sikongjueluo/pi-permission-inner-cmd](https://www.npmjs.com/package/@sikongjueluo/pi-permission-inner-cmd) | Unwraps transparent Bash wrappers (`timeout`, `time`, …) and authorizes the inner command |

## Install

Per package from npm:

```bash
pi install npm:@sikongjueluo/pi-permission-ai-judge
pi install npm:@sikongjueluo/pi-permission-inner-cmd
```

Or the whole repo via git (both extensions mount through the root `package.json` `pi.extensions` manifest):

```bash
pi install git:github.com/SikongJueluo/pi-extensions
```

Either way, effective in any directory. Prerequisites:

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

## Release

Bump the version in `packages/<pkg>/package.json`, commit, then tag and push:

```bash
jj tag set @sikongjueluo/pi-permission-ai-judge@0.1.0 -r <rev>
jj git push   # pushes the bookmark and new tags
```

The [publish workflow](.github/workflows/publish.yml) verifies the tag matches the `package.json` name and version, runs check and tests, then publishes to npm with provenance. Requires the `NPM_TOKEN` repository secret (granular token with publish rights on the `@sikongjueluo` scope, or a classic automation token).

## License

GPL-3.0
