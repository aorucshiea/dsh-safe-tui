# dsh-safe-console

DeepSeek Harness 安全模式 / 修理终端。

## 它是什么

当主 Web UI 因为插件/客户端补丁损坏而无法打开时，用这个独立的终端可以：

- 不加载任何用户插件、不加载 Web UI；
- 不发现用户自建预设（`includeUserRoot: false`），交互上只允许 `minimal` / `standard`；
- 继承 `~/.dsh/sessions` 里的历史会话（`/list` + `/resume <id>`）；
- 从内置 pristine 副本自动修复已损坏的官方客户端文件（`/repair` 或独立 Repair 快捷方式）。

## 使用

桌面已创建两个入口：

- **DeepSeek Harness Safe Mode**：进入安全终端（现代化全屏 TUI）。
- **DeepSeek Harness Repair**：只运行修复脚本，不需要 DSH 启动。

也可以手动运行：

```bat
dsh --profile safe
dsh --profile safe "你的问题"          :: 一次性问答
dsh --profile safe --list
dsh --profile safe --resume <sessionId>
dsh --profile safe --check
dsh --profile safe --repair
node "C:\Users\Administrator\dsh-safe-console\lib\repair.js" --repair
```

安全终端内命令：

```
/help /list /new /resume <id> /preset [minimal|standard] /models /models <provider/model> /providers /add-provider /status /repair /check /quit
```

## 从插件市场 / GitHub 安装

插件本身是自包含的 DSH bundle，包含 `agent-presets` + `safe-console`，无需手动建 profile：

```bash
# 从 GitHub 安装并初始化 safe profile
dsh plugin --profile safe add github:aorucshiea/dsh-safe-console#v0.1.0
```

之后运行：

```bash
dsh --profile safe
```

仓库：<https://github.com/aorucshiea/dsh-safe-console>

## 关键文件

- `cordis.patch.yml` — bundle 补丁，挂载 `safe-console` 插件。
- `lib/index.js` — 交互式/一次性安全终端插件。
- `lib/repair.js` — 无需 DSH 即可独立运行的修复脚本。
- `pristine/` — 从官方 `0.1.0-rc.6` 提取的原始文件，用于恢复。
- `~/.dsh/profiles/safe/` — 安全 profile，只有 `dsh-base` + `dsh-safe-console`。
