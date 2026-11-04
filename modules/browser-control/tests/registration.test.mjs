// 工具注册与执行期权限的验收测试：不依赖 QQ，直接驱动模块的 setup。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

/** 造一个最小可用的 Aurabot api 替身，把 tool() 拿到的选择函数留下来。 */
function makeApi({ ownerSessions = new Set(['owner-session']), config = {} } = {}) {
  const state = {
    tools: null,
    commands: [],
    routes: new Map(),
    rules: [],
    settings: { enabled: true },
  }
  const api = {
    log: silentLog,
    dir: mkdtempSync(join(tmpdir(), 'bc-reg-')),
    dataDir: () => state.dataDir || (state.dataDir = mkdtempSync(join(tmpdir(), 'bc-reg-data-'))),
    settings: () => state.settings,
    saveSettings: (patch) => { state.settings = { ...state.settings, ...patch } },
    config: () => ({ enabled: true, dryRun: false, ownerQQ: '3394460631', ...config }),
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

test('模块元信息完整（外置模块要求）', () => {
  assert.equal(mod.id, 'browser-control')
  assert.equal(mod.api, 1)
  assert.equal(mod.panel, 'panel.js')
  assert.ok(mod.name && mod.version && mod.description)
  assert.equal(typeof mod.setup, 'function')
  assert.ok(mod.defaults && typeof mod.defaults === 'object')
})

test('主人私聊 full：拿得到全部工具', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const names = tools.map((t) => t.name).sort()
  assert.equal(tools.length, 13, '应该是 13 个工具，实际：' + names.join(','))
  for (const want of ['bc_status', 'bc_open', 'bc_read', 'bc_click', 'bc_fill', 'bc_press', 'bc_scroll', 'bc_tabs', 'bc_screenshot', 'bc_eval', 'bc_batch', 'bc_task', 'bc_back']) {
    assert.ok(names.includes(want), '缺少工具 ' + want)
  }
  // 每个工具都要有描述和 execute
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 5, tool.name + ' 缺描述')
    assert.equal(typeof tool.execute, 'function', tool.name + ' 缺 execute')
  }
})

test('群聊里拿不到任何工具', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  assert.deepEqual(state.tools({ chat: { kind: 'group', groupId: '123' }, level: 'full', sessionId: 'owner-session' }), [])
})

test('私聊但不是 full 等级：拿不到工具', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  for (const level of ['chat', 'social', 'basic']) {
    assert.deepEqual(state.tools({ chat: { kind: 'private' }, level, sessionId: 'owner-session' }), [], level + ' 不该拿到工具')
  }
})

test('私聊 full 但会话不是主人：拿不到工具', () => {
  const { api, state } = makeApi({ ownerSessions: new Set() })
  mod.setup(api)
  assert.deepEqual(state.tools(OWNER_CTX), [])
})

test('模块开关关掉后工具列表为空', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  state.settings = { ...state.settings, enabled: false }
  assert.deepEqual(state.tools(OWNER_CTX), [])
})

test('执行期二次校验：会话中途失去主人身份就拒绝', async () => {
  const owners = new Set(['owner-session'])
  const { api, state } = makeApi({ ownerSessions: owners })
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const status = tools.find((t) => t.name === 'bc_status')
  assert.ok(status, '要能拿到 bc_status')

  // 一开始还是主人：这个工具会真的去探测后端，所以只检查它没被权限挡掉
  // （用错误消息区分「权限拒绝」和「后端不可用」）
  owners.clear()
  const blocked = await status.execute({})
  assert.equal(blocked.ok, false)
  assert.match(String(blocked.message), /只对主人开放/)
})

test('命令注册齐全', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const names = state.commands.map((c) => c.name)
  assert.ok(names.includes('浏览器'), '缺少 /浏览器 命令')
  const cmd = state.commands.find((c) => c.name === '浏览器')
  assert.ok(Array.isArray(cmd.aliases) && cmd.aliases.length > 0)
  assert.equal(typeof cmd.run, 'function')
})

test('面板路由齐全（含诊断/自检/批量/审批）', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  for (const path of ['/state', '/probe', '/diag', '/selftest', '/batch', '/tabs', '/snapshot', '/screenshot', '/open', '/approve', '/reject', '/cancel', '/reset', '/tasks']) {
    assert.ok(state.routes.has(path), '缺少路由 ' + path)
  }
})

test('bc_batch 会拦掉空的 steps 和危险表达式', async () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const batch = tools.find((t) => t.name === 'bc_batch')
  assert.equal((await batch.execute({ steps: [] })).ok, false)
  const danger = await batch.execute({ steps: [{ action: 'evaluate', expression: 'fetch("https://x")' }] })
  assert.equal(danger.ok, false)
  assert.match(String(danger.message), /改状态|外发/)
  const tooMany = await batch.execute({ steps: Array.from({ length: 30 }, () => ({ action: 'scroll' })) })
  assert.equal(tooMany.ok, false)
})

test('bc_eval 会拦掉 fetch / cookie 写入 / eval', async () => {
  const { api, state } = makeApi()
  mod.setup(api)
  const tools = state.tools(OWNER_CTX)
  const evaluate = tools.find((t) => t.name === 'bc_eval')
  for (const expression of ['fetch("/x")', 'document.cookie = "a=1"', 'eval("1")', 'localStorage.setItem("a","1")']) {
    const result = await evaluate.execute({ expression })
    assert.equal(result.ok, false, expression + ' 应该被拦')
  }
  assert.equal((await evaluate.execute({ expression: '' })).ok, false)
})

test('会往她的系统提示里注入能力说明（只在主人私聊、且模块开着时）', () => {
  const { api, state } = makeApi()
  mod.setup(api)
  assert.ok(state.rules.length >= 1, '应该注册了至少一条 rule')
  const text = String(state.rules[0]('private'))
  assert.ok(text.length > 80, '说明太短，可能没生效')
  assert.match(text, /bc_batch/, '要提到关键工具名')
  assert.match(text, /多步/, '要提到关键用法')
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
  assert.match(out.text, /bc_batch/)
})
