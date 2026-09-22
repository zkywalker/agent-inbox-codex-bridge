# Codex Bridge 主机部署指南

本文对应合并本指南修复后发布的 `v0.1.3+` 发布包。`v0.1.2` 的历史包没有包含 `supervisor/`，不要用它部署。本文描述的是**人工首次安装和人工升级**流程；当前版本的 Supervisor 负责固定入口、子进程重启和启动失败重试，网关远程升级/自动回滚协议尚未启用。不要把网关上的“更新”按钮接到本版本上。

## 1. 部署前提

- macOS 13+（Intel 或 Apple Silicon）或 Linux x86_64。
- Node.js `22.13+`，并且 `node`、`npm` 在服务管理器启动时可见。
- 目标主机已安装并登录 Codex CLI；`codexBinary` 使用绝对路径。
- 主机可以通过 HTTPS 访问 Agent Inbox 网关。
- 已从 GitHub Release 下载与主机匹配的 `tar.gz` 和 `checksums.txt`。不要从 PR、分支或任意 URL 安装。

Bridge 只建立出站连接，不监听入站端口。网关不能执行主机命令，也不能直接读取主机文件。

## 2. 下载并校验发布包

在临时目录下载发布包和校验清单，然后验证 SHA-256。示例中的版本可替换为目标 Release 版本：

```sh
set -eu
VERSION=0.1.3
PLATFORM=darwin-arm64 # linux-x64 / darwin-x64 / darwin-arm64
INSTALL_ROOT="$HOME/.agent-inbox/codex-bridge"
TMP="$(mktemp -d)"
cd "$TMP"

# 用浏览器或 gh 下载对应 Release 的两个文件后再执行校验。
shasum -a 256 -c "checksums.txt" --ignore-missing
mkdir -p "$INSTALL_ROOT/versions/$VERSION" "$INSTALL_ROOT/downloads" "$INSTALL_ROOT/state"
tar -xzf "codex-bridge-${VERSION}-${PLATFORM}.tar.gz"
cp -R "codex-bridge-${VERSION}-${PLATFORM}/." "$INSTALL_ROOT/versions/$VERSION/"
```

Linux 没有 `shasum` 时使用：

```sh
sha256sum -c checksums.txt --ignore-missing
```

校验失败、平台不匹配或清单缺失时停止，不要继续解压或切换版本。

## 3. 安装私有配置

将 `docs/config.example.json` 复制为私有配置，并填写真实值：

```sh
CONFIG="$HOME/.agent-inbox/codex-bridge/config.json"
umask 077
install -d -m 700 "$HOME/.agent-inbox/codex-bridge" "$HOME/.agent-inbox/codex-bridge/state"
cp docs/config.example.json "$CONFIG"
chmod 600 "$CONFIG"
```

至少需要修改：

- `gatewayUrl`：Agent Inbox 的 HTTPS 地址。
- `token`：消息连接器 Token。
- `managementToken`：运行时管理连接器 Token；不要与消息 Token 混用。
- `codexBinary`：主机上 `codex` 的绝对路径。
- `stateDir`：只允许当前用户可读写的私有目录。
- `projects`：允许 Codex 使用的项目目录；路径必须是绝对路径。

检查权限和配置：

```sh
chmod 600 "$CONFIG"
"$HOME/.agent-inbox/codex-bridge/versions/$VERSION/node_modules/.bin/" 2>/dev/null || true
node "$HOME/.agent-inbox/codex-bridge/versions/$VERSION/dist/src/main.js" --validate "$CONFIG"
```

如果发布包中没有依赖目录，在该版本目录执行一次 `npm ci --omit=dev`；不要在生产主机运行 `npm install` 改写锁文件：

```sh
cd "$HOME/.agent-inbox/codex-bridge/versions/$VERSION"
npm ci --omit=dev
node dist/src/main.js --validate "$CONFIG"
```

## 4. 建立固定 Supervisor 入口

服务管理器必须始终启动固定路径，而不是某个版本目录。首次安装时创建 `current`：

```sh
cd "$HOME/.agent-inbox/codex-bridge"
ln -sfn "versions/$VERSION" current
```

手动前台验证（确认网关能看到 Agent 上线后按 `Ctrl-C`）：

```sh
AGENT_INBOX_BRIDGE_ROOT="$HOME/.agent-inbox/codex-bridge" \
AGENT_INBOX_BRIDGE_CONFIG="$CONFIG" \
node "$HOME/.agent-inbox/codex-bridge/current/supervisor/supervisor.mjs"
```

不要把 `supervisor.mjs` 复制到项目目录或使用工作区中的开发构建。

## 5. macOS launchd

创建 `~/Library/LaunchAgents/com.agent-inbox.codex-bridge.plist`。将 `YOUR_USER` 和 Node 的实际绝对路径替换为目标值；LaunchAgent 以当前用户运行，不能使用 root：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-inbox.codex-bridge</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USER/.agent-inbox/codex-bridge/current/supervisor/supervisor.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AGENT_INBOX_BRIDGE_ROOT</key><string>/Users/YOUR_USER/.agent-inbox/codex-bridge</string>
    <key>AGENT_INBOX_BRIDGE_CONFIG</key><string>/Users/YOUR_USER/.agent-inbox/codex-bridge/config.json</string>
    <key>HOME</key><string>/Users/YOUR_USER</string>
    <!-- Must include the directory containing node. Codex's npm wrapper uses /usr/bin/env node. -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>/Users/YOUR_USER/.agent-inbox/codex-bridge</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/Users/YOUR_USER/.agent-inbox/codex-bridge/state/supervisor.log</string>
  <key>StandardErrorPath</key><string>/Users/YOUR_USER/.agent-inbox/codex-bridge/state/supervisor.err.log</string>
</dict></plist>
```

加载和检查：

```sh
chmod 600 "$HOME/Library/LaunchAgents/com.agent-inbox.codex-bridge.plist"
launchctl bootout "gui/$(id -u)/com.agent-inbox.codex-bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agent-inbox.codex-bridge.plist"
launchctl kickstart -k "gui/$(id -u)/com.agent-inbox.codex-bridge"
launchctl print "gui/$(id -u)/com.agent-inbox.codex-bridge"
tail -f "$HOME/.agent-inbox/codex-bridge/state/supervisor.err.log"
```

Apple Silicon 通常使用 `/opt/homebrew/bin/node`，Intel Homebrew 通常使用 `/usr/local/bin/node`；以 `command -v node` 的结果为准。

## 6. Linux systemd -- user service

创建 `~/.config/systemd/user/agent-inbox-codex-bridge.service`：

```ini
[Unit]
Description=Agent Inbox Codex Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.agent-inbox/codex-bridge
Environment=AGENT_INBOX_BRIDGE_ROOT=%h/.agent-inbox/codex-bridge
Environment=AGENT_INBOX_BRIDGE_CONFIG=%h/.agent-inbox/codex-bridge/config.json
ExecStart=/usr/bin/node %h/.agent-inbox/codex-bridge/current/supervisor/supervisor.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

启用和查看日志：

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-inbox-codex-bridge.service
systemctl --user status agent-inbox-codex-bridge.service
journalctl --user -u agent-inbox-codex-bridge.service -f
```

需要开机后无登录会话仍运行时，管理员可为该用户启用 linger：

```sh
sudo loginctl enable-linger "$USER"
```

## 7. 人工升级

升级前先确认网关没有运行中的 Codex 任务，并保留当前版本。不要删除 `state`、`config.json` 或数据库：

```sh
ROOT="$HOME/.agent-inbox/codex-bridge"
VERSION=0.1.3
PLATFORM=darwin-arm64

# 下载并校验后解压到 ROOT/versions/VERSION
mkdir -p "$ROOT/versions/$VERSION"
tar -xzf "codex-bridge-${VERSION}-${PLATFORM}.tar.gz" -C /tmp
cp -R "/tmp/codex-bridge-${VERSION}-${PLATFORM}/." "$ROOT/versions/$VERSION/"
cd "$ROOT/versions/$VERSION" && npm ci --omit=dev
node dist/src/main.js --validate "$ROOT/config.json"

ln -sfn "versions/$VERSION" "$ROOT/current"
```

切换后重启服务并确认重新注册：

```sh
# macOS
launchctl kickstart -k "gui/$(id -u)/com.agent-inbox.codex-bridge"

# Linux
systemctl --user restart agent-inbox-codex-bridge.service
```

在网关中确认 Agent 重新上线、Bridge 版本更新、Codex 环境报告正常，再把旧版本保留至少一个发布周期。

## 8. 回滚和中断恢复

如果新版本不能注册、健康检查失败或日志持续报错，切换回保留的版本：

```sh
ROOT="$HOME/.agent-inbox/codex-bridge"
OLD=0.1.3
ln -sfn "versions/$OLD" "$ROOT/current"
```

然后按上节重启服务。不要回滚 `state`；状态库由 Bridge 维护，回滚代码与状态不兼容时应停止服务并保留现场，先复制 `state` 目录再处理。

如果升级过程中服务突然退出：

1. 停止服务，避免 Supervisor 反复重启。
2. 检查 `current` 是否指向一个完整目录。
3. 运行 `node current/dist/src/main.js --validate config.json`。
4. 检查配置权限是否仍为 `0600`、`stateDir` 是否为 `0700`。
5. 无法确认版本完整性时切回旧版本；不要手工删除 SQLite。

## 9. 健康检查与卸载

当前没有公开的本机 HTTP 健康端口。健康检查以三层信号为准：

- 服务管理器显示进程在运行；
- 日志出现 `ready` 且没有持续的 management connection error；
- 网关中的 Agent 在线，并能读取 Codex 环境报告。

卸载时先停服务，再删除服务定义和 Bridge 版本目录。是否删除 `config.json`、Token 和 `state` 必须由主机所有者明确决定：

```sh
# macOS
launchctl bootout "gui/$(id -u)/com.agent-inbox.codex-bridge" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.agent-inbox.codex-bridge.plist"

# Linux
systemctl --user disable --now agent-inbox-codex-bridge.service
rm -f "$HOME/.config/systemd/user/agent-inbox-codex-bridge.service"
systemctl --user daemon-reload
```

## 当前能力边界

- `v0.1.2` 支持人工安装、人工升级和人工回滚。
- 网关分发的模型提供商配置会由 Bridge 写入受管命名空间，并在确认重载 App Server 后才回报成功。
- 网关远程升级 Bridge、签名下载、原子切换、自动健康检查和自动回滚属于后续版本；在这些能力发布前，必须登录目标主机执行本指南。
- API Key 和管理 Token 只应存在于私有配置/受保护状态目录，不得进入日志、Release、Git 或聊天消息。
