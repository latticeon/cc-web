# Claude/Codex 多供应商路由

## 目标

统一 Claude 与 Codex 的供应商和模型选择，并允许同一可见会话在一轮响应结束后切换供应商或模型。

## 约束

- 请求模型格式固定为 `providerId/modelId`，只按第一个 `/` 分割。
- 路由按请求解析供应商，不保存全局当前供应商。
- Claude 使用 Anthropic Messages 路由，Codex 使用 OpenAI Responses 路由。
- CodeBuddy、Kimi、OpenCode 保持现状。
- 不提供旧配置和旧会话迁移兼容。
- 本次只做 Node.js 语法检查与静态审阅，不执行构建或浏览器验证。

## 验收条件

1. 可保存多个 Claude/Codex 供应商，每个供应商包含 Base URL、API Key 和模型列表。
2. 上游请求不会收到 cc-web 虚拟 Key，模型名会被还原为真实模型 ID。
3. 同一会话空闲时可通过 WebSocket 切换供应商、模型和 Codex thinking 强度，不创建新会话。
4. 运行时对本地登录态和远程 API 配置均有明确错误提示。
