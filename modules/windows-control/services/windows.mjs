// 桌面「动作」层：一切会改变桌面状态的操作都从这里走，先过策略再调后端。
// 设计原则：不做"点了就算成功"，每个动作都把后端返回的原文往上带，让上层能核对。

const HIGH_RISK_FILE_MODES = new Set(['delete', 'move', 'copy', 'write'])

// 允许的文件操作（白名单）。后端自己也认这些，但入口处先挡一层，
// 免得模型塞进来一个奇怪 mode 直接被透传到 Windows-MCP。
const FILE_MODES = new Set(['read', 'write', 'copy', 'move', 'delete', 'list', 'search', 'info'])

export function createWindowsActions({ adapter, policy, log }) {
  const guardPath = (path) => policy.checkPath(path)

  const app = async (args = {}) => {
    // 只允许按应用名启动，不接受直接丢一个 exe 路径进来
    if (args.executable) {
      return { ok: false, message: '不支持直接指定可执行文件路径，请用应用名（name），例如「记事本」' }
    }
    if (args.args) {
      return { ok: false, message: '不支持给应用传命令行参数' }
    }
    const mode = String(args.mode || 'launch')
    const payload = { mode }
    if (args.name) payload.name = String(args.name)
    if (args.executable) payload.executable = String(args.executable)
    if (Array.isArray(args.window_loc)) payload.window_loc = args.window_loc.map(Number)
    if (Array.isArray(args.window_size)) payload.window_size = args.window_size.map(Number)
    const result = await adapter.callTool('App', payload, { timeoutMs: 20000 })
    if (!result.ok) return { ok: false, message: (result.message || result.text || '应用操作失败') + '\n（切窗口失败通常是窗口名不对，先用 wc_state 看看现在开着哪些窗口）' }

    // Windows-MCP 有些失败也是 ok:true，只能看正文：实测 "Notepad not found in start menu."
    const said = String(result.text || '')
    if (/not found|does not exist|no such|could not|failed/i.test(said)) {
      return { ok: false, message: '没启动起来：' + said.trim().slice(0, 200) }
    }
    if (/not detected yet/i.test(said)) {
      return { ok: true, warning: '已发出启动命令，但窗口还没检测到（可能还在起）。等一两秒用 wc_state 确认一下。', message: said.trim().slice(0, 200) + '\n（已发出，稍等再确认）' }
    }
    return { ok: true, message: '应用动作完成：' + mode + '\n' + String(result.text || '').slice(0, 800), data: { text: result.text } }
  }

  let lastClickLoc = null

  const click = async (args = {}) => {
    const payload = { button: String(args.button || 'left'), clicks: Math.max(1, Math.min(3, Number(args.clicks) || 1)) }
    if (Array.isArray(args.loc)) payload.loc = args.loc.map(Number)
    else if (args.label != null) payload.label = Number(args.label)
    else if (typeof args.loc === 'string' && args.loc.trim()) payload.loc = args.loc.trim()
    if (!payload.loc && payload.label == null) return { ok: false, message: '要给出坐标 loc=[x,y] 或元素 label' }
    const result = await adapter.callTool('Click', payload, { timeoutMs: 30000 })
    if (result.ok && Array.isArray(payload.loc)) lastClickLoc = payload.loc.slice()
    if (!result.ok) return { ok: false, message: result.message || result.text || '点击失败' }
    return { ok: true, message: '点击完成\n' + String(result.text || '').slice(0, 600), data: { text: result.text } }
  }

  const type = async (args = {}) => {
    const payload = { text: String(args.text ?? '') }
    if (Array.isArray(args.loc)) payload.loc = args.loc.map(Number)
    if (args.label != null) payload.label = Number(args.label)
    if (args.clear != null) payload.clear = Boolean(args.clear)
    if (args.press_enter != null) payload.press_enter = Boolean(args.press_enter)
      // 后端硬要求给 loc 或 label（实测：不给就 "Either loc or label must be provided"）
      if (!payload.loc && payload.label == null && lastClickLoc) payload.loc = lastClickLoc.slice()
      if (!payload.loc && payload.label == null) {
        return { ok: false, message: '输入要先有落点：用 wc_click 点一下输入框（或直接给 loc=[x,y]），再输入' }
      }
    if (args.caret_position) payload.caret_position = String(args.caret_position)
    const result = await adapter.callTool('Type', payload, { timeoutMs: 45000 })
    if (!result.ok) return { ok: false, message: result.message || result.text || '输入失败' }
    return { ok: true, message: '输入完成（' + payload.text.length + ' 字）\n' + String(result.text || '').slice(0, 600), data: { text: result.text } }
  }

  const scroll = async (args = {}) => {
    const payload = {
      type: String(args.type || 'vertical'),
      direction: String(args.direction || 'down'),
      wheel_times: Math.max(1, Math.min(20, Number(args.wheel_times) || 3)),
    }
    if (Array.isArray(args.loc)) payload.loc = args.loc.map(Number)
    else if (args.label != null) payload.label = Number(args.label)
    else payload.loc = 'None'
    const result = await adapter.callTool('Scroll', payload, { timeoutMs: 30000 })
    return result.ok
      ? { ok: true, message: '滚动了 ' + payload.wheel_times + ' 格', data: { text: result.text } }
      : { ok: false, message: result.message || result.text || '滚动失败' }
  }

  const move = async (args = {}) => {
    const payload = { duration: Number(args.duration) || 0.2 }
    if (Array.isArray(args.loc)) payload.loc = args.loc.map(Number)
    else if (args.label != null) payload.label = Number(args.label)
    if (args.drag) {
      payload.drag = true
      if (Array.isArray(args.from_loc)) payload.from_loc = args.from_loc.map(Number)
    }
    const result = await adapter.callTool('Move', payload, { timeoutMs: 30000 })
    return result.ok
      ? { ok: true, message: args.drag ? '拖动完成' : '鼠标移过去了', data: { text: result.text } }
      : { ok: false, message: result.message || result.text || '移动失败' }
  }

  const shortcut = async (args = {}) => {
    const combo = String(args.shortcut || '').trim()
    if (!combo) return { ok: false, message: '快捷键是空的，例如 ctrl+c' }
    const result = await adapter.callTool('Shortcut', { shortcut: combo }, { timeoutMs: 30000 })
    return result.ok
      ? { ok: true, message: '按了 ' + combo, data: { text: result.text } }
      : { ok: false, message: result.message || result.text || '快捷键失败' }
  }

  // Windows-MCP 的 Clipboard 只有 get / set 两种 mode（实测 schema），不是 copy/paste。
  const clipboard = async (args = {}) => {
    const mode = String(args.mode || 'set')
    if (mode !== 'set' && mode !== 'get') {
      return { ok: false, message: '剪贴板只支持 set（写）和 get（读），收到的是「' + mode + '」' }
    }
    const payload = { mode }
    if (mode === 'set') {
      if (args.text == null) return { ok: false, message: 'set 需要给 text' }
      payload.text = String(args.text)
    }
    const result = await adapter.callTool('Clipboard', payload, { timeoutMs: 30000 })
    if (!result.ok) return { ok: false, message: result.message || result.text || '剪贴板操作失败' }
    return {
      ok: true,
      // 读出来的内容不往上带（里面可能就是密码），只报告成功
      message: mode === 'set' ? '已写进剪贴板（' + payload.text.length + ' 字）' : '读到剪贴板内容（不回显）',
      data: { mode },
    }
  }

  const file = async (args = {}) => {
    const mode = String(args.mode || 'read')
    if (!FILE_MODES.has(mode)) {
      return { ok: false, message: '不支持的文件操作「' + mode + '」，可用：' + [...FILE_MODES].join('/') }
    }
    const target = guardPath(args.path)
    if (!target.ok) return target
    const payload = { mode, path: target.path }
    if (args.destination) {
      const dest = guardPath(args.destination)
      if (!dest.ok) return dest
      payload.destination = dest.path
    }
    if (args.content != null) payload.content = String(args.content)
    if (args.pattern) payload.pattern = String(args.pattern)
    if (args.recursive != null) payload.recursive = Boolean(args.recursive)
    if (args.append != null) payload.append = Boolean(args.append)
    if (args.overwrite != null) payload.overwrite = Boolean(args.overwrite)
    if (args.limit != null) payload.limit = Number(args.limit)
    if (args.offset != null) payload.offset = Number(args.offset)
    const result = await adapter.callTool('FileSystem', payload, { timeoutMs: mode === 'search' ? 60000 : 45000 })
    if (!result.ok) return { ok: false, message: result.message || result.text || '文件操作失败' }
    return {
      ok: true,
      message: '文件操作完成：' + mode + ' ' + target.path + '\n' + String(result.text || '').slice(0, 1500),
      data: { text: result.text, mode, highRisk: HIGH_RISK_FILE_MODES.has(mode) },
    }
  }

  const wait = async (args = {}) => {
    // Windows-MCP 的 Wait 只要整数秒（传 0.3 会被 pydantic 拒）
    const seconds = Math.max(1, Math.min(30, Math.round(Number(args.duration) || 1)))
    const result = await adapter.callTool('Wait', { duration: seconds }, { timeoutMs: Math.round(seconds * 1000) + 15000 })
    return result.ok ? { ok: true, message: '等了 ' + seconds + ' 秒' } : { ok: false, message: result.message || '等待失败' }
  }

  // 后端只认这五个条件（实测报错信息里列的），传别的会直接报错
  const WAIT_CONDITIONS = new Set(['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element'])
  const waitFor = async (args = {}) => {
    const condition = String(args.condition || 'text_exists')
    if (!WAIT_CONDITIONS.has(condition)) {
      return { ok: false, message: '等待条件不支持「' + condition + '」，可用：' + [...WAIT_CONDITIONS].join('/') }
    }
    const payload = {
      condition,
      timeout: Math.max(1, Math.min(60, Number(args.timeout) || 10)),
    }
    if (args.text) payload.text = String(args.text)
    if (args.window_name) payload.window_name = String(args.window_name)
    const result = await adapter.callTool('WaitFor', payload, { timeoutMs: payload.timeout * 1000 + 20000 })
    return result.ok
      ? { ok: true, message: '等到了：' + (result.text || '').slice(0, 400), data: { text: result.text } }
      : { ok: false, message: result.message || result.text || '等待条件没满足' }
  }

  const notify = async (args = {}) => {
    const result = await adapter.callTool('Notification', {
      title: String(args.title || '大肥鱼'),
      message: String(args.message || ''),
    }, { timeoutMs: 20000 })
    return result.ok ? { ok: true, message: '通知弹出来了' } : { ok: false, message: result.message || '通知失败' }
  }

  return { app, click, type, scroll, move, shortcut, clipboard, file, wait, waitFor, notify }
}