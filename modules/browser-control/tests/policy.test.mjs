import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserPolicy, riskOf, ACTION_RISK } from '../security/policy.mjs'

const makePolicy = (overrides = {}) => createBrowserPolicy({
  settings: () => ({ allowDomains: '', denyDomains: '', ...overrides }),
  log: { warn() {}, info() {} },
})

test('读取类动作是低风险', () => {
  for (const action of ['snapshot', 'screenshot', 'state', 'tabs', 'evaluate', 'wait']) {
    assert.equal(riskOf(action), 'low', action + ' 应该是 low')
  }
})

test('写动作默认中风险', () => {
  for (const action of ['open', 'click', 'fill', 'press', 'upload']) {
    assert.equal(riskOf(action), 'medium', action + ' 应该是 medium')
  }
})

test('点击支付类按钮升级为高风险', () => {
  assert.equal(riskOf('click', { target: 'button "立即支付"' }), 'high')
  assert.equal(riskOf('click', { target: 'a "提交订单"' }), 'high')
  assert.equal(riskOf('click', { target: 'button "Delete"' }), 'high')
  assert.equal(riskOf('click', { target: 'button "搜索"' }), 'medium')
})

test('填值里出现危险词也算高风险', () => {
  assert.equal(riskOf('fill', { target: '#q', value: '请帮我付款' }), 'high')
})

test('上传可执行文件升级为高风险', () => {
  assert.equal(riskOf('upload', { files: ['C:/x/setup.exe'] }), 'high')
  assert.equal(riskOf('upload', { files: ['C:/x/photo.png'] }), 'medium')
})

test('域名禁止名单优先', () => {
  const policy = makePolicy({ denyDomains: 'bank.example.com' })
  assert.equal(policy.checkUrl('https://bank.example.com/login').ok, false)
  assert.equal(policy.checkUrl('https://a.bank.example.com/x').ok, false)
  assert.equal(policy.checkUrl('https://example.com').ok, true)
})

test('允许名单为空时不限制', () => {
  const policy = makePolicy()
  assert.equal(policy.checkUrl('https://any.site/x').ok, true)
})

test('允许名单非空时只放行名单内', () => {
  const policy = makePolicy({ allowDomains: 'github.com' })
  assert.equal(policy.checkUrl('https://github.com/a').ok, true)
  assert.equal(policy.checkUrl('https://gist.github.com/a').ok, true)
  assert.equal(policy.checkUrl('https://evil.com').ok, false)
})

test('网址必须带协议', () => {
  const policy = makePolicy()
  assert.equal(policy.checkUrl('example.com').ok, false)
  assert.equal(policy.checkUrl('https://example.com').ok, true)
})

test('试运行由 dryRun 或 readOnly 触发', () => {
  assert.equal(makePolicy({ dryRun: true }).isDryRun(), true)
  assert.equal(makePolicy({ readOnly: true }).isDryRun(), true)
  assert.equal(makePolicy().isDryRun(), false)
})

test('sanitize 会截断超长内容', () => {
  const policy = makePolicy()
  const long = 'x'.repeat(200)
  assert.ok(policy.sanitize(long, 50).length < 120)
  assert.ok(policy.sanitize(long, 50).includes('截断'))
})

test('动作风险表覆盖所有会用的动作', () => {
  for (const action of ['state', 'tabs', 'snapshot', 'screenshot', 'evaluate', 'wait', 'hover', 'scroll', 'newtab', 'closetab', 'open', 'back', 'forward', 'reload', 'click', 'dblclick', 'fill', 'press', 'select', 'download', 'upload']) {
    assert.ok(ACTION_RISK[action], '缺少风险定义：' + action)
  }
})