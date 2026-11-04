// Aurabot 外置模块：Windows 电脑操控
//
// 后端：CursorTouch/Windows-MCP（stdio MCP）。不重复造鼠标键盘底层。
// 权限：工具只给主人私聊 + level=full；执行时再核对；危险工具在**服务端**就被 --exclude-tools 摘掉。
// 风险：低/中/高；高风险必须主人在面板确认。锁屏 / 安全桌面一律不碰。
// 平台：只在 Windows 上生效；其他系统明确报"不支持"，不注册可执行工具。

import { join } from 'node:path'
import { createWindowsMcpAdapter } from './adapters/windows-mcp.mjs'
import { createWindowsPolicy, riskOf, NEVER_EXPOSE } from './security/policy.mjs'
import { createTaskStore } from './services/tasks.mjs'
import { createDesktopService } from './services/desktop.mjs'
import { createWindowsActions } from './services/windows.mjs'

const IS_WINDOWS = process.platform === 'win32'
const OWNER_ONLY = '电脑操控只对主人开放'
const HIGH_RISK_ACTIONS = new Set(['app-launch', 'file-write', 'file-delete', 'file-move', 'file-copy', 'shortcut-danger'])

export default {
  id: 'windows-control',
  name: 'Windows 电脑操控',
  version: '1.0.0',
  api: 1,
  panel: 'panel.js',
  description: '让大肥鱼在你的 Windows 电脑上真的操作：看屏幕、开应用、切窗口、点、输入、快捷键、在授权目录里读写文件。',
  defaults: {
    enabled: true,
    windowsMcpPath: '',
    allowScrape: false,
    dryRun: false,
    confirmHighRisk: true,
    allowedDirs: '',
    allowAnyPath: false,
    allowStartApps: true,
    maxSnapshotChars: 8000,
    actionPauseMs: 300,
  },
  settings: [],

  setup(api) {
    const log = api.log
    const dataDir = api.dataDir()
    const policy = createWindowsPolicy({ settings: api.settings, log })
    const tasks = createTaskStore({ dataDir, log })
    const adapter = createWindowsMcpAdapter({ dataDir, log, settings: api.settings })
    const desktop = createDesktopService({ adapter, log })
    const actions = createWindowsActions({ adapter, policy, log })

    const APPROVAL_TTL_MS = 5 * 60 * 1000
    const isExpired = (item) => !item || Date.now() - item.at > APPROVAL_TTL_MS
    let pendingApproval = new Map()

    const cfg = () => api.settings()
    const isDryRun = () => cfg().dryRun === true
    const paused = () => cfg().paused === true

    /** 动作前统一前置检查：系统 / 开关 / 试运行 / 锁屏。 */
    const preflight = async ({ needUnlocked = false } = {}) => {
      if (!IS_WINDOWS) return { ok: false, message: '这个模块只在 Windows 上工作，当前系统是 ' + process.platform }
      if (cfg().enabled === false) return { ok: false, message: '电脑操控模块关着，先在面板打开' }
      if (api.config().enabled === false) return { ok: false, message: 'Aurabot 总开关关着' }
      if (paused()) return { ok: false, message: '电脑操控现在是暂停状态，先在面板恢复' }
      if (!needUnlocked) return { ok: true }
      const state = await desktop.state()
      if (!state.ok) return { ok: false, message: state.message }
      const lock = state.data.parsed.lock
      // 只有明确是锁屏/安全桌面才拦。「读不到窗口列表」(no-window) 不算锁屏——
      // 后端 Snapshot 在复杂界面下会超时，实测误判过一次，不能因此把人正常干活也挡住。
      if (lock === 'lock' || lock === 'secure-desktop') {
        return { ok: false, message: '桌面现在锁着（' + lock + '），需要你自己先解锁，我不会去碰锁屏和安全桌面' }
      }
      return { ok: true, state, warning: lock === 'no-window' ? '没读到窗口列表（后端可能超时了），按正常情况继续' : '' }
    }

    /** 动作包装：风险判断 → 试运行 → 审批 → 执行 → 记录。 */
    const perform = async (tool, actionKey, args, ctx = {}) => {
      const risk = riskOf(tool, args)
      const source = String(ctx.source || 'panel')
      const task = tasks.openTask(source)

      if (isDryRun() && risk !== 'low') {
        const note = '试运行：没有真的执行（' + tool + '）'
        tasks.step(task.id, { action: tool, ok: true, risk, note })
        return { ok: true, dryRun: true, message: note }
      }

      const high = risk === 'high' || HIGH_RISK_ACTIONS.has(actionKey)
      if (high && cfg().confirmHighRisk !== false && !ctx.approved) {
        const id = Math.random().toString(36).slice(2, 10)
        pendingApproval.set(id, { tool, args, actionKey, source, at: Date.now(), summary: ctx.summary || describe(tool, args) })
        tasks.step(task.id, { action: tool, ok: false, risk: 'high', note: '等待主人确认' })
        tasks.setStatus(task.id, 'awaiting_approval')
        return {
          ok: false,
          needsApproval: true,
          approvalId: id,
          message: '这一步是高风险（' + (ctx.summary || describe(tool, args)) + '），需要主人在面板里点确认。',
        }
      }

      const started = Date.now()
      let result
      try {
        result = await ctx.run()
      } catch (error) {
        result = { ok: false, message: error.message }
      }
      tasks.step(task.id, {
        action: tool,
        ok: Boolean(result.ok),
        risk,
        ms: Date.now() - started,
        note: result.ok ? String(result.message || '').slice(0, 200) : '',
        error: result.ok ? '' : String(result.message || '').slice(0, 300),
      })
      if (!result.ok) tasks.setStatus(task.id, 'failed', { error: String(result.message || '').slice(0, 400) })
      if (Number(cfg().actionPauseMs) > 0) await delay(Number(cfg().actionPauseMs))
      return result
    }

    const approve = async (id) => {
      const item = pendingApproval.get(id)
      if (!item) return { ok: false, message: '没有这个待确认操作' }
      if (isExpired(item)) {
        pendingApproval.delete(id)
        return { ok: false, message: '这个确认已经过期（超过 5 分钟），要执行请重新发起一次' }
      }
      pendingApproval.delete(id)
      const check = await preflight({ needUnlocked: true })
      if (!check.ok) return check
      const result = await perform(item.tool, item.actionKey, item.args, { source: item.source, approved: true })
      return result
    }

    const reject = (id) => {
      const existed = pendingApproval.delete(id)
      return { ok: existed, message: existed ? '已拒绝，没有执行' : '没有这个待确认操作' }
    }

    const listPending = () => {
      for (const [id, item] of pendingApproval) if (isExpired(item)) pendingApproval.delete(id)
      return [...pendingApproval.entries()].map(([id, item]) => ({
        id, tool: item.tool, summary: item.summary, at: item.at, source: item.source,
      }))
    }

    // ---------------------------------------------------------------- 工具

    // 「自主任务」会话：模块自己用 hub.runSystemTurn 起的后台会话，chatId 形如 system:windows-auto
    const AUTO_PREFIX = 'system:windows-auto'
    const isAutoChat = (chat) => Boolean(chat && chat.kind === 'system' && String(chat.chatId || '').startsWith(AUTO_PREFIX))
    const isAutoSession = (sessionId) => {
      try { return String(api.core.hub.chatOfSession(sessionId) || '').startsWith(AUTO_PREFIX) } catch (error) { return false }
    }

/** 让她自己干一件电脑上的活：拼出给后台会话的指令。 */
const buildWindowsAutoPrompt = (task) => [
  '你能操作这台 Windows 电脑，主人把这件事交给你自己做：' + task,
  '干活方式：',
  '1. 先 wc_state 看当前是什么窗口、桌面什么状态。',
  '2. 打开软件用 wc_app（mode=launch，name 用中文名，比如「记事本」「微信」）；切窗口用 wc_app（mode=switch）。',
  '3. 输入内容：先 wc_click 点到输入框（或给 loc=[x,y]），再 wc_type（会沿用上次点击的位置）。',
  '4. 按快捷键用 wc_key；读文件用 wc_file（mode=read）；文件只能碰 桌面/下载/文档/图片。',
  '5. 后端说读不到窗口（Snapshot 超时）就用 wc_wait 等一两秒再试一次，别急着重试十次。',
  '6. 关机、改系统设置、注册表、命令行这些没有，不要试。',
  '7. 启动应用、写删文件这类会被要求主人确认——别绕，也别假装做成了。',
  '8. 做完用中文说清楚：你做了什么、屏幕上现在什么样、结论是什么。做不到就直说。',
].join('\n')

/** 起一个自主任务：开/复用专用会话，后台跑，做完私聊汇报。 */
const startAutoTask = ({ task, timeoutSec }) => {
  const text = String(task || '').trim()
  if (!text) return { ok: false, message: '要做什么？说清楚一点' }
  if (text.length > 2000) return { ok: false, message: '任务描述太长了，精简到 2000 字以内' }
  const prompt = buildWindowsAutoPrompt(text)
  const ms = Math.max(60, Math.min(1800, Number(timeoutSec) || 600)) * 1000
  const ownerQq = String(api.config().ownerQQ || '')
  const title = '电脑·' + text.slice(0, 16).replace(/\s+/g, ' ')
  Promise.resolve()
    .then(() => api.core.hub.runSystemTurn('windows-auto', title, prompt, { timeoutMs: ms }))
    .then((reply) => {
      api.log.info('[电脑] 自主任务完成：' + title + '（回复 ' + String(reply || '').length + ' 字）')
      if (ownerQq) api.core.hub.deliver('private:' + ownerQq, '【电脑任务完成】' + title + '\n\n' + String(reply || '（她没有回话）').slice(0, 2000))
    })
    .catch((error) => {
      const why = String((error && error.message) || error).slice(0, 400)
      api.log.warn('[电脑] 自主任务失败：' + title + ' —— ' + why)
      if (ownerQq) api.core.hub.deliver('private:' + ownerQq, '【电脑任务没做成】' + title + '\n' + why)
    })
  return { ok: true, title, message: '已经开始干了。专用对话在 DSH 的「Aurabot · QQ」里，标题「QQ · ' + title + '」；做完我私聊告诉你。' }
}

    api.tool(({ chat, level, sessionId }) => {
      const auto = isAutoChat(chat)
      const allowed = IS_WINDOWS && (auto || (level === 'full' && chat && chat.kind === 'private' && api.core.hub.turnHasOwner(sessionId)))
      if (!allowed) return []
      const source = 'qq:' + (chat.userId || 'owner')

      const tool = (name, description, properties, required, handler) => api.defineTool({
        name, description, properties, required,
        execute: async (args) => {
          if (!isAutoSession(sessionId) && !api.core.hub.turnHasOwner(sessionId)) {
            return { ok: false, message: OWNER_ONLY }
          }
          if (!IS_WINDOWS) return { ok: false, message: '这个模块只在 Windows 上工作' }
          try {
            return await handler(args || {})
          } catch (error) {
            return { ok: false, message: '桌面操作出错：' + error.message }
          }
        },
      })

      return [
        tool('wc_task', '把一整套电脑上的活交给她自己做：会开一个专用对话（DSH 里能看到），自己看屏幕、点、打字，做完主动私聊告诉你。适合「帮我在记事本里写个东西」「看着某个任务，完了告诉我」这类多步的事。', {
          task: { type: 'string', description: '要她做的事，用日常话说清楚' },
          timeoutSec: { type: 'number', description: '最多让她干多久，默认 600 秒' },
        }, ['task'], async ({ task, timeoutSec }) => {
          const text = String(task || '').trim()
          if (!text) return { ok: false, message: '要做什么？说清楚一点' }
          if (text.length > 2000) return { ok: false, message: '任务描述太长了，精简到 2000 字以内' }
          const prompt = buildWindowsAutoPrompt(text)
          const ms = Math.max(60, Math.min(1800, Number(timeoutSec) || 600)) * 1000
          const ownerQq = String(api.config().ownerQQ || '')
          const title = '电脑·' + text.slice(0, 16).replace(/\s+/g, ' ')
          Promise.resolve()
            .then(() => api.core.hub.runSystemTurn('windows-auto', title, prompt, { timeoutMs: ms }))
            .then((reply) => {
              if (ownerQq) api.core.hub.deliver('private:' + ownerQq, '【电脑任务完成】' + title + '\n\n' + String(reply || '（她没有回话）').slice(0, 2000))
            })
            .catch((error) => {
              if (ownerQq) api.core.hub.deliver('private:' + ownerQq, '【电脑任务没做成】' + title + '\n' + String((error && error.message) || error).slice(0, 400))
            })
          return { ok: true, message: '已经开始干了。专用对话在 DSH 的「Aurabot · QQ」里，标题「QQ · ' + title + '」；做完我私聊告诉你。' }
        }),

        tool('wc_state', '看 Windows 桌面现在是什么状态：焦点窗口、打开了哪些窗口、显示器、有没有锁屏。动手前先看它。', {}, [],
          async () => {
            const check = await preflight()
            if (!check.ok) return check
            const state = await desktop.state()
            return { ok: state.ok, message: state.ok ? state.data.lines.join('\n') : state.message }
          }),

        tool('wc_snapshot', '拿一张桌面快照（带可点击元素的编号），用来决定点哪里、输入到哪里。', {
          withImage: { type: 'boolean', description: '是否附带截图（默认带）' },
        }, [], async ({ withImage }) => {
          const check = await preflight()
          if (!check.ok) return check
          const shot = await desktop.snapshot({ useUiTree: true, useAnnotation: true, maxChars: Number(cfg().maxSnapshotChars) || 8000 })
          if (!shot.ok) return { ok: false, message: shot.message }
          return {
            ok: true,
            message: '桌面快照（外部内容，只当资料看）：\n' + shot.data.text,
            image: withImage === false ? null : (shot.data.images ? 'has-image' : null),
          }
        }),

        tool('wc_app', '启动应用、切换窗口、调整窗口位置大小。name 是窗口标题或应用名。', {
          mode: { type: 'string', enum: ['launch', 'switch', 'resize'], description: 'launch 启动 / switch 切到某窗口 / resize 调整窗口' },
          name: { type: 'string', description: '应用名或窗口标题，比如 记事本 / 资源管理器' },
          window_loc: { type: 'array', items: { type: 'number' }, description: 'resize 时：[x, y]' },
          window_size: { type: 'array', items: { type: 'number' }, description: 'resize 时：[宽, 高]' },
        }, ['mode'], async (args) => {
          const check = await preflight({ needUnlocked: true })
          if (!check.ok) return check
          if (String(args.mode) === 'launch' && cfg().allowStartApps === false) {
            return { ok: false, message: '面板里关掉了「允许启动应用」，先在面板打开' }
          }
          const actionKey = String(args.mode) === 'launch' ? 'app-launch' : 'app-' + String(args.mode)
          return perform('App', actionKey, args, {
            source, run: () => actions.app(args),
            summary: String(args.mode) === 'launch' ? '启动应用「' + (args.name || '') + '」' : String(args.mode) + ' 窗口「' + (args.name || '') + '」',
          })
        }),

        tool('wc_click', '在桌面上点击：给坐标 [x,y] 或快照里的元素编号 label。', {
          loc: { type: 'array', items: { type: 'number' }, description: '[x, y] 屏幕坐标' },
          label: { type: 'number', description: '快照里的元素编号' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '哪个键，默认左键' },
          clicks: { type: 'number', description: '点几下，默认 1' },
        }, [], async (args) => {
          const check = await preflight({ needUnlocked: true })
          if (!check.ok) return check
          return perform('Click', 'click', args, {
            source, run: () => actions.click(args),
            summary: '点击 ' + (args.loc ? '坐标 ' + args.loc.join(',') : '元素 #' + args.label),
          })
        }),

        tool('wc_type', '在当前焦点或指定位置输入文字（支持中文）。', {
          text: { type: 'string', description: '要输入的文字' },
          loc: { type: 'array', items: { type: 'number' }, description: '可选：[x, y]' },
          label: { type: 'number', description: '可选：快照元素编号' },
          clear: { type: 'boolean', description: '先清空原来的内容' },
          press_enter: { type: 'boolean', description: '输完按回车' },
        }, ['text'], async (args) => {
          const check = await preflight({ needUnlocked: true })
          if (!check.ok) return check
          return perform('Type', 'type', args, {
            source, run: () => actions.type(args),
            summary: '输入 ' + String(args.text || '').slice(0, 20) + '…',
          })
        }),

        tool('wc_key', '按快捷键，比如 ctrl+s / alt+tab / win+e / enter。', {
          shortcut: { type: 'string', description: '组合键，比如 ctrl+s' },
        }, ['shortcut'], async (args) => {
          const check = await preflight({ needUnlocked: true })
          if (!check.ok) return check
          return perform('Shortcut', 'shortcut', args, { source, run: () => actions.shortcut(args) })
        }),

        tool('wc_scroll', '在桌面上滚动滚轮。', {
          direction: { type: 'string', enum: ['up', 'down'], description: '方向' },
          wheel_times: { type: 'number', description: '滚几格，默认 3' },
          loc: { type: 'array', items: { type: 'number' }, description: '可选：在哪个坐标滚' },
        }, [], async (args) => {
          const check = await preflight({ needUnlocked: true })
          if (!check.ok) return check
          return perform('Scroll', 'scroll', args, { source, run: () => actions.scroll(args) })
        }),

        tool('wc_file', '在授权目录里读/写/列/搜文件。写、删、移动、复制需要主人确认。', {
          mode: { type: 'string', enum: ['read', 'list', 'search', 'info', 'write', 'append', 'copy', 'move', 'delete'], description: '做什么' },
          path: { type: 'string', description: '文件或目录的完整路径' },
          content: { type: 'string', description: 'write/append 时的内容' },
          destination: { type: 'string', description: 'copy/move 的目标路径' },
          pattern: { type: 'string', description: 'search 时的匹配模式' },
        }, ['mode', 'path'], async (args) => {
          const check = await preflight()
          if (!check.ok) return check
          const mode = String(args.mode || 'read')
          const key = ['write', 'append'].includes(mode) ? 'file-write' : mode === 'delete' ? 'file-delete' : mode === 'move' ? 'file-move' : mode === 'copy' ? 'file-copy' : 'file-' + mode
          return perform('FileSystem', key, args, {
            source, run: () => actions.file({ ...args, mode: mode === 'append' ? 'write' : mode, append: mode === 'append' }),
            summary: '文件操作 ' + mode + '：' + String(args.path || '').slice(0, 80),
          })
        }),

        tool('wc_clipboard', '把一段文字放进系统剪贴板（比如整理好的内容，你再去粘贴）。只写不读——读取剪贴板会碰到密码之类的东西，所以没开。', {
          text: { type: 'string', description: '要放进剪贴板的文字' },
        }, ['text'], async ({ text }) => {
          const check = await preflight()
          if (!check.ok) return check
          const value = String(text ?? '')
          if (!value) return { ok: false, message: '文字是空的' }
          if (value.length > 20000) return { ok: false, message: '太长了（超过 20000 字），先截断' }
          return perform('Clipboard', 'clipboard-set', { mode: 'set', text: value }, {
            source,
            run: () => actions.clipboard({ mode: 'set', text: value }),
            summary: '写剪贴板（' + value.length + ' 字）',
          })
        }),

        tool('wc_wait', '等一会儿，或者等某个窗口/文字出现。', {
          seconds: { type: 'number', description: '等几秒（用 wait 时）' },
          condition: { type: 'string', enum: ['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element'], description: 'waitFor 用（后端只认这几个）' },
          text: { type: 'string', description: 'waitFor 用：等这段文字' },
          window_name: { type: 'string', description: 'waitFor 用：等这个窗口' },
        }, [], async (args) => {
          const check = await preflight()
          if (!check.ok) return check
          if (args.condition) {
            return perform('WaitFor', 'waitFor', args, { source, run: () => actions.waitFor(args) })
          }
          return perform('Wait', 'wait', args, { source, run: () => actions.wait(args) })
        }),
      ]
    })

    // ---------------------------------------------------------------- 命令
    // ---------------------------------------------------------------- 规则
    // 同上：让她知道自己真能操作这台电脑，以及哪些事做不了。
    const ruleText = (kind) => {
      if (kind !== 'private') return ''
      if (api.settings().enabled === false) return ''
      return [
        '你能操作这台 Windows 电脑（真能点能打字，不是模拟）：wc_state 看桌面状态、wc_snapshot 桌面快照（带元素坐标）、wc_app 开关/切换应用、wc_click 点鼠标、wc_type 打字、wc_key 快捷键、wc_scroll 滚动、wc_file 读写文件、wc_wait 等待、wc_clipboard 把文字放进剪贴板。',
        '什么时候用：主人让你打开某个软件、点某个按钮、在某个窗口里输入内容、存个文件、看看屏幕上有什么、整理桌面上的文件 —— 直接用工具做，别说「我没法操作电脑」。',
        '动手顺序：先用 wc_state 看当前是什么窗口；要输入就先 wc_click 点一下输入框，再 wc_type（会记住上次点击的位置，点哪打哪）。',
        '文件只能碰 桌面/下载/文档/图片 这几个目录，别的路径会被拒绝。关机、改系统设置、注册表、命令行这些没有，别去试。',
        '高风险动作（启动应用、写/删/移动文件、危险快捷键）需要主人在面板确认；这是保护，别绕、别反复重试，也别自己宣布已经完成。',
        '机器锁屏时做不了动作，会直接告诉你，这时候可以请主人解锁。',
      ].join('\n')
    }
    api.rule(ruleText)

    api.command({
      name: '电脑',
      aliases: ['desktop', 'win'],
      desc: '电脑操控：状态 / 看看 / 截图 / 快照 / 取消 / 帮助',
      run: async (arg) => {
        if (!IS_WINDOWS) return '这个模块只在 Windows 上工作，当前系统是 ' + process.platform
        const head = (String(arg || '状态').trim().split(/\s+/)[0] || '状态').toLowerCase()
        if (/^(帮助|help|\?)$/.test(head)) {
          return ['电脑操控：',
            '/电脑 状态 —— 焦点窗口、打开的窗口、是否锁屏',
            '/电脑 快照 —— 带元素编号的桌面快照',
            '/电脑 截图 —— 截一张屏',
            '/电脑 取消 —— 取消待确认/进行中的操作',
            '想让她干活直接说：「打开记事本，帮我写…」「看看我现在的屏幕」'].join('\n')
        }
        if (/^(状态|state)$/.test(head)) {
          const check = await preflight()
          if (!check.ok) return check.message
          const state = await desktop.state()
          return state.ok ? state.data.lines.join('\n') : state.message
        }
        if (/^(快照|snapshot)$/.test(head)) {
          const check = await preflight()
          if (!check.ok) return check.message
          const shot = await desktop.snapshot({ useUiTree: true, maxChars: 4000 })
          return shot.ok ? shot.data.text : shot.message
        }
        if (/^(截图|shot)$/.test(head)) {
          const check = await preflight()
          if (!check.ok) return check.message
          const shot = await desktop.screenshot()
          return shot.ok ? '截图好了（' + (shot.data.images.length || 0) + ' 张，已在面板里可看）' : shot.message
        }
        if (/^(取消|cancel|停)$/.test(head)) {
          const n = pendingApproval.size
          pendingApproval.clear()
          const count = tasks.cancelAll('主人在 QQ 里取消')
          return (n || count) ? '已取消（待确认 ' + n + ' 个，任务 ' + count + ' 个）' : '没有待取消的操作'
        }
        return '没听明白，发 /电脑 帮助'
      },
    })

    // ---------------------------------------------------------------- 面板接口
    const body = async (req) => {
      try { return (await api.core.http.body(req)) || {} } catch { return {} }
    }

    // 主人自己看一眼：她的系统提示里到底被塞了什么
    api.route('/prompt', async () => ({
      ok: true,
      kind: 'private',
      enabled: api.settings().enabled !== false,
      text: ruleText('private'),
      note: '这就是她在主人私聊里收到的能力说明（enabled 为 false 时实际不注入）',
    }))

    // 面板里也能直接给她派个活
    api.route('/task', async (req) => {
      const payload = await body(req)
      return startAutoTask(payload || {})
    })

    api.route('/state', async () => {
      let probe = { ok: false, message: IS_WINDOWS ? '' : '当前系统不是 Windows' }
      if (IS_WINDOWS) probe = await adapter.probe()
      const info = adapter.info()
      return {
        ok: true,
        platform: process.platform,
        supported: IS_WINDOWS,
        enabled: cfg().enabled !== false,
        paused: paused(),
        dryRun: isDryRun(),
        confirmHighRisk: cfg().confirmHighRisk !== false,
        backend: { ...info, probed: Boolean(probe?.ok), installed: probe?.installed !== false, message: probe?.message || '', exe: probe?.exe || '' },
        allowedDirs: policy.listAllowedDirs(),
        allowAnyPath: cfg().allowAnyPath === true,
        pending: listPending(),
        tasks: tasks.list(12),
      }
    })

    api.route('/probe', async () => {
      if (!IS_WINDOWS) return { ok: false, message: '不支持当前系统' }
      return adapter.probe()
    })

    api.route('/snapshot', async () => {
      const check = await preflight()
      if (!check.ok) return check
      const shot = await desktop.snapshot({ useUiTree: true, useAnnotation: false, maxChars: Number(cfg().maxSnapshotChars) || 8000, timeoutMs: 45000 })
      if (shot.ok) return { ok: true, message: shot.data.text, images: (shot.data.images ? 'yes' : 'no') }
      const fast = await desktop.screenshot()
      if (fast.ok) {
        return { ok: true, degraded: true, message: 'UI 树没拿到（' + shot.message + '），先给你截图版：\n' + fast.data.text }
      }
      return { ok: false, message: shot.message }
    })

    api.route('/screen', async () => {
      const check = await preflight()
      if (!check.ok) return check
      const shot = await desktop.screenshot()
      if (!shot.ok) return { ok: false, message: shot.message }
      return { ok: true, text: shot.data.text, images: shot.data.images.slice(0, 1) }
    })

    // 自检：不依赖桌面解锁的那部分 —— 文件读写、显示器、等待、越界拦截。
    // 只在自己写的一个带时间戳的 txt 上做，跑完删掉，不碰用户任何真实文件。
    api.route('/selftest', async () => {
      const steps = []
      const stamp = Date.now()
      const dir = policy.listAllowedDirs()[0]
      const target = join(dir, 'aurabot-selftest-' + stamp + '.txt')
      const content = 'aurabot selftest ' + stamp

      const timed = async (name, fn, { optional = false } = {}) => {
        const started = Date.now()
        let result
        try {
          result = await fn()
        } catch (error) {
          result = { ok: false, message: error.message }
        }
        steps.push({
          name,
          ok: Boolean(result && result.ok),
          optional,
          ms: Date.now() - started,
          detail: String((result && (result.message || result.text)) || '').slice(0, 160),
        })
        return result
      }

      const check = await preflight()
      if (!check.ok) return { ok: false, passed: false, message: check.message, steps }

      const run = (tool, key, args, summary) => perform(tool, key, args, {
        source: 'selftest',
        approved: true,
        summary,
        run: () => actions.file(args),
      })

      await timed('列授权目录', () => actions.file({ mode: 'list', path: dir }))
      await timed('写测试文件', () => run('FileSystem', 'file-write', { mode: 'write', path: target, content, overwrite: true }, '自检写文件'))
      const read = await timed('读回文件', () => actions.file({ mode: 'read', path: target }))
      await timed('文件信息', () => actions.file({ mode: 'info', path: target }))
      await timed('删掉测试文件', () => run('FileSystem', 'file-delete', { mode: 'delete', path: target }, '自检删文件'))
      const afterDelete = await timed('确认已删掉（这步应当失败）', () => actions.file({ mode: 'info', path: target }), { optional: true })
      await timed('读显示器信息', () => desktop.displays())
      await timed('等待 1 秒', () => actions.wait({ duration: 1 }))

      // 越界拦截（纯策略判断，不真的去读）
      const blocked = policy.checkPath('C:/Windows/System32/drivers/etc/hosts')

      const readText = String((read && read.data && read.data.text) || '')
      const latest = tasks.list(1)[0]
      if (latest) tasks.setStatus(latest.id, 'completed', { verified: true })

      const readOk = Boolean(read && read.ok) && readText.includes(content)
      // 删除后 info 可能返回 ok:true 但正文写 Error: Path not found，所以要同时看文本
      const goneText = String((afterDelete && afterDelete.data && afterDelete.data.text) || (afterDelete && afterDelete.message) || '')
      const deleteOk = afterDelete.ok === false || /not found|不存在|找不到/i.test(goneText)
      const guardOk = blocked.ok === false
      const passed = readOk && deleteOk && guardOk

      return {
        ok: passed,
        passed,
        checks: {
          writeAndReadBack: readOk,
          deleted: deleteOk,
          blockedOutsideDirs: guardOk,
        },
        target,
        steps,
        note: passed
          ? '文件链路真跑通了：写 → 读回一致 → 删除 → 确认不在；越界路径也被拦住'
          : '有没通过的项，看 checks 和 steps',
      }
    })

    api.route('/diag', async () => {
      const checks = []
      const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
      push('系统是 Windows', IS_WINDOWS, process.platform)
      push('模块开关', cfg().enabled !== false, cfg().enabled === false ? '关着' : '开')
      push('Aurabot 总开关', api.config().enabled !== false, api.config().enabled === false ? '关着' : '开')
      const probe = await adapter.probe()
      push('Windows-MCP 可执行', probe.installed !== false, probe.exe || '')
      push('MCP 已连接', probe.ok, probe.serverInfo ? 'v' + probe.serverInfo.version : (probe.message || '未连接'))
      push('工具数 > 0', (probe.toolCount || 0) > 0, probe.toolCount || 0)
      const excluded = probe.excluded || []
      push('危险工具已在服务端摘除', ['PowerShell', 'Registry', 'Process'].every((x) => excluded.includes(x)), excluded.join('、') || '（没排除！）')
      const state = await desktop.state()
      push('桌面可读', state.ok, state.ok ? '焦点窗口：' + (state.data.parsed.focusedWindow || '（空）') : state.message)
      const lock = state.ok ? state.data.parsed.lock : 'unknown'
      const reallyLocked = lock === 'lock' || lock === 'secure-desktop'
      push('桌面可交互', state.ok && !reallyLocked,
        reallyLocked ? '锁屏/安全桌面（' + lock + '），动作会被拒绝'
          : (lock === 'no-window' ? '没读到窗口列表（后端 Snapshot 可能超时），动作照常可试' : '正常'))
      const dirs = policy.listAllowedDirs()
      push('授权目录已配置', dirs.length > 0, dirs.join(' / '))
      return { ok: checks.every((c) => c.ok), checks, lock }
    })

    api.route('/windows', async () => {
      const state = await desktop.state()
      if (!state.ok) return { ok: false, message: state.message }
      return { ok: true, focused: state.data.parsed.focusedWindow, opened: state.data.parsed.opened, displays: state.data.parsed.displays, lock: state.data.parsed.lock }
    })

    api.route('/approve', async (req) => {
      const payload = await body(req)
      return approve(String(payload.id || ''))
    })

    api.route('/reject', async (req) => {
      const payload = await body(req)
      return reject(String(payload.id || ''))
    })

    api.route('/cancel', async () => {
      const n = pendingApproval.size
      pendingApproval.clear()
      const count = tasks.cancelAll('面板取消')
      return { ok: true, message: '已取消（待确认 ' + n + '，任务 ' + count + '）' }
    })

    api.route('/pause', async (req) => {
      const payload = await body(req)
      api.saveSettings({ paused: Boolean(payload.paused) })
      return { ok: true, message: payload.paused ? '已暂停' : '已恢复' }
    })

    api.route('/restart', async () => {
      adapter.stop()
      const probe = await adapter.probe()
      return { ok: Boolean(probe.ok), message: probe.ok ? '后端已重启' : (probe.message || '重启失败') }
    })

    api.route('/tasks', async () => ({ ok: true, tasks: tasks.list(20) }))

    api.onDispose(() => {
      pendingApproval.clear()
      adapter.stop()
      tasks.cancelAll('模块卸载')
      log.info('[Windows] 扩展已停止')
    })

    log.info('[Windows] 扩展已加载 v1.0.0（' + (IS_WINDOWS ? 'Windows' : '非 Windows：只显示不支持') + '）')

    return {
      probe: () => adapter.probe(),
      state: () => desktop.state(),
      tasks: () => tasks.list(20),
      cancel: (reason) => { pendingApproval.clear(); return tasks.cancelAll(reason || '外部取消') },
      stop: () => adapter.stop(),
      platform: process.platform,
      supported: IS_WINDOWS,
    }
  },
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(5000, ms))))

function describe(tool, args) {
  if (tool === 'App') return (args.mode === 'launch' ? '启动应用' : '切换窗口') + '「' + (args.name || '') + '」'
  if (tool === 'FileSystem') return '文件操作 ' + (args.mode || '') + '：' + String(args.path || '').slice(0, 60)
  if (tool === 'Shortcut') return '快捷键 ' + (args.shortcut || '')
  if (tool === 'Click') return '点击 ' + (args.loc ? args.loc.join(',') : '#' + args.label)
  if (tool === 'Type') return '输入文字'
  return tool
}