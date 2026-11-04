# ============================================================
#  Aurabot 扩展一键安装脚本
#  用法：右键 → 使用 PowerShell 运行；或者在 PowerShell 里执行 .\install.ps1
#  作用：把 modules 文件夹里的三个扩展，复制到 Aurabot 的模块目录
# ============================================================

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  Aurabot 扩展安装（小红书 / 浏览器 / 电脑）' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

# 本脚本所在目录
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$src = Join-Path $here 'modules'
if (-not (Test-Path $src)) {
  Write-Host "[×] 找不到 modules 文件夹，请确保 install.ps1 和 modules 在同一个目录里。" -ForegroundColor Red
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) { Read-Host '按回车退出' }
  exit 1
}

# 目标：%USERPROFILE%\.dsh\plugins-data\aurabot\modules
$dest = Join-Path $env:USERPROFILE '.dsh\plugins-data\aurabot\modules'

Write-Host "安装到：$dest"
Write-Host ''

if (-not (Test-Path $dest)) {
  Write-Host '[!] 这个目录还不存在，说明 Aurabot 可能还没装过、或者还没启动过一次。' -ForegroundColor Yellow
  Write-Host '    没关系，我现在帮你建出来。' -ForegroundColor Yellow
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
}

# 逐个复制
$mods = Get-ChildItem $src -Directory
$copied = 0
foreach ($m in $mods) {
  $target = Join-Path $dest $m.Name
  if (Test-Path $target) {
    $bak = "$target.bak-" + (Get-Date -Format 'MMddHHmmss')
    Write-Host "[!] 已经有一个叫 $($m.Name) 的扩展，先备份成：" -ForegroundColor Yellow
    Write-Host "    $(Split-Path -Leaf $bak)"
    Move-Item $target $bak
  }
  Copy-Item $m.FullName $target -Recurse -Force
  Write-Host "[√] 已安装：$($m.Name)" -ForegroundColor Green
  $copied++
}

Write-Host ''
Write-Host "完成，一共装了 $copied 个扩展。" -ForegroundColor Green
Write-Host ''
Write-Host '接下来：' -ForegroundColor Cyan
Write-Host '  1. 打开 DeepSeek Harness（DSH）'
Write-Host '  2. 左边点「Aurabot」→ 上方点「平台」→ 最下面一排就是这三个扩展'
Write-Host '  3. 想用哪个就打开哪个的开关'
Write-Host ''
Write-Host '如果 DSH 本来就开着，请在 Aurabot 面板里点一下「重启」让新扩展被认出来。' -ForegroundColor Yellow
Write-Host ''
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  接着检查环境依赖（会自动装缺的）' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan

$setup = Join-Path $here 'setup.ps1'
if (Test-Path $setup) {
  & $setup
} else {
  Write-Host '[!] 没找到 setup.ps1，跳过环境检查' -ForegroundColor Yellow
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) { Read-Host '按回车关闭这个窗口' }
}