// 任务记录：一次「浏览器任务」= 同一会话里连续的一串动作。
// 状态机与 windows-control 保持一致：pending / running / paused / awaiting_approval / completed / failed / cancelled

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const TASK_STATES = ['pending', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled']

const IDLE_MS = 5 * 60 * 1000
const MAX_STEPS = 40
const MAX_TASKS = 30

export function createTaskStore({ dataDir, log }) {
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, 'tasks.json')
  let tasks = []
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(saved)) tasks = saved.slice(0, MAX_TASKS)
  } catch { /* 首次运行 */ }

  const save = () => {
    try {
      const tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify(tasks.slice(0, MAX_TASKS), null, 2), 'utf8')
      renameSync(tmp, path)
    } catch (error) { log.warn('[浏览器] 任务存档失败：' + error.message) }
  }

  const bySource = new Map()

  /** 空闲太久的 running 任务自动结案，避免记录永远停在 running（热重载时会误导）。 */
  const settleIdle = () => {
    const now = Date.now()
    let changed = false
    for (const task of tasks) {
      if (task.status === 'running' && now - task.updatedAt >= IDLE_MS) {
        task.status = 'completed'
        task.settledBy = 'idle'
        changed = true
      }
    }
    if (changed) save()
  }

  const openTask = (source) => {
    settleIdle()
    const now = Date.now()
    const existingId = bySource.get(source)
    const existing = existingId ? tasks.find((t) => t.id === existingId) : null
    if (existing && now - existing.updatedAt < IDLE_MS && ['running', 'paused', 'awaiting_approval'].includes(existing.status)) {
      return existing
    }
    const task = {
      id: randomUUID().slice(0, 8),
      kind: 'browser',
      source: String(source || 'unknown').slice(0, 80),
      backend: 'ego-browser',
      status: 'running',
      goal: '',
      steps: [],
      createdAt: now,
      updatedAt: now,
      error: '',
      verified: false,
    }
    tasks.unshift(task)
    tasks = tasks.slice(0, MAX_TASKS)
    bySource.set(source, task.id)
    save()
    return task
  }

  const step = (taskId, entry) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return null
    task.steps.push({ at: Date.now(), ...entry })
    if (task.steps.length > MAX_STEPS) task.steps = task.steps.slice(-MAX_STEPS)
    task.updatedAt = Date.now()
    if (entry.status && TASK_STATES.includes(entry.status)) task.status = entry.status
    if (entry.error) task.error = String(entry.error).slice(0, 500)
    if (entry.goal) task.goal = String(entry.goal).slice(0, 200)
    save()
    return task
  }

  const setStatus = (taskId, status, patch = {}) => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return null
    if (TASK_STATES.includes(status)) task.status = status
    Object.assign(task, patch, { updatedAt: Date.now() })
    save()
    return task
  }

  const list = (limit = 12) => {
    settleIdle()
    return tasks.slice(0, limit).map((task) => ({
    id: task.id,
    source: task.source,
    status: task.status,
    goal: task.goal,
    steps: task.steps.length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    verified: task.verified,
    lastSteps: task.steps.slice(-3).map((s) => ({ action: s.action, ok: s.ok, note: s.note })),
    }))
  }

  const active = () => {
    const now = Date.now()
    return tasks.filter((t) => ['running', 'paused', 'awaiting_approval'].includes(t.status) && now - t.updatedAt < IDLE_MS)
  }

  const cancelAll = (reason) => {
    let count = 0
    for (const task of tasks) {
      if (['running', 'paused', 'awaiting_approval', 'pending'].includes(task.status)) {
        task.status = 'cancelled'
        task.error = reason || '手动取消'
        task.updatedAt = Date.now()
        count += 1
      }
    }
    if (count) save()
    return count
  }

  return { openTask, step, setStatus, list, active, cancelAll, tasks: () => tasks }
}