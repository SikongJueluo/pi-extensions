# pi-permission-ai-judge

[`pi`](https://github.com/earendil-works/pi-coding-agent) 的 Bash 权限 AI 判官——对每一条进入权限对话框的命令,用 AI 模型给出第二意见。

- **影子模式**(默认):判官并行给出"允许 / 拒绝 / 交给人类"的判决,人类照常决策;判决与证据元数据全部落盘,可离线分析
- **强制模式**(config v2):**用户自担风险的便利模式**——判官判决"允许"且运行时健康门全部通过时跳过人类对话框;判官"拒绝/交人类/超时/健康异常"一律回落对话框,不引入自动拒绝。明确的高风险命令形状(不可逆删除、发布/基础设施销毁、提权/系统修改、直接读删凭据)永远交人类。详见 ADR 0008

## 安装

```bash
pi install github.com/SikongJueluo/pi-extensions
```

依赖项目启用 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) ≥ 25.4,并配置授权链(仅 UI 会话生效):

```json
// .pi/extensions/pi-permission-system/config.json
{ "authorizerChain": ["ai-bash-judge", "inner-cmd"] }
```

## 配置

`~/.pi/agent/pi-permission-ai-judge.config.json`,会话启动时读取:

```json
{
  "version": 2,
  "mode": "enforce",
  "model": { "provider": "openai-codex", "id": "gpt-5.6-sol" },
  "timeoutMs": 30000
}
```

- `version`:配置协议版本。**旧 v1 配置(无 `version` 字段)里的 `mode: "enforce"` 不会静默获得新授权**——会回退 shadow 并提示迁移;写入 `"version": 2` 即完成一次显式迁移,这个动作本身就是风险同意
- `mode`:`shadow`(默认)| `enforce`(强制)。非法值一律回退 shadow
- `model`(可选,仅 v2):固定判官模型,不随会话模型切换。配置的模型不存在、无认证或 API 不支持时,该次询问记为基础设施失败并交人类,**绝不静默改用会话模型**;未配置时跟随当前会话模型
- `timeoutMs`:5000–30000,默认 15000

强制模式每次会话启动时弹一次非阻塞通知,显示实际判官模型与风险契约;不逐次重复。若判官模型不在推荐目录里,通知会附带"未经项目测试,自担风险"提示(仅提示,不阻断——见下)。

## 强制模式 = 风险契约(不是安全认证)

手写 `mode: "enforce"` 即表示:你授权所选判官模型代为批准普通操作,并**自行承担漏判/误判风险**(ADR 0008)。本包不承诺任何"模型已获安全认证",也不试图覆盖所有危险 shell 行为。保留的运行时保护:

- **健康门**(全部 fail-closed):审计日志健康、遥测健康、判决结果类型、审计回执、会话世代——任一失败即回退对话框
- **内置高风险 override**(窄范围代码级规则,不是 sandbox):明确的数据丢失/历史重写(`git clean -xfd`、`git reset --hard`、`git push --force`、`rm -rf ~` 等)、发布/部署/基础设施销毁(`npm publish`、`terraform destroy` 等)、提权/系统修改(`sudo`、`mkfs`、`dd of=/dev/*`、`shutdown` 等)、直接凭据读取/输出/删除(`cat ~/.ssh/id_*`、`~/.aws/credentials`、`~/.gnupg` 等)。Enforce 命中时不调模型、立即交人类;Shadow 命中时仍调模型(保留质量观测)并记录 override,最终照常人类决策。不解析别名/脚本内容/变量展开,没有 `alwaysPrompt` 配置
- 回滚 = 配置切回 `shadow`

## 推荐模型目录(咨询性,不是认证)

包内 `src/models-catalog.json` 维护一份**版本化推荐模型清单**:每个条目记录 owner 用 corpus replay 实测某 provider/model 的结果——测试时间、prompt/corpus 版本、逐例匹配数、基础设施失败数、延迟摘要(p50/p95/max),以及包内完整报告路径(`reports/`)。条目可标 `deprecated`/`revoked`。

**推荐 ≠ 安全认证**:owner 测试只说明结构化输出/质量/延迟的**兼容性**,不构成任何安全承诺。目录外的模型**仍可用于 Enforce,风险自担**——运行时不设资格门(ADR 0008),目录只影响每会话通知与文档:列表外/已弃用模型在 Enforce 通知中附注状态,仅此而已。

历史治理(v4 及更早的 promotion cohort、三重记录门)已被 ADR 0008 取代,运行时不再读取 `promotion-records.jsonl`;旧记录与 cohort 报告原样保留作审计资料,见 `docs/testing/`。

## 日志与工具

- **判官审计日志**:`~/.pi/agent/extensions/pi-permission-ai-judge/logs/audit.jsonl`(逐条落盘;写入失败则标记不健康并拒绝强制授权)
- **离线分析**:`npx tsx src/analyzer/cli.ts <review-log> --audit <audit-log> --after <t> --before <t>`
- **语料重放**(质量环):`tools/corpus-replay.ts`,21 例对照集,需真实模型端点。加 `--strict` 时按轻量资格标准严格退出:全部匹配、零基础设施失败、延迟在预算内 → exit 0,否则 exit 2(仅 setup 失败才是 exit 1);不加则保持观测语义 exit 0(保留不利结果,不过滤)
- **测试**:`pnpm check && pnpm test`

## 文档

- 风险契约与治理变更:ADR 0008 / PIEXTENSIO-23
- 审计自持:ADR 0006;不可逆边界:ADR 0007,见 `docs/adr/`
- 旧 cohort 证据(v4 前含晋升治理):`docs/testing/`
