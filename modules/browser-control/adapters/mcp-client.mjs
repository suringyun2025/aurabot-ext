// 极简 MCP stdio 客户端：只做 initialize / tools/list / tools/call。
// 两个模块各带一份（模块之间不互相依赖）。

import { spawn } from 'node:child_process'

export function createMcpClient({ command, args = [], env = {}, cwd, clientName = 'aurabot' }) {
  let child = null
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  let ready = false
  let lastError = ''
  let serverInfo = null
  let tools = []

  const rejectAll = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, message: reason })
    }
    pending.clear()
  }

  const start = () => new Promise((resolve) => {
    try {
      child = spawn(command, args, {
        windowsHide: true,
        cwd: cwd || undefined,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      lastError = '启动失败：' + error.message
      return resolve({ ok: false, message: lastError })
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
            entry.resolve(msg.error ? { ok: false, error: msg.error, message: msg.error.message || 'MCP 调用出错' } : { ok: true, result: msg.result })
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    })
    child.stderr.on('data', (chunk) => { lastError = chunk.toString('utf8').slice(0, 800) })
    child.on('error', (error) => { lastError = error.message; rejectAll(lastError) })
    child.on('close', () => { ready = false; rejectAll('MCP 进程退出了' + (lastError ? '：' + lastError.slice(0, 200) : '')) })
    resolve({ ok: true })
  })

  const request = (method, params = {}, timeoutMs = 30000) => new Promise((resolve) => {
    if (!child || child.killed) return resolve({ ok: false, message: 'MCP 进程没在跑' })
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, message: method + ' 超时（' + Math.round(timeoutMs / 1000) + ' 秒）' })
    }, Math.max(3000, timeoutMs))
    pending.set(id, { resolve, timer })
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      resolve({ ok: false, message: '写入 MCP 失败：' + error.message })
    }
  })

  const notify = (method, params = {}) => {
    try { child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') } catch { /* ignore */ }
  }

  const initialize = async () => {
    const started = await start()
    if (!started.ok) return started
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    }, 30000)
    if (!init.ok) return { ok: false, message: 'MCP 握手失败：' + (init.message || '') }
    serverInfo = init.result?.serverInfo || null
    notify('notifications/initialized')
    ready = true
    const listed = await request('tools/list', {}, 20000)
    tools = listed.ok ? (listed.result?.tools || []) : []
    return { ok: true, serverInfo, toolCount: tools.length }
  }

  const callTool = async (name, args = {}, timeoutMs = 60000) => {
    if (!ready) return { ok: false, message: 'MCP 还没连上' }
    const result = await request('tools/call', { name, arguments: args }, timeoutMs)
    if (!result.ok) return result
    const content = result.result?.content || []
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const images = content.filter((b) => b.type === 'image')
    return {
      ok: !result.result?.isError,
      text,
      images,
      isError: Boolean(result.result?.isError),
      raw: result.result,
    }
  }

  const listTools = () => tools
  const isReady = () => ready
  const info = () => ({ serverInfo, toolCount: tools.length, ready, lastError })
  const stop = () => {
    rejectAll('客户端关闭')
    try { child?.stdin.end() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    child = null
    ready = false
  }

  return { initialize, callTool, listTools, isReady, info, stop }
}