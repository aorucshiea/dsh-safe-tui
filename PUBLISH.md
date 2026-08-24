# 发布 dsh-safe-console 到 DeepSeek Harness 插件市场

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
dsh plugin --profile web add github:<owner>/dsh-safe-console
# 或如果发到 npm：
dsh plugin --profile web add @scope/dsh-safe-console
```

- `dsh plugin` 会：
  1. 在 profile 里通过 pnpm 安装包
  2. 自动检测 `dsh.bundle.patch`
  3. 自动把包名加入 `dsh.profile.bundles`
  4. 重启 DSH 后生效

- 本仓库已经是合法 bundle：
  - `package.json` 有 `dsh.bundle.patch`
  - 有 `cordis.patch.yml`
  - 纯 JS、无 `prepare`/`postinstall` 安装脚本
  - 市场扫描器会判定为“可安全安装”的格式

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

```bash
cd C:\Users\Administrator\dsh-safe-console
git init
git add .
git commit -m "feat: dsh-safe-console recovery plugin"
git remote add origin git@github.com:<你的用户名>/dsh-safe-console.git
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

如果想要 `dsh plugin add @scope/dsh-safe-console` 这种方式：

```bash
npm login
npm publish --access public
```

发布后，用户也可以：

```bash
dsh plugin --profile web add @scope/dsh-safe-console
```

## 4. 建议的安装说明（写进 README）

```bash
# GitHub 安装（推荐，可固定 commit）
dsh plugin --profile web add github:<owner>/dsh-safe-console#<commit-sha>

# npm 安装（如果已发布）
dsh plugin --profile web add @scope/dsh-safe-console
```

重启后打开：

```text
http://127.0.0.1:3080/
```

或在终端运行：

```powershell
deepseek
```

## 5. 当前环境限制

本机没有安装 `gh` CLI 和 GitHub 登录态，所以还不能直接帮你推送仓库、创建 GitHub Release。需要你提供 GitHub 用户名/仓库名，或先安装 `gh` 并登录：

```bash
winget install GitHub.cli
gh auth login
```

之后我可以继续帮你执行 `git init`、提交、创建仓库、打 Release、加 topic 等发布动作。
