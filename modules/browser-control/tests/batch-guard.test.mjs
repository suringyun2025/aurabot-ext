// batch 内部的每步也必须过策略 —— 这里是漏洞回归测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserPolicy } from '../security/policy.mjs'
import { createTaskStore } from '../services/tasks.mjs'
import { createBrowserService } from '../services/browser.mjs'

const silentLog = { info() {}, warn() {}, debug() {}, error() {} }

function harness(config = {}) {
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'bc-batch-guard-'))
  const settings = () => ({ enabled: true, confirmHighRisk: true, allowDomains: '', denyDomains: '', ...config })
  const adapter = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { ok: true, data: { results: [], done: true } }
    },
  }
  const policy = createBrowserPolicy({ settings, log: silentLog })
  const tasks = createTaskStore({ dataDir: dir, log: silentLog })
  const service = createBrowserService({ adapter, policy, tasks, settings, log: silentLog })
  return { service, calls }
}

test('batch 里的 open 也要过域名策略（禁止名单）', async () => {
  const { service, calls } = harness({ denyDomains: 'bank.example.com' })
  const result = await service.act('batch', {
    steps: [
      { action: 'open', url: 'https://bank.example.com/pay' },
      { action: 'click', target: '#pay' },
    ],
  }, { source: 'test' })
  assert.equal(result.ok, false, '应该整体拒绝')
  assert.match(String(result.message), /第 ?1 ?步|禁止名单/)
  assert.equal(calls.length, 0, '策略应该在后端之前拦住，一次都不该调')
})

test('batch 里的 open 也要过允许名单', async () => {
  const { service, calls } = harness({ allowDomains: 'github.com' })
  const result = await service.act('batch', {
    steps: [{ action: 'open', url: 'https://evil.example.com' }],
  }, { source: 'test' })
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
})

test('batch 里的 evaluate 也要拦危险表达式', async () => {
  const { service, calls } = harness()
  for (const expression of ['fetch("/x")', 'document.cookie = "a=1"', 'eval("1")', 'localStorage.setItem("k","v")', 'new Function("1")()']) {
    const result = await service.act('batch', {
      steps: [{ action: 'evaluate', expression }],
    }, { source: 'test' })
    assert.equal(result.ok, false, expression + ' 应该被拦')
    assert.match(String(result.message), /第 ?1 ?步|改状态|外发|表达式/)
  }
  assert.equal(calls.length, 0)
})

test('batch 里的高危动作还是要人工确认', async () => {
  const { service, calls } = harness()
  const result = await service.act('batch', {
    steps: [
      { action: 'open', url: 'https://example.com' },
      { action: 'click', target: 'button "立即支付"' },
    ],
  }, { source: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.needsApproval, true)
  assert.equal(calls.length, 0)
})

test('正常的 batch 该放行就放行', async () => {
  const { service, calls } = harness()
  const result = await service.act('batch', {
    steps: [
      { action: 'open', url: 'https://example.com' },
      { action: 'fill', target: '#q', value: 'hi' },
      { action: 'click', target: '#go' },
    ],
  }, { source: 'test' })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'batch')
})