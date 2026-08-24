# Generate demo GIF frames for dsh-safe-tui README.
Add-Type -AssemblyName System.Drawing

$outDir = "$env:TEMP\dsh-demo-frames"
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$canvasW = 1000
$canvasH = 620
$fontSize = 15
$lineH = 24
$font = [System.Drawing.Font]::new("Consolas", $fontSize)
$bg = [System.Drawing.Color]::FromArgb(12, 14, 17)
$cyan = [System.Drawing.Color]::FromArgb(95, 175, 255)
$gray = [System.Drawing.Color]::FromArgb(138, 138, 138)
$dim = [System.Drawing.Color]::FromArgb(90, 90, 90)
$blue = [System.Drawing.Color]::FromArgb(111, 111, 255)
$green = [System.Drawing.Color]::FromArgb(135, 215, 135)
$yellow = [System.Drawing.Color]::FromArgb(240, 200, 90)
$white = [System.Drawing.Color]::FromArgb(230, 230, 230)

function New-Frame {
    param([string]$Path, [string[]]$Lines, [System.Drawing.Color[]]$Colors)
    $bmp = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($bg)
    $y = 30
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $color = if ($Colors.Count -gt $i) { $Colors[$i] } else { $white }
        $brush = New-Object System.Drawing.SolidBrush($color)
        $g.DrawString($Lines[$i], $font, $brush, 25, $y)
        $brush.Dispose()
        $y += $lineH
    }
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$c = @($cyan, $gray, $dim, $dim, $blue, $dim, $gray, $dim)

New-Frame -Path "$outDir\frame01.png" -Lines @(
    "DeepSeek Harness - Safe Mode",
    "-----------------------------------------",
    "",
    "safe - standard - deepseek-official/deepseek-v4-flash-vision-exp - C:\Users\Administrator",
    "> Ask anything... (/ for commands)",
    "",
    "/list  /resume <id>  /new  /preset  /models  /status  /repair  /check  /help  /quit",
    "safe mode - only minimal / standard presets - no user plugins - ctrl+o expand/collapse details"
) -Colors $c

$c2 = @($cyan, $gray, $dim, $yellow, $white, $white, $white, $white, $yellow, $blue, $dim)

New-Frame -Path "$outDir\frame02.png" -Lines @(
    "DeepSeek Harness - Safe Mode",
    "-----------------------------------------",
    "  +------------------------------------------------------+",
    "  | /list            List saved sessions                 |",
    "  | /resume <id>     Resume a session (inherits history) |",
    "  | /model           List available models               |",
    "  | /models          Alias of /model                     |",
    "  | /providers       List active model providers         |",
    "  +------------------------------------------------------+",
    "> /",
    "  type / for commands - arrow keys navigate"
) -Colors $c2

$c3 = @($cyan, $gray, $dim, $white, $yellow, $white, $dim, $blue)

New-Frame -Path "$outDir\frame03.png" -Lines @(
    "DeepSeek Harness - Safe Mode",
    "-----------------------------------------",
    "  +-- Select model ----------------------+",
    "  | deepseek-official/deepseek-v4-flash    |",
    "  | deepseek-official/deepseek-v4-pro      |",
    "  | deepseek-official/deepseek-v4-flash-vision-exp",
    "  +---------------------------------------+",
    "> /",
    "  up/down select - enter choose - esc cancel"
) -Colors $c3

$c4 = @($cyan, $gray, $dim, $green, $dim, $yellow, $dim, $green, $dim, $blue)

New-Frame -Path "$outDir\frame04.png" -Lines @(
    "DeepSeek Harness - Safe Mode",
    "-----------------------------------------",
    "you  fix the broken web client",
    "- turn started",
    "+ Thought: The client file may be missing AgentPresetRow... (ctrl+o to expand)",
    "+ pwsh({ command: 'Get-NetTCPConnection ...' }) (ctrl+o to expand)",
    "dsh  Found the cause: the old server is still running on port 3080.",
    "- turn ended: completed",
    "> Ask anything... (/ for commands)"
) -Colors $c4

Write-Host "frames written to $outDir"
Get-ChildItem $outDir | Select-Object Name,Length | Format-Table -HideTableHeaders | Out-String
