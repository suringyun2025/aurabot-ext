// 统一浏览器能力层：策略检查 → 后端调用 → 任务记录。
// 上层（工具/面板）只跟这里打交道，换后端不用改上层。

import { randomUUID } from 'node:crypto'
import { riskOf } from '../security/policy.mjs'

const WRITE_ACTIONS = new Set(['open', 'click', 'dblclick', 'fill', 'press', 'select', 'upload', 'download', 'newtab', 'closetab'])

// batch 里允许的动作（白名单，不是黑名单）
const BATCH_ACTIONS = new Set([
  'open', 'fill', 'click', 'press', 'select', 'scroll', 'wait', 'evaluate', 'snapshot', 'screenshot',
])

// evaluate 里出现这些就拒：会改状态、会发请求、会执行动态代码
const DANGEROUS_EVAL = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|document\.cookie\s*=|localStorage\.setItem|sessionStorage\.setItem|indexedDB|eval\s*\(|new\s+Function|import\s*\(|location\s*=|location\.(assign|replace)|window\.open|submit\s*\()/i

// 待确认操作的存活时间：过了就作废，避免很久以前的确认被翻出来用
export const APPROVAL_TTL_MS = 5 * 60 * 1000
export const isApprovalExpired = (item, now = Date.now()) => !item || !item.at || now - item.at > APPROVAL_TTL_MS
const isExpired = (item) => isApprovalExpired(item)

export function createBrowserService({ adapter, policy, tasks, settings, log }) {
  const pending = new Map()

  const sourceOf = (ctx) => String(ctx.source || 'panel')

  const act = async (action, params = {}, ctx = {}) => {
    const cfg = settings()
    if (cfg.enabled === false && !ctx.force) return { ok: false, message: '浏览器操控模块关着，先在面板打开' }

    const risk = riskOf(action, params)
    const source = sourceOf(ctx)
    const task = tasks.openTask(source)

    // batch：逐步过策略 —— 不能因为包在 batch 里就跳过域名和注入检查
    if (action === 'batch') {
      const verdict = precheckBatch(params && params.steps, ctx, policy)
      if (!verdict.ok) {
        tasks.step(task.id, { action, ok: false, risk, note: verdict.message })
        tasks.setStatus(task.id, 'failed', { error: verdict.message })
        return verdict
      }
    }

    // 网址策略
    if (action === 'open' || (action === 'newtab' && params.url)) {
      const verdict = policy.checkUrl(params.url, { allowLocal: Boolean(ctx.allowLocal) })
      if (!verdict.ok) {
        tasks.step(task.id, { action, ok: false, risk, note: verdict.message })
        tasks.setStatus(task.id, 'failed', { error: verdict.message })
        return verdict
      }
    }

    // 试运行：只放行读取类
    if (policy.isDryRun() && WRITE_ACTIONS.has(action)) {
      const note = '试运行：这条动作没有真的执行（' + action + '）'
      tasks.step(task.id, { action, ok: true, risk, note })
      return { ok: true, dryRun: true, message: note, preview: { action, params } }
    }

    // 高风险：必须面板确认
    if (risk === 'high' && cfg.confirmHighRisk !== false && !ctx.approved) {
      const id = randomUUID().slice(0, 8)
      pending.set(id, { action, params, source, at: Date.now(), summary: ctx.summary || '' })
      tasks.step(task.id, { action, ok: false, risk, note: '等待主人确认' })
      tasks.setStatus(task.id, 'awaiting_approval')
      const what = ctx.summary || describe(action, params)
      return {
        ok: false,
        needsApproval: true,
        approvalId: id,
        message: '这一步属于高风险操作（' + what + '），需要主人在面板里点确认才会执行。',
      }
    }

    const started = Date.now()
    const result = await adapter.call(action, params, { timeoutMs: ctx.timeoutMs })
    const ms = Date.now() - started
    tasks.step(task.id, {
      action,
      ok: Boolean(result.ok),
      risk,
      ms,
      note: result.ok ? summarize(action, result.data) : String(result.message || '').slice(0, 300),
      error: result.ok ? '' : String(result.message || '').slice(0, 300),
    })
    if (!result.ok) {
      tasks.setStatus(task.id, 'failed', { error: String(result.message || '').slice(0, 400) })
    } else if (action === 'batch') {
      // batch 本身就是"一个完整目标"，成功即结案
      tasks.setStatus(task.id, 'completed')
    } else if (['state', 'tabs', 'snapshot', 'screenshot'].includes(action)) {
      // 只读动作不结束任务，继续累积
    }
    return result
  }

  const approve = async (id) => {
    const item = pending.get(id)
    if (!item) return { ok: false, message: '没有这个待确认的操作' }
    if (isExpired(item)) {
      pending.delete(id)
      return { ok: false, message: '这个确认已经过期（超过 5 分钟），要执行请重新发起一次' }
    }
    pending.delete(id)
    const cfg = settings()
    if (cfg.enabled === false) return { ok: false, message: '模块关着，没有执行' }
    const result = await adapter.call(item.action, item.params, { timeoutMs: 90000 })
    const task = tasks.openTask(item.source)
    tasks.step(task.id, {
      action: item.action,
      ok: Boolean(result.ok),
      risk: 'high',
      note: '主人确认后执行：' + (result.ok ? summarize(item.action, result.data) : String(result.message || '')),
      error: result.ok ? '' : String(result.message || '').slice(0, 300),
    })
    if (result.ok) tasks.setStatus(task.id, 'completed')
    else tasks.setStatus(task.id, 'failed', { error: String(result.message || '').slice(0, 300) })
    return result
  }

  const reject = (id) => {
    const item = pending.get(id)
    if (!item) return { ok: false, message: '没有这个待确认的操作' }
    pending.delete(id)
    return { ok: true, message: '已拒绝，没有执行' }
  }

  const listPending = () => {
    for (const [id, item] of pending) if (isExpired(item)) pending.delete(id)
    return [...pending.entries()].map(([id, item]) => ({
    id,
    action: item.action,
    summary: item.summary || describe(item.action, item.params),
      at: item.at,
      source: item.source,
    }))
  }

  return { act, approve, reject, listPending, pendingCount: () => pending.size }
}

function describe(action, params) {
  if (action === 'click' || action === 'dblclick') return '点击「' + String(params.target || '').slice(0, 40) + '」'
  if (action === 'fill') return '在「' + String(params.target || '').slice(0, 30) + '」里输入内容'
  if (action === 'press') return '按键 ' + String(params.key || '')
  if (action === 'upload') return '上传 ' + (Array.isArray(params.files) ? params.files.length : 0) + ' 个文件'
  if (action === 'download') return '下载文件'
  return action
}

function summarize(action, data) {
  if (!data) return action + ' 完成'
  if (action === 'open') return '打开 ' + String(data.url || '').slice(0, 120)
  if (action === 'snapshot') return '拿到页面快照（' + (data.length || 0) + ' 字符）'
  if (action === 'screenshot') return '截图存到 ' + (data.saved || '')
  if (action === 'tabs') return '共 ' + (data.tabs || []).length + ' 个标签页'
  if (action === 'click') return '点了 ' + String(data.title || data.url || '').slice(0, 60)
  if (action === 'fill') return '输入了 ' + (data.filled || 0) + ' 字'
  if (action === 'evaluate') return '取到结构化结果'
  return action + ' 完成'
}

/** batch 的逐步前置检查：动作白名单 + 域名策略 + evaluate 注入拦截 + 步数上限。 */
function precheckBatch(steps, ctx, policy) {
  ctx = ctx || {}
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) return { ok: false, message: 'steps 是空的' }
  if (list.length > 25) return { ok: false, message: '一次最多 25 步，拆开做' }
  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {}
    const action = String(step.action || '')
    const where = '第 ' + (i + 1) + ' 步'
    if (!BATCH_ACTIONS.has(action)) {
      return { ok: false, message: where + '：不支持的动作「' + action + '」，可用：' + [...BATCH_ACTIONS].join('/') }
    }
    if (action === 'open') {
      if (!step.url) return { ok: false, message: where + '：open 没给 url' }
      const verdict = policy.checkUrl(step.url, { allowLocal: Boolean(ctx.allowLocal) })
      if (!verdict.ok) return { ok: false, message: where + '不行：' + verdict.message }
    }
    if (action === 'evaluate') {
      const expression = String(step.expression || '')
      if (!expression.trim()) return { ok: false, message: where + '：表达式是空的' }
      if (DANGEROUS_EVAL.test(expression)) {
        return { ok: false, message: where + '：evaluate 里有会改状态或外发的调用，换一种只读取值的写法' }
      }
    }
  }
  return { ok: true }
}
