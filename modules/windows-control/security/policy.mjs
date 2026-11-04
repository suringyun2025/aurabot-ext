// Windows 操控的权限与风险策略。
//
// 与浏览器模块的区别：
//  - 桌面动作天然更危险（会动真实鼠标键盘），所以默认更保守。
//  - 文件操作必须落在「授权目录」里，默认只允许用户目录下的几个常用位置。
//  - 锁屏 / UAC 安全桌面一律不碰。

import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

export const TOOL_RISK = {
  Snapshot: 'low',
  Screenshot: 'low',
  DisplayInventory: 'low',
  Wait: 'low',
  WaitFor: 'low',
  App: 'medium',
  Click: 'medium',
  Type: 'medium',
  Scroll: 'medium',
  Move: 'medium',
  Shortcut: 'medium',
  Clipboard: 'medium',
  MultiSelect: 'medium',
  MultiEdit: 'medium',
  Notification: 'low',
  FileSystem: 'medium',
}

// 这些工具即使后端给了也不允许模型直接调（必须在面板开开关，且仍然只走 FileSystem 的读模式）
export const NEVER_EXPOSE = ['PowerShell', 'Registry', 'Process', 'Scrape']

const HIGH_RISK_FILE_MODES = ['delete', 'move', 'copy', 'write']
const HIGH_RISK_KEYS = ['alt+f4', 'ctrl+shift+esc', 'win+r', 'ctrl+alt+del']

export function riskOf(tool, args = {}) {
  let level = TOOL_RISK[tool] || 'medium'
  if (tool === 'FileSystem') {
    const mode = String(args.mode || 'read')
    if (HIGH_RISK_FILE_MODES.includes(mode)) level = 'high'
    if (mode === 'read' || mode === 'list' || mode === 'search' || mode === 'info') level = 'low'
  }
  if (tool === 'Shortcut') {
    const combo = String(args.shortcut || '').toLowerCase().replace(/\s+/g, '')
    if (HIGH_RISK_KEYS.some((key) => combo.includes(key))) level = 'high'
  }
  if (tool === 'App') {
    const mode = String(args.mode || 'launch')
    if (mode === 'launch' || mode === 'launch_executable') level = 'high'
  }
  if (tool === 'Type' || tool === 'MultiEdit') {
    const text = String(args.text || '') + JSON.stringify(args.locs || args.labels || [])
    if (/format\s+[a-z]:|rmdir|del\s+\/|shutdown|reg\s+add/i.test(text)) level = 'high'
  }
  return level
}

export function createWindowsPolicy({ settings, log }) {
  const home = homedir()
  const defaults = [
    resolve(home, 'Desktop'),
    resolve(home, 'Downloads'),
    resolve(home, 'Documents'),
    resolve(home, 'Pictures'),
  ]

  const allowedDirs = () => {
    const raw = String(settings().allowedDirs || '').trim()
    const extra = raw ? raw.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean).map((p) => resolve(p)) : []
    return [...defaults, ...extra]
  }

  const isInside = (target, root) => {
    const a = resolve(target).toLowerCase()
    const b = resolve(root).toLowerCase()
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
  }

  /** 文件路径必须在授权目录里；除非主人在面板里显式放开了整个盘。 */
  const checkPath = (target) => {
    const value = String(target || '').trim()
    if (!value) return { ok: false, message: '路径是空的' }
    const resolved = resolve(value)
    if (settings().allowAnyPath) return { ok: true, path: resolved }
    const roots = allowedDirs()
    if (!roots.some((root) => isInside(resolved, root))) {
      return {
        ok: false,
        message: '路径不在授权目录里：' + resolved + '\n允许的目录：' + roots.join(' / ') + '\n要放开就在面板「授权目录」里加，或勾「允许任意路径」（不建议）',
      }
    }
    return { ok: true, path: resolved }
  }

  const listAllowedDirs = () => allowedDirs()

  return { checkPath, listAllowedDirs, allowedDirs }
}

/** 从 Snapshot / Screenshot 文本里看当前桌面是不是锁屏、无人值守或安全桌面。 */
export function detectLockScreen(text) {
  const value = String(text || '')
  if (/Focused Window:[\s\S]{0,200}?(锁屏|LockScreen|Lock App|Windows 默认锁屏)/i.test(value)) return 'lock'
  if (/安全桌面|Secure Desktop|UAC|用户帐户控制|用户账户控制/i.test(value) && /Focused Window:/i.test(value)) return 'secure-desktop'
  // 注意：后端有时会说「没有活动窗口 / 没有窗口」，但那**不代表锁屏**——
  // 实测过桌面明明解锁、窗口一堆，Snapshot 却超时或返回空列表的情况。
  // 所以这里不再把它当成锁屏，只标一个 no-window，让上层决定放不放行。
  const noFocus = /Focused Window:\s*\n\s*No active window found/i.test(value)
  const noWindows = /Opened Windows:\s*\n\s*No windows found/i.test(value)
  if (noFocus && noWindows) return 'no-window'
  return ''
}
