import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApprovalExpired, APPROVAL_TTL_MS } from '../services/browser.mjs'

test('待确认操作 5 分钟后过期', () => {
  const now = Date.now()
  assert.equal(APPROVAL_TTL_MS, 5 * 60 * 1000)
  assert.equal(isApprovalExpired({ at: now }, now), false, '刚创建不该过期')
  assert.equal(isApprovalExpired({ at: now - 4 * 60 * 1000 }, now), false, '4 分钟还没过期')
  assert.equal(isApprovalExpired({ at: now - 5 * 60 * 1000 - 1 }, now), true, '超过 5 分钟就该过期')
  assert.equal(isApprovalExpired({ at: now - 60 * 60 * 1000 }, now), true, '一小时前的肯定作废')
})

test('不存在的待确认项也算过期', () => {
  assert.equal(isApprovalExpired(null), true)
  assert.equal(isApprovalExpired(undefined), true)
  assert.equal(isApprovalExpired({}), true, '没有 at 字段就当过期')
})