# ============================================================
#  Aurabot 扩展 · 环境自检与自动安装
#  会自动检查并装上三个扩展需要的全部依赖：
#    - Python 包：requests / websockets
#    - uv（Windows 电脑操控需要）
#    - windows-mcp（Windows 电脑操控需要）
#  缺什么装什么，已经有的直接跳过。
#
#  用法：右键 → 使用 PowerShell 运行
# ============================================================

$ErrorActionPreference = 'Continue'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text)   { Write-Host "  [√] $text" -ForegroundColor Green }
function Warn2($t)   { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Bad($text)  { Write-Host "  [×] $text" -ForegroundColor Red }
function Head($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }

Say ''
Say '==============================================' Cyan
Say '  Aurabot 扩展 · 环境自检' Cyan
Say '==============================================' Cyan
Say '  缺什么会自动装，已经有的直接跳过。' DarkGray

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$fail = @()

# ------------------------------------------------------------
# 1) Python
# ------------------------------------------------------------
Head '1 / 3  Python'

$py = $null
$cands = @(
  "$env:USERPROFILE\AppData\Local\Programs\Python\Python313\python.exe",
  "$env:USERPROFILE\AppData\Local\Programs\Python\Python312\python.exe",
  "$env:USERPROFILE\AppData\Local\Programs\Python\Python311\python.exe",
  'C:\Python313\python.exe',
  'C:\Python312\python.exe'
)
foreach ($c in $cands) { if (Test-Path $c) { $py = $c; break } }
if (-not $py) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $py = $cmd.Source }
}

if ($py) {
  $ver = & $py -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
  Ok "Python $ver  （$py）"
} else {
  Bad '没找到 Python。'
  Warn2 '小红书扩展需要 Python 3.10 以上。'
  Warn2 '装法：打开 Microsoft Store 搜 Python 安装，或去 python.org 下载。'
  Warn2 '装完重新运行本脚本。'
  $fail += 'Python'
}

# ------------------------------------------------------------
# 2) Python 包（requests / websockets）
# ------------------------------------------------------------
Head '2 / 3  Python 包（requests / websockets）'

if ($py) {
  foreach ($pkg in @('requests', 'websockets')) {
    $has = & $py -c "import importlib.util as u;print('1' if u.find_spec('$pkg') else '0')" 2>$null
    if ($has -eq '1') {
      Ok "$pkg 已安装"
    } else {
      Warn2 "$pkg 没装，正在装…"
      & $py -m pip install --quiet --disable-pip-version-check $pkg 2>&1 | Out-Null
      $again = & $py -c "import importlib.util as u;print('1' if u.find_spec('$pkg') else '0')" 2>$null
      if ($again -eq '1') { Ok "$pkg 装好了" }
      else {
        Bad "$pkg 没装上"
        Warn2 "手动装：`"$py`" -m pip install $pkg"
        $fail += $pkg
      }
    }
  }
} else {
  Warn2 '没有 Python，跳过'
}

# ------------------------------------------------------------
# 3) uv + windows-mcp（Windows 电脑操控）
# ------------------------------------------------------------
Head '3 / 3  uv 与 windows-mcp（Windows 电脑操控用）'

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
  # 也找一下常见安装位置（刚装完还没进 PATH 的情况）
  foreach ($p in @("$env:USERPROFILE\.local\bin\uv.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\uv.exe")) {
    if (Test-Path $p) { $uv = [pscustomobject]@{ Source = $p }; break }
  }
}

if ($uv) {
  $uvver = & $uv.Source --version 2>$null
  Ok "uv 已安装（$uvver）"
} else {
  Warn2 'uv 没装，正在自动安装…'
  try {
    $env:UV_INSTALL_DIR = "$env:USERPROFILE\.local\bin"
    Invoke-RestMethod -Uri 'https://astral.sh/uv/install.ps1' -OutFile "$env:TEMP\uv-install.ps1"
    & powershell -ExecutionPolicy Bypass -File "$env:TEMP\uv-install.ps1" 2>&1 | Out-Null
    foreach ($p in @("$env:USERPROFILE\.local\bin\uv.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\uv.exe")) {
      if (Test-Path $p) { $uv = [pscustomobject]@{ Source = $p }; break }
    }
    if ($uv) { Ok "uv 装好了（$($uv.Source)）" }
    else {
      Bad 'uv 自动安装没成功'
      Warn2 '手动装法（在 PowerShell 里跑一次）：'
      Warn2 '  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
      $fail += 'uv'
    }
  } catch {
    Bad '下载 uv 安装脚本失败（可能是网络）'
    Warn2 '手动装法：powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
    $fail += 'uv'
  }
}

# windows-mcp
$wmc = $null
$wmcPaths = @(
  "$env:APPDATA\uv\tools\windows-mcp\Scripts\windows-mcp.exe",
  "$env:USERPROFILE\.local\share\uv\tools\windows-mcp\Scripts\windows-mcp.exe"
)
foreach ($p in $wmcPaths) { if (Test-Path $p) { $wmc = $p; break } }

if ($wmc) {
  Ok "windows-mcp 已安装"
} elseif ($uv) {
  Warn2 'windows-mcp 没装，正在装（要下载一会儿）…'
  & $uv.Source tool install windows-mcp 2>&1 | ForEach-Object { if ($_ -match 'error|失败') { Write-Host "    $_" -ForegroundColor DarkYellow } }
  foreach ($p in $wmcPaths) { if (Test-Path $p) { $wmc = $p; break } }
  if ($wmc) { Ok 'windows-mcp 装好了' }
  else {
    Bad 'windows-mcp 没装上'
    Warn2 '手动装：uv tool install windows-mcp'
    $fail += 'windows-mcp'
  }
} else {
  Warn2 '没有 uv，跳过 windows-mcp'
}

# ------------------------------------------------------------
# 汇总
# ------------------------------------------------------------
Head '检查结果'
if ($fail.Count -eq 0) {
  Say '  全部就绪，三个扩展都能用了。' Green
  Say ''
  Say '  下一步：打开 DeepSeek Harness → Aurabot → 平台 → 打开开关' Cyan
} else {
  Say ("  这几样还没好：" + ($fail -join '、')) Yellow
  Say '  按上面提示装好，再运行一次本脚本。' Yellow
  Warn2 '小红书和浏览器扩展不受影响，可以先开始用。'
}

Say ''
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Read-Host '按回车关闭这个窗口'
}