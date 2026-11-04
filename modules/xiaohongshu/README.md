# 小红书 · Aurabot 扩展模块 v0.2.0

在 Aurabot 面板「平台 → 小红书」里管理一台专用浏览器里的**你自己**的小红书账号。
所有页面操作都交给 `worker.py`（复用本机 `~/.dsh/skills/xiaohongshu-skills` 的 CDP 实现），
本模块只负责：状态、开关、频率、草稿确认、结果汇报。

## 能做什么

| 能力 | 入口 | 验证情况 |
|---|---|---|
| 登录状态 / 账号识别 | 面板「扫码登录」「检查登录」 | 已用真实账号验证（已登录：百通工程师不糊锅老师 / `66a30c2f000000001d032d47`） |
| 首页推荐、关键词搜索 | 面板按钮 / `/小红书 看看`、`/小红书 搜 关键词` / 工具 `xhs_home`、`xhs_search` | 已验证（首页 34 条、搜索有结果） |
| 读笔记详情与评论 | 面板「读一篇笔记」/ 工具 `xhs_read` | 已验证 |
| 我的笔记 | 面板「我的笔记」/ `/小红书 笔记` | 已验证（5 篇） |
| 评论与 @ 通知 | 面板「看评论和@」/ `/小红书 评论` | 已验证（20 条，含 comment id、笔记 token） |
| 笔记数据（曝光/观看/点赞…） | 面板「看笔记数据」/ `/小红书 数据` | 已验证（创作者中心真实数据） |
| 私信列表 / 读会话 | 面板「私信」/ `/小红书 私信`、`/小红书 读私信 1` | 已验证（10 个会话、真实聊天记录） |
| 发私信 | 面板会话区 / `/小红书 回私信 1 内容` / 工具 `xhs_send_dm` | 已验证（真实发出并回读确认） |
| 定时浏览 + 分享给主人 | 面板「浏览与分享」 | 代码已实现，默认关闭；触发条件走开关与时段，未在无人值守下长跑 |
| 自动回复私信 | 面板「私信」 | 逻辑与发送能力已验证，自动循环默认关闭 |
| 自动回复评论 | 面板「自动回复评论」 | ⚠ 见下方「已知限制」 |
| 评论 / 回复评论 / 发布笔记草稿 | 面板「公开互动与发布」/ 工具 `xhs_prepare_draft` | 草稿→确认→执行链路已实现；真实发布未执行 |

## 登录

三种方式，面板里都在「小红书登录」卡片：

1. **扫码登录（推荐）**：点「扫码登录」，二维码直接显示在面板里，用小红书 App 扫；
   扫完自动轮询 75 秒确认。浏览器是无头运行的，不占桌面。
2. **打开登录窗口**：弹一个有窗口的专用浏览器，你手动登录/过验证码。
3. **Cookie 分项导入**：填 `web_session`（必填）、`a1`、`webId`、`websect`、`gid`，
   或「其他」里直接贴 `name=value; name2=value2`。

登录态保存在 `plugins-data/aurabot/modules-data/xiaohongshu/browser-profile/`，
**不回显到面板、不进聊天、不进模型上下文**；日志里的敏感值由插件统一脱敏。

> 关于「复用 ego-browser 的登录状态」：ego lite 的 profile 是它自己的加密存储，
> Aurabot 无法直接读取。可行的替代是先在 ego lite 登录小红书，再用
> `ego-browser nodejs` + `Network.getCookies` 导出 Cookie 走上面的方式导入。
> 实测当前 ego lite 里小红书也是未登录状态，所以这条路暂时没有额外收益。

## 配置项（面板里改，记得点底部「保存设置」）

- 浏览：`autoBrowse`、`autoShare`、`intervalMinutes`、`keywords`、`startHour`/`endHour`、`maxSharesPerDay`
- 评论回复：`autoReply`、`replyCheckMinutes`（≥20）、`maxRepliesPerDay`、`replyGapMinutes`
- 私信回复：`autoDM`、`dmCheckMinutes`、`maxDMPerDay`、`dmGapMinutes`
- 账号：`accountUserId` / `accountName`（登录后自动填）

所有定时任务都受三层约束：本模块 `enabled`、Aurabot 总开关、`dryRun`（试运行）。
自动回复首次启用会先建立基线，历史评论/历史私信不会被补回。
读通知失败、登录失效、结果不明确时**当天直接停**并在面板写明原因。

## 主人指令

QQ 私聊（只认主人）：

```
/小红书 状态 | 看看 | 搜 DeepSeek | 笔记 | 数据 | 私信 | 读私信 1 | 回私信 1 内容 | 评论 | 回复 | 帮助
```

大肥鱼自己也能用这些工具（仅主人私聊、`level=full`）：
`xhs_status` `xhs_home` `xhs_search` `xhs_read` `xhs_notifications` `xhs_my_notes`
`xhs_metrics` `xhs_messages` `xhs_read_dm` `xhs_send_dm` `xhs_prepare_draft`。

## 栏上的状态点

「平台」分组里每个 tab 后面的小圆点：绿＝启用，灰＝关闭。内置 tab 本来就有，
扩展模块的 tab 原来没有——因为 `client.js` 生成扩展 tab 时没带 `flag` 字段，
`mark()` 里 `if (!t.flag) return null` 直接不画点。

改了 `client.js` 一行（约 3370 行）：

```js
// 改前
.map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id }))
// 改后
.map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id,
  flag: (m.defaults && Object.prototype.hasOwnProperty.call(m.defaults, 'enabled')) ? 'ext.' + m.id + '.enabled' : '' }))
```

效果：所有「defaults 里有 `enabled`」的扩展模块都和内置模块一样显示绿/灰点，
没有 `enabled` 的模块保持原样（不画点）。点上的 tooltip 也是内置那套「开着 / 关着」。

⚠ 这一行改在插件本体 `node_modules/dsh-aurabot-qq/client/client.js` 上，
Aurabot 升级会覆盖，升级后重打这一行即可（或等上游支持）。

## 未登录也能刷（尽力而为）

- `do_feeds` / `do_search` / `do_detail` 不再因为没登录就直接拒绝：先去试，
  读到就返回并标「游客态」，读不到就把真实原因写出来。
- 分享本身不依赖登录（只是把链接发到 QQ 私聊），所以没登录也能把链接给你。
- 定时浏览在没登录时照常尝试，命中带 token 的笔记就按开关分享。

实测结论（2026-11-04）：**全新资料目录、完全没有任何 cookie 时访问
`xiaohongshu.com/explore`，小红书会直接跳到 `website-login/error`，
页面写「当前网络存在风险，请切换可靠网络后重试 300012」。**
也就是说游客态能不能刷取决于平台当时的风控，不取决于插件。
所以策略是「尽力 + 如实」：试，读不到就写「被挡在登录风控页」，绝不假装刷到了。

## 分享：一律带链接

分享的消息固定是「一句话 + 一条能直接点开的链接」，两个入口：

- 面板「搜索与账号数据」：搜完每篇笔记后面有「分享给我」，点了就把链接发到你的 QQ 私聊
- 面板「分享链接给我」：粘贴小红书里复制的链接（`www.xiaohongshu.com/explore/…` 或 `xhslink.com` 短链），直接发
- 她说「发我看看 / 分享给我」时会调 `xhs_share` 工具，同样走这条链路
- 定时浏览命中 `autoShare` 时也走同一个函数

链接形态（`=` 保留，`+`/`&` 转义，和官方分享链接一致）：

```
https://www.xiaohongshu.com/explore/<笔记 id>?xsec_token=<token>&xsec_source=pc_feed
```

已实测：链接成功发到主人 QQ 私聊，标题在上一行。

## 已知限制（实测结论，不含猜测）

1. **评论回复已修好，但依赖一个平台细节。**
   小红书把评论节点写成 `id="comment-<评论 id>"`，**没有** `data-comment-id` / `data-id`，
   技能库按 data 属性匹配会全部落空（`target_comment_not_matched`）。
   本模块的 `do_reply` 改成按 `#comment-<id>` 精确定位 → 点 `.reply` →
   往 `.content-input` 输入 → 点 `button.btn.submit`（"发送"）→ 回读确认。
   已实测提交成功（2026-11-03，回复「老师好，我有4个ds的窗想接入qq…」那条）。
   如果评论排序靠后没渲染出来，会滚动最多 12 次仍未命中就如实报「没加载出这条评论」，不会乱点。
2. **发布笔记只到「草稿 + 确认」为止，没有真的发过一条。**
   发布需要真实素材（图片/视频绝对路径），会污染账号，故未做破坏性验证。
3. 搜索结果的 `xsec_token` 有时为空，读详情/评论时要挑带 token 的条目。
4. 平台接口是页面内 `fetch`（继承登录 Cookie，不带 x-s 签名）：
   `im/web/v3/chats`、`messages/history`、`get_unread` 可用；
   `v2/user/me`、`im/web/v3/chats?num=20`（缺参数时）会 406/500。
   所以账号昵称走「主页快照」，会话列表固定带 `limit/complete/page/source` 参数。
5. 评论与 @ 通知接口在**非通知页**调用会被拦，所以 `do_mentions` 会先导航到 `/notification`。
6. 定时任务（浏览/分享/评论回复/私信回复）没有在无人值守下长跑过，
   只验证过单次链路；频率与暂停逻辑按代码审阅为正确，首次开启建议先观察一天。

## 文件

```
index.mjs   模块主体：工具、命令、面板接口、定时任务、草稿
panel.js    面板 UI（登录 / 运行情况 / 浏览 / 评论 / 私信 / 数据 / 发布 / 结果）
worker.py   浏览器执行层：stdin 一个 JSON 请求，stdout 一个 JSON 结果
```

`worker.py` 支持的操作：`status qrcode qrcode_wait open close cookie logout
feeds search detail mentions metrics my_notes profile dms dm_thread dm_send
comment reply publish upvote bookmark probe`。

## 排查

- 面板「运行情况」看最近一次的真实返回
- 插件「日志」页按 `xiaohongshu` 过滤
- 想看平台当前接口：`worker.py` 的 `probe` 操作（打开页面并收集 `/api/` 请求）
- 专用浏览器卡住：面板没入口，可直接结束占用 `9420` 端口的 chrome 进程，再点「检查登录」