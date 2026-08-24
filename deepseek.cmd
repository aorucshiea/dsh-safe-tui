@echo off
rem deepseek - quick entry to dsh-safe-tui TUI.
rem Optional: copy this file to a directory on PATH (e.g. %APPDATA%\npm).
setlocal
chcp 65001 >nul
cd /d "%USERPROFILE%"
where dsh >nul 2>&1
if %errorlevel%==0 (
  dsh --profile safe %*
) else (
  npx --yes @deepseek-ai/dsh --profile safe %*
)
endlocal
