# pi-permission-ai-judge

[`pi`](https://github.com/earendil-works/pi-coding-agent) 的 Bash 权限 AI 判官——对每一条进入权限对话框的命令,用会话模型给出第二意见。

- **影子模式**(默认):判官并行给出"允许 / 拒绝 / 交给人类"的判决,人类照常决策;判决与证据元数据全部落盘,可离线分析
- **强制模式**:仅允许委托——仅当判决为"允许"且全部治理门通过时跳过人类对话框;任何不确定(交人类 / 拒绝 / 超时 / 健康异常)一律回落对话框。不可逆操作(如 `git clean -xfd`)永远交给人类,详见 ADR 0007

## 安装

```bash
pi install github.com/Sikongjueluo/pi-extensions
```

依赖项目启用 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) ≥ 25.4,并配置授权链(仅 UI 会话生效):

```json
// .pi/extensions/pi-permission-system/config.json
{ "authorizerChain": ["ai-bash-judge", "inner-cmd"] }
```

## 配置

`~/.pi/agent/pi-permission-ai-judge.config.json`,会话启动时读取:

```json
{ "mode": "shadow", "timeoutMs": 30000 }
```

- `mode`:`shadow`(影子)| `enforce`(强制),默认影子;非法值一律回退影子
- `timeoutMs`:5000–30000,默认 15000。**非默认超时是独立的配置群组**,不继承其他群组的晋升记录

## 强制模式晋升（仅仓库所有者；普通用户无需任何操作）

默认影子模式对使用者零门槛。强制模式意味着“判官说允许就跳过对话框”，因此启用前需要证据链：影子模式下收集一批真实流量（群组，如 110 条）证明零误放，然后所有者显式记录三次——群组合格、批准、激活（三个独立动作，精确绑定候选身份：模型 × 提示词版本 × 超时群组等 9 个字段）。任一缺失或身份漂移即自动关闸。

**使用者两种选择：**信任本仓库已归档的群组证据，直接拷贝 `promotion-records.jsonl` 并配置 `mode: "enforce"`；或换用自己的模型，重新收集群组后自行记录。所有者记录命令：

```bash
cd packages/pi-permission-ai-judge
npx tsx tools/promotion-record.ts --kind cohort_qualified \
  --provider openai-codex --model gpt-5.6-sol --api openai-codex-responses \
  --timeout-cohort 30000 --basis "cohort id; report path"
# 再依次 --kind owner_approval、--kind activation(三个独立显式动作)
```

记录写入 `~/.pi/agent/extensions/pi-permission-ai-judge/promotion-records.jsonl`(只追加)。回滚 = 配置切回 `shadow`;记录保留作审计轨迹。

## 日志与工具

- **判官审计日志**:`~/.pi/agent/extensions/pi-permission-ai-judge/logs/audit.jsonl`(逐条落盘;写入失败则标记不健康并拒绝强制授权)
- **离线分析**:`npx tsx src/analyzer/cli.ts <review-log> --audit <audit-log> --after <t> --before <t>`
- **语料重放**(质量环):`tools/corpus-replay.ts`,21 例对照集,需真实模型端点
- **测试**:`pnpm check && pnpm test`

## 文档

- 治理与晋升底线:PIEXTENSIO-10;v3 失败与 v4 修复:PIEXTENSIO-19/20/22,见 `docs/testing/`
- ADR 0006(审计自持)、0007(不可逆边界):见 `docs/adr/`
