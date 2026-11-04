// 截图库：刷小红书时顺手把笔记画面存下来，之后她自己发、或主人让她挑一张发出来。
//
// 存 <模块数据目录>/shots/：每张一个 jpg + 一个 index.json。
// 按 MD5 去重（同一篇笔记重看一遍不会又存一遍），只留最近 max 张，超了删最旧的。

import { createHash } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const validFile = (file) => typeof file === 'string' && /^[a-f0-9]{12}\.jpg$/.test(file)

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback() }
}
const writeJson = (path, value) => {
  try { writeFileSync(path, JSON.stringify(value), 'utf8') } catch { /* 存不下就算了 */ }
}

export function createShotStore({ dir, max = () => 600 }) {
  const root = () => join(dir, 'shots')
  const indexFile = () => join(root(), 'index.json')
  const cap = () => {
    const v = typeof max === 'function' ? max() : max
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 600
  }

  const load = () => {
    const s = readJson(indexFile(), () => ({ items: [] }))
    return { items: s && Array.isArray(s.items) ? s.items.filter((i) => i && validFile(i.file)) : [] }
  }
  const save = (s) => writeJson(indexFile(), s)
  const pathOf = (item) => (validFile(item && item.file) ? join(root(), item.file) : '')

  /** 收一张图。meta 里的 noteId / title / note 会一起记下来。 */
  function put(buf, meta = {}) {
    try {
      const md5 = createHash('md5').update(buf).digest('hex').slice(0, 12)
      const s = load()
      const exist = s.items.find((i) => i.md5 === md5)
      if (exist) {
        if (meta.title && !exist.title) exist.title = String(meta.title)
        if (meta.note && !exist.note) exist.note = String(meta.note)
        save(s)
        return exist
      }
      mkdirSync(root(), { recursive: true })
      const file = md5 + '.jpg'
      writeFileSync(join(root(), file), buf)
      const item = {
        md5,
        file,
        at: Date.now(),
        bytes: buf.length,
        noteId: String(meta.noteId || ''),
        title: String(meta.title || ''),
        note: String(meta.note || '').slice(0, 200),
      }
      s.items.unshift(item)
      while (s.items.length > cap()) {
        const out = s.items.pop()
        try { unlinkSync(join(root(), out.file)) } catch (error) {}
      }
      save(s)
      return item
    } catch (error) {
      return null
    }
  }

  function list(query = '') {
    const items = load().items
    const q = String(query || '').trim()
    if (!q) return items
    return items.filter((i) => (i.title || '').includes(q) || (i.note || '').includes(q))
  }

  /** 挑一张：给了条件就按标题/备注匹配，匹配不到返回 null。 */
  function pick(query = '') {
    const items = list('')
    if (!items.length) return null
    const q = String(query || '').trim()
    if (!q) return items[0]
    let best = null
    let bestScore = 0
    for (const it of items) {
      const hay = [it.title || '', it.note || '']
      let s = 0
      for (const h of hay) {
        if (!h) continue
        if (h.includes(q)) s = Math.max(s, 10)
        else {
          const hit = [...q].filter((ch) => h.includes(ch)).length
          if (hit >= 2) s = Math.max(s, (hit / q.length) * 5)
        }
      }
      if (s > bestScore) { best = it; bestScore = s }
    }
    return bestScore >= 2 ? best : null
  }

  function trim() {
    const s = load()
    let n = 0
    while (s.items.length > cap()) {
      const out = s.items.pop()
      try { unlinkSync(join(root(), out.file)) } catch (error) {}
      n++
    }
    if (n) save(s)
    return n
  }

  function remove(file) {
    const name = String(file || '').trim()
    if (!name) return { ok: false, message: '没说要删哪张' }
    const s = load()
    const it = s.items.find((i) => i.file === name)
    if (!it) return { ok: false, message: '库里没有这张' }
    try { unlinkSync(pathOf(it)) } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, message: '截图没删掉：' + error.message }
    }
    s.items = s.items.filter((i) => i.file !== name)
    save(s)
    return { ok: true, message: `删掉了《${it.title || '截图'}》那一张` }
  }

  function panel() {
    trim()
    return load().items.map((i) => ({ ...i, limit: cap() }))
  }

  return {
    put,
    list,
    pick,
    trim,
    remove,
    panel,
    count: () => load().items.length,
    exists: (item) => Boolean(item && existsSync(pathOf(item))),
    path: pathOf,
    dir: root,
  }
}
