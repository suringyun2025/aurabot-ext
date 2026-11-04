import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskOf, detectLockScreen, createWindowsPolicy, NEVER_EXPOSE } from '../security/policy.mjs'
import { ALLOWED_TOOLS, HARD_EXCLUDES } from '../adapters/windows-mcp.mjs'

test('危险工具永远不在客户端白名单里', () => {
  for (const name of NEVER_EXPOSE) {
    assert.equal(ALLOWED_TOOLS.has(name), false, name + ' 不该在白名单里')
  }
})

test('默认排除清单包含 PowerShell / Registry / Process', () => {
  for (const name of ['PowerShell', 'Registry', 'Process']) {
    assert.ok(HARD_EXCLUDES.includes(name), name + ' 应该在硬排除里')
  }
})

test('常见安全工具在白名单里', () => {
  for (const name of ['Snapshot', 'Screenshot', 'Click', 'Type', 'App', 'FileSystem', 'WaitFor']) {
    assert.ok(ALLOWED_TOOLS.has(name), name + ' 应该可用')
  }
})

test('文件读是低风险，写删移是高危', () => {
  assert.equal(riskOf('FileSystem', { mode: 'read' }), 'low')
  assert.equal(riskOf('FileSystem', { mode: 'list' }), 'low')
  assert.equal(riskOf('FileSystem', { mode: 'write' }), 'high')
  assert.equal(riskOf('FileSystem', { mode: 'delete' }), 'high')
  assert.equal(riskOf('FileSystem', { mode: 'move' }), 'high')
})

test('启动应用是高危，切窗口不是', () => {
  assert.equal(riskOf('App', { mode: 'launch', name: 'notepad' }), 'high')
  assert.equal(riskOf('App', { mode: 'switch', name: 'notepad' }), 'medium')
})

test('危险快捷键升级为高危', () => {
  assert.equal(riskOf('Shortcut', { shortcut: 'alt+f4' }), 'high')
  assert.equal(riskOf('Shortcut', { shortcut: 'win+r' }), 'high')
  assert.equal(riskOf('Shortcut', { shortcut: 'ctrl+s' }), 'medium')
})

test('输入里带格式化命令升级为高危', () => {
  assert.equal(riskOf('Type', { text: 'format c: /q' }), 'high')
  assert.equal(riskOf('Type', { text: '你好，帮我写一段话' }), 'medium')
})

test('锁屏检测兼容 Snapshot 与 Screenshot 两种文本', () => {
  const snapshot = `Focused Window:\n Name Depth Status Width Height Handle\n----\nWindows 默认锁屏界面 0 Normal 2560 1600 4916436`
  assert.equal(detectLockScreen(snapshot), 'lock')

  const noWindow = `Focused Window:\n    No active window found\n\n    Opened Windows:\n    No windows found`
  assert.equal(detectLockScreen(noWindow), 'no-window')

  const normal = `Focused Window:\n  Name Depth Status\n  ----\n  记事本 0 Normal 800 600 12345\nOpened Windows:\n  记事本 0 Normal 800 600 12345`
  assert.equal(detectLockScreen(normal), '')
})

test('授权目录默认包含桌面/下载/文档/图片', () => {
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: { warn() {} } })
  const dirs = policy.listAllowedDirs().join('|').toLowerCase()
  for (const part of ['desktop', 'downloads', 'documents', 'pictures']) {
    assert.ok(dirs.includes(part), '缺少 ' + part)
  }
})

test('授权目录外的路径被拒绝', () => {
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: { warn() {} } })
  assert.equal(policy.checkPath('C:/Windows/System32/drivers/etc/hosts').ok, false)
  const home = policy.listAllowedDirs()[0]
  assert.equal(policy.checkPath(home + '\\测试.txt').ok, true)
})

test('allowAnyPath 打开后放行任意路径', () => {
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '', allowAnyPath: true }), log: { warn() {} } })
  assert.equal(policy.checkPath('C:/Windows/notepad.exe').ok, true)
})

test('面板加的目录会被并进白名单', () => {
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: 'D:\\项目' }), log: { warn() {} } })
  assert.equal(policy.checkPath('D:/项目/readme.md').ok, true)
  assert.equal(policy.checkPath('D:/别的/x.md').ok, false)
})