// 工具注册与执行期权限的验收测试（Windows 模块）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { ALLOWED_TOOLS } from '../adapters/windows-mcp.mjs'

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

function makeApi({ ownerSessions = new Set(['owner-session']) } = {}) {
  const state = { tools: null, commands: [], routes: new Map(),
    rules: [], settings: { enabled: true } }
  const api = {
    log: silentLog,
    dir: mkdtempSync(join(tmpdir(), 'wc-reg-')),
    dataDir: () => state.dataDir || (state.dataDir = mkdtempSync(join(tmpdir(), 'wc-reg-data-'))),
    settings: () => state.settings,
    saveSettings: (patch) => { state.settings = { ...state.settings, ...patch } },
    config: () => ({ enabled: true, dryRun: false, ownerQQ: '3394460631' }),
    tool: (build) => { state.tools = build },
    defineTool: (spec) => spec,
    command: (cmd) => { state.commands.push(cmd) },
    route: (path, handler) => { state.routes.set(path, handler) },
    rule: (fn) => { state.rules.push(fn); return () => {} },
    every: () => {},
    onDispose: () => {},
    core: {
      hub: { turnHasOwner: (sessionId) => ownerSessions.has(sessionId) },
      http: { body: async () => ({}) },
    },
  }
  return { api, state }
}

const OWNER_CTX = { chat: { kind: 'private', userId: '3394460631' }, level: 'full', sessionId: 'owner-session' }

test('模块元信息完整', () => {
  assert.equal(mod.id, 'windows-control')
  assert.equal(mod.api, 1)
  assert.equal(mod.panel, 'panel.js')
  assert.equal(typeof mod.setup, 'function')
})

test('主人私聊 full：11 个桌面工具，且没有一个是危险工具', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const tools = state.tools(OWNER_CTX).map((t) => t.name).sort()
  assert.equal(tools.length, 11, '实际：' + tools.join(','))
  for (const want of ['wc_state', 'wc_snapshot', 'wc_app', 'wc_click', 'wc_type', 'wc_key', 'wc_scroll', 'wc_file', 'wc_wait', 'wc_clipboard', 'wc_task']) {
    assert.ok(tools.includes(want), '缺少 ' + want)
  }
  // 工具名里绝不能出现这些
  for (const bad of ['PowerShell', 'Registry', 'Process', 'Scrape', 'powershell', 'registry']) {
    assert.equal(tools.some((n) => n.includes(bad)), false, '不该出现 ' + bad)
  }
})

test('工具背后用到的后端工具都在白名单内', () => {
  for (const name of ['Snapshot', 'Screenshot', 'DisplayInventory', 'App', 'Click', 'Type', 'Shortcut', 'Scroll', 'Move', 'FileSystem', 'Wait', 'WaitFor', 'Clipboard', 'Notification']) {
    assert.ok(ALLOWED_TOOLS.has(name), name + ' 应在白名单')
  }
})

test('群聊 / 非 full / 非主人：一律拿不到工具', () => {
  const { api, state } = makeApi({ ownerSessions: new Set() })
  mod.setup(api)
  assert.deepEqual(state.tools({ chat: { kind: 'group' }, level: 'full', sessionId: 'owner-session' }), [])
  assert.deepEqual(state.tools({ chat: { kind: 'private' }, level: 'chat', sessionId: 'owner-session' }), [])
  assert.deepEqual(state.tools(OWNER_CTX), [])
})

test('执行期二次校验：失去主人身份就拒绝', async () => {
  const owners = new Set(['owner-session'])
  const { api, state } = makeApi({ ownerSessions: owners })
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const snapshotOfState = tools.find((t) => t.name === 'wc_state')
  owners.clear()
  const blocked = await snapshotOfState.execute({})
  assert.equal(blocked.ok, false)
  assert.match(String(blocked.message), /只对主人开放/)
})

test('命令与路由齐全', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  assert.ok(state.commands.some((c) => c.name === '电脑'))
  for (const path of ['/state', '/probe', '/diag', '/selftest', '/snapshot', '/screen', '/windows', '/approve', '/reject', '/cancel', '/pause', '/restart', '/tasks']) {
    assert.ok(state.routes.has(path), '缺少路由 ' + path)
  }
})

test('wc_file 拒绝授权目录外的路径（执行期，不依赖后端）', async () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const file = tools.find((t) => t.name === 'wc_file')
  const result = await file.execute({ mode: 'read', path: 'C:/Windows/System32/config/SAM' })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /不在授权目录/)
})

// 说明：这里**不测** wc_click / wc_app 这类动作工具的入参校验 ——
// 它们会走 preflight → 读桌面，从而拉起 Windows-MCP 子进程，单测里没必要。
// 那部分逻辑已经在 tests/actions.test.mjs 里用假后端覆盖过了。

test('面板 /state 路由存在且是函数（真实返回已在 HTTP 层验过）', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  // 注意：不在这里真调 handler —— 它会拉起 Windows-MCP 子进程，
  // 单测里没必要，/state 的真实返回已经在对外接口那层验证过。
  assert.equal(typeof state.routes.get('/state'), 'function')
  assert.equal(typeof state.routes.get('/diag'), 'function')
  assert.equal(typeof state.routes.get('/selftest'), 'function')
})

test('会往她的系统提示里注入能力说明（只在主人私聊、且模块开着时）', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  assert.ok(state.rules.length >= 1, '应该注册了至少一条 rule')
  const text = String(state.rules[0]('private'))
  assert.ok(text.length > 80, '说明太短，可能没生效')
  assert.match(text, /wc_type/, '要提到关键工具名')
  assert.match(text, /wc_click/, '要提到关键用法')
  // 群聊里不注入
  assert.equal(state.rules[0]('social'), '')
  // 模块关掉就不注入
  state.settings = { ...state.settings, enabled: false }
  assert.equal(state.rules[0]('private'), '')
})

test('/prompt 能看到她被告诉了什么', async () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const out = await state.routes.get('/prompt')({})
  assert.equal(out.ok, true)
  assert.match(out.text, /wc_type/)
})
