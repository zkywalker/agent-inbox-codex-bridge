# Agent Inbox Codex Bridge

Codex Bridge 是运行在 Codex 主机上的出站连接器。它连接 Agent Inbox 网关，并通过本机 stdio 控制官方 Codex App Server；它不是 Codex 的替代实现，也不开放入站端口。

## 运行边界

- `Bridge` 负责消息、管理请求、会话恢复和受控的 App Server 生命周期。
- `Codex App Server` 负责原生会话、模型调用、工具、沙箱和审批。
- `Supervisor` 负责 Bridge 版本切换、健康检查和回滚。
- 网关不执行主机命令，也不能直接读取主机文件。

## 本地构建

需要 Node.js 22.13+ 和已登录的 Codex CLI：

```sh
npm ci
npm run typecheck
npm run build
node dist/src/main.js --validate /absolute/path/to/private-config.json
```

私有配置必须是 `0600`，`stateDir` 必须是私有目录。配置示例见 `docs/config.example.json`。

## 发布

稳定版本只从受保护的 `v*` 标签发布。GitHub Actions 会运行检查、构建 bundle、生成校验清单、SBOM 和 provenance attestation，然后创建 Release。发布前必须在 GitHub 仓库设置中启用分支保护、标签保护、环境审批和 Dependabot。

发布流程和主机升级契约见 `RELEASE.md`。Bridge 不接受远程 URL、shell 命令、任意安装路径或任意版本参数。

## 安全

请勿提交网关 Token、管理 Token、API Key、私有配置、SQLite 数据库或主机路径。漏洞报告见 `SECURITY.md`。
