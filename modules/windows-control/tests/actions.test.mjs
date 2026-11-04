import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWindowsPolicy } from '../security/policy.mjs'
import { createWindowsActions } from '../services/windows.mjs'

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

function harness(config = {}) {
  const calls = []
  const settings = () => ({ allowedDirs: '', allowAnyPath: false, ...config })
  const adapter = {
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { ok: true, text: '（模拟后端返回）', images: [] }
    },
  }
  const policy = createWindowsPolicy({ settings, log: silentLog })
  const actions = createWindowsActions({ adapter, policy, log: silentLog })
  return { actions, calls }
}

test('授权目录外的文件：直接拒绝，不碰后端', async () => {
  const { actions, calls } = harness()
  const result = await actions.file({ mode: 'read', path: 'C:/Windows/System32/config/SAM' })
  assert.equal(result.ok, false)
  assert.match(result.message, /不在授权目录/)
  assert.equal(calls.length, 0, '策略先拦，后端不该被调用')
})

test('授权目录内的文件：正常放行到后端', async () => {
  const { actions, calls } = harness()
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: silentLog })
  const dir = policy.listAllowedDirs()[0]
  const result = await actions.file({ mode: 'list', path: dir })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'FileSystem')
  assert.equal(calls[0].args.mode, 'list')
})

test('copy/move 的两个路径都要过策略', async () => {
  const { actions, calls } = harness()
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: silentLog })
  const home = policy.listAllowedDirs()[0]
  const bad = await actions.file({ mode: 'copy', path: home + '\\a.txt', destination: 'C:/Windows/a.txt' })
  assert.equal(bad.ok, false)
  assert.equal(calls.length, 0)

  const good = await actions.file({ mode: 'copy', path: home + '\\a.txt', destination: home + '\\b.txt' })
  assert.equal(good.ok, true)
  assert.equal(calls.length, 1)
})

test('allowAnyPath 打开后放行目录外', async () => {
  const { actions, calls } = harness({ allowAnyPath: true })
  const result = await actions.file({ mode: 'list', path: 'C:/Windows' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
})

test('点击没给坐标也没给元素编号时直接报错', async () => {
  const { actions, calls } = harness()
  const result = await actions.click({})
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('输入必须先有落点：没点过也没给 loc 就明确报错', async () => {
  const { actions, calls } = harness()
  const result = await actions.type({ text: '你好' })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /落点|loc/)
  assert.equal(calls.length, 0, '不该盲打后端')
})

test('点过之后再输入，自动沿用那个坐标，并带上 clear / press_enter', async () => {
  const { actions, calls } = harness()
  await actions.click({ loc: [100, 200] })
  await actions.type({ text: '你好', clear: true, press_enter: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args.loc, [100, 200])
  assert.equal(calls[1].args.text, '你好')
  assert.equal(calls[1].args.clear, true)
  assert.equal(calls[1].args.press_enter, true)
})

test('滚动没给坐标时用 None（后端要求）', async () => {
  const { actions, calls } = harness()
  await actions.scroll({ direction: 'down', wheel_times: 2 })
  assert.equal(calls[0].args.loc, 'None')
  assert.equal(calls[0].args.wheel_times, 2)
})

test('快捷键为空时不发请求', async () => {
  const { actions, calls } = harness()
  const result = await actions.shortcut({ shortcut: '' })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('后端报错时原样往上传，不吞掉', async () => {
  const calls = []
  const adapter = { callTool: async () => ({ ok: false, message: '后端说：找不到窗口' }) }
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: silentLog })
  const actions = createWindowsActions({ adapter, policy, log: silentLog })
  const result = await actions.app({ mode: 'switch', name: '不存在的窗口' })
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到窗口/)
})

test('等窗口会按 timeout 放大超时', async () => {
  const calls = []
  const adapter = {
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, text: 'ok' } },
  }
  const policy = createWindowsPolicy({ settings: () => ({ allowedDirs: '' }), log: silentLog })
  const actions = createWindowsActions({ adapter, policy, log: silentLog })
  const started = Date.now()
  await actions.waitFor({ condition: 'text_exists', text: '保存', timeout: 2 })
  assert.equal(calls[0].name, 'WaitFor')
  assert.equal(calls[0].args.timeout, 2)
  assert.ok(Date.now() - started < 1000, '不该真的等 2 秒（假后端立刻返回）')
})

test('文件 mode 白名单：奇怪 mode 直接拒，不透传到后端', async () => {
  const { actions, calls } = harness()
  for (const mode of ['exec', 'rm', 'chmod', 'READ; rm -rf /']) {
    const result = await actions.file({ mode, path: 'C:/x' })
    assert.equal(result.ok, false, mode + ' 应被拒')
    assert.match(String(result.message), /不支持的文件操作/)
  }
  assert.equal(calls.length, 0)
})

test('不允许直接指定可执行文件路径', async () => {
  const { actions, calls } = harness()
  const result = await actions.app({ mode: 'launch', executable: 'C:/Windows/System32/calc.exe' })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /应用名/)
  assert.equal(calls.length, 0)
})

test('不允许给应用传命令行参数', async () => {
  const { actions, calls } = harness()
  const result = await actions.app({ mode: 'launch', name: 'cmd', args: ['/c', 'del'] })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('waitFor 只认后端支持的五个条件', async () => {
  const { actions, calls } = harness()
  for (const condition of ['exists', 'visible', 'text', 'whatever']) {
    const result = await actions.waitFor({ condition, text: 'x' })
    assert.equal(result.ok, false, condition + ' 应被拒')
    assert.match(String(result.message), /等待条件不支持/)
  }
  assert.equal(calls.length, 0)
})

test('剪贴板只认 get / set（后端真实 schema）', async () => {
  const { actions, calls } = harness()
  for (const mode of ['copy', 'paste', 'cut']) {
    const result = await actions.clipboard({ mode, text: 'x' })
    assert.equal(result.ok, false, mode + ' 应被拒')
  }
  assert.equal(calls.length, 0)
  const setOk = await actions.clipboard({ mode: 'set', text: 'hello' })
  assert.equal(setOk.ok, true)
  assert.equal(calls[0].args.mode, 'set')
  assert.equal(calls[0].args.text, 'hello')
})

test('剪贴板 set 不给 text 时直接拒', async () => {
  const { actions, calls } = harness()
  const result = await actions.clipboard({ mode: 'set' })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})
