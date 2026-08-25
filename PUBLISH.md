# 发布 dsh-safe-tui 到 DeepSeek Harness 插件市场

## 1. DSH 插件安装机制（已确认）

- 一个可安装的 DSH 插件 = **npm/GitHub 包**，其 `package.json` 必须声明：

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

- 用户安装：

```bash
dsh plugin --profile web add github:<owner>/dsh-safe-tui
# 或如果发到 npm：
dsh plugin --profile web add @scope/dsh-safe-tui
```

- `dsh plugin` 会：
  1. 在 profile 里通过 pnpm 安装包
  2. 自动检测 `dsh.bundle.patch`
  3. 自动把包名加入 `dsh.profile.bundles`
  4. 重启 DSH 后生效

- 本仓库已经是合法 bundle：
  - `package.json` 有 `dsh.bundle.patch`
  - 有 `cordis.patch.yml`，且 bundle 内自带 `agent-presets` + `safe-tui`
  - 纯 JS、无 `prepare`/`postinstall` 安装脚本
  - 市场扫描器会判定为“可安全安装”的格式

已用 `dsh plugin --profile <new> add <package>` 实测：新 profile 初始化后直接能跑 `dsh --profile <new> --help`，无需手工补丁。

## 2. 市场现状

目前**没有唯一官方的 DSH 插件市场**，社区有多个：

| 市场 | 地址 / 仓库 | 收录方式 |
|---|---|---|
| dsh-plugin.market | https://dsh-plugin.market , 仓库 `0326/dsh-plugin-market` | 自动扫描 GitHub `dsh-plugin` topic + 官网 Submit 页 |
| dsh-plugin-market | `uluckystar/dsh-plugin-market`（mydsh.dev） | 扫描 GitHub `dsh-plugin` topic 入库，Web 端一键安装 |
| dsh-market | `2BingLing/dsh-market` / `dsh-market/dsh-market` | 收录 1500+ 插件，通常通过 PR/issue 提交 |
| awesome-deepseek-harness | `Dominic789654/awesome-deepseek-harness` | 精选清单，PR 添加 |

核心逻辑：**公开 GitHub 仓库 + `dsh-plugin` topic** 是进入大部分市场扫描器的关键。

## 3. 发布步骤

### 3.1 把仓库推到 GitHub

已完成：

```text
https://github.com/aorucshiea/dsh-safe-tui
分支：main
```

如果以后要重新推送：

```bash
cd dsh-safe-tui
git push -u origin main
```

### 3.2 给仓库加 topic

在 GitHub 仓库页：

- Settings → Topics → 添加：
  - `dsh-plugin`
  - `deepseek-harness`
  - `dsh`

### 3.3 确保没有安装脚本

本仓库已经是纯 JS，`package.json` 没有 `scripts.prepare` / `postinstall`。不要随便加构建步骤；如果需要构建，请把 `lib/` 产物提交进仓库。

### 3.4 提交到各市场

- **dsh-plugin.market**：打开官网 Submit 页提交仓库 URL，或等 topic 自动扫描。
- **mydsh.dev / uluckystar 市场**：等自动扫描；也可在仓库 issue 中联系。
- **2BingLing/dsh-market**：给对应仓库提交 PR，把插件加入插件列表。
- **awesome-deepseek-harness**：给 `Dominic789654/awesome-deepseek-harness` 提交 PR，加入精选清单。

### 3.5 可选：发布到 npm

如果想要 `dsh plugin add @scope/dsh-safe-tui` 这种方式：

```bash
npm login
npm publish --access public
```

发布后，用户也可以：

```bash
dsh plugin --profile web add @scope/dsh-safe-tui
```

## 4. 建议的安装说明（已写进 README）

```bash
# GitHub 安装（推荐，可固定 Release）
dsh plugin --profile safe add github:aorucshiea/dsh-safe-tui#v0.4.11
```

重启后打开：

```text
http://127.0.0.1:3080/
```

或在终端运行：

```powershell
deepseek
```

## 5. 当前发布状态

已完成：

- GitHub CLI 安装并登录
- 公开仓库创建：https://github.com/aorucshiea/dsh-safe-tui
- 推送到 `main`
- 添加 topics：`dsh-plugin`、`deepseek-harness`、`dsh`、`deepseek`
- 创建 Release：v0.4.11

剩余可选：

- 在 dsh-plugin.market Submit 页提交
- 给 2BingLing/dsh-market 提交
- 给 awesome-deepseek-harness 提交 PR
- 发布到 npm
