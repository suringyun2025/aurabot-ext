const { useState, useEffect, useRef } = React

return function WindowsControlPanel({ settings, draftSettings, setSettings, toast }) {
  const cfg = draftSettings || settings || {}
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [snapshot, setSnapshot] = useState('')
  const [shot, setShot] = useState('')
  const [selfTest, setSelfTest] = useState(null)
  const [desktop, setDesktop] = useState(null)
  const timer = useRef(null)

  const change = (patch) => (setSettings ? setSettings(patch) : toast('这个面板不支持保存设置'))
  const refresh = async () => {
    try { setState(await call('/state')) } catch (error) { /* ignore */ }
  }
  const loadDesktop = async () => {
    try {
      const out = await call('/windows')
      if (out && out.ok) setDesktop(out)
    } catch (error) { /* 读不到桌面不打断面板 */ }
  }
  useEffect(() => {
    refresh()
    loadDesktop()
    timer.current = setInterval(() => { refresh().catch(() => {}) }, 15000)
    return () => clearInterval(timer.current)
  }, [])

  const act = async (label, path, body) => {
    setBusy(label)
    try {
      const out = await call(path, body)
      if (out && out.message) toast(String(out.message).slice(0, 200), out.ok === false ? 'err' : 'ok')
      await refresh()
      return out
    } catch (error) {
      toast(error.message, 'err')
      return { ok: false, message: error.message }
    } finally {
      setBusy('')
    }
  }

  const txt = (key, placeholder) => h('input', {
    className: 'ab-input', value: cfg[key] || '', placeholder,
    onChange: (e) => change({ [key]: e.target.value }),
  })
  const num = (key, min, max) => h('input', {
    className: 'ab-input', type: 'number', min, max, value: cfg[key] ?? 0,
    onChange: (e) => change({ [key]: Number(e.target.value) }), style: { width: 96 },
  })
  const saveHint = h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '改完记得点面板底部的「保存设置」。')

  const supported = state?.supported !== false
  const backend = state?.backend || {}
  const pending = state?.pending || []

  return h('div', { className: 'ab-grid' },
    // ---------------------------------------------------------------- 总状态
    h(ui.Card, {
      title: 'Windows 电脑操控',
      desc: '让大肥鱼在你的电脑上真的动手：看屏幕、开应用、切窗口、点击、输入、快捷键、在授权目录里读写文件。底层走 Windows-MCP。',
      right: h('span', { className: 'ab-small', style: { color: supported ? (backend.probed ? 'var(--ab-ok)' : 'var(--ab-warn)') : 'var(--ab-err)' } },
        supported ? (backend.probed ? '后端在线' : '后端未连上') : '不支持当前系统'),
    },
      !supported ? h('div', { className: 'ab-note', style: { color: 'var(--ab-err)' } },
        '当前系统是 ' + (state?.platform || process?.platform || '未知') + '，这个模块只在 Windows 10/11 上工作，工具不会注册。') : null,
      h(ui.Row, { label: '功能开关', hint: '关掉后工具、命令、面板动作都不执行' },
        h(ui.Switch, { on: cfg.enabled !== false, onChange: (v) => change({ enabled: v }) })),
      h(ui.Row, { label: '暂停', hint: '临时冻结：不出手，但不清配置' },
        h(ui.Switch, { on: Boolean(cfg.paused), onChange: (v) => { change({ paused: v }); call('/pause', { paused: v }).catch(() => {}) } })),
      h(ui.Row, { label: '试运行', hint: '开着时只读屏幕，不点击、不输入、不动文件' },
        h(ui.Switch, { on: Boolean(cfg.dryRun), onChange: (v) => change({ dryRun: v }) })),
      h(ui.Row, { label: '高风险要确认', hint: '启动应用、写/删文件、危险快捷键必须你在这里确认' },
        h(ui.Switch, { on: cfg.confirmHighRisk !== false, onChange: (v) => change({ confirmHighRisk: v }) })),
      h(ui.Row, { label: '当前焦点窗口' },
        h('span', { className: 'ab-small' },
          !state?.backend?.probed ? '—'
            : desktop?.lock ? '锁屏 / 无交互桌面（' + desktop.lock + '）'
              : (desktop?.focused || '还没读到')),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: loadDesktop }, '刷新')),
      desktop && desktop.opened && desktop.opened.length && desktop.opened[0] !== 'No windows found'
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
          '已开窗口：' + desktop.opened.slice(0, 5).join(' · '))
        : null,
      h('div', { className: 'ab-flex', style: { marginTop: 8, flexWrap: 'wrap', gap: 8 } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('probe')
          try {
            const out = await call('/probe')
            toast(out.ok ? '后端连上了' : (out.message || '连不上'), out.ok ? 'ok' : 'err')
            await refresh()
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '连接/探测后端'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('restart', '/restart', {}) }, '重启后端'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('cancel', '/cancel', {}) }, '取消全部'),
      ),
      saveHint,
    ),

    // ---------------------------------------------------------------- 后端
    h(ui.Card, {
      title: '后端（Windows-MCP）',
      desc: 'PowerShell / Registry / Process 这几个工具在服务端就被摘掉了，面板里也打不开——这是硬限制，不是靠提示词约束。',
    },
      h(ui.Row, { label: '安装状态' },
        h('span', { className: 'ab-small', style: { color: backend.installed ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
          backend.installed ? '已安装' + (backend.serverInfo?.version ? ' · v' + backend.serverInfo.version : '') : '没找到')),
      h(ui.Row, { label: '运行状态' },
        h('span', { className: 'ab-small' }, backend.ready ? '已连接 · ' + (backend.toolCount || 0) + ' 个工具' : (backend.message || '未连接'))),
      h(ui.Row, { label: '已排除的工具' },
        h('span', { className: 'ab-small ab-muted' }, (backend.excluded || ['PowerShell', 'Registry', 'Process']).join('、'))),
      h(ui.Row, { label: '可执行文件路径', hint: '留空用 uv 装好的默认路径' }, txt('windowsMcpPath', 'C:\\\\…\\\\windows-mcp.exe')),
      h(ui.Row, { label: '允许用 Scrape 抓网页', hint: '它相当于一个网页抓取工具；默认关' },
        h(ui.Switch, { on: Boolean(cfg.allowScrape), onChange: (v) => change({ allowScrape: v }) })),
      saveHint,
    ),

    // ---------------------------------------------------------------- 待确认
    pending.length ? h(ui.Card, {
      title: '等你确认（' + pending.length + '）',
      desc: '高风险动作。确认前不会执行；模型自己说"已确认"不算。',
    },
      pending.map((item) => h('div', {
        key: item.id,
        className: 'ab-flex',
        style: { padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'center' },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', null, item.summary || item.tool),
          h('div', { className: 'ab-small ab-muted' }, '来源 ' + item.source + ' · ' + new Date(item.at).toLocaleTimeString('zh-CN'))),
        h(ui.Btn, { small: true, kind: 'primary', disabled: Boolean(busy), onClick: () => act('approve', '/approve', { id: item.id }) }, '确认执行'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('reject', '/reject', { id: item.id }) }, '拒绝'),
      )),
    ) : null,

    // ---------------------------------------------------------------- 看屏幕
    h(ui.Card, {
      title: '看屏幕',
      desc: '快照带可点击元素编号（label），点击时用编号比坐标稳。截图只在本地面板里显示。',
    },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('snap')
          try {
            const out = await call('/snapshot')
            if (out.ok) { setSnapshot(String(out.message || '')); toast('已取桌面快照', 'ok') }
            else toast(out.message || '取不到快照', 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '取桌面快照'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('shot')
          try {
            const out = await call('/screen')
            if (out.ok && out.images && out.images.length) {
              setShot('data:' + (out.images[0].mime || 'image/png') + ';base64,' + out.images[0].data)
              toast('截图好了', 'ok')
            } else toast(out.message || '截图失败', 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '截一张屏'),
      ),
      shot ? h('div', { style: { marginTop: 8 } },
        h('img', { src: shot, alt: '桌面截图', style: { maxWidth: '100%', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)' } })) : null,
      snapshot ? h('pre', {
        className: 'ab-small',
        style: { marginTop: 8, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      }, snapshot.slice(0, 8000)) : null,
    ),

    // ---------------------------------------------------------------- 自检
    h(ui.Card, {
      title: '自检',
      desc: '不依赖你解锁桌面：在桌面目录里写一个临时 txt → 读回比对 → 删掉 → 确认不在；顺带验证越界路径会被拦。',
    },
      h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
        setBusy('selftest')
        try {
          const out = await call('/selftest')
          setSelfTest(out)
          toast(out.passed ? '自检通过：文件读写链路是通的' : (out.note || out.message || '自检没通过'), out.passed ? 'ok' : 'err')
        } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
      } }, '跑自检（文件链路）'),
      selfTest ? h('div', { style: { marginTop: 8 } },
        h('div', { className: 'ab-small', style: { color: selfTest.passed ? 'var(--ab-ok)' : 'var(--ab-warn)' } },
          selfTest.note || (selfTest.passed ? '自检通过' : '自检未通过')),
        selfTest.checks ? h('div', { className: 'ab-small ab-muted' },
          '写读一致：' + (selfTest.checks.writeAndReadBack ? '是' : '否')
          + ' · 删除成功：' + (selfTest.checks.deleted ? '是' : '否')
          + ' · 越界拦截：' + (selfTest.checks.blockedOutsideDirs ? '是' : '否')) : null,
        (selfTest.steps || []).map((s, i) => h('div', { key: i, className: 'ab-small', style: { padding: '1px 0' } },
          (s.ok ? '✓ ' : '✗ ') + s.name + ' (' + s.ms + 'ms)'))) : null,
    ),

    // ---------------------------------------------------------------- 权限
    h(ui.Card, {
      title: '授权范围',
      desc: '文件操作只能落在下面这些目录里。默认桌面 / 下载 / 文档 / 图片。',
    },
      h(ui.Row, { label: '授权目录', hint: '一行一个绝对路径，会追加到默认四个目录' },
        h('textarea', {
          className: 'ab-input', rows: 3, value: cfg.allowedDirs || '',
          placeholder: 'D:\\\\项目\nD:\\\\临时',
          onChange: (e) => change({ allowedDirs: e.target.value }),
        })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } },
        '现在生效：' + ((state?.allowedDirs || []).join(' / ') || '（还没读到）')),
      h(ui.Row, { label: '允许任意路径', hint: '⚠ 会让文件操作跑出授权目录，默认关' },
        h(ui.Switch, { on: Boolean(cfg.allowAnyPath), onChange: (v) => change({ allowAnyPath: v }) })),
      h(ui.Row, { label: '允许启动应用', hint: '关掉后 App(launch) 一律拒绝' },
        h(ui.Switch, { on: cfg.allowStartApps !== false, onChange: (v) => change({ allowStartApps: v }) })),
      h(ui.Row, { label: '快照最多返回' }, num('maxSnapshotChars', 1000, 20000), h('span', { className: 'ab-muted' }, '字')),
      h(ui.Row, { label: '每步之间停' }, num('actionPauseMs', 0, 3000), h('span', { className: 'ab-muted' }, '毫秒（给界面留反应时间）')),
      saveHint,
    ),

    // ---------------------------------------------------------------- 任务
    h(ui.Card, {
      title: '最近操作',
      desc: '每次桌面动作都记在这里，失败写明原因。',
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
      )) : h('div', { className: 'ab-small ab-muted' }, '还没有操作记录。'),
    ),
  )
}