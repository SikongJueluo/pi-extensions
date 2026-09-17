# pi-permission-inner-cmd

pi 内部命令的 Bash 授权器：把 pi 内部命令触发的原生 Bash 确认请求送进
pi-permission-system 的人工弹窗，并只在证明过的 UI 根会话上注册。

## 安装

```bash
pi install npm:@sikongjueluo/pi-permission-inner-cmd
```

或从仓库安装：

```bash
pi install github.com/SikongJueluo/pi-extensions
```

前提：项目启用 [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system)
≥ 32，并把 `inner-cmd` 挂进授权链（链按书写顺序依次咨询，仅 UI 会话生效）：

```json
// .pi/extensions/pi-permission-system/config.json
{ "authorizerChain": ["inner-cmd", "ai-bash-judge"] }
```

## 工作方式

- 仅在捕获到 UI-present 的根会话（`session_start` 且 sessionId 非空）后，才向权限服务注册 `inner-cmd` 授权器；headless / in-process 子代理不注册，避免子会话上下文冒充根会话
- 扩展与权限系统谁先就绪都能完成注册（`PERMISSIONS_READY_CHANNEL` 重试）
- 会话 id 中途变化时按活会话 id 重新解析服务并重挂授权器
- 授权时从结构化 prompt 载荷提取完整命令与触发单元作为证据，逐个 handler 判决
- `session_shutdown` 时注销授权器

## 测试

`pnpm check && pnpm test`
