// Playwright MCP 适配层（可选后端）。
//
// 重要：@playwright/mcp 未安装时**不会**自动下载（任务要求：不擅自安装不受信任的程序）。
// 面板里会给出安装命令，装了之后把命令配置进来就能用。
// 不同版本的 Playwright MCP 工具名有差异，所以能力映射按名字模糊匹配，匹配不到就如实报错。

import { existsSync } from 'node:fs'
import { createMcpClient } from './mcp-client.mjs'

const HINTS = {
  open: ['browser_navigate', 'navigate', 'browser_open'],
  snapshot: ['browser_snapshot', 'snapshot'],
  click: ['browser_click', 'click'],
  fill: ['browser_type', 'browser_fill', 'type', 'fill'],
  press: ['browser_press_key', 'press_key', 'key'],
  select: ['browser_select_option', 'select_option'],
  screenshot: ['browser_take_screenshot', 'take_screenshot', 'screenshot'],
  tabs: ['browser_tabs', 'tabs'],
  evaluate: ['browser_evaluate', 'evaluate'],
  back: ['browser_navigate_back', 'navigate_back', 'go_back'],
  wait: ['browser_wait_for', 'wait_for'],
  hover: ['browser_hover', 'hover'],
  upload: ['browser_file_upload', 'file_upload'],
  download: ['browser_download', 'download'],
}

const pickTool = (tools, action) => {
  const names = HINTS[action] || []
  for (const want of names) {
    const hit = tools.find((tool) => tool.name === want)
    if (hit) return hit
  }
  for (const want of names) {
    const hit = tools.find((tool) => tool.name.toLowerCase().includes(want.toLowerCase()))
    if (hit) return hit
  }
  return null
}

export function createPlaywrightAdapter({ dataDir, log, settings }) {
  let client = null
  let lastLaunch = 0

  const commandLine = () => {
    const raw = String(settings().playwrightMcpCommand || '').trim()
    if (!raw) return null
    // 支持 "npx @playwright/mcp@latest --headless" 这种整串
    const parts = raw.match(/"[^"]+"|\S+/g) || []
    return { command: parts[0].replace(/^"|"$/g, ''), args: parts.slice(1) }
  }

  const probe = async () => {
    const line = commandLine()
    if (!line) {
      return {
        ok: false,
        available: false,
        message: '没有配置 Playwright MCP 命令。装好后在面板里填，例如：npx @playwright/mcp@latest --headless',
        hint: 'npm i -g @playwright/mcp  然后面板里填 npx @playwright/mcp@latest',
      }
    }
    const isPath = /[\\/]/.test(line.command) && existsSync(line.command)
    if (!isPath && ['npx', 'npx.cmd'].includes(line.command)) {
      return {
        ok: false,
        available: false,
        needsInstall: true,
        message: 'Playwright MCP 需要 npx 现场拉包，可能触发下载。确认允许后再启用（面板里勾「允许 npx 拉包」）。',
      }
    }
    return { ok: true, available: true, command: line.command, args: line.args }
  }

  const ensure = async () => {
    if (client && client.isReady()) return { ok: true }
    const line = commandLine()
    if (!line) return { ok: false, message: '没有配置 Playwright MCP 命令' }
    client = createMcpClient({ command: line.command, args: line.args, clientName: 'aurabot-browser-control', env: {} })
    lastLaunch = Date.now()
    const init = await client.initialize()
    if (!init.ok) {
      log.warn('[浏览器] Playwright MCP 连不上：' + (init.message || ''))
      return { ok: false, message: 'Playwright MCP 连不上：' + (init.message || '') }
    }
    return { ok: true, serverInfo: init.serverInfo, toolCount: init.toolCount }
  }

  /** 把统一能力映射到 Playwright MCP 的工具。语义不完全等价的地方直说。 */
  const call = async (action, params = {}) => {
    const connected = await ensure()
    if (!connected.ok) return { ok: false, backend: 'playwright-mcp', message: connected.message }
    const tools = client.listTools()
    const tool = pickTool(tools, action)
    if (!tool) {
      return {
        ok: false,
        backend: 'playwright-mcp',
        message: '这个 Playwright MCP 版本没有对应「' + action + '」的工具。可用工具：' + tools.map((t) => t.name).slice(0, 20).join(', '),
      }
    }
    const args = mapArgs(action, params)
    const result = await client.callTool(tool.name, args, 90000)
    if (!result.ok) return { ok: false, backend: 'playwright-mcp', message: result.message || result.text || '调用失败' }
    return {
      ok: true,
      backend: 'playwright-mcp',
      data: {
        text: result.text,
        images: result.images ? result.images.length : 0,
        url: params.url || '',
      },
      message: 'Playwright MCP 执行了 ' + tool.name,
    }
  }

  const stop = () => { try { client?.stop() } catch { /* ignore */ } ; client = null }
  const info = () => ({ connected: Boolean(client && client.isReady()), tools: client ? client.listTools().map((t) => t.name) : [], lastLaunch })

  return { id: 'playwright-mcp', probe, call, stop, info }
}

function mapArgs(action, params) {
  if (action === 'open') return { url: params.url }
  if (action === 'snapshot') return {}
  if (action === 'click') return { element: params.target, ref: params.target }
  if (action === 'fill') return { element: params.target, ref: params.target, text: String(params.value ?? '') }
  if (action === 'press') return { key: params.key }
  if (action === 'select') return { element: params.target, values: [params.label ?? params.value] }
  if (action === 'screenshot') return params.path ? { filename: params.path } : {}
  if (action === 'tabs') return { action: 'list' }
  if (action === 'evaluate') return { function: '() => (' + params.expression + ')' }
  if (action === 'wait') return params.ms ? { time: Math.round(params.ms / 1000) } : {}
  if (action === 'hover') return { element: params.target, ref: params.target }
  return params
}

export default createPlaywrightAdapter