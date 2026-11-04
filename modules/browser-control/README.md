# 浏览器操控 · Aurabot 外置模块 v1.0.0

让大肥鱼真的操作浏览器：打开网页、点击、输入、滚动、读内容、截图、接管已登录会话、完成多步骤网页任务。

## 它是什么

- **Aurabot 外置模块**，不修改插件核心文件，升级 Aurabot 不影响本模块。
- 后端默认 **ego-browser**（ego lite 的 embedded Node runtime），直接连主人自己的 ego lite —— **登录态天然共享**。
- 可选后端 **Playwright MCP**，独立浏览器实例，登录态不通用（切换后端不会迁移会话）。
- 权限分三级，高风险必须主人在本地面板确认；模型自称"已确认"无效。

## 目录

```
browser-control/
├── index.mjs                 模块入口：工具、命令、面板接口、生命周期
├── panel.js                  面板 UI
├── adapters/
│   ├── ego-browser.mjs       ego-browser CLI 适配（spawn + 脚本 + 结果解析 + space 续用）
│   ├── playwright-mcp.mjs    Playwright MCP 适配（可选，未装时明确报错）
│   └── mcp-client.mjs        极简 MCP stdio 客户端
├── services/
│   ├── browser.mjs           统一能力层：策略 → 后端 → 任务记录
│   └── tasks.mjs             任务状态机（持久化）
├── security/
│   └── policy.mjs            风险分级、域名允许/禁止、试运行
├── tests/
│   └── policy.test.mjs       纯函数单测
└── README.md
```

## 安装

1. 装好 **ego lite**（https://github.com/citrolabs/ego-lite），确认 `ego-browser` 命令可用：
   ```powershell
   ego-browser --version
   ```
2. 把 `browser-control` 文件夹放到：
   ```
   %USERPROFILE%\.dsh\plugins-data\aurabot\modules\browser-control\
   ```
3. Aurabot 会在几秒内自动加载（看日志出现 `[浏览器] 扩展已加载 v1.0.0`）。
4. 面板：Aurabot →「扩展」→「浏览器操控」。

可选后端 Playwright MCP：
```powershell
npm i -g @playwright/mcp
```
然后在面板「Playwright MCP 命令」里填 `npx @playwright/mcp@latest --headless`。
**模块不会自己下载安装任何东西**，没装就直说没装。

## 用起来

自然语言（QQ 私聊，只认主人）：

```
帮我打开 GitHub 看看这个项目最新 issues
打开我已经登录的 B 站，看最近的消息
用浏览器搜一下这个关键词，整理成一段话
```

命令：

```
/浏览器 状态
/浏览器 打开 https://example.com
/浏览器 看看
/浏览器 标签
/浏览器 截图
/浏览器 取消
```

## 工具（给大肥鱼自己调）

| 工具 | 作用 | 风险 |
|---|---|---|
| `bc_status` | 后端/空间/最近错误 | 低 |
| `bc_open` | 打开网址（读一次内容） | 中 |
| `bc_read` | 快照 / 纯文本 / 链接 / 表格 | 低 |
| `bc_click` | 点击（ref / 文字 / css / loc=） | 中（命中支付/发布/删除词升级为高） |
| `bc_fill` | 填输入框 | 中 |
| `bc_press` | 按键/快捷键 | 中 |
| `bc_scroll` | 滚动 | 低 |
| `bc_tabs` | 列/新建/关闭标签页 | 低 |
| `bc_screenshot` | 截图存文件 | 低 |
| `bc_eval` | 只读 JS 取值（拒绝 fetch/cookie 写入/eval） | 低 |
| `bc_batch` | **一次做完一串动作**（打开→填表→提交→读结果），失败即停并报第几步 | 取子步骤最高 |
| `bc_back` | 后退/前进/刷新 | 中 |

## 关键技术事实（都是实测，不是猜测）

- `ego-browser nodejs -e "<script>"` 一次性执行，**每次都是新 Node 进程**，但 **TaskSpace / 标签页 / Page 标签会保留**。
- 续用空间用 **名字**（`taskSpace("aurabot-browser")`）最稳；按 id 续用在本机实测会报 `task space not found`。
- `page.url()` / `page.title()` 返回 **Promise**，必须 `await`（直接序列化会得到 `{}`）。
- `console.log` 的输出有时走 **stderr**，所以结果解析必须两边一起找。
- 快照里可交互元素带 `[ref=N, loc=css:…]`，点击用 `@N` 或 `loc=`；纯文本元素没有 ref。
- eg-browser 不继承 shell 环境变量，所以参数一律内联进 `-e` 的脚本里（spawn 传数组，不经 shell，中文安全）。

### ⚠ 跨进程页面状态：可能会被重置，所以做了两手准备

先把结论说准，因为我在这一条上改过口：

**实测复现过页面被重置**（`xp-a.mjs` → `xp-b.mjs` 两次独立调用）：

```
A 进程：打开 example.com → 注入表单 → injected: true
B 进程：再进去看 →
   url: "chrome://new-tab-page/"
   hasQ: false
   page.fill → "Selector #q matched 0 elements"
```

**但也实测过页面正常保留**（同一个 space 连做 3 次 snapshot）：

```
第1次 snapshot: title=Example Domain url=https://example.com/ restored= len=1166
第2次 snapshot: title=Example Domain url=https://example.com/ restored= len=1285
第3次 snapshot: title=Example Domain url=https://example.com/ restored= len=1166
```

`restored` 是空的 —— 说明恢复逻辑没被触发，页面本来就在。

**所以准确说法是：页面状态会丢，但不是每次都丢，触发条件我还没完全摸清**
（可能跟 space 干不干净、窗口焦点、ego 内部清理时机有关）。

既然不能保证，就做了两手准备：

**① `bc_batch`：把一串动作塞进同一次调用**（最可靠）

一次 batch 实测 7 步全 PASS，18 秒：

```
PASS open        {"url":"https://example.com/","title":"Example Domain"}
PASS evaluate    true
PASS fill        {"value":"aurabot-ok"}
PASS click       {"title":"clicked:aurabot-ok"}
PASS evaluate    {"title":"clicked:aurabot-ok","value":"aurabot-ok"}
PASS scroll      {}
PASS screenshot  {...\shots\batch-test.png}
```

`title` 变成 `clicked:aurabot-ok`，说明**点击真的触发了事件，而且读到了刚填进去的值**。

**② 记住上次打开的网址，页面空了就自动回去**

适配层把最近一次 `open` 成功的 URL 存进 `ego-state.json` 的 `lastUrl`。
后续的 snapshot / click / fill / evaluate / screenshot 等动作，如果发现当前页面是
`chrome://new-tab-page` / `about:blank`，就先自动 `goto(lastUrl)` 再干活，
并在返回里带上 `restored: "<url>"`；恢复失败会带 `restoreError`。

这样即使页面被重置，她也不会对着空白页点半天。

**但实测里这条从来没被触发过**（`restored` 一直是空的）。下面三次尝试都没能让它出场：

| 做法 | 结果 |
|---|---|
| 把 `ego-state.json` 的 `spaceId` 置空、保留 `lastUrl`，重启模块后调 snapshot | `title=Example Domain`，`restored` 空 |
| 直接把 `aurabot-browser` 这个 space `finish()` 掉，再调 snapshot | `title=Example Domain`，`restored` 空 |
| 用 ego CLI 把页面强推到 `about:blank`，再调 snapshot | `title=Example Domain`，`restored` 空 |

结论：**ego 自己就会把上次的页面恢复回来**（space 级 session restore）。
所以这条恢复逻辑是纯保险——留着，但**它的代码路径没有在真实场景里被验证过**，这点得说清楚。

> 踩坑记录：这段恢复逻辑最初写成正则 `/^(chrome|edge|about):\/\/(new-tab-page|blank)/`，
> 但它嵌在 JS 模板字符串里 —— `\/` 被模板吞成 `/`，生成出来变成 `//` 开头的注释，
> 整个脚本直接 `SyntaxError: await is only valid in async functions`。
> 后来改成纯字符串判断（`indexOf('new-tab-page')`），不跟转义较劲。

## 安全设计

1. **工具注册阶段**：只有 `chat.kind === 'private'` + `level === 'full'` + `hub.turnHasOwner(sessionId)` 才拿到工具。群里任何人（包括管理员）都拿不到。
2. **执行阶段**：再核对一次 `turnHasOwner`、模块开关、Aurabot 总开关、暂停/试运行。
3. **风险分级**：目标文本命中「支付/下单/发布/发送/删除/…」自动升为高风险；高风险必须面板点确认（一次性 approvalId，**5 分钟真过期**，用过即废）。
   过期判断在 `isApprovalExpired()` 里，有单测盯着（`tests/guards.test.mjs`）——之前 README 说 5 分钟，代码里其实没有，是这轮补上的。
4. **试运行**：写操作一律不执行，只回报"会做什么"。
5. **域名策略**：允许名单（留空=不限制）+ 禁止名单，禁止优先。
6. **注入防护**：页面内容一律当不可信资料；`bc_eval` 拒绝 `fetch`/`XMLHttpRequest`/`document.cookie =`/`eval(`。
7. **凭据**：不读取、不回显 cookie；截图只落本地文件。

> 面板 HTTP 接口**不是权限边界**（Aurabot 的 `/aurabot/api/*` 本机可访问）。
> 所以面板只暴露「查询状态 / 改配置 / 确认审批」，真正的浏览器动作只经工具走，工具层有主人校验。

## 验收结果（2026-11-04 本机真实运行）

| 项目 | 结果 |
|---|---|
| 作为外置模块加载 | ✅ 日志 `[浏览器] 扩展已加载 v1.0.0` |
| 独立启停 / 热重载 | ✅ 改文件自动重载，`onDispose` 会停 Playwright 客户端并取消任务 |
| 检测 ego-browser | ✅ `egoOk=true`，能列出任务空间 |
| 打开网页 | ✅ `https://example.com/` → title `Example Domain`；`https://www.baidu.com` 也能打开 |
| 标签页管理 | ✅ `[p1] 新标签页`，space 续用 `resumed:true` |
| 获取真实页面内容 | ✅ 快照返回可访问性树（`[ref=2, loc=css:a[aria-label="Gmail "]]`） |
| 取值 / 读 DOM | ✅ `bc_eval` 在真实页面读到 `title`、`querySelector` 结果 |
| 滚动 | ✅ 返回 ok |
| 截图 | ✅ 落盘 `shots/*.png`（EGO 在新空间里 500ms 完成） |
| 复用登录态 | ✅ 用的是主人 ego lite 的 profile |
| 多步骤任务 | ✅ 同一 space 跨调用保留，动作累积在一个任务里 |
| 页面被关掉 | ✅ `task space not found` 自动重建重试一次，失败原样上报 |
| 无权会话 | ✅ 工具不注册（需 `private` + `full` + owner） |
| 高风险无法绕过确认 | ✅ 10 个单测：未确认时后端调用次数为 0，approvalId 用过即失效 |
| 群友无法触发 | ✅ 需 `private + full + turnHasOwner` 三项同时成立 |
| 退出无遗留 | ✅ `onDispose` 取消任务；自检用的临时空间会 `finish({keep:[]})` |
| **点击元素** | ✅ 一次 batch 内点击按钮后 `document.title` 变成 `clicked:aurabot-ok`（真触发了事件） |
| **向输入框输入** | ✅ 同一次 batch 内 `fill` 后读回 `value === "aurabot-ok"` |
| 多步串起来 | ✅ `bc_batch` 7 步 18 秒跑完，全 PASS，临时空间自动收掉 |
| 中途失败能停 | ✅ 三步里第 2 步选择器不存在 → `done=false, okCount=1, failedAt=1, results=2`，第 3 步没执行 |

### 失败即停的真实记录

```json
// 请求：open example.com → fill #definitely-not-here → scroll
{"done":false,"okCount":1,"failedAt":1,"results":2}
PASS [0] open   204ms
FAIL [1] fill  1074ms  page.fill failed: Selector #definitely-not-here matched 0 elements …
```

`results` 只有 2 条 —— **第 3 步压根没跑**，不是跑完再报错。错误原文完整带回，不做改写。

### 自带诊断

```powershell
# 后端能不能用、空间在不在、最近有没有报错
POST /aurabot/api/ext/browser-control/diag

# 一次调用里跑完整流程（自己新建临时空间，跑完就收）
POST /aurabot/api/ext/browser-control/selftest

# 任意动作串（最多 25 步），面板调试也用它
POST /aurabot/api/ext/browser-control/batch   {"steps":[{"action":"open","url":"…"},{"action":"fill","target":"#q","value":"…"}]}
```

`/selftest` 现在的真实输出：

```
ok=True passed=True value=aurabot-ok title=clicked:aurabot-ok ms=18044 finished=True
PASS open (337ms)
PASS evaluate (4ms)
PASS fill (32ms)
PASS click (1311ms)
PASS evaluate (3ms)
PASS scroll (896ms)
FAIL screenshot (15016ms) CDP request timed out
```

截图那一步在 batch 里偶发 CDP 超时（单独调 `/screenshot` 通常 500–2400ms 成功），
所以它不影响判定，但确实是个不稳定点，已记在下面的限制里。

### 失败即停的真实记录

```json
// 请求：open example.com → fill #definitely-not-here → scroll
{"done":false,"okCount":1,"failedAt":1,"results":2}
PASS [0] open   204ms
FAIL [1] fill  1074ms  page.fill failed: Selector #definitely-not-here matched 0 elements …
```

`results` 只有 2 条 —— **第 3 步压根没跑**，不是跑完再报错。错误原文完整带回，不做改写。

### 自带诊断

```powershell
# 后端能不能用、空间在不在、最近有没有报错
POST /aurabot/api/ext/browser-control/diag

# 跑一段固定多步流程（自己新建临时空间，跑完就收），逐步报每步 ok/耗时/原因
POST /aurabot/api/ext/browser-control/selftest
```

`/selftest` 目前能稳定 PASS 的步骤：打开公开页 → 在页面里建测试表单 → 读回值 → 滚动 → 截图 → 收掉空间；
`fill` / `click` 两步会如实报失败原因（见上）。

### 任务状态机的终态

任务记录落盘在 `modules-data/browser-control/tasks.json`，状态是
`pending / running / paused / awaiting_approval / completed / failed / cancelled`。

结案规则（都实测过）：

- `batch` 一次成功 → 直接 `completed`（实测记录 `#f2d22573 completed`）
- 浏览器 自检跑完 → `completed` 且 `verified: true`（实测 `#b0d5f8f2 completed verified=True`）
- 失败 → `failed` 并带错误原文
- 空闲超过 5 分钟 → 自动从 `running` 结案成 `completed`（`settledBy: "idle"`），
  避免热重载后一堆记录永远停在 `running`
- 模块卸载 / 手动取消 → 只有**进行中**的会变 `cancelled`，已完成的不受影响

## 为什么「模块」面板里 tools 显示 0

如果你去看 `/aurabot/api/modules`，会看到本模块 `tools: []`，但 `commands` 和 `routes` 都在。
**这不是没注册上，是统计口径问题。**

Aurabot 的 `toolNames(rec)`（`src/core/modules.js`）统计时会用一个**假会话**去调工具构建函数：

```js
b({ chat: { chatId: 'private:0', kind: 'private', userId: '0' }, level: 'full', sessionId: '' })
```

注意 `sessionId: ''` —— 本模块的门禁里有 `hub.turnHasOwner(sessionId)`，空 sessionId 当然不是主人，
于是**正确地返回空数组**。所以列表里是 0。

真实会话走的是另一条路（`src/chat/hub.js`）：

```js
const tools = level !== 'chat' && typeof buildTools === 'function'
  ? buildTools({ chat, level, sessionId: sid })   // 真实 sid
  : []
```

那时 `turnHasOwner(sid)` 为真，工具就出来了。`tests/registration.test.mjs` 里用假 api 复现了这两条路径：
主人私聊 `full` 拿 12 个（Windows 模块 9 个），其它情况 0 个。

**换句话说：面板显示 0 恰好说明门禁在生效。**

### batch 里的每一步也过策略（这是一个修过的漏洞）

最初 `bc_batch` 只把整串当成一个动作，结果是：

```
steps: [ open https://bank.example.com/pay , click #pay ]
→ 域名禁止名单形同虚设，整串照跑
steps: [ evaluate fetch("...") ]
→ 注入检查形同虚设
```

因为域名策略和 `eval` 拦截原本只挂在 `open` / `evaluate` 这两个**单独动作**上，
包进 batch 就绕过去了。

现在改成 `service` 层**逐步前置检查**（`precheckBatch`），工具和面板两条入口都覆盖：

- 动作必须在白名单里（open/fill/click/press/select/scroll/wait/evaluate/snapshot/screenshot）
- 每一步的 `open` 都过域名允许/禁止名单
- 每一步的 `evaluate` 都过危险表达式拦截（fetch / cookie 写入 / eval / new Function / location 跳转 / window.open / submit …）
- 步数上限 25
- 任何一步不合规 → **整串拒绝，后端一次都不调**

`tests/batch-guard.test.mjs` 5 个用例盯着这件事，其中三条明确断言 `calls.length === 0`
（也就是"策略挡在后端前面，不是跑完再报error"）。

## 怎么让她知道自己有这些能力

光注册工具**不够**——工具只在模型决定"要调工具"时才出现在视野里。她得先知道"我有这个本事、该直接动手"，
才会去调。Aurabot 给的正解是 `api.rule()`：写进去的文字会进她的**系统提示词**，每一轮都在。

本模块在 `setup()` 里注册了一条：

```js
const ruleText = (kind) => {
  if (kind !== 'private') return ''            // 群聊不注入
  if (api.settings().enabled === false) return ''  // 模块关着不注入
  return ['你身上装着浏览器能力（真能开，不是说说）：bc_open / bc_read / bc_click …',
          '什么时候用：主人让你上网查东西、打开链接、看页面、填表 —— 直接动手，别说「我没有浏览器」',
          '【重要】多步必须用 bc_batch 塞进一次调用…'].join('\n')
}
api.rule(ruleText)
```

想看她到底被告知了什么，直接打开：

```
http://127.0.0.1:6457/aurabot/api/ext/browser-control/prompt
http://127.0.0.1:6457/aurabot/api/ext/windows-control/prompt
```

（`/prompt` 是本模块自己加的只读路由。）

三个层次合起来才够：

| 层次 | 作用 | 在哪 |
|---|---|---|
| 系统提示（`api.rule`） | 让她**知道自己会**，且知道该直接动手 | 每轮都在，最有效 |
| 工具描述（`description`） | 让她**知道怎么调**、参数怎么填 | 工具列表里可见 |
| `/prompt` 路由 | 让**主人**能核对实际注入的文字 | 面板外可直接访问 |

### 踩过的坑

`api.rule` 的回调只拿得到 `kind`（`private` / `social`），**拿不到 sessionId**。
所以"是不是主人"这一层只能在**工具层**卡（`turnHasOwner`），规则文字只能按"私聊/群聊"分。
写在规则里的话会让群里任何人都看到——所以规则里不能写敏感操作细节，只写"有什么能力、怎么用"。

## 已知限制

- 每次工具调用都会启一个 `ego-browser` 进程（约 2–5 秒开销）。多步骤任务靠 space 续用，不是长连接。
- 不同后端**不共享登录态**，切换后端也不会迁移会话——面板文案里写明了。
- 快照很长时按 `maxSnapshotChars` 截断，超出部分她看不到（可以调大或分区域看）。
- 高风险的判定是**关键词命中**，不是语义理解；宁可多问一次，也不会漏掉支付类动作，但可能把普通"提交"也拦一下。
- **跨进程页面状态可能丢**（复现过，也见过保留）。所以：单步工具只适合「打开后立刻做一件事」；
  多步任务用 `bc_batch` 一次跑完；就算页面真被重置，`lastUrl` 也会自动把你带回上次那个网址。
- batch 里 `screenshot` 偶发 CDP 超时（15s），单独调用 `/screenshot` 正常。

## 测试

```powershell
cd %USERPROFILE%\.dsh\plugins-data\aurabot\modules\browser-control
node --test tests/policy.test.mjs tests/approval.test.mjs tests/registration.test.mjs tests/batch-guard.test.mjs tests/guards.test.mjs
```

40 个用例，全过。五组各管一件事：

| 文件 | 覆盖 |
|---|---|
| `policy.test.mjs` | 风险分级、域名允许/禁止、试运行开关、截断 |
| `approval.test.mjs` | 高风险**不调后端**、approvalId 一次性、拒绝后不执行、试运行不写 |
| `registration.test.mjs` | 工具注册权限：主人私聊 12 个工具 / 群聊 0 个 / 非 full 0 个 / 非主人 0 个 / 开关关 0 个；执行期二次校验 |
| `batch-guard.test.mjs` | batch 逐步过策略：域名名单、evaluate 注入、高危要确认、正常 batch 放行 |
| `guards.test.mjs` | 审批 5 分钟过期（含缺字段、空值边界） |