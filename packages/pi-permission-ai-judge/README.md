# pi-permission-ai-judge

pi 的 Bash 权限 AI 判官：每条待确认的 Bash 命令先交给模型，得到 allow / deny / defer（拿不准）三种判决之一。

## 模式

- **shadow**（默认）：判决只写日志，弹窗照旧。适合先观察模型判断质量。
- **enforce**：判决 allow 时跳过弹窗直接执行，其余情况照常弹窗。只减少弹窗，不会自动拒绝。

enforce 是自担风险的便利模式：模型误判，危险命令可能在无人确认时执行。退出方式：mode 改回 shadow。

## 安装

```bash
pi install github.com/SikongJueluo/pi-extensions
```

前提：项目启用 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) ≥ 25.4，并把判官挂进授权链（链按书写顺序依次咨询，仅 UI 会话生效）：

```json
// .pi/extensions/pi-permission-system/config.json
{ "authorizerChain": ["inner-cmd", "ai-bash-judge"] }
```

## 配置

`~/.pi/agent/pi-permission-ai-judge.config.json`，会话启动时读取，改动下个会话生效。

```json
{
  "version": 2,
  "mode": "enforce",
  "model": { "provider": "openai-codex", "id": "gpt-5.6-sol" },
  "timeoutMs": 30000
}
```

| 字段 | 说明 |
|---|---|
| `version` | 不写按 v1 处理，v1 的 enforce 不生效；要用 enforce 写 2 |
| `mode` | `shadow`（默认）或 `enforce`，非法值回退 shadow |
| `model` | 可选，固定判官模型；不写则跟随会话模型。解析失败按故障处理并弹窗，绝不静默改用会话模型 |
| `timeoutMs` | 单次判决等待上限，5000–30000，默认 15000 |

## enforce 的防线

**高风险命令永远弹窗。** 四类形状硬编码在代码里，enforce 下命中即跳过模型、交回人工；规则不可配置，不解析别名/脚本/变量展开——是兜底，不是沙箱：

- 数据丢失/历史重写：`git clean -xfd`、`git reset --hard`、`git push --force`、`rm -rf ~` 等
- 发布/部署/基础设施销毁：`npm publish`、`terraform destroy` 等
- 提权/系统修改：`sudo`、`mkfs`、`dd of=/dev/*`、`shutdown` 等
- 凭据读取/输出/删除：`cat ~/.ssh/id_*`、`~/.aws/credentials`、`~/.gnupg` 等

**运行时自检。** 审计日志写入失败、遥测异常、模型返回格式不对、会话已关闭——任一出现，当次弹窗，不放行。

## 推荐模型目录

`src/models-catalog.json` 列出实测过的判官模型（测试时间、prompt/语料版本、匹配数、延迟分布），逐例报告在 `reports/`。"推荐"只代表兼容性实测通过，不是安全认证；目录外的模型仍可用于 enforce（不拦截），仅会话开始时提示未经测试。

## 日志与工具

- **审计日志**：`~/.pi/agent/extensions/pi-permission-ai-judge/logs/audit.jsonl`，逐条落盘；写入失败则 enforce 停止代批
- **离线分析**：`npx tsx src/analyzer/cli.ts <review-log> --audit <audit-log> --after <t> --before <t>`
- **语料回放**：`npx tsx tools/corpus-replay.ts --provider <p> --model <m> --timeout-ms N [--strict]`，21 用例，需真实端点。`--strict`：全对、零故障、延迟达标才 exit 0，否则 exit 2（setup 失败 exit 1）；不加则只出报告
- **测试**：`pnpm check && pnpm test`

## 文档

- 风险契约与治理：ADR 0008；审计自持：ADR 0006；不可逆边界：ADR 0007——见 `docs/adr/`
- 历史 cohort 报告：`docs/testing/`
