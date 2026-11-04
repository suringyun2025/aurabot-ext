const { useState, useEffect, useRef } = React

return function BrowserControlPanel({ settings, draftSettings, setSettings, toast }) {
  const cfg = draftSettings || settings || {}
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [tabs, setTabs] = useState([])
  const [snapshot, setSnapshot] = useState('')
  const [shot, setShot] = useState('')
  const [url, setUrl] = useState('')
  const [diag, setDiag] = useState(null)
  const [selfTest, setSelfTest] = useState(null)
  const timer = useRef(null)

  const change = (patch) => (setSettings ? setSettings(patch) : toast('这个面板不支持保存设置'))
  const refresh = async () => {
    try { setState(await call('/state')) } catch (error) { /* 面板刷新失败不打断 */ }
  }
  useEffect(() => {
    refresh()
    // 顺手拉一次标签页，面板一打开就能看到现在开了哪些
    call('/tabs').then((out) => {
      if (out && out.ok) setTabs((out.data && out.data.tabs) || [])
    }).catch(() => {})
    timer.current = setInterval(() => { refresh().catch(() => {}) }, 15000)
    return () => clearInterval(timer.current)
  }, [])

  const act = async (label, path, body, okText) => {
    setBusy(label)
    try {
      const out = await call(path, body)
      if (out && out.message) toast(out.message, out.ok === false ? 'err' : 'ok')
      else if (okText) toast(okText, 'ok')
      await refresh()
      return out
    } catch (error) {
      toast(error.message, 'err')
      return { ok: false, message: error.message }
    } finally {
      setBusy('')
    }
  }

  const num = (key, min, max) => h('input', {
    className: 'ab-input', type: 'number', min, max, value: cfg[key] ?? 0,
    onChange: (e) => change({ [key]: Number(e.target.value) }), style: { width: 96 },
  })
  const txt = (key, placeholder) => h('input', {
    className: 'ab-input', value: cfg[key] || '', placeholder,
    onChange: (e) => change({ [key]: e.target.value }),
  })
  const area = (key, placeholder, rows) => h('textarea', {
    className: 'ab-input', rows: rows || 2, value: cfg[key] || '', placeholder,
    onChange: (e) => change({ [key]: e.target.value }),
  })
  const saveHint = h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '改完记得点面板底部的「保存设置」。')

  const egoOk = state?.ego?.ok
  const pwOk = state?.playwright?.ok
  const pendingCount = state?.pending?.length || 0

  return h('div', { className: 'ab-grid' },
    // ---------------------------------------------------------------- 总状态
    h(ui.Card, {
      title: '浏览器操控',
      desc: '让大肥鱼真的操作浏览器：打开网页、点击、输入、读内容、截图。默认用 ego-browser，直接复用你 ego lite 里的登录态。',
      right: h('span', { className: 'ab-small', style: { color: egoOk ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
        egoOk ? '后端可用' : '后端不可用'),
    },
      h(ui.Row, { label: '功能开关', hint: '关掉后工具、命令和面板操作都不执行' },
        h(ui.Switch, { on: cfg.enabled !== false, onChange: (v) => change({ enabled: v }) })),
      h(ui.Row, { label: '试运行', hint: '开着时只读页面，不点击、不输入、不下载' },
        h(ui.Switch, { on: Boolean(cfg.dryRun), onChange: (v) => change({ dryRun: v }) })),
      h(ui.Row, { label: '高风险要确认', hint: '支付、下单、发布、发送、删除这类动作必须你在这里点确认' },
        h(ui.Switch, { on: cfg.confirmHighRisk !== false, onChange: (v) => change({ confirmHighRisk: v }) })),
      h(ui.Row, { label: '任务空间' },
        h('span', { className: 'ab-small' },
          state?.space?.spaceId ? '#' + state.space.spaceId + '（复用中）' : '还没创建，第一次操作会自动建')),
      h(ui.Row, { label: '当前状态' },
        h('span', { className: 'ab-small' },
          (state?.configEnabled === false ? 'Aurabot 总开关关着 · ' : '')
          + (state?.space?.lastError ? '最近错误：' + String(state.space.lastError).slice(0, 60) : '正常'))),
      state?.space?.lastError ? h('div', { className: 'ab-note', style: { marginTop: 6, color: 'var(--ab-warn)' } },
        String(state.space.lastError).slice(0, 300)) : null,
      h('div', { className: 'ab-flex', style: { marginTop: 8, flexWrap: 'wrap', gap: 8 } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('probe', '/probe', {}, '探测完成') }, '重新探测'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          const out = await act('tabs', '/tabs')
          if (out && out.ok) setTabs((out.data && out.data.tabs) || [])
        } }, '刷新标签页'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('reset', '/reset', {}, '已重置任务空间') }, '重置任务空间'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('cancel', '/cancel', {}, '已取消') }, '取消进行中的任务'),
      ),
      saveHint,
    ),

    // ---------------------------------------------------------------- 后端
    h(ui.Card, {
      title: '后端',
      desc: 'ego-browser 连的是你自己的 ego lite，登录态天然共享；Playwright MCP 是独立浏览器实例，登录态不通用（切换后端不会帮你迁移会话）。',
    },
      h(ui.Row, { label: '用哪个' },
        h(ui.Select, {
          value: cfg.backend || 'ego-browser',
          onChange: (e) => change({ backend: e.target.value }),
          options: [
            { value: 'ego-browser', label: 'ego-browser（推荐）' },
            { value: 'playwright-mcp', label: 'Playwright MCP（备用）' },
          ],
        })),
      h(ui.Row, { label: 'ego-browser 状态' },
        h('span', { className: 'ab-small', style: { color: egoOk ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
          egoOk ? '可用 · ' + (state?.ego?.spaces?.length || 0) + ' 个任务空间' : (state?.ego?.message || '未探测'))),
      h(ui.Row, { label: 'ego-browser 路径', hint: '留空自动找（Citro Labs 默认安装位置）' }, txt('egoBinary', '可选：ego-browser.exe 完整路径')),
      h(ui.Row, { label: 'Playwright MCP 状态' },
        h('span', { className: 'ab-small', style: { color: pwOk ? 'var(--ab-ok)' : 'var(--ab-muted)' } },
          pwOk ? '可用' : (state?.playwright?.message || '未配置'))),
      h(ui.Row, { label: 'Playwright MCP 命令', hint: '装好后填，例如 npx @playwright/mcp@latest --headless' },
        txt('playwrightMcpCommand', 'npx @playwright/mcp@latest --headless')),
      state?.playwright?.hint ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, '安装：' + state.playwright.hint) : null,
      saveHint,
    ),

    // ---------------------------------------------------------------- 待确认
    pendingCount ? h(ui.Card, {
      title: '等你确认（' + pendingCount + '）',
      desc: '这些是高风险管理操作。确认之前不会执行；模型自己说"已经确认"不算数。',
    },
      (state.pending || []).map((item) => h('div', {
        key: item.id,
        className: 'ab-flex',
        style: { padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'center' },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', null, item.summary || item.action),
          h('div', { className: 'ab-small ab-muted' }, '来源 ' + item.source + ' · ' + new Date(item.at).toLocaleTimeString('zh-CN'))),
        h(ui.Btn, { small: true, kind: 'primary', disabled: Boolean(busy), onClick: () => act('approve', '/approve', { id: item.id }) }, '确认执行'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('reject', '/reject', { id: item.id }) }, '拒绝'),
      )),
    ) : null,

    // ---------------------------------------------------------------- 标签页
    h(ui.Card, {
      title: '标签页与页面',
      desc: '大肥鱼操作的就是这里列出来的页面。截图会存到模块数据目录，不会上传。',
    },
      h(ui.Row, { label: '打开网址' },
        h('input', { className: 'ab-input', value: url, placeholder: 'https://…', onChange: (e) => setUrl(e.target.value) }),
        h(ui.Btn, {
          small: true, disabled: Boolean(busy) || !url.trim(),
          onClick: async () => {
            const out = await act('open', '/open', { url: url.trim() })
            if (out?.ok) setUrl('')
          },
        }, '打开')),
      h('div', { className: 'ab-flex', style: { marginTop: 6, gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('snap')
          try {
            const out = await call('/snapshot')
            if (out.ok) setSnapshot(String(out.data?.snapshot || ''))
            toast(out.ok ? '已读取页面快照' : (out.message || '读不到'), out.ok ? 'ok' : 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '读页面快照'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('shot')
          try {
            const out = await call('/screenshot', {})
            if (out.ok) {
              const path = out.data?.saved || ''
              const data = await call('/shot-data', { path })
              if (data.ok) setShot('data:' + data.mime + ';base64,' + data.base64)
              toast('截图：' + path, 'ok')
            } else toast(out.message || '截图失败', 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '截一张图'),
      ),
      h('div', { style: { marginTop: 8 } },
        tabs.length
          ? tabs.map((tab, i) => h('div', { key: tab.label + i, className: 'ab-small', style: { padding: '3px 0' } },
            '[' + tab.label + '] ' + (tab.title || '') + ' — ' + String(tab.url || '').slice(0, 80)))
          : h('div', { className: 'ab-small ab-muted' }, '还没读到标签页，点上面「刷新标签页」')),
      shot ? h('div', { style: { marginTop: 8 } },
        h('img', { src: shot, alt: '页面截图', style: { maxWidth: '100%', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)' } })) : null,
      snapshot ? h('pre', {
        className: 'ab-small',
        style: { marginTop: 8, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      }, snapshot.slice(0, 8000)) : null,
    ),

    // ---------------------------------------------------------------- 权限
    h(ui.Card, {
      title: '权限与范围',
      desc: '默认不限制域名；填了「允许的域名」就只放行这些。禁止名单优先级更高。',
    },
      h(ui.Row, { label: '允许的域名', hint: '一行一个；留空 = 不限制' }, area('allowDomains', 'xiaohongshu.com\ngithub.com')),
      h(ui.Row, { label: '禁止的域名', hint: '一行一个；命中就拒绝打开' }, area('denyDomains', '例如：bank.example.com')),
      h(ui.Row, { label: '快照最多返回' }, num('maxSnapshotChars', 500, 40000), h('span', { className: 'ab-muted' }, '字')),
      h(ui.Row, { label: '单个动作超时' }, num('defaultTimeoutSec', 10, 180), h('span', { className: 'ab-muted' }, '秒')),
      h(ui.Row, { label: '动作后自动读页面' },
        h(ui.Switch, { on: cfg.readAfterAction !== false, onChange: (v) => change({ readAfterAction: v }) })),
      h(ui.Row, { label: '截图目录', hint: '留空用模块数据目录下的 shots' }, txt('screenshotDir', '可选：D:\\\\shots')),
      saveHint,
    ),

    // ---------------------------------------------------------------- 诊断
    h(ui.Card, {
      title: '诊断与自检',
      desc: '后端连不上、动作没效果的时候先跑这两个。自检会自己开一个临时空间，跑完就收，不碰你正在用的页面。',
    },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('diag')
          try { setDiag(await call('/diag')) } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '跑诊断'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('selftest')
          try {
            const out = await call('/selftest')
            setSelfTest(out)
            toast(out.passed ? '自检通过：填字和点击都是真的' : (out.note || out.message || '自检没通过'), out.passed ? 'ok' : 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '跑自检（填字+点击）'),
      ),
      diag && diag.checks ? h('div', { style: { marginTop: 8 } },
        h('div', { className: 'ab-small', style: { color: diag.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
          diag.ok ? '诊断全部通过' : '有没通过的项，看下面'),
        diag.checks.map((c, i) => h('div', { key: i, className: 'ab-small', style: { padding: '2px 0' } },
          (c.ok ? '✓ ' : '✗ ') + c.name + (c.detail ? '：' + c.detail : '')))) : null,
      selfTest ? h('div', { style: { marginTop: 8 } },
        h('div', { className: 'ab-small', style: { color: selfTest.passed ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
          selfTest.note || (selfTest.passed ? '自检通过' : '自检未通过')),
        h('div', { className: 'ab-small ab-muted' },
          '输入读回：' + (selfTest.value || '（空）') + ' · 点击后 title：' + (selfTest.title || '（空）')),
        (selfTest.steps || []).map((s, i) => h('div', { key: i, className: 'ab-small', style: { padding: '1px 0' } },
          (s.ok ? '✓ ' : '✗ ') + s.action + ' (' + s.ms + 'ms)' + (s.error ? '：' + s.error : '')))) : null,
    ),

    // ---------------------------------------------------------------- 任务
    h(ui.Card, {
      title: '最近任务',
      desc: '每次浏览器动作都会记下来，失败会写明原因。她说的"做完了"，以这里的记录为准。',
    },
      (state?.tasks || []).length ? (state.tasks || []).map((task) => h('div', {
        key: task.id,
        style: { padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)' },
      },
        h('div', { className: 'ab-flex', style: { justifyContent: 'space-between' } },
          h('span', { className: 'ab-small' }, '#' + task.id + ' · ' + task.source + ' · ' + task.steps + ' 步'),
          h('span', {
            className: 'ab-small',
            style: { color: task.status === 'completed' ? 'var(--ab-ok)' : task.status === 'failed' ? 'var(--ab-err)' : 'var(--ab-warn)' },
          }, task.status)),
        task.lastSteps && task.lastSteps.length
          ? h('div', { className: 'ab-small ab-muted' }, task.lastSteps.map((s) => (s.ok ? '✓' : '✗') + ' ' + s.action).join('  '))
          : null,
        task.error ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, String(task.error).slice(0, 200)) : null,
      )) : h('div', { className: 'ab-small ab-muted' }, '还没有任务记录。'),
    ),
  )
}