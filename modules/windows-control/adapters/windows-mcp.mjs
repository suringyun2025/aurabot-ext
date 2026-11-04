// Windows-MCP 适配层：把 CursorTouch/Windows-MCP 当成桌面操控后端。
//
// 真实接口（本机实测 windows-mcp 0.8.5 / server 4.1.4）：
//   windows-mcp serve --transport stdio [--exclude-tools A,B]
//   MCP: initialize → notifications/initialized → tools/list → tools/call
//   20 个工具：App / DisplayInventory / PowerShell / FileSystem / Snapshot / Screenshot /
//             Click / Type / Scroll / Move / Shortcut / Wait / WaitFor / Scrape /
//             MultiSelect / MultiEdit / Clipboard / Process / Notification / Registry
//
// 权限隔离优先用 `--exclude-tools` 在**服务端**摘掉危险工具（比在客户端过滤可靠），
// 客户端再做一次白名单校验，两层都过才执行。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const DEFAULT_EXE = 'C:\\Users\\33944\\AppData\\Roaming\\uv\\tools\\windows-mcp\\Scripts\\windows-mcp.exe'

// 默认从服务器端摘掉的高危工具
export const HARD_EXCLUDES = ['PowerShell', 'Registry', 'Process']

// 客户端白名单（即使服务器端漏了，这里也会拦）
export const ALLOWED_TOOLS = new Set([
  'App', 'DisplayInventory', 'FileSystem', 'Snapshot', 'Screenshot',
  'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor',
  'MultiSelect', 'MultiEdit', 'Clipboard', 'Notification',
])

const RESULT_TIMEOUT = 110000

export function createWindowsMcpAdapter({ dataDir, log, settings }) {
  let child = null
  let buffer = ''
  let nextId = 1
  let ready = false
  let serverInfo = null
  let tools = []
  let lastError = ''
  let restarts = 0
  const pending = new Map()

  const exePath = () => {
    const configured = String(settings().windowsMcpPath || '').trim()
    if (configured && existsSync(configured)) return configured
    const fromEnv = String(process.env.AURABOT_WINDOWS_MCP || '').trim()
    if (fromEnv && existsSync(fromEnv)) return fromEnv
    return existsSync(DEFAULT_EXE) ? DEFAULT_EXE : 'windows-mcp'
  }

  const excludeList = () => {
    const list = [...HARD_EXCLUDES]
    if (!settings().allowScrape) list.push('Scrape')
    return list
  }

  const rejectAll = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, message: reason })
    }
    pending.clear()
  }

  const request = (method, params = {}, timeoutMs = 30000) => new Promise((resolve) => {
    if (!child || child.killed) return resolve({ ok: false, message: 'Windows-MCP 进程没在跑' })
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, message: method + ' 超时（' + Math.round(timeoutMs / 1000) + ' 秒没响应）' })
    }, Math.max(5000, timeoutMs))
    pending.set(id, { resolve, timer })
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      resolve({ ok: false, message: '写入 Windows-MCP 失败：' + error.message })
    }
  })

  const notify = (method, params = {}) => {
    try { child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') } catch { /* ignore */ }
  }

  const stop = () => {
    rejectAll('后端关闭')
    try { child?.stdin.end() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    child = null
    ready = false
    tools = []
  }

  const start = async () => {
    if (ready && child && !child.killed) return { ok: true, reused: true }
    stop()
    const exe = exePath()
    const args = ['serve', '--transport', 'stdio']
    const excluded = excludeList()
    if (excluded.length) args.push('--exclude-tools', excluded.join(','))
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      lastError = '启动失败：' + error.message
      return { ok: false, message: lastError }
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id && pending.has(msg.id)) {
            const entry = pending.get(msg.id)
            pending.delete(msg.id)
            clearTimeout(entry.timer)
            entry.resolve(msg.error
              ? { ok: false, message: msg.error.message || 'MCP 调用出错' }
              : { ok: true, result: msg.result })
          }
        } catch { /* 非 JSON 行（日志）忽略 */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      // 正常启动日志也会写到 stderr，只有真的报错才记
      if (/Traceback|Error:|Exception|refused|denied/i.test(text)) lastError = text.slice(0, 800)
    })
    child.on('error', (error) => { lastError = error.message; rejectAll(lastError) })
    child.on('close', () => { ready = false; rejectAll('Windows-MCP 退出了' + (lastError ? '：' + lastError.slice(0, 200) : '')) })

    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aurabot-windows-control', version: '1.0.0' },
    }, 40000)
    if (!init.ok) {
      stop()
      return { ok: false, message: 'Windows-MCP 握手失败：' + (init.message || '') }
    }
    serverInfo = init.result?.serverInfo || null
    notify('notifications/initialized')
    ready = true
    const listed = await request('tools/list', {}, 20000)
    tools = listed.ok ? (listed.result?.tools || []) : []
    log.info('[Windows] Windows-MCP 已连接 ' + (serverInfo?.version || '?') + '，' + tools.length + ' 个工具（排除 ' + excluded.join('/') + '）')
    return { ok: true, serverInfo, toolCount: tools.length, excluded }
  }

  /** 调用一个工具；进程挂了会按策略重启一次。 */
  const callTool = async (name, args = {}, options = {}) => {
    if (!ALLOWED_TOOLS.has(name)) {
      return { ok: false, message: '工具「' + name + '」不在允许清单里（这是本扩展的硬限制）' }
    }
    if (!ready) {
      const started = await start()
      if (!started.ok) return { ok: false, message: started.message }
    }
    const visible = tools.find((tool) => tool.name === name)
    if (!visible) {
      return { ok: false, message: '后端没有「' + name + '」这个工具（可能被 --exclude-tools 摘掉了）' }
    }
    let result = await request('tools/call', { name, arguments: args }, options.timeoutMs || RESULT_TIMEOUT)
    if (!result.ok && /没在跑|退出了|超时/.test(String(result.message || '')) && restarts < 2) {
      restarts += 1
      log.warn('[Windows] 后端异常，重启第 ' + restarts + ' 次')
      stop()
      const started = await start()
      if (started.ok) {
        result = await request('tools/call', { name, arguments: args }, options.timeoutMs || RESULT_TIMEOUT)
      }
    }
    if (!result.ok) return { ok: false, message: result.message }
    const content = result.result?.content || []
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const images = content.filter((b) => b.type === 'image')
    return {
      ok: !result.result?.isError,
      text,
      images,
      isError: Boolean(result.result?.isError),
      message: result.result?.isError ? text.slice(0, 600) : '',
    }
  }

  const probe = async () => {
    const exe = exePath()
    const exists = exe.includes('\\') ? existsSync(exe) : true
    if (!exists) {
      return {
        ok: false,
        installed: false,
        exe,
        message: '没找到 Windows-MCP：' + exe,
        hint: 'uv tool install windows-mcp  或 uvx windows-mcp',
      }
    }
    if (ready) {
      return { ok: true, installed: true, running: true, exe, serverInfo, toolCount: tools.length, excluded: excludeList() }
    }
    const started = await start()
    return {
      ok: started.ok,
      installed: true,
      running: started.ok,
      exe,
      serverInfo: started.serverInfo || serverInfo,
      toolCount: started.toolCount || 0,
      excluded: started.excluded || excludeList(),
      message: started.ok ? '' : started.message,
    }
  }

  return {
    start,
    stop,
    probe,
    callTool,
    tools: () => tools,
    info: () => ({ ready, serverInfo, toolCount: tools.length, lastError, restarts, excluded: excludeList() }),
  }
}