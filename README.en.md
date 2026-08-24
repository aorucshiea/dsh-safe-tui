# dsh-safe-tui

A safe-mode recovery TUI for DeepSeek Harness.

## What it is

When the main Web UI cannot start because of a broken plugin/client patch, use this standalone terminal to:

- Load only `dsh-base` + `dsh-safe-tui`; no user plugins, no Web UI.
- Disable user-authored presets (`includeUserRoot: false`); only `minimal` / `standard` are exposed.
- Inherit existing DeepSeek history from `~/.dsh/sessions` (`/list` + `/resume <id>`).
- Repair corrupted official client files from bundled pristine copies (`/repair` or the standalone Repair shortcut).
- Switch models and providers (`/models`, `/providers`, `/add-provider`).

## Quick start

```bash
# Install the plugin into a fresh safe profile
dsh plugin --profile safe add github:aorucshiea/dsh-safe-tui#v0.1.0
```

Then either:

```bash
dsh --profile safe
```

or, if the `deepseek` command is available:

```bash
deepseek
```

The `deepseek` command opens the same full-screen TUI directly.

### Getting the `deepseek` command

- If the package is installed through npm/global tooling, the `deepseek` binary is provided automatically.
- On Windows you can also copy `deepseek.cmd` from this repository into a directory on `PATH`, for example:

```bat
copy deepseek.cmd %APPDATA%\npm\
```

Then open a new terminal and run:

```bat
deepseek
```

## TUI commands

```text
/help /list /new /resume <id> /preset [minimal|standard] /models /models <provider/model> /providers /add-provider /status /repair /check /quit
```

- Type `/` to open the command palette.
- Use `↑` / `↓` to navigate, `Enter` to choose, `Esc` to cancel.
- Selecting `/model`, `/resume`, or `/preset` opens a second-level picker.

## Other CLI usage

```bash
dsh --profile safe "your question"           # one-shot
dsh --profile safe --list                    # list saved sessions
dsh --profile safe --resume <sessionId>      # resume in TUI
dsh --profile safe --models                  # list models
dsh --profile safe --providers               # list providers
dsh --profile safe --model <id>              # switch default model
dsh --profile safe --check                   # health check
dsh --profile safe --repair                  # repair broken files
```

## Repository

<https://github.com/aorucshiea/dsh-safe-tui>

## License

MIT
