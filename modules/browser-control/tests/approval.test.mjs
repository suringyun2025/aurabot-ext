import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserPolicy } from '../security/policy.mjs'
import { createTaskStore } from '../services/tasks.mjs'
import { createBrowserService } from '../services/browser.mjs'

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

/** 造一个只记调用次数的假后端 + 独立的服务实例。 */
function harness(config = {}) {
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'bc-test-'))
  const settings = () => ({ enabled: true, confirmHighRisk: true, allowDomains: '', denyDomains: '', ...config })
  const adapter = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { ok: true, data: { action, url: params?.url || '', title: 'ok', length: 12 } }
    },
  }
  const policy = createBrowserPolicy({ settings, log: silentLog })
  const tasks = createTaskStore({ dataDir: dir, log: silentLog })
  const service = createBrowserService({ adapter, policy, tasks, settings, log: silentLog })
  return { service, calls, tasks }
}

test('高风险点击：不调后端，返回待确认', async () => {
  const { service, calls } = harness()
  const result = await service.act('click', { target: 'button "立即支付"' }, { source: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.needsApproval, true)
  assert.ok(result.approvalId, '要给出 approvalId')
  assert.equal(calls.length, 0, '没确认前绝不能碰后端')
})

test('待确认列表能看到这条，拒绝后消失', async () => {
  const { service } = harness()
  const first = await service.act('click', { target: 'a "提交订单"' }, { source: 'test' })
  assert.equal(service.listPending().length, 1)
  const rejected = service.reject(first.approvalId)
  assert.equal(rejected.ok, true)
  assert.equal(service.listPending().length, 0)
})

test('主人确认后才真的执行，且只能执行一次', async () => {
  const { service, calls } = harness()
  const pending = await service.act('click', { target: 'button "删除"' }, { source: 'test' })
  assert.equal(calls.length, 0)
  const done = await service.approve(pending.approvalId)
  assert.equal(done.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'click')
  const again = await service.approve(pending.approvalId)
  assert.equal(again.ok, false, 'approvalId 用过就失效')
  assert.equal(calls.length, 1)
})

test('普通点击（中风险）直接执行，不需要确认', async () => {
  const { service, calls } = harness()
  const result = await service.act('click', { target: 'button "搜索"' }, { source: 'test' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
})

test('试运行时写操作不执行，只回报会做什么', async () => {
  const { service, calls } = harness({ dryRun: true })
  const result = await service.act('click', { target: 'button "搜索"' }, { source: 'test' })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(calls.length, 0, '试运行不能碰后端')
})

test('试运行时读取类照常执行', async () => {
  const { service, calls } = harness({ dryRun: true })
  const result = await service.act('snapshot', {}, { source: 'test' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
})

test('禁止名单里的域名连打开都不允许', async () => {
  const { service, calls } = harness({ denyDomains: 'bank.example.com' })
  const result = await service.act('open', { url: 'https://bank.example.com/pay' }, { source: 'test' })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('允许名单非空时，名单外域名拒绝', async () => {
  const { service, calls } = harness({ allowDomains: 'github.com' })
  assert.equal((await service.act('open', { url: 'https://evil.com' })).ok, false)
  assert.equal(calls.length, 0)
  assert.equal((await service.act('open', { url: 'https://github.com/a' })).ok, true)
  assert.equal(calls.length, 1)
})

test('模块关闭后一律拒绝', async () => {
  const { service, calls } = harness({ enabled: false })
  const result = await service.act('snapshot', {}, { source: 'test' })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('动作会写进任务记录，失败时状态是 failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-test-'))
  const settings = () => ({ enabled: true, confirmHighRisk: true })
  const adapter = { call: async () => ({ ok: false, message: '页面崩了' }) }
  const policy = createBrowserPolicy({ settings, log: silentLog })
  const tasks = createTaskStore({ dataDir: dir, log: silentLog })
  const service = createBrowserService({ adapter, policy, tasks, settings, log: silentLog })
  await service.act('open', { url: 'https://example.com' }, { source: 'test-source' })
  const list = tasks.list(5)
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'failed')
  assert.match(list[0].error, /页面崩了/)
  assert.equal(list[0].steps, 1)
})