const { useState, useEffect, useRef } = React

return function XiaohongshuPanel({ settings, draftSettings, setSettings, toast, reload }) {
  const cfg = draftSettings || settings || {}
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [qr, setQr] = useState('')
  const [cookie, setCookie] = useState({ a1: '', web_session: '', webId: '', websect: '', gid: '', extra: '' })
  const [result, setResult] = useState(null)
  const [resultTitle, setResultTitle] = useState('')
  const [query, setQuery] = useState('')
  const [feeds, setFeeds] = useState([])
  const [shareUrl, setShareUrl] = useState('')
  const [shareTitle, setShareTitle] = useState('')
  const [feedId, setFeedId] = useState('')
  const [token, setToken] = useState('')
  const [chats, setChats] = useState(null)
  const [thread, setThread] = useState(null)
  const [shots, setShots] = useState([])
  const [shotsBusy, setShotsBusy] = useState(false)
  const timer = useRef(null)

  const change = (patch) => (setSettings ? setSettings(patch) : toast('这个面板不支持保存设置'))
  const refresh = async () => {
    try { setState(await call('/state')) } catch (error) { toast(error.message) }
  }
  useEffect(() => {
    refresh()
    timer.current = setInterval(() => { refresh().catch(() => {}) }, 20000)
    return () => clearInterval(timer.current)
  }, [])
  useEffect(() => { loadShots().catch(() => {}) }, [])

  const loadShots = async () => {
    setShotsBusy(true)
    try {
      const out = await call('/shots')
      setShots(Array.isArray(out && out.items) ? out.items : [])
    } catch (error) { /* 读不到就先空着 */ }
    finally { setShotsBusy(false) }
  }

  const act = async (label, path, body, title) => {
    setBusy(label)
    try {
      const out = await call(path, body)
      if (title) { setResultTitle(title); setResult(out) }
      if (out && out.message) toast(out.message, out.ok === false ? 'err' : 'ok')
      await refresh()
      return out
    } catch (error) {
      toast(error.message, 'err')
      return { ok: false, message: error.message }
    } finally {
      setBusy('')
    }
  }

  const number = (key, min, max, step) => h('input', {
    className: 'ab-input', type: 'number', min, max, step: step || 1,
    value: cfg[key] ?? 0,
    onChange: (e) => change({ [key]: Number(e.target.value) }),
    style: { width: 96 },
  })
  const text = (key, placeholder) => h('input', {
    className: 'ab-input', value: cfg[key] || '', placeholder,
    onChange: (e) => change({ [key]: e.target.value }),
  })
  const area = (key, placeholder) => h('textarea', {
    className: 'ab-input', rows: 2, value: cfg[key] || '', placeholder,
    onChange: (e) => change({ [key]: e.target.value }),
  })
  const saveHint = h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '改完设置记得点面板底部的「保存设置」。')

  const loginState = state?.loggedIn === 'loggedIn'
    ? { text: '已登录', color: 'var(--ab-ok)' }
    : state?.loggedIn === 'loggedOut'
      ? { text: '未登录', color: 'var(--ab-warn)' }
      : { text: '还没检查', color: 'var(--ab-sub)' }

  const startScan = async () => {
    setBusy('qr')
    try {
      const out = await call('/qrcode')
      setQr(out.qrcode || '')
      toast(out.message || '', out.ok ? 'ok' : 'err')
      if (out.loggedIn) { await refresh(); return }
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      setBusy('')
    }
    if (!qr) { /* 二维码没出来时下方还有「打开登录窗口」可用 */ }
    setBusy('wait')
    try {
      const waited = await call('/qrcode-wait', { seconds: 75 })
      toast(waited.message || '', waited.ok ? 'ok' : 'err')
      if (waited.ok) setQr('')
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      setBusy('')
      await refresh()
    }
  }

  const importCookie = async () => {
    const parts = []
    for (const key of ['a1', 'web_session', 'webId', 'websect', 'gid']) {
      const value = String(cookie[key] || '').trim()
      if (value) parts.push(key + '=' + value)
    }
    const extra = String(cookie.extra || '').trim()
    if (extra) parts.push(extra)
    if (!parts.length) return toast('至少填一个 Cookie 字段')
    const out = await act('cookie', '/cookie', { cookie: parts.join('; ') }, 'Cookie 导入')
    if (out.ok) setCookie({ a1: '', web_session: '', webId: '', websect: '', gid: '', extra: '' })
  }

  const renderDraft = (draft) => {
    if (!draft) return h('div', { className: 'ab-small ab-muted' }, '还没有待确认的草稿。')
    const opName = { comment: '评论笔记', reply: '回复评论', publish: '发布笔记' }[draft.op] || draft.op
    return h('div', { className: 'ab-note', style: { marginTop: 8 } },
      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '待确认：' + opName),
      draft.title ? h('div', null, '标题：' + draft.title) : null,
      draft.feedId ? h('div', { className: 'ab-small ab-muted' }, '目标笔记：' + draft.feedId) : null,
      draft.commentId ? h('div', { className: 'ab-small ab-muted' }, '目标评论：' + draft.commentId) : null,
      h('div', { style: { whiteSpace: 'pre-wrap', margin: '6px 0' } }, draft.content),
      draft.images && draft.images.length ? h('div', { className: 'ab-small' }, '图片：' + draft.images.join('、')) : null,
      draft.video ? h('div', { className: 'ab-small' }, '视频：' + draft.video) : null,
      h('div', { className: 'ab-flex', style: { marginTop: 6 } },
        h(ui.Btn, {
          small: true, kind: 'primary', disabled: busy === 'approve',
          onClick: async () => {
            setBusy('approve')
            try {
              const out = await call('/approve', { id: draft.id })
              toast(out.message || '', out.ok ? 'ok' : 'err')
              setResultTitle('执行结果'); setResult(out)
            } catch (error) { toast(error.message, 'err') } finally { setBusy(''); await refresh() }
          },
        }, '确认并执行'),
        h(ui.Btn, { small: true, onClick: () => act('discard', '/discard', { id: draft.id }) }, '丢弃'),
      ),
    )
  }

  const drafts = state?.drafts || []

  return h('div', { className: 'ab-grid' },
    // ---------------------------------------------------------------- 登录
    h(ui.Card, {
      title: '小红书登录',
      desc: '插件用一台专用浏览器保存登录状态，凭据只留在本机，不回显、不进聊天和模型上下文。推荐扫码：二维码会显示在这里，用小红书 App 扫一下就行。',
      right: h('span', { className: 'ab-small', style: { color: loginState.color } }, loginState.text),
    },
      h(ui.Row, { label: '功能开关', hint: '关掉后工具、定时任务和面板操作都不再执行' },
        h(ui.Switch, { on: cfg.enabled !== false, onChange: (v) => change({ enabled: v }) })),
      h(ui.Row, { label: '账号' },
        h('span', null, state?.account?.nickname ? state.account.nickname + '（' + state.account.userId + '）' : '还没识别到，登录后点一次「检查登录」')),
      h(ui.Row, { label: '登录状态' }, h('span', { className: 'ab-small' }, state?.last || '还没跑过')),
      qr ? h('div', { style: { padding: '8px 0' } },
        h('img', { src: qr, alt: '登录二维码', style: { width: 200, height: 200, background: '#fff', borderRadius: 8 } }),
        h('div', { className: 'ab-small ab-muted' }, '用小红书 App 扫这张码；扫完会自动检查登录，也会保持 75 秒等待。')) : null,
      h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 8, marginTop: 6 } },
        h(ui.Btn, { small: true, kind: 'primary', disabled: busy === 'qr' || busy === 'wait', onClick: startScan },
          busy === 'qr' ? '正在取二维码…' : busy === 'wait' ? '等你扫码…' : '扫码登录'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('open', '/login', {}, '打开登录窗口') }, '打开登录窗口'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('status', '/status', {}, '登录检查') }, '检查登录'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('logout', '/logout', {}, '退出登录') }, '退出登录'),
      ),
      h('div', { style: { marginTop: 10 } },
        h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '备用方式：分项填 Cookie（导入会替换专用浏览器的会话）'),
        h(ui.Row, { label: 'a1' }, h('input', { className: 'ab-input', type: 'password', value: cookie.a1, onChange: (e) => setCookie({ ...cookie, a1: e.target.value }) })),
        h(ui.Row, { label: 'web_session', hint: '必填，这是主要的登录凭据' }, h('input', { className: 'ab-input', type: 'password', value: cookie.web_session, onChange: (e) => setCookie({ ...cookie, web_session: e.target.value }) })),
        h(ui.Row, { label: 'webId' }, h('input', { className: 'ab-input', type: 'password', value: cookie.webId, onChange: (e) => setCookie({ ...cookie, webId: e.target.value }) })),
        h(ui.Row, { label: 'websect' }, h('input', { className: 'ab-input', type: 'password', value: cookie.websect, onChange: (e) => setCookie({ ...cookie, websect: e.target.value }) })),
        h(ui.Row, { label: 'gid' }, h('input', { className: 'ab-input', type: 'password', value: cookie.gid, onChange: (e) => setCookie({ ...cookie, gid: e.target.value }) })),
        h(ui.Row, { label: '其他', hint: '可选：name=value; name2=value2' }, h('input', { className: 'ab-input', value: cookie.extra, onChange: (e) => setCookie({ ...cookie, extra: e.target.value }) })),
        h('div', { className: 'ab-flex', style: { marginTop: 6 } },
          h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: importCookie }, '导入 Cookie')),
      ),
      state?.dryRun ? h('div', { className: 'ab-note', style: { marginTop: 8 } }, 'Aurabot 正在试运行：读取类操作照常，发送消息 / 评论 / 私信 / 发布都不会真的执行。') : null,
      state?.loggedIn === 'loggedOut' ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
        '现在没登录。浏览和分享仍然会去试（拿得到就发链接给你），但小红书在未登录时多数页面直接给登录墙，试不通会照实写原因，不会假装刷到了。') : null,
      state?.configEnabled === false ? h('div', { className: 'ab-note', style: { marginTop: 8, color: 'var(--ab-warn)' } }, 'Aurabot 总开关是关的，小红书不会自己动。') : null,
    ),

    // ---------------------------------------------------------------- 运行情况
    h(ui.Card, { title: '运行情况', desc: '这里都是真实执行结果；失败会照实写，不会把“点过”当成“成功”。' },
      h(ui.Row, { label: '最近一次' }, h('span', { className: 'ab-small', style: { whiteSpace: 'pre-wrap' } }, state?.last || '还没跑过')),
      h(ui.Row, { label: '今日统计' },
        h('span', { className: 'ab-small' },
          '分享 ' + (state?.stats?.sharesToday ?? 0) + ' · 评论回复 ' + (state?.stats?.repliesToday ?? 0) + ' · 私信回复 ' + (state?.stats?.dmsToday ?? 0))),
      h(ui.Row, { label: '自动回复状态' },
        h('span', { className: 'ab-small' },
          (state?.stats?.replyBaseline ? '评论已建基线' : '评论未建基线')
          + ' · ' + (state?.stats?.replyPaused ? '评论今天已暂停' : '评论正常')
          + ' · ' + (state?.stats?.dmPaused ? '私信今天已暂停' : '私信正常'))),
      h('div', { className: 'ab-flex', style: { marginTop: 6 } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('home', '/read', { op: 'feeds' }, '首页推荐') }, '刷一下首页'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('metrics', '/read', { op: 'metrics' }, '笔记数据') }, '看笔记数据'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('mentions', '/read', { op: 'mentions' }, '评论和@') }, '看评论和@'),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('notes', '/read', { op: 'my_notes' }, '我的笔记') }, '我的笔记'),
      ),
    ),

    // ---------------------------------------------------------------- 浏览
    h(ui.Card, {
      title: '浏览与分享',
      desc: '定时去刷首页或按关键词搜，看到合适的挑一篇私聊分享给你。只在下面的时段里跑。',
    },
      h(ui.Row, { label: '定时自己去刷' }, h(ui.Switch, { on: Boolean(cfg.autoBrowse), onChange: (v) => change({ autoBrowse: v }) })),
      h(ui.Row, { label: '把好笔记分享给我' }, h(ui.Switch, { on: Boolean(cfg.autoShare), onChange: (v) => change({ autoShare: v }) })),
      h(ui.Row, { label: '多久刷一轮' }, number('intervalMinutes', 10, 1440), h('span', { className: 'ab-muted' }, '分钟')),
      h(ui.Row, { label: '每天最多分享' }, number('maxSharesPerDay', 0, 10), h('span', { className: 'ab-muted' }, '篇')),
      h(ui.Row, { label: '兴趣关键词', hint: '一行一个或逗号分隔；留空就刷首页推荐' }, area('keywords', 'AI\n游戏\n白米饭')),
      h(ui.Row, { label: '运行时段（北京时间）', hint: '开始和结束相同表示全天' },
        number('startHour', 0, 23), h('span', { className: 'ab-muted' }, ' 点到 '), number('endHour', 0, 23), h('span', { className: 'ab-muted' }, ' 点')),
      h(ui.Row, { label: '自主刷（读内容再决定）', hint: '打开后：搜关键词 → 逐篇读正文和评论 → 她判断 → 点赞/评论/分享 → 记进记忆。关着就还是老办法只分享链接' },
        h(ui.Switch, { on: Boolean(cfg.smartBrowse), onChange: (v) => change({ smartBrowse: v }) })),
      h(ui.Row, { label: '每天最多刷几轮' }, number('maxRunsPerDay', 0, 24), h('span', { className: 'ab-muted' }, '轮')),
      h(ui.Row, { label: '一轮读几篇' }, number('perRun', 1, 10), h('span', { className: 'ab-muted' }, '篇')),
      h(ui.Row, { label: '顺手点赞' }, h(ui.Switch, { on: Boolean(cfg.likeEnabled), onChange: (v) => change({ likeEnabled: v }) })),
      h(ui.Row, { label: '每天最多点赞' }, number('maxLikesPerDay', 0, 50), h('span', { className: 'ab-muted' }, '个')),
      h(ui.Row, { label: '每天最多主动评论' }, number('maxCommentsPerDay', 0, 10), h('span', { className: 'ab-muted' }, '条')),
      saveHint,
    ),

    // ---------------------------------------------------------------- 看画面
    h(ui.Card, {
      title: '看画面（截图 + 视觉）',
      desc: '默认只读标题、正文和评论。打开后每篇笔记会截一张页面图交给视觉模型，截图存在本机（下面截图库里能看、能删、能让她发）。没有视觉模型或截图失败时，自动继续纯文字阅读。',
    },
      h(ui.Row, { label: '让她看画面', hint: '需要视觉模型支持图片；关掉就退回只看文字' },
        h(ui.Switch, { on: Boolean(cfg.vision), onChange: (v) => change({ vision: v }) })),
      h(ui.Row, { label: '刷完顺手发张截图', hint: '概率；0 = 从不。截图都在本机，你让她发她也能挑' },
        number('shotChance', 0, 100), h('span', { className: 'ab-muted' }, '%')),
      h(ui.Row, { label: '截图库最多存' },
        number('shotLibrary', 10, 5000), h('span', { className: 'ab-muted' }, '张（超过自动删最旧的）')),
      saveHint,
    ),

    // ---------------------------------------------------------------- 评论回复
    h(ui.Card, {
      title: '自动回复评论',
      desc: '她用自己的账号回你笔记下的新评论。第一次启用先建立基线，历史评论不会补回；读通知失败、结果不明确或遇到验证时当天直接停。',
    },
      h(ui.Row, { label: '自动回复评论' }, h(ui.Switch, { on: Boolean(cfg.autoReply), onChange: (v) => change({ autoReply: v }) })),
      h(ui.Row, { label: '多久检查一次' }, number('replyCheckMinutes', 20, 1440), h('span', { className: 'ab-muted' }, '分钟（最少 20）')),
      h(ui.Row, { label: '每天最多回复' }, number('maxRepliesPerDay', 0, 50), h('span', { className: 'ab-muted' }, '条')),
      h(ui.Row, { label: '两次回复至少间隔' }, number('replyGapMinutes', 5, 1440), h('span', { className: 'ab-muted' }, '分钟')),
      h(ui.Row, { label: '本人用户 ID', hint: '自动填；核对评论是不是发在你的笔记下面时要用', }, text('accountUserId', '登录后自动填')),
      saveHint,
    ),

    // ---------------------------------------------------------------- 私信
    h(ui.Card, {
      title: '私信',
      desc: '读写都走你自己的账号。自动回复只在对方最后一条不是你说的时候触发，会按上下文生成一句，推销 / 骚扰 / 要隐私的一律不回。',
    },
      h(ui.Row, { label: '自动回复私信' }, h(ui.Switch, { on: Boolean(cfg.autoDM), onChange: (v) => change({ autoDM: v }) })),
      h(ui.Row, { label: '多久检查一次' }, number('dmCheckMinutes', 10, 1440), h('span', { className: 'ab-muted' }, '分钟')),
      h(ui.Row, { label: '每天最多回' }, number('maxDMPerDay', 0, 30), h('span', { className: 'ab-muted' }, '个会话')),
      h(ui.Row, { label: '两次回复至少间隔' }, number('dmGapMinutes', 5, 1440), h('span', { className: 'ab-muted' }, '分钟')),
      h('div', { className: 'ab-flex', style: { marginTop: 6 } },
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
          setBusy('dms')
          try {
            const out = await call('/dms')
            setChats(out)
            setResultTitle('私信列表'); setResult(out)
            if (out.message) toast(out.message, out.ok ? 'ok' : 'err')
          } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
        } }, '读私信列表'),
        h(ui.Btn, {
          small: true, disabled: Boolean(busy),
          onClick: () => act('home2', '/read', { op: 'feeds' }, '刷新会话'),
        }, '刷新'),
      ),
      chats && Array.isArray(chats.items) ? h('div', { style: { marginTop: 8 } },
        chats.items.slice(0, 10).map((chat, index) => h('div', {
          key: chat.conversationId + index,
          className: 'ab-flex',
          style: { padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'center' },
        },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', null, (index + 1) + '. ' + (chat.nickname || '（无昵称）') + (Number(chat.unread) > 0 ? ' · ' + chat.unread + ' 未读' : '')),
            h('div', { className: 'ab-small ab-muted', style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
              (chat.time || '') + ' ' + (chat.summary || '')),
          ),
          h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
            setBusy('thread')
            try {
              const out = await call('/dm', { conversationId: chat.conversationId, limit: 30 })
              setThread({ chat, out })
              setResultTitle('会话：' + (chat.nickname || '')); setResult(out)
            } catch (error) { toast(error.message, 'err') } finally { setBusy('') }
          } }, '读'),
        )),
      ) : null,
      thread ? h('div', { className: 'ab-note', style: { marginTop: 8, maxHeight: 320, overflow: 'auto' } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '和 ' + (thread.chat.nickname || '') + ' 的最近消息'),
        (thread.out?.data?.items || []).map((msg, i) => h('div', {
          key: i, className: 'ab-small',
          style: { textAlign: msg.mine ? 'right' : 'left', margin: '3px 0', color: msg.mine ? 'var(--ab-ok)' : 'inherit' },
        }, (msg.mine ? '我：' : '') + msg.text)),
      ) : null,
      !chats ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '点「读私信列表」看看谁给你发过消息。') : null,
      saveHint,
    ),

    // ---------------------------------------------------------------- 账号数据
    h(ui.Card, {
      title: '搜索与账号数据',
      desc: '读取用的都是你登录后的会话。读不到就是读不到，不会用估计值填。搜到的笔记可以直接点「分享给我」，会把链接发到你的 QQ 私聊。',
    },
      h(ui.Row, { label: '搜索' },
        h('input', { className: 'ab-input', value: query, placeholder: '关键词', onChange: (e) => setQuery(e.target.value) }),
        h(ui.Btn, {
          small: true, disabled: Boolean(busy),
          onClick: async () => {
            const out = await act('search', '/read', { op: 'search', query }, '搜索：' + query)
            const list = Array.isArray(out?.data?.feeds) ? out.data.feeds : []
            setFeeds(list)
          },
        }, '搜')),
      feeds.length ? h('div', { style: { marginTop: 8 } },
        feeds.slice(0, 8).map((item, index) => {
          const card = item.noteCard || item.note_card || {}
          const title = String(card.displayTitle || card.title || '').slice(0, 60)
          const author = String(card.user?.nickname || card.user?.nickName || '').slice(0, 20)
          const id = String(item.id || card.noteId || '')
          const token = String(item.xsecToken || card.xsecToken || '')
          return h('div', {
            key: id + index,
            className: 'ab-flex',
            style: { padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)', alignItems: 'center' },
          },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'ab-small', style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
                (index + 1) + '. ' + (title || '（无标题）') + (author ? ' · ' + author : '')),
              h('div', { className: 'ab-small ab-muted' }, token ? '有 token，可分享/可读' : '这条没带 token，可能读不全')),
            h(ui.Btn, {
              small: true, disabled: Boolean(busy) || !id,
              onClick: () => act('share-' + index, '/share', { feedId: id, xsecToken: token, title }, '分享给我'),
            }, '分享给我'),
          )
        }),
      ) : h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '搜一下，结果会列在这里，每篇都能一键分享链接。'),
      h(ui.Row, { label: '读一篇笔记' },
        h('input', { className: 'ab-input', value: feedId, placeholder: '笔记 ID', onChange: (e) => setFeedId(e.target.value) }),
        h('input', { className: 'ab-input', value: token, placeholder: 'xsec_token', onChange: (e) => setToken(e.target.value) }),
        h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('detail', '/read', { op: 'detail', feedId, xsecToken: token }, '笔记详情') }, '读')),
    ),

    // ---------------------------------------------------------------- 手动分享链接
    h(ui.Card, {
      title: '分享链接给我',
      desc: '把小红书里「复制链接」出来的那条粘进来，直接发到你的 QQ 私聊。支持 www.xiaohongshu.com 的完整链接，也支持 xhslink.com 短链。',
    },
      h(ui.Row, { label: '链接' },
        h('input', {
          className: 'ab-input', value: shareUrl, placeholder: 'https://www.xiaohongshu.com/explore/… 或 http://xhslink.com/…',
          onChange: (e) => setShareUrl(e.target.value),
        }),
        h(ui.Btn, {
          small: true, disabled: Boolean(busy) || !shareUrl.trim(),
          onClick: async () => {
            const out = await act('share-link', '/share', { url: shareUrl.trim(), title: shareTitle }, '分享链接')
            if (out?.ok) setShareUrl('')
          },
        }, '发给我')),
      h(ui.Row, { label: '说一句', hint: '可选，放在链接上面；不填就写「小红书笔记」' },
        h('input', { className: 'ab-input', value: shareTitle, placeholder: '比如：这篇讲 DeepSeek 的可以看看', onChange: (e) => setShareTitle(e.target.value) })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '发出去的样子：第一行一句话，第二行一条能直接点开的链接。分享用的是你自己的 QQ 私聊，不会发到群里。'),
    ),

    // ---------------------------------------------------------------- 发布
    h(ui.Card, {
      title: '公开互动与发布',
      desc: '先准备草稿，核对标题 / 正文 / 素材，再点确认。执行结果不明确时到小红书核对，别重复点。',
    },
      drafts.length ? drafts.map((draft) => h('div', { key: draft.id }, renderDraft(draft)))
        : renderDraft(null),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        '也可以直接跟大肥鱼说：「帮我准备一篇关于 XXX 的图文笔记」，她会准备草稿，草稿会出现在这里等你确认。'),
    ),

    // ---------------------------------------------------------------- 结果
    // ---------------------------------------------------------------- 截图库
    h(ui.Card, {
      title: '截图库（' + shots.length + ' 张）',
      desc: '刷小红书时顺手截下来的笔记画面，都在这台机器上。点「发这张」直接私聊发给你，点「删」就删掉。',
    },
      h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
        h(ui.Btn, { small: true, disabled: shotsBusy, onClick: () => loadShots() }, shotsBusy ? '读…' : '刷新'),
        h('span', { className: 'ab-small ab-muted', style: { marginLeft: 8 } }, '最多存 ' + (cfg.shotLibrary || 600) + ' 张，超了自动删最旧的')),
      shots.length
        ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 } },
            shots.map((x) => h('div', { key: x.file, style: { border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, overflow: 'hidden' } },
              h('img', {
                src: '/aurabot/api/ext/xiaohongshu/shot-data?file=' + encodeURIComponent(x.file),
                alt: x.title || '截图',
                style: { width: '100%', height: 96, objectFit: 'cover', display: 'block', background: '#111' },
              }),
              h('div', { className: 'ab-small', style: { padding: '6px 8px' } },
                h('div', { style: { marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.title || '（无标题）'),
                h('div', { className: 'ab-flex' },
                  h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: () => act('shot-send', '/shot', { query: x.title || '' }, '发截图') }, '发这张'),
                  h(ui.Btn, { small: true, disabled: Boolean(busy), onClick: async () => {
                    const r = await act('shot-del', '/shot-delete', { file: x.file }, '删截图')
                    if (r && r.ok) loadShots()
                  } }, '删'))))),
          )
        : h('div', { className: 'ab-small ab-muted' }, '还没有截图。把上面「看画面」打开，再刷一轮就有了。'),
    ),

    h(ui.Card, { title: resultTitle || '最近结果', desc: '原样显示接口返回，方便你自己判断。' },
      h('pre', {
        className: 'ab-small',
        style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', margin: 0 },
      }, result ? JSON.stringify(result, null, 2).slice(0, 12000) : '还没有结果。'),
      h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { small: true, onClick: refresh }, '刷新状态'),
        h(ui.Btn, { small: true, onClick: () => { setResult(null); setResultTitle('') } }, '清空'),
      ),
    ),
  )
}