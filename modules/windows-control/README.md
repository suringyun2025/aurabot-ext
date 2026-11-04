# Windows 电脑操控 · Aurabot 外置模块 v1.0.0

让大肥鱼在你的 Windows 电脑上真的动手：看屏幕、开应用、切窗口、点击、输入、快捷键、在授权目录里读写文件。

## 它是什么

- **Aurabot 外置模块**，不修改插件核心文件。
- 后端是 **CursorTouch/Windows-MCP**（stdio MCP），不重复造鼠标键盘和 UI Automation 底层。
- 危险工具（PowerShell / Registry / Process）在**服务端**就用 `--exclude-tools` 摘掉，客户端还有一层白名单——两层都过才可能执行。
- 只在 Windows 10/11 生效；其他系统明确显示"不支持当前系统"，不注册任何可执行工具。

## 目录

```
windows-control/
├── index.mjs                 模块入口：工具、命令、面板接口、生命周期
├── panel.js                  面板 UI
├── adapters/
│   └── windows-mcp.mjs       Windows-MCP stdio MCP 客户端（握手/工具调用/重启）
├── services/
│   ├── desktop.mjs           观察：Snapshot / Screenshot / 显示器 / 窗口解析 / 锁屏检测
│   ├── windows.mjs           动作：App / Click / Type / Shortcut / Clipboard / FileSystem …
│   └── tasks.mjs             任务状态机（持久化）
├── security/
│   └── policy.mjs            风险分级、授权目录、锁屏/安全桌面检测
├── tests/
│   └── policy.test.mjs
└── README.md
```

## 安装

1. 装 Windows-MCP（需要 uv）：
   ```powershell
   uv tool install windows-mcp
   ```
   或者用 uvx 直接跑。装好后确认：
   ```powershell
   windows-mcp --help
   ```
2. 把 `windows-control` 文件夹放到：
   ```
   %USERPROFILE%\.dsh\plugins-data\aurabot\modules\windows-control\
   ```
3. 日志出现 `[Windows] 扩展已加载 v1.0.0（Windows）` 即成功。
4. 面板：Aurabot →「扩展」→「Windows 电脑操控」，先点「连接/探测后端」。

> 不需要在 DSH 的「设置 → 桌面」里开那个 `dsh-windows-mcp` bridge——
> 本模块自己用 stdio 拉一个 `windows-mcp serve`，和它互不干扰。

## 用起来

QQ 私聊（只认主人）：

```
打开记事本，把这段话整理一下存到桌面
看看我现在的屏幕
打开资源管理器，找一下下载里的 xxx
```

命令：

```
/电脑 状态
/电脑 快照
/电脑 截图
/电脑 取消
```

## 工具

| 工具 | 作用 | 风险 |
|---|---|---|
| `wc_state` | 焦点窗口 / 窗口列表 / 显示器 / 是否锁屏 | 低 |
| `wc_snapshot` | 带元素编号的桌面快照 | 低 |
| `wc_app` | 启动应用 / 切窗口 / 调整窗口 | **启动=高** |
| `wc_click` | 坐标或元素编号点击 | 中 |
| `wc_type` | 输入文字（支持中文） | 中 |
| `wc_key` | 快捷键（`ctrl+s`、`alt+tab`） | 中（`alt+f4`/`win+r` 等升级为高） |
| `wc_scroll` | 滚轮 | 中 |
| `wc_file` | 读/列/搜/写/移动/复制/删除 | 读=低，**写删移=高** |
| `wc_wait` | 等待时间 / 等窗口或文字（条件只认 `text_exists`/`active_window`/`element_exists`/`element_enabled`/`focused_element`） | 低 |
| `wc_clipboard` | 把文字放进剪贴板（**只写不读**） | 中 |

## 安全设计（写进代码的，不是写进提示词的）

1. **服务端摘工具**：`windows-mcp serve --exclude-tools PowerShell,Registry,Process,Scrape`。
2. **客户端白名单**：`ALLOWED_TOOLS` 之外的调用直接拒（就算后端漏了也过不去）。
3. **授权目录 + 操作白名单**：文件操作必须落在 `桌面/下载/文档/图片` + 面板里加的目录里；`mode` 只认 read/write/copy/move/delete/list/search/info，奇怪的值直接拒、不透传给后端；`allowAnyPath` 默认关。
   **`App` 只接受应用名**，不接受直接丢 exe 路径、也不接受命令行参数（这两条都是这轮补的，之前 `actions.app` 会把 `executable` 原样传下去）。
4. **锁屏/安全桌面**：动手前先读桌面；检测到锁屏（`no-window` / `lock` / `secure-desktop`）就**拒绝执行**，不试图绕过 UAC 或锁屏。
5. **高风险确认**：启动应用、写/删/移/复制文件、危险快捷键 → 生成 approvalId，主人在面板点「确认执行」才跑；一次性、**5 分钟真过期**。
6. **试运行**：非低风险动作一律不执行，只回报"会做什么"。
7. **暂停**：面板一个开关，立刻冻结所有动作。
8. **剪贴板只写不读**：`wc_clipboard` 只做 `set`。`get` 在 `actions` 里实现着但**没暴露成工具**，读出来的内容也不往上带——剪贴板里经常就是密码。
   顺带说明：`Clipboard` 的 mode 只有 `get` / `set`（不是 copy/paste），这是实测 schema 出来的，原来写成 copy/paste 是错的。
9. **双人身份校验**：工具注册与执行都核对 `private + full + turnHasOwner`。

## 验收结果（2026-11-04 本机真实运行，桌面当时处于锁屏）

`POST /aurabot/api/ext/windows-control/diag` 的真实返回：

```
PASS 系统是 Windows :: win32
PASS 模块开关 :: 开
PASS Aurabot 总开关 :: 开
PASS Windows-MCP 可执行 :: C:\Users\33944\AppData\Roaming\uv\tools\windows-mcp\Scripts\windows-mcp.exe
PASS MCP 已连接 :: v4.1.4
PASS 工具数 > 0 :: 16
PASS 危险工具已在服务端摘除 :: PowerShell、Registry、Process、Scrape
PASS 桌面可读 :: 焦点窗口：No active window found
FAIL 桌面可交互 :: 锁屏/无交互桌面（no-window），动作会被拒绝
PASS 授权目录已配置 :: Desktop / Downloads / Documents / Pictures
```

也就是说：**连接、工具隔离、桌面读取、锁屏拦截都验证过了**；因为当时机器锁着屏，
点击/输入/开应用这类动作按设计被拒绝，**没有在真实桌面跑过一次完整交互**（见下方未验证项）。

### 文件链路自检（不需要解锁桌面）

`POST /aurabot/api/ext/windows-control/selftest` 的真实输出：

```
ok=True passed=True
checks={"writeAndReadBack":true,"deleted":true,"blockedOutsideDirs":true}
PASS 列授权目录 (5218ms)
PASS 写测试文件 (317ms)
PASS 读回文件 (5ms)
PASS 文件信息 (5ms)
PASS 删掉测试文件 (318ms)
PASS 确认已删掉（这步应当失败） (5ms)
PASS 读显示器信息 (7ms)
PASS 等待 1 秒 (1006ms)
```

它干的事：在 `桌面` 里写一个 `aurabot-selftest-<时间戳>.txt` → 读回内容比对 → 删掉 → 确认已不存在，
并验证 `C:/Windows/System32/...` 这类越界路径会被策略拦住。**这四条都是真的调 Windows-MCP 跑出来的。**

顺带修掉一个真 bug：`Wait` 的 `duration` 只要整数秒，传 `0.3` 会被 pydantic 直接拒。

## 锁屏状态下哪些工具还能用（实测）

机器锁着屏的时候，鼠标键盘类动作物理上做不了，但有几样仍然可用。实测结果：

| 工具 | 锁屏下 | 备注 |
|---|---|---|
| `FileSystem`（读/写/列/搜/删） | ✅ 可用 | 不依赖桌面会话 |
| `Clipboard` | ✅ 可用 | 剪贴板不依赖桌面 |
| `Wait` | ✅ 可用 | |
| `DisplayInventory` | ✅ 可用 | 返回结构化 JSON（显示器/工作区尺寸） |
| `Screenshot` | ✅ 可用 | 能拍到锁屏画面 |
| `Snapshot`（UI 树） | ❌ 100 秒超时 | 所以默认走 Screenshot |
| `Click` / `Type` / `App` / `Shortcut` | ❌ 做不了 | 会打到安全桌面上 |

`App` 切到一个**不存在的窗口**时，后端会一直等到超时（实测 25 秒）才返回，所以模块把 App 的超时收到 20 秒，
并在失败信息里提示「先用 wc_state 看看现在开着哪些窗口」。

## 真机验收：桌面交互（2026-11-04 解锁后实测）

机器解锁后，直接驱动模块自己的 `services` / `adapters` 代码路径跑了一遍：

| 动作 | 结果 | 后端原话 |
|---|---|---|
| `App switch` | ✅ | `Switched to Readme.Txt - Notepad window.` |
| `Click` | ✅ | `Single left clicked at (1400,800).` |
| `Type`（中文） | ✅ | `Typed AURABOT-TYPED-OK-大肥鱼 at (1400,800).` |
| `Shortcut` | ✅ | `ctrl+n` 新建标签、`ctrl+a/c/z` 全响应 |
| `Snapshot`（记事本前台） | ✅ **1.6 秒** | 返回完整 UI 树 + 元素坐标 |
| `Screenshot` | ✅ | 2560×1600，坐标缩放 1.481481 |
| `/diag` | ✅ **10/10 PASS** | |

输入是**肉眼确认过的**：截图里记事本标签页标题 `AURABOT-TYPED-OK`，正文第一行
`AURABOT-TYPED-OK-大肥鱼`，状态栏 `行 1, 列 21  20 个字符`，编码 UTF-8。

### 真机跑出来的三个 bug（都已修）

**① `App launch` 会假成功**

```
App { mode: 'launch', name: 'notepad' }  →  ok: true
                                          正文："Notepad not found in start menu."
```

返回 `ok:true` 但压根没启动，我原来只判 `isError`，被骗了。现在会读正文：
含 `not found / does not exist / failed` 一律判失败。

顺带发现：`name: 'notepad'` 找不到，**`name: '记事本'` 才能起来**（Windows 11 的中文开始菜单）。

**② `Type` 必须给落点**

```
Type { text: '...' }  →  Error: Either loc or label must be provided.
```

后端要求元素级输入，不能"往当前焦点盲打"。现在：
- 先 `wc_click` 点一下输入框，`wc_type` 会自动沿用**上次点击的坐标**（点哪打哪）
- 既没点过也没给 `loc`，直接回「输入要先有落点」，不往后端送

**③ 锁屏误判会把正常操作挡掉**

`Snapshot` 在复杂界面（比如 DSH 这种巨型 Electron 树）会超时或返回空窗口列表，
原来的判定是「没有焦点窗口 + 没有窗口 = 锁屏」，于是**明明解锁了也拒绝执行**。

现在改成：只有正文明确出现 `LockScreen / Lock App / 锁屏` 才算 `lock`，
`no-window`（读不到窗口）只当警告，不再拦。`/diag` 那条也从"失败"改成"照常可试"。

## 未验证 / 已知限制

- **锁屏状态下的交互未验证**：验收时桌面处于锁屏，模块正确地拒绝了动作。解锁后需要再跑一次「打开记事本 → 输入 → 保存」的完整链路。
- **`Snapshot`（UI 树）在本机锁屏时 100 秒超时**，所以默认走 `Screenshot`（快），UI 树拿不到会降级并说明原因。
- **DPI 缩放**：`Screenshot` 会给 `Screenshot Coordinate Scale`（本机 1.481481），坐标点击时要乘这个系数；面板和工具文案里提示了，但没做自动换算（不同显示器不一样，自动换算反而容易错）。
- 多显示器只支持 `display` 参数指定，没有做跨屏窗口跟随。
- 中文输入依赖 Windows-MCP 的实现（它用键盘注入 + 剪贴板），输入法状态异常时可能出问题。
- 远程桌面断开、UAC 提权窗口不在支持范围（会明确拒绝）。

## 测试

```powershell
cd %USERPROFILE%\.dsh\plugins-data\aurabot\modules\windows-control
node --test tests/policy.test.mjs tests/actions.test.mjs tests/registration.test.mjs
```

36 个用例，全过。

| 文件 | 覆盖 |
|---|---|
| `policy.test.mjs` | 工具风险分级、锁屏检测（两种文本格式）、授权目录、越界拒绝 |
| `actions.test.mjs` | **策略真的挡在后端前面**：目录外路径根本调不到 Windows-MCP；copy/move 两个路径都过检查；文件 mode 白名单；拒绝 exe 路径和命令行参数；后端报错原样上抛 |
| `registration.test.mjs` | 工具注册权限：主人私聊 9 个工具（且**不含** PowerShell/Registry/Process/Scrape）、群聊/非 full/非主人一律 0 个；执行期二次校验 |


### 任务状态机的终态

任务记录落盘在 `modules-data/windows-control/tasks.json`，状态是
`pending / running / paused / awaiting_approval / completed / failed / cancelled`。

结案规则（都实测过）：

- `batch` 一次成功 → 直接 `completed`（实测记录 `#f2d22573 completed`）
- Windows 自检跑完 → `completed` 且 `verified: true`（实测 `#b0d5f8f2 completed verified=True`）
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

