# 执行计划

内部等级：L。单代理串行执行，按模块验证。

1. 新增统一配置模块和请求级 HTTP 路由。
2. 接入 server.js，扩展会话字段、WebSocket 配置与切换消息。
3. 改造 Claude/Codex runtime 的启动参数和环境注入。
4. 在前端增加统一配置编辑器，并让 Claude/Codex 模型选择器发送统一选择消息。
5. 执行 `node --check`，静态审阅路由鉴权、请求体重写和会话空闲限制。

## 回滚

仅回滚本次新增模块及对应 server.js/public/app.js 局部改动，不触碰 CodeBuddy、Kimi、OpenCode 代码。
