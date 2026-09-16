# pi-extensions

[English](README.md) | 简体中文

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码代理的个人扩展集，专注 Bash 权限：放行前拆包、审视、再审。

## 包

| 包 | 说明 |
|---|---|
| [pi-permission-ai-judge](packages/pi-permission-ai-judge) | AI 判官。模型对每条待确认的 Bash 命令给出 allow / deny / defer；shadow 只记日志，enforce 代批放行 |
| [pi-permission-inner-cmd](packages/pi-permission-inner-cmd) | 解包透明包装命令（`timeout`、`time` 等），按内层命令授权 |

## 安装

```bash
pi install git:github.com/SikongJueluo/pi-extensions
```

包清单（根 `package.json` 的 `pi.extensions`）声明式挂载两个扩展，任意目录生效。前提：

1. 启用 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) ≥ 32
2. 把扩展挂进授权链——顺序即咨询顺序，仅 UI 会话生效：

```jsonc
// ~/.pi/agent/extensions/pi-permission-system/config.json
{ "authorizerChain": ["inner-cmd", "ai-bash-judge"] }
```

ai-judge 的模式、判官模型与防线见其 [README](packages/pi-permission-ai-judge/README.md)。

## 开发

pnpm workspace，TypeScript + vitest。

```bash
pnpm install
pnpm check   # tsc --noEmit
pnpm test    # vitest run
```

设计决策见 [docs/adr/](docs/adr/)。

## License

GPL-3.0
