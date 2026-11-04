// ego-browser 适配层：把 ego lite 的 embedded Node runtime 当成浏览器后端。
//
// 真实接口（来自 `ego-browser skill` 与本机实测）：
//   ego-browser nodejs -e "<script>"   一次性执行脚本，顶层 await 可用
//   可用的全局：taskSpace(name|id), listTaskSpaces(), claimTaskSpace(id), takeOverTaskSpace(id)
//   TaskSpace: spaceId / page(label) / pages() / newPage() / finish({keep}) / cdp()
//   Page: goto / goBack / goForward / reload / snapshot / screenshot / click / dblclick / fill
//         press / selectOption / scroll / evaluate / waitForSelector / waitForLoadState
//         waitForTimeout / keyboard.* / mouse.* / cdp
// 每次调用都是新的 Node 进程，但 TaskSpace、标签页和 Page 标签会保留，所以用 spaceId 续上。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const RESULT_PREFIX = '__AURABOT_RESULT__ '
const SPACE_NAME = 'aurabot-browser'

const CANDIDATES = [
  'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego-browser.exe',
  'C:\\Program Files\\Citro Labs\\ego lite\\ego-browser.cmd',
]

/** 找 ego-browser 可执行文件：设置 → 环境变量 → 常见安装路径 → PATH。 */
export function resolveEgoBinary(configured) {
  const fromSetting = String(configured || '').trim()
  if (fromSetting && existsSync(fromSetting)) return { path: fromSetting, source: 'setting' }
  const fromEnv = String(process.env.AURABOT_EGO_BROWSER || '').trim()
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, source: 'env' }
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return { path: candidate, source: 'default' }
  return { path: 'ego-browser', source: 'path' }
}

export function createEgoAdapter({ dataDir, log, settings }) {
  mkdirSync(dataDir, { recursive: true })
  const statePath = join(dataDir, 'ego-state.json')
  let state = { spaceId: null, lastUrl: '', lastOkAt: 0, lastError: '', version: '' }
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    if (saved && typeof saved === 'object') state = { ...state, ...saved }
  } catch { /* 首次运行 */ }

  const saveState = () => {
    try {
      const tmp = statePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, statePath)
    } catch (error) { log.warn('[浏览器] 存档失败：' + error.message) }
  }

  let busy = false
  const isBusy = () => busy

  /** 跑一段脚本，收集 stdout 里的结果行。 */
  const runScript = (code, timeoutMs) => new Promise((resolve) => {
    const bin = resolveEgoBinary(settings().egoBinary)
    let settled = false
    let stdout = ''
    let stderr = ''
    let child = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child?.kill() } catch { /* 已退出 */ }
      finish({ ok: false, timeout: true, message: 'ego-browser 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有返回，浏览器可能卡住了' })
    }, Math.max(15000, timeoutMs))

    try {
      child = spawn(bin.path, ['nodejs', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return finish({ ok: false, message: '启动 ego-browser 失败：' + error.message })
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > 8 * 1024 * 1024) { try { child.kill() } catch { /* ignore */ } }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 6000) })
    child.on('error', (error) => finish({ ok: false, message: 'ego-browser 启动失败：' + error.message }))
    child.on('close', (code_) => {
      // ego-browser 的 embedded runtime 有时把 console.log 写进 stderr，所以两边一起找
      const all = stdout + '\n' + stderr
      const hit = all.split(/\r?\n/).filter((line) => line.includes(RESULT_PREFIX)).pop()
      if (hit) {
        try {
          const parsed = JSON.parse(hit.slice(hit.indexOf(RESULT_PREFIX) + RESULT_PREFIX.length))
          return finish({ ok: true, data: parsed, stderr: stderr.trim(), exitCode: code_ })
        } catch (error) {
          return finish({ ok: false, message: 'ego-browser 返回的结果不是 JSON：' + error.message, raw: hit.slice(0, 400) })
        }
      }
      const tail = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-8).join(' ').slice(0, 700)
      finish({
        ok: false,
        message: code_ === 0
          ? 'ego-browser 跑完了但没给结果' + (tail ? '：' + tail : '')
          : 'ego-browser 退出码 ' + code_ + (tail ? '：' + tail : ''),
        raw: tail,
      })
    })
  })

  /** 生成一次调用的脚本：先接上 space（没有就新建），再执行动作。 */
  const buildScript = ({ action, params, keepSpace }) => {
    const spaceLiteral = state.spaceId ? String(state.spaceId) : 'null'
    const lastUrlLiteral = JSON.stringify(state.lastUrl || '')
    const actionLiteral = JSON.stringify(action)
    const paramsLiteral = JSON.stringify(params || {})
    return `
const __ARGS__ = ${paramsLiteral};
const __ACTION__ = ${actionLiteral};
const __SAVED_SPACE__ = ${spaceLiteral};
const __SAVED_URL__ = ${lastUrlLiteral};
const __out = { action: __ACTION__ };
const __SPACE_NAME__ = __ARGS__.spaceName || ${JSON.stringify(SPACE_NAME)};
const __connect = async () => {
  try {
    const byName = await taskSpace(__SPACE_NAME__);
    return { task: byName, resumed: Boolean(__SAVED_SPACE__) };
  } catch (error) {
    __out.nameError = String(error && error.message || error).slice(0, 140);
  }
  if (__SAVED_SPACE__) {
    try { const t = await taskSpace(__SAVED_SPACE__); return { task: t, resumed: true }; }
    catch (error) { __out.spaceGone = String(error && error.message || error).slice(0, 120); }
  }
  throw new Error('开不了浏览器任务空间：' + (__out.nameError || __out.spaceGone || '未知原因'));
};
const __page = async (task, label) => {
  const want = String(label || 'p1');
  let pages = await task.pages();
  if (!pages.length) await task.newPage();
  pages = await task.pages();
  const found = pages.find((p) => p.label === want);
  if (found) return found;
  if (want !== 'p1' && pages[0]) return pages[0];
  return pages[0];
};
try {
  const { task, resumed } = await __connect();
  __out.spaceId = task.spaceId;
  __out.resumed = resumed;
  if (__ACTION__ === 'state') {
    const pages = await task.pages();
    const page = await __page(task);
    __out.pages = pages.map((p) => p.label);
    __out.url = typeof page.url === 'function' ? await page.url() : '';
    __out.title = typeof page.title === 'function' ? await page.title() : '';
    __out.ownership = task.ownership;
    __out.name = task.name;
  } else if (__ACTION__ === 'tabs') {
    const pages = await task.pages();
    const list = [];
    for (const page of pages) {
      list.push({ label: page.label, url: typeof page.url === 'function' ? await page.url() : '', title: typeof page.title === 'function' ? await page.title() : '' });
    }
    __out.tabs = list;
    __out.spaceId = task.spaceId;
  } else {
    const page = await __page(task, __ARGS__.page);
    __out.label = page.label;
    const step = __ARGS__;
    const A = __ACTION__;
    // ego 每次调用都是新进程，页面会被推回新标签页。
    // 这里记着上次打开的网址，一旦发现页面是空白的就自动回去，免得她对着空白页点半天。
    if (__SAVED_URL__ && !['open', 'newtab', 'tabs', 'closetab'].includes(A)) {
      let currentUrl = '';
      try { currentUrl = String(await page.url()); } catch (error) { currentUrl = ''; }
          const blankPage = !currentUrl
            || currentUrl.indexOf('new-tab-page') >= 0
            || currentUrl.indexOf('about:blank') === 0
            || currentUrl === 'chrome://newtab/';
          if (blankPage) {
        try {
          await page.goto(__SAVED_URL__, { timeout: step.timeout || 35000 });
          await page.waitForLoadState().catch(() => {});
          __out.restored = __SAVED_URL__;
        } catch (error) {
          __out.restoreError = String(error && error.message || error).slice(0, 160);
        }
      }
    }
    if (A === 'open') {
      await page.goto(step.url, { timeout: step.timeout || 45000 });
      await page.waitForLoadState().catch(() => {});
      __out.url = typeof page.url === 'function' ? await page.url() : '';
      __out.title = typeof page.title === 'function' ? await page.title() : '';
      __out.rememberUrl = __out.url;
    } else if (A === 'newtab') {
      const fresh = await task.newPage();
      if (step.url) await fresh.goto(step.url, { timeout: step.timeout || 45000 });
      __out.label = fresh.label;
      __out.url = typeof fresh.url === 'function' ? await fresh.url() : '';
      __out.tabs = (await task.pages()).map((p) => p.label);
    } else if (A === 'closetab') {
      if (page && typeof page.close === 'function') await page.close();
      __out.tabs = (await task.pages()).map((p) => p.label);
    } else if (A === 'back') {
      await page.goBack({ timeout: step.timeout || 30000 });
      await page.waitForLoadState().catch(() => {});
      __out.url = typeof page.url === 'function' ? await page.url() : '';
    } else if (A === 'forward') {
      await page.goForward({ timeout: step.timeout || 30000 });
      await page.waitForLoadState().catch(() => {});
      __out.url = typeof page.url === 'function' ? await page.url() : '';
    } else if (A === 'reload') {
      await page.reload({ timeout: step.timeout || 30000 });
      await page.waitForLoadState().catch(() => {});
      __out.url = typeof page.url === 'function' ? await page.url() : '';
    } else if (A === 'snapshot') {
      const text = String(await page.snapshot(step.options || {}) || '');
      __out.snapshot = step.maxChars ? text.slice(0, step.maxChars) : text;
      __out.length = text.length;
      __out.url = typeof page.url === 'function' ? await page.url() : '';
      __out.title = typeof page.title === 'function' ? await page.title() : '';
    } else if (A === 'click') {
      if (typeof page.bringToFront === 'function') { try { await page.bringToFront(); } catch (e) {} }
      await page.click(step.target, step.options || {});
      await page.waitForTimeout(step.settle || 300);
      __out.url = typeof page.url === 'function' ? await page.url() : '';
      __out.title = typeof page.title === 'function' ? await page.title() : '';
      __out.ok = true;
    } else if (A === 'dblclick') {
      await page.dblclick(step.target, step.options || {});
      await page.waitForTimeout(step.settle || 300);
      __out.ok = true;
    } else if (A === 'hover') {
      await page.hover(step.target, step.options || {});
      __out.ok = true;
    } else if (A === 'fill') {
      // ego 的 fill 作用在当前可见页面上；先提到前台，再按 clearFirst 语义填
      if (typeof page.bringToFront === 'function') { try { await page.bringToFront(); } catch (e) {} }
      const val = String(step.value == null ? '' : step.value);
      await page.fill(step.target, val, { clearFirst: step.clearFirst !== false });
      __out.ok = true;
      __out.filled = val.length;
      __out.value = val;
    } else if (A === 'press') {
      if (step.target) await page.press(step.target, step.key);
      else await page.keyboard.press(step.key);
      await page.waitForTimeout(step.settle || 200);
      __out.ok = true;
    } else if (A === 'select') {
      const option = {};
      if (step.label != null) option.label = step.label;
      if (step.value != null) option.value = step.value;
      await page.selectOption(step.target, option);
      __out.ok = true;
    } else if (A === 'scroll') {
      if (step.target) await page.locator(step.target).scrollIntoViewIfNeeded().catch(() => {});
      if (step.deltaY != null && page.mouse && typeof page.mouse.wheel === 'function') await page.mouse.wheel(0, step.deltaY);
      else await page.evaluate((dy) => window.scrollBy(0, dy), step.deltaY || 600);
      await page.waitForTimeout(step.settle || 300);
      __out.ok = true;
    } else if (A === 'evaluate') {
      const result = await page.evaluate(new Function('return (' + step.expression + ')'));
      __out.value = result;
    } else if (A === 'screenshot') {
      const shot = await page.screenshot(step.path ? { path: step.path } : undefined);
      __out.saved = step.path || '';
      __out.bytes = typeof shot === 'string' ? shot.length : 0;
      __out.url = typeof page.url === 'function' ? await page.url() : '';
    } else if (A === 'wait') {
      if (step.urlPattern) await page.waitForURL(step.urlPattern, { timeout: step.timeout || 30000 });
      else if (step.target) await page.waitForSelector(step.target, { timeout: step.timeout || 30000 });
      else await page.waitForTimeout(step.ms || 1000);
      __out.ok = true;
      __out.url = typeof page.url === 'function' ? await page.url() : '';
    } else if (A === 'upload') {
      const chooserPromise = page.waitForEvent ? page.waitForEvent('filechooser', { timeout: step.timeout || 15000 }) : null;
      if (step.target) await page.click(step.target, { label: '打开文件选择' });
      const chooser = chooserPromise ? await chooserPromise : null;
      if (!chooser) throw new Error('没有等到文件选择框');
      await chooser.setFiles(step.files || []);
      __out.ok = true;
    } else if (A === 'download') {
      const evt = page.waitForEvent ? page.waitForEvent('download', { timeout: step.timeout || 30000 }) : null;
      if (step.target) await page.click(step.target, { label: '开始下载' });
      const dl = evt ? await evt : null;
      if (!dl) throw new Error('没有等到下载事件');
      const target = step.path || '';
      if (target) await dl.saveAs(target);
      __out.ok = true;
      __out.saved = target;
    } else {
      throw new Error('不认识的动作：' + A);
    }
  }
  if (!__out.spaceId) __out.spaceId = __SAVED_SPACE__;
  if (__ARGS__.finish && __ARGS__.spaceName && typeof task.finish === 'function') {
    try { await task.finish({ keep: [] }); __out.finished = true; } catch (error) { __out.finishError = String(error && error.message || error).slice(0, 120); }
  }
} catch (error) {
  __out.error = String(error && error.message || error).slice(0, 900);
  __out.failed = true;
  try { const spaces = await listTaskSpaces(); __out.spaces = spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership })).slice(0, 10); } catch (e2) {}
}
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(__out));
`
  }


  /**
   * 批量脚本：一次进程里跑完一串动作。
   *
   * 为什么需要它：ego-browser 每次调用都是新进程，实测**页面会被重置回新标签页**
   * （goto 过的 URL 不保留），所以"打开 → 填表 → 提交"这种多步任务不能拆成多次调用。
   * 必须在一个进程里连着做完，页面状态才不会丢。
   */
  const buildBatchScript = ({ steps, spaceName }) => {
    const list = JSON.stringify(Array.isArray(steps) ? steps : [])
    return `
const __STEPS__ = ${list};
const __SPACE_NAME__ = ${JSON.stringify(spaceName || SPACE_NAME)};
const __IS_TEMP__ = ${spaceName ? 'true' : 'false'};
const __out = { action: 'batch', results: [] };
try {
  const task = await taskSpace(__SPACE_NAME__);
  __out.spaceId = task.spaceId;
  let pages = await task.pages();
  if (!pages.length) { await task.newPage(); pages = await task.pages(); }
  const page = pages[0];
  __out.label = page.label;
  for (let i = 0; i < __STEPS__.length; i++) {
    const step = __STEPS__[i] || {};
    const action = String(step.action || '');
    const started = Date.now();
    try {
      let value;
      if (action === 'open') {
        await page.goto(String(step.url), { timeout: step.timeout || 45000 });
        await page.waitForLoadState().catch(() => {});
        value = { url: await page.url(), title: await page.title() };
      } else if (action === 'fill') {
        if (typeof page.bringToFront === 'function') { try { await page.bringToFront(); } catch (e) {} }
        const val = String(step.value == null ? '' : step.value);
        await page.fill(String(step.target), val, { clearFirst: step.clearFirst !== false });
        value = { value: val };
      } else if (action === 'click') {
        if (typeof page.bringToFront === 'function') { try { await page.bringToFront(); } catch (e) {} }
        await page.click(String(step.target), step.options || {});
        await page.waitForTimeout(step.settle || 300);
        value = { url: await page.url(), title: await page.title() };
      } else if (action === 'press') {
        if (step.target) await page.press(String(step.target), String(step.key));
        else await page.keyboard.press(String(step.key));
        await page.waitForTimeout(step.settle || 200);
        value = {};
      } else if (action === 'select') {
        const option = {};
        if (step.label != null) option.label = step.label;
        if (step.value != null) option.value = step.value;
        await page.selectOption(String(step.target), option);
        value = {};
      } else if (action === 'scroll') {
        if (step.target) await page.locator(String(step.target)).scrollIntoViewIfNeeded().catch(() => {});
        if (step.deltaY != null && page.mouse && typeof page.mouse.wheel === 'function') await page.mouse.wheel(0, Number(step.deltaY));
        else await page.evaluate(new Function('return (function (dy) { window.scrollBy(0, dy); })'), Number(step.deltaY) || 600);
        await page.waitForTimeout(step.settle || 200);
        value = {};
      } else if (action === 'wait') {
        if (step.urlPattern) await page.waitForURL(step.urlPattern, { timeout: step.timeout || 30000 });
        else if (step.target) await page.waitForSelector(String(step.target), { timeout: step.timeout || 30000 });
        else await page.waitForTimeout(step.ms || 1000);
        value = { url: await page.url() };
      } else if (action === 'evaluate') {
        value = await page.evaluate(new Function('return (' + String(step.expression) + ')'));
      } else if (action === 'snapshot') {
        const text = String(await page.snapshot(step.options || {}) || '');
        value = { length: text.length, snapshot: text.slice(0, step.maxChars || 4000) };
      } else if (action === 'screenshot') {
        const shot = await page.screenshot(step.path ? { path: String(step.path) } : undefined);
        value = { saved: step.path || '', bytes: typeof shot === 'string' ? shot.length : 0 };
      } else {
        throw new Error('批量里不认识的动作：' + action);
      }
      __out.results.push({ index: i, action, ok: true, ms: Date.now() - started, value });
    } catch (error) {
      __out.results.push({ index: i, action, ok: false, ms: Date.now() - started, error: String(error && error.message || error).slice(0, 300) });
      __out.failedAt = i;
      break;
    }
  }
  __out.okCount = __out.results.filter((r) => r.ok).length;
  __out.done = __out.results.length === __STEPS__.length;
  if (__IS_TEMP__ && __STEPS__.length && __out.done) {
    try { await task.finish({ keep: [] }); __out.finished = true; } catch (error) { __out.finishError = String(error && error.message || error).slice(0, 120); }
  }
  __out.url = await page.url().catch(() => '');
} catch (error) {
  __out.error = String(error && error.message || error).slice(0, 600);
  __out.failed = true;
}
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(__out));
`
  }

  /** 对外唯一出口：跑一个动作，自动处理 space 失效重连。 */
  const call = async (action, params = {}, options = {}) => {
    if (busy) return { ok: false, message: '浏览器正在执行上一个动作，等一下' }
    busy = true
    const timeoutMs = Math.max(20000, Math.min(180000, Number(options.timeoutMs) || 75000))
    try {
      const script = action === 'batch'
        ? buildBatchScript({ steps: params && params.steps, spaceName: params && params.spaceName })
        : buildScript({ action, params })
      let result = await runScript(script, timeoutMs)
      if (result.ok && result.data && result.data.spaceId) {
        if (state.spaceId !== result.data.spaceId) {
          state.spaceId = result.data.spaceId
          saveState()
        }
      }
      // space 被关掉（用户手动关窗口 / finish）→ 重建一次再试
      const data = result.data || {}
      const spaceGone = result.ok && data.failed && /task space not found|no such space|space .*not found/i.test(String(data.error || ''))
      if (spaceGone) {
        log.warn('[浏览器] 之前的任务空间没了，重开一个')
        state.spaceId = null
        saveState()
        result = await runScript(script, timeoutMs)
        if (result.ok && result.data && result.data.spaceId) {
          state.spaceId = result.data.spaceId
          saveState()
        }
      }
      if (!result.ok) {
        state.lastError = result.message || ''
        saveState()
        return result
      }
      const out = result.data || {}
      if (out.failed) {
        state.lastError = String(out.error || '未知错误')
        saveState()
        return {
          ok: false,
          message: '浏览器动作失败：' + state.lastError,
          data: out,
        }
      }
      if (out.rememberUrl) state.lastUrl = out.rememberUrl
      else if (action === 'open' && out.url) state.lastUrl = out.url
      state.lastOkAt = Date.now()
      state.lastError = ''
      saveState()
      return { ok: true, data: out }
    } finally {
      busy = false
    }
  }

  /** 探测 CLI 是否装了、能不能跑（不碰页面）。 */
  const probe = async () => {
    const bin = resolveEgoBinary(settings().egoBinary)
    if (bin.source !== 'path' && !existsSync(bin.path)) {
      return { ok: false, available: false, path: bin.path, message: '找不到 ego-browser：' + bin.path }
    }
    const result = await runScript(`
const __out = {};
try {
  __out.cli = typeof ego !== 'undefined' ? 'sdk' : 'runtime';
  const spaces = await listTaskSpaces();
  __out.spaces = spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership }));
} catch (error) {
  __out.error = String(error && error.message || error);
}
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(__out));
`, 45000)
    if (!result.ok) return { ok: false, available: false, path: bin.path, message: result.message }
    const data = result.data || {}
    if (data.error) return { ok: false, available: false, path: bin.path, message: 'ego-browser 能启动但连不上浏览器：' + data.error }
    state.version = 'ego-lite'
    saveState()
    return { ok: true, available: true, path: bin.path, source: bin.source, spaces: data.spaces || [], spaceId: state.spaceId }
  }

  const spaceInfo = () => ({ spaceId: state.spaceId, lastUrl: state.lastUrl, lastOkAt: state.lastOkAt, lastError: state.lastError })
  const resetSpace = () => {
    state.spaceId = null
    state.lastUrl = ''
    state.lastError = ''
    saveState()
  }

  return { call, probe, spaceInfo, resetSpace, isBusy, buildScript, SPACE_NAME }
}