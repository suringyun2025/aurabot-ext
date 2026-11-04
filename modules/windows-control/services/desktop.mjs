// 桌面「观察」层：只读，不产生任何输入事件。
// 优先用 Snapshot（截图 + UI 树 + 光标/显示器信息），必要时用 DisplayInventory 补 DPI。

import { detectLockScreen } from '../security/policy.mjs'

const clip = (text, max = 8000) => {
  const value = String(text == null ? '' : text)
  return value.length > max ? value.slice(0, max) + '\n…（截断，原长 ' + value.length + ' 字）' : value
}

/** 把 Snapshot / Screenshot 的文本拆成「焦点窗口 / 打开的窗口 / 显示器」。 */
function sectionLines(value, label, limit = 20) {
  const idx = value.indexOf(label)
  if (idx < 0) return []
  const out = []
  for (const raw of value.slice(idx + label.length).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      if (out.length) break
      continue
    }
    if (/^-+$/.test(line)) continue
    if (/^(Name|Depth|Width Height|Active Desktop|All Desktops|Visible Displays|Cursor Position|Screenshot|UI Tree|Opened Windows|Focused Window)/i.test(line)) continue
    if (/Depth Status|Width\s+Height/.test(line)) continue
    out.push(line.slice(0, 140))
    if (out.length >= limit) break
  }
  return out
}

export function parseSnapshot(text) {
  const value = String(text || '')
  const display = /Visible Displays:\s*([^\n]+)/.exec(value)
  const scale = /Screenshot Coordinate Scale:\s*([0-9.]+)/.exec(value)
  const focused = sectionLines(value, 'Focused Window:', 1)
  const opened = sectionLines(value, 'Opened Windows:', 20)
  const lock = detectLockScreen(value)
  return {
    focusedWindow: focused[0] ? focused[0].slice(0, 120) : '',
    displays: display ? display[1].trim().slice(0, 200) : '',
    imageScale: scale ? Number(scale[1]) : 0,
    opened,
    lock,
  }
}

export function createDesktopService({ adapter, log }) {
  const snapshot = async (options = {}) => {
    const result = await adapter.callTool('Snapshot', {
      use_ui_tree: options.useUiTree !== false,
      use_dom: Boolean(options.useDom),
      use_annotation: options.useAnnotation === true,
      use_vision: Boolean(options.useVision),
      display: options.display || null,
    }, { timeoutMs: options.timeoutMs || 100000 })
    if (!result.ok) return { ok: false, message: result.message || result.text || '快照失败' }
    const text = String(result.text || '')
    return {
      ok: true,
      data: {
        text: clip(text, options.maxChars || 8000),
        images: result.images ? result.images.length : 0,
        parsed: parseSnapshot(text),
      },
      message: '拿到桌面快照',
    }
  }

  const screenshot = async (options = {}) => {
    const result = await adapter.callTool('Screenshot', {
      use_annotation: options.useAnnotation === true,
      display: options.display || null,
    }, { timeoutMs: 60000 })
    if (!result.ok) return { ok: false, message: result.message || '截图失败' }
    return {
      ok: true,
      data: {
        text: clip(result.text, 4000),
        images: (result.images || []).map((img) => ({ mime: img.mimeType, data: img.data })),
        parsed: parseSnapshot(result.text),
      },
      message: '截了一张桌面图',
    }
  }

  const displays = async () => {
    const result = await adapter.callTool('DisplayInventory', {}, { timeoutMs: 30000 })
    if (!result.ok) return { ok: false, message: result.message || '读显示器信息失败' }
    return { ok: true, data: { text: clip(result.text, 4000) }, message: '读到了显示器信息' }
  }

  /** 当前活动窗口 + 是否锁屏。用来在动手前确认"现在画面是什么"。 */
  const state = async () => {
    let shot = await screenshot({ useAnnotation: false })
    if (!shot.ok) shot = await snapshot({ useUiTree: true, useAnnotation: false, maxChars: 6000 })
    if (!shot.ok) return shot
    const parsed = shot.data.parsed
    const lines = [
      '焦点窗口：' + (parsed.focusedWindow || '读不到'),
      '显示器：' + (parsed.displays || '读不到'),
      parsed.opened.length ? '打开的窗口：\n' + parsed.opened.slice(0, 10).map((w) => '  ' + w).join('\n') : '',
      parsed.lock ? '⚠ 现在桌面是锁屏/安全界面（' + parsed.lock + '），不能自动操作，需要你解锁' : '',
    ].filter(Boolean)
    return { ok: true, data: { ...shot.data, lines }, message: lines.join('\n') }
  }

  return { snapshot, screenshot, displays, state, parseSnapshot }
}