// 权限与风险策略：所有判断都在执行层，不依赖提示词。
//
// 分三级：
//   low    读取类（快照、截图、查状态、取文本）—— 主人授权范围内直接跑
//   medium 会改变页面或产生外部影响的动作（打开、点击、输入、下载、上传）
//   high   明确会花钱/对外发布/删除的动作 —— 必须主人在本地面板确认，模型自称"已确认"无效

export const RISK_LEVELS = ['low', 'medium', 'high']

export const ACTION_RISK = {
  state: 'low',
  tabs: 'low',
  probe: 'low',
  snapshot: 'low',
  screenshot: 'low',
  evaluate: 'low',
  wait: 'low',
  hover: 'low',
  scroll: 'low',
  newtab: 'low',
  closetab: 'low',
  open: 'medium',
  back: 'medium',
  forward: 'medium',
  reload: 'medium',
  click: 'medium',
  dblclick: 'medium',
  fill: 'medium',
  press: 'medium',
  select: 'medium',
  download: 'medium',
  upload: 'medium',
  batch: 'medium',
}

// 目标文本里出现这些词，就把动作提到 high（更保守总没错）
const HIGH_RISK_WORDS = [
  '支付', '付款', '购买', '下单', '结算', '提交订单', '确认支付', '充值', '转账', '打款',
  '发布', '发表', '发送', '提交', '删除', '注销', '解绑', '退订', '取消订单', '确认收货',
  'pay', 'checkout', 'purchase', 'buy now', 'place order', 'delete', 'unsubscribe', 'publish', 'send',
]

const parseList = (text) => String(text || '')
  .split(/[\n,，;；]/)
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean)

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

/** 判断这次动作的风险等级（在 action 默认等级之上升级）。 */
export function riskOf(action, params = {}) {
  if (action === 'batch') {
    const list = Array.isArray(params && params.steps) ? params.steps : []
    const levels = list.map((step) => riskOf(String(step && step.action || ''), step || {}))
    if (levels.includes('high')) return 'high'
    if (levels.includes('medium')) return 'medium'
    return 'low'
  }
  let level = ACTION_RISK[action] || 'medium'
  if (level !== 'low' && params && params.highRisk) level = 'high'
  if (action === 'click' || action === 'dblclick' || action === 'press' || action === 'fill') {
    const target = String(params.target || '') + ' ' + String(params.value || '') + ' ' + String(params.key || '')
    const lower = target.toLowerCase()
    if (HIGH_RISK_WORDS.some((word) => lower.includes(word.toLowerCase()))) level = 'high'
  }
  if (action === 'upload') {
    const files = Array.isArray(params.files) ? params.files : []
    if (files.some((file) => /\.(exe|msi|bat|cmd|ps1|vbs|scr|jar|dll)$/i.test(String(file)))) level = 'high'
  }
  return level
}

export function createBrowserPolicy({ settings, log }) {
  const checkUrl = (url, options = {}) => {
    const raw = String(url || '').trim()
    // 自检用的本地沙箱页：data: / about:blank 没有 origin，读不到任何站点数据
    if (options.allowLocal && /^(data:|about:blank)/i.test(raw)) return { ok: true, host: 'local', local: true }
    const host = hostOf(raw)
    if (!host) return { ok: false, message: '网址看不懂，直接给完整链接（要带 http/https）' }
    const deny = parseList(settings().denyDomains)
    const allow = parseList(settings().allowDomains)
    if (deny.some((item) => host === item || host.endsWith('.' + item))) {
      return { ok: false, message: '域名「' + host + '」在禁止名单里，不能打开' }
    }
    if (allow.length && !allow.some((item) => host === item || host.endsWith('.' + item))) {
      return { ok: false, message: '域名「' + host + '」不在允许名单里。要访问请在面板「允许的域名」里加上，或清空允许名单' }
    }
    return { ok: true, host }
  }

  /** 页面内容一律当不可信资料：README 里也这么写，这里只负责截断和去噪。 */
  const sanitize = (text, max = 12000) => {
    const value = String(text == null ? '' : text)
    return value.length > max ? value.slice(0, max) + '\n…（截断，原长 ' + value.length + ' 字）' : value
  }

  const isDryRun = () => Boolean(settings().dryRun) || Boolean(settings().readOnly)

  return { checkUrl, sanitize, isDryRun, riskOf, parseList, hostOf }
}