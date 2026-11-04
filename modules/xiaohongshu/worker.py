"""Aurabot 小红书扩展：浏览器执行层。

单次调用协议：stdin 读一个 JSON 请求，stdout 写一个 JSON 结果。
凭据只存在于专用浏览器资料目录（AURABOT_XHS_DATA/browser-profile），
不写入 argv、不回显给调用方、不写进日志。

所有“读取”都可能有平台侧失败。失败必须如实返回 ok=false 与原因，
不允许把未确认的结果当成成功。
"""
import contextlib
import io
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request

def _find_skill_dir():
    """找到 xiaohongshu-skills 里的 scripts 目录。找不到就返回 None，由上层给出人话报错。"""
    here = pathlib.Path(__file__).resolve().parent
    dsh_home = os.environ.get('DSH_HOME') or str(pathlib.Path.home() / '.dsh')
    candidates = [
        os.environ.get('AURABOT_XHS_SKILL_DIR', ''),          # 环境变量优先
        str(here / 'xiaohongshu-skills' / 'scripts'),          # 就放在扩展文件夹里
        str(pathlib.Path(dsh_home) / 'skills' / 'xiaohongshu-skills' / 'scripts'),
        str(pathlib.Path.home() / '.dsh' / 'skills' / 'xiaohongshu-skills' / 'scripts'),
        r'C:\Users\33944\.dsh\skills\xiaohongshu-skills\scripts',  # 开发机的老路径，兜底
    ]
    for item in candidates:
        if not item:
            continue
        p = pathlib.Path(item)
        if (p / 'cdp_publish.py').exists():
            return p
    return None


SKILL_DIR = _find_skill_dir()
if SKILL_DIR is None:
    raise RuntimeError(
        '没找到 xiaohongshu-skills 的 scripts 目录。三个办法：\n'
        '1) 把 xiaohongshu-skills 整个文件夹放进本扩展文件夹里；\n'
        '2) 放到 %USERPROFILE%\\.dsh\\skills\\xiaohongshu-skills\\；\n'
        '3) 设环境变量 AURABOT_XHS_SKILL_DIR 指向它的 scripts 目录。'
    )
sys.path.insert(0, str(SKILL_DIR))
from cdp_publish import XiaohongshuPublisher  # noqa: E402

HOME_URL = 'https://www.xiaohongshu.com'
EXPLORE_URL = HOME_URL + '/explore'
MESSAGES_URL = HOME_URL + '/messages'
NOTIFICATION_URL = HOME_URL + '/notification'
API_ORIGIN = 'https://edith.xiaohongshu.com'
PORT = int(os.environ.get('AURABOT_XHS_PORT', '9420'))
DATA_DIR = pathlib.Path(os.environ['AURABOT_XHS_DATA'])
PROFILE_DIR = DATA_DIR / 'browser-profile'
SESSION_NAMES = ('web_session', 'web_session_id', 'customerClientId', 'access-token')
CHROME_CANDIDATES = [
    os.environ.get('AURABOT_XHS_CHROME', ''),
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe'),
]
CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


# --------------------------------------------------------------------------
# 基础设施
# --------------------------------------------------------------------------
def find_chrome():
    for raw in CHROME_CANDIDATES:
        if raw and pathlib.Path(raw).is_file():
            return raw
    raise RuntimeError('没有找到 Chrome 或 Edge，请在扩展文件夹里设置环境变量 AURABOT_XHS_CHROME')


def port_open(port=PORT):
    with socket.socket() as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def launch(headless=True):
    """确保专用浏览器在运行并返回 (进程或 None, 是否复用)。"""
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    if port_open():
        return None, True
    flags = [find_chrome(), '--remote-debugging-address=127.0.0.1',
             '--remote-debugging-port=%d' % PORT, '--user-data-dir=%s' % PROFILE_DIR,
             '--no-first-run', '--no-default-browser-check', '--restore-last-session']
    if headless:
        flags.append('--headless=new')
    # headless 下窗口不出现；有窗口模式让用户扫码或人工观察。
    flags.append('about:blank')
    proc = subprocess.Popen(flags, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            creationflags=CREATE_NO_WINDOW if headless else 0)
    for _ in range(250):
        if proc.poll() is not None:
            raise RuntimeError('小红书专用浏览器启动失败（资料目录可能正被占用）')
        if port_open():
            return proc, False
        time.sleep(0.1)
    raise RuntimeError('小红书专用浏览器启动超时')


def attach():
    pub = XiaohongshuPublisher(host='127.0.0.1', port=PORT, account_name='aurabot-xhs')
    pub.login_cache_ttl_seconds = 0
    pub.connect(reuse_existing_tab=True)
    pub._send('Network.enable')
    return pub


def ensure_page(pub):
    """保证当前标签页在小红书站点内：页面内 fetch 与 localStorage 都需要这个来源。"""
    try:
        current = pub._evaluate('location.href')
    except Exception:
        current = ''
    if 'xiaohongshu.com' not in str(current or ''):
        pub._navigate(EXPLORE_URL)
        pub._sleep(2.2, minimum_seconds=0.8)
    return current


def shutdown(pub, proc):
    if pub is not None and pub.ws:
        try:
            pub._send('Browser.close')
        except Exception:
            pass
        try:
            pub.disconnect()
        except Exception:
            pass
    if proc is not None:
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


def cookies_now(pub):
    got = pub._send('Network.getCookies', {'urls': [HOME_URL + '/']})
    return got.get('cookies', []) if isinstance(got, dict) else []


def has_session(cookie_list):
    return any(c.get('name') in SESSION_NAMES and c.get('value') for c in cookie_list)


def page_fetch(pub, url, method='GET', body=None):
    """在页面上下文里发请求，继承登录 Cookie。返回 (ok, status, payload)。"""
    js = """
        (() => fetch(%s, {
            method: %s,
            credentials: 'include',
            headers: {'Accept': 'application/json, text/plain, */*'%s},
            %s
        }).then(async (r) => ({status: r.status, ok: r.ok, body: await r.text()}))
          .catch((e) => ({status: 0, ok: false, body: String(e)})))()
    """ % (
        json.dumps(url),
        json.dumps(method),
        ",'Content-Type': 'application/json'" if body else '',
        ("body: JSON.stringify(%s)," % json.dumps(body, ensure_ascii=False)) if body else '',
    )
    raw = pub._evaluate(js)
    if not isinstance(raw, dict):
        return False, 0, None
    if not raw.get('ok') or int(raw.get('status') or 0) != 200:
        return False, int(raw.get('status') or 0), None
    try:
        payload = json.loads(raw.get('body') or '')
    except Exception:
        return False, int(raw.get('status') or 0), None
    if isinstance(payload, dict) and payload.get('success') is False:
        return False, int(raw.get('status') or 0), payload
    return True, 200, payload


def data_of(payload):
    if not isinstance(payload, dict):
        return {}
    data = payload.get('data')
    return data if isinstance(data, dict) else {}


def first_list(data, keys):
    for key in keys:
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, list):
            return value
    return []


SELF_PATHS = ('/api/sns/web/v2/user/me', '/api/sns/web/v1/user/me', '/api/sns/web/v1/user/selfinfo')


def self_info(pub):
    """拿本人账号信息（昵称、用户 ID、粉丝数）。失败返回空字典，不编造。"""
    for path in SELF_PATHS:
        ok, _, payload = page_fetch(pub, API_ORIGIN + path)
        if not ok:
            continue
        data = data_of(payload)
        basic = data.get('basic_info') or data.get('basicInfo') or data.get('user') or data
        if not isinstance(basic, dict):
            continue
        uid = basic.get('user_id') or basic.get('userId') or ''
        nickname = basic.get('nickname') or basic.get('nick_name') or basic.get('nickName') or ''
        if not (uid or nickname):
            continue
        return {
            'userId': str(uid or '').strip(),
            'nickname': str(nickname or '').strip(),
            'redId': str(basic.get('red_id') or basic.get('redId') or '').strip(),
            'fans': basic.get('fans') or basic.get('fans_count') or '',
            'following': basic.get('following') or basic.get('follows') or '',
            'desc': str(basic.get('desc') or '').strip()[:200],
            'guest': bool(basic.get('guest')),
            'endpoint': path,
        }
    return {}


def own_user_id(pub, fallback=''):
    """自己的用户 ID：侧边栏「我」的链接最可信，其次 localStorage 里带自己 ID 的键。"""
    sidebar = pub._evaluate("""
        (() => {
            const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
            const links = [...document.querySelectorAll('a[href^="/user/profile/"]')];
            const mine = links.find((a) => /^(我|我的)$/.test(norm(a.innerText)));
            const target = mine || links[0];
            const hit = target ? String(target.getAttribute('href') || '').match(/\\/user\\/profile\\/([0-9a-zA-Z]+)/) : null;
            return hit ? hit[1] : '';
        })()
    """)
    if isinstance(sidebar, str) and len(sidebar) >= 16:
        return sidebar
    stored = pub._evaluate("""
        (() => {
            const hits = {};
            for (const key of Object.keys(localStorage)) {
                const m = key.match(/^xhs-pc-search-history-(\\w+)$/) ||
                          key.match(/^xhs-favicon-badge-track-state:(\\w+)$/);
                if (m) hits[m[1]] = (hits[m[1]] || 0) + 1;
            }
            const rows = Object.entries(hits).sort((a, b) => b[1] - a[1]);
            return rows.length ? rows[0][0] : '';
        })()
    """)
    if isinstance(stored, str) and len(stored) >= 16:
        return stored
    info = self_info(pub)
    if info.get('userId'):
        return info['userId']
    return str(fallback or '').strip()


# --------------------------------------------------------------------------
# 登录
# --------------------------------------------------------------------------
def do_status(pub):
    cookie_list = cookies_now(pub)
    if not has_session(cookie_list):
        return {'ok': False, 'loggedIn': False,
                'message': '未检测到登录会话，请扫码登录或导入 Cookie'}
    pub._navigate(EXPLORE_URL)
    pub._sleep(2.0, minimum_seconds=0.8)
    if not pub.check_home_login():
        return {'ok': False, 'loggedIn': False,
                'message': '主页提示未登录，请重新扫码或更新 Cookie'}
    info = self_info(pub)
    uid = own_user_id(pub) or info.get('userId') or ''
    name = info.get('nickname') or ''
    if uid and not name:
        try:
            snapshot = pub.get_profile_snapshot(user_id=uid)
            if isinstance(snapshot, dict):
                for key in ('nickname', 'nickName', 'user_name', 'userName', 'name'):
                    value = snapshot.get(key)
                    if isinstance(value, str) and value.strip():
                        name = value.strip()
                        break
                if not name:
                    for holder in ('profile', 'basic_info', 'user', 'user_info'):
                        node = snapshot.get(holder)
                        if isinstance(node, dict):
                            name = str(node.get('nickname') or node.get('nickName') or '').strip()
                            if name:
                                break
        except Exception:
            name = ''
    account = dict(info) if isinstance(info, dict) else {}
    account['userId'] = uid
    account['nickname'] = name
    return {'ok': True, 'loggedIn': True, 'account': account,
            'message': ('已登录：' + name) if name else ('已登录（' + uid + '）' if uid else '已检测到登录会话；账号信息未能读取')}


def do_qrcode(pub, headless=True):
    pub._navigate(EXPLORE_URL)
    pub._sleep(2.5, minimum_seconds=1.0)
    cookie_list = cookies_now(pub)
    if has_session(cookie_list):
        info = self_info(pub)
        return {'ok': True, 'loggedIn': True, 'account': info, 'qrcode': '',
                'message': '已经登录，无需扫码'}
    meta = {}
    deadline = time.time() + 12
    while time.time() < deadline:
        meta = pub._locate_login_qrcode() or {}
        if meta.get('ok'):
            break
        pub._sleep(0.6, minimum_seconds=0.2)
    if meta.get('ok'):
        data_url = meta.get('data_url') or ''
        if not (isinstance(data_url, str) and data_url.startswith('data:image/')):
            src = meta.get('src') or ''
            data_url = src if isinstance(src, str) and src.startswith('data:image/') else ''
        if not data_url:
            rect = meta.get('rect') or {}
            data_url = 'data:image/png;base64,' + pub._capture_clip_png_base64(rect)
        return {'ok': True, 'loggedIn': False, 'qrcode': data_url,
                'message': '用小红书 App 扫下面这张二维码；扫完点「检查登录」'}
    shot = 'data:image/png;base64,' + pub._capture_clip_png_base64(
        {'x': 0, 'y': 0, 'width': 1280, 'height': 720})
    return {'ok': False, 'loggedIn': False, 'qrcode': shot,
            'message': '没有识别到登录二维码，下面是当前页面截图；也可以点「打开登录窗口」手动登录'}


def do_qrcode_wait(pub, seconds=90):
    deadline = time.time() + max(10, min(150, int(seconds or 90)))
    while time.time() < deadline:
        if has_session(cookies_now(pub)):
            pub._navigate(EXPLORE_URL)
            pub._sleep(1.6, minimum_seconds=0.6)
            info = self_info(pub)
            return {'ok': True, 'loggedIn': True, 'account': info,
                    'message': '扫码成功，已登录' + ('：' + info['nickname'] if info.get('nickname') else '')}
        time.sleep(2)
    return {'ok': False, 'loggedIn': False, 'message': '还没检测到登录，可能没扫或超时了'}


def do_cookie(pub, cookie_value):
    cookies = parse_cookie(cookie_value)
    pub._send('Network.clearBrowserCookies')
    pub._send('Network.setCookies', {'cookies': cookies})
    pub._navigate(EXPLORE_URL)
    pub._sleep(2.0, minimum_seconds=0.8)
    alive = has_session(cookies_now(pub))
    return {'ok': bool(alive), 'loggedIn': bool(alive),
            'message': 'Cookie 已写入专用浏览器' if alive else 'Cookie 已写入，但没检测到登录会话，请检查是否复制完整'}


def do_logout(pub):
    pub._send('Network.clearBrowserCookies')
    for origin in (HOME_URL, 'https://creator.xiaohongshu.com', API_ORIGIN):
        try:
            pub._send('Storage.clearDataForOrigin',
                      {'origin': origin, 'storageTypes': 'local_storage,session_storage'})
        except Exception:
            pass
    return {'ok': True, 'loggedIn': False, 'message': '已清除扩展专用浏览器的登录信息'}


def parse_cookie(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 32768 or '\n' in value or '\r' in value:
        raise ValueError('Cookie 格式无效')
    out = []
    for part in value.split(';'):
        part = part.strip()
        if not part:
            continue
        name, sep, val = part.partition('=')
        if not sep or not name or any(ch in name for ch in ' \t,'):
            raise ValueError('Cookie 格式无效，请粘贴请求头 Cookie 的值')
        out.append({'name': name, 'value': val, 'domain': '.xiaohongshu.com', 'path': '/',
                    'secure': True, 'expires': time.time() + 7 * 86400})
    if not out:
        raise ValueError('Cookie 为空')
    return out


# --------------------------------------------------------------------------
# 读取：首页 / 搜索 / 详情 / 通知 / 数据 / 我的笔记
# --------------------------------------------------------------------------
def need_login(pub):
    if not has_session(cookies_now(pub)):
        return {'ok': False, 'loggedIn': False, 'message': '还没有登录小红书，请先扫码登录或导入 Cookie'}
    return None


def blocked_by_risk(pub):
    """小红书会把游客态/可疑网络直接挡到登录或风控页。"""
    try:
        url = str(pub._evaluate('location.href') or '')
    except Exception:
        return ''
    if 'website-login/error' in url:
        return '小红书把这次访问挡在登录风控页（error 页），换个网络或扫码登录再试'
    if 'error_code=' in url:
        return '小红书返回风控页（' + url.split('error_code=')[-1][:40] + '），换个网络或扫码登录再试'
    return ''


def _read_wrapper(pub, opener, label):
    """读取类操作：未登录也先试，能读到就返回，读不到如实说原因。"""
    risk = opener()
    if risk:
        return {'ok': False, 'loggedIn': has_session(cookies_now(pub)), 'blocked': True, 'message': risk}
    return None


def do_feeds(pub):
    pub._navigate(EXPLORE_URL)
    pub._sleep(2.6, minimum_seconds=1.0)
    risk = blocked_by_risk(pub)
    logged = has_session(cookies_now(pub))
    if risk and not logged:
        return {'ok': False, 'loggedIn': False, 'blocked': True, 'message': risk}
    try:
        data = pub.list_feeds()
    except Exception as exc:
        reason = str(exc)[:160] or '页面没有返回推荐数据'
        if not logged:
            reason += '（未登录时小红书基本只给登录墙，扫码登录后就能正常刷）'
        return {'ok': False, 'loggedIn': logged, 'message': '首页推荐没读到：' + reason}
    count = data.get('count') if isinstance(data, dict) else None
    tail = '' if logged else '，游客态'
    return {'ok': True, 'loggedIn': logged, 'data': data,
            'message': '已读取首页推荐（%s 条%s）' % (count if count is not None else '?', tail)}


def do_search(pub, query):
    keyword = str(query or '').strip()[:100]
    if not keyword:
        return {'ok': False, 'message': '请填写搜索关键词'}
    logged = has_session(cookies_now(pub))
    if not logged:
        pub._navigate(HOME_URL)
        pub._sleep(1.6, minimum_seconds=0.6)
        risk = blocked_by_risk(pub)
        if risk:
            return {'ok': False, 'loggedIn': False, 'blocked': True, 'message': risk}
    try:
        data = pub.search_feeds(keyword=keyword)
    except Exception as exc:
        reason = str(exc)[:160] or '搜索结果为空'
        if not logged:
            reason += '（未登录时搜索经常被挡，扫码登录后正常）'
        return {'ok': False, 'loggedIn': logged, 'message': '搜索没结果：' + reason}
    return {'ok': True, 'loggedIn': logged, 'data': data,
            'message': '已搜索：' + keyword + ('' if logged else '（游客态）')}


def do_detail(pub, feed_id, token, load_all=False):
    logged = has_session(cookies_now(pub))
    kwargs = {}
    if load_all:
        kwargs = {'load_all_comments': True, 'limit': 20, 'click_more_replies': True, 'reply_limit': 10}
    try:
        data = pub.get_feed_detail(feed_id=feed_id, xsec_token=token, **kwargs)
    except Exception as exc:
        return {'ok': False, 'loggedIn': logged, 'message': '笔记详情没读到：' + (str(exc)[:160] or '页面没有返回数据')}
    return {'ok': True, 'loggedIn': logged, 'data': data, 'message': '已读取笔记详情'}


def do_mentions(pub):
    """评论与 @ 通知：优先在页面内直接请求接口（快且稳），失败再退回技能实现。"""
    blocked = need_login(pub)
    if blocked:
        return blocked
    # 通知接口在 /notification 页面里调用最稳（白名单与签名都由页面自己带）
    try:
        pub._navigate(NOTIFICATION_URL + '?source=discovery')
        pub._sleep(2.4, minimum_seconds=1.0)
    except Exception:
        pass
    ok, status, payload = page_fetch(pub, API_ORIGIN + '/api/sns/web/v1/you/mentions?num=20&cursor=')
    if ok:
        data = data_of(payload)
        items = first_list(data, ('message_list', 'items', 'mentions', 'list'))
        if isinstance(items, list):
            return {'ok': True, 'source': 'api',
                    'data': {'items': items, 'count': len(items),
                             'has_more': data.get('has_more'), 'cursor': data.get('cursor')},
                    'message': '已读取评论与@通知（%d 条）' % len(items)}
    try:
        data = pub.get_notification_mentions()
    except Exception as exc:
        return {'ok': False, 'message': '读评论通知失败：' + (str(exc)[:160] or '页面没有响应')}
    raw_items = ((data or {}).get('raw_payload') or {}).get('data', {}).get('message_list') or (data or {}).get('items') or []
    return {'ok': True, 'source': 'browser',
            'data': {'items': raw_items, 'count': len(raw_items), 'raw': data},
            'message': '已读取评论与@通知（%d 条）' % len(raw_items)}


def do_metrics(pub):
    blocked = need_login(pub)
    if blocked:
        return blocked
    data = pub.get_content_data()
    return {'ok': True, 'data': data, 'message': '已读取创作者中心笔记数据'}


def do_my_notes(pub, user_id='', limit=20):
    blocked = need_login(pub)
    if blocked:
        return blocked
    uid = str(user_id or '').strip() or own_user_id(pub)
    if not uid:
        return {'ok': False, 'message': '没能识别本人用户 ID；请在面板填写，或先在浏览器里打开自己的主页'}
    data = pub.list_profile_notes(user_id=uid, limit=max(1, min(50, int(limit or 20))), max_scrolls=3)
    return {'ok': True, 'userId': uid, 'data': data, 'message': '已读取本人主页笔记'}


def do_profile(pub, user_id=''):
    blocked = need_login(pub)
    if blocked:
        return blocked
    uid = str(user_id or '').strip() or own_user_id(pub)
    if not uid:
        return {'ok': False, 'message': '没能识别用户 ID'}
    data = pub.get_profile_snapshot(user_id=uid)
    return {'ok': True, 'userId': uid, 'data': data, 'message': '已读取主页信息'}


# --------------------------------------------------------------------------
# 私信
# --------------------------------------------------------------------------
CHAT_URL = 'https://www.xiaohongshu.com/chat?channel_id=&channel_type=explore_feed'
CHAT_URL_PREFIX = 'https://www.xiaohongshu.com/chat/'
CHATS_ENDPOINT = '/api/im/web/v3/chats?limit=100&complete=true&page=0&source=pc'
RECENT_ENDPOINT = '/api/sns/v1/im/web/get_recent_chats'
HISTORY_ENDPOINT = '/api/im/web/messages/history?chat_user_id=%s&start_id=0&limit=%d'


def _clean_text(value, depth=0):
    """把消息 content 里的多层 JSON 压成一句可读文本。"""
    if value is None or depth > 4:
        return ''
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ''
        if text[0] in '{[':
            try:
                return _clean_text(json.loads(text), depth + 1)
            except Exception:
                return text[:500]
        return text[:500]
    if isinstance(value, dict):
        if value.get('smileId') or value.get('smile_id'):
            return '[表情]'
        if value.get('image') or value.get('imageUrl') or value.get('image_url'):
            return '[图片]'
        for key in ('content', 'text', 'message', 'desc', 'title', 'name'):
            if key in value:
                out = _clean_text(value[key], depth + 1)
                if out:
                    return out
        return ''
    if isinstance(value, list):
        parts = [_clean_text(item, depth + 1) for item in value]
        return ' '.join(p for p in parts if p)[:500]
    return str(value)[:200]


def _message_row(item, me):
    sender = str(item.get('sender_id') or item.get('senderId') or '')
    created = item.get('created_at') or item.get('createdAt') or 0
    try:
        stamp = int(created)
        when = time.strftime('%Y-%m-%d %H:%M', time.localtime(stamp / 1000)) if stamp > 10 ** 12 else ''
    except Exception:
        when = ''
    return {
        'id': str(item.get('id') or item.get('uuid') or ''),
        'senderId': sender,
        'mine': bool(me) and sender == me,
        'time': when,
        'text': _clean_text(item.get('content')),
        'revoked': bool(item.get('revoked')),
    }


def do_dms(pub):
    blocked = need_login(pub)
    if blocked:
        return blocked
    me = own_user_id(pub)
    ok, status, payload = page_fetch(pub, API_ORIGIN + CHATS_ENDPOINT)
    chats, source = [], 'api'
    if ok:
        chats = first_list(data_of(payload), ('chats', 'chat_list', 'items', 'list'))
    if not chats:
        ok2, _, payload2 = page_fetch(pub, API_ORIGIN + RECENT_ENDPOINT)
        if ok2:
            chats = first_list(data_of(payload2), ('user_list', 'chats', 'items'))
    rows = []
    for chat in chats:
        if not isinstance(chat, dict):
            continue
        info = chat.get('info') if isinstance(chat.get('info'), dict) else {}
        # v3/chats 里 user_id 是「我」，对方在 chat_user_id；旧接口用 user_id 表示对方
        uid = str(chat.get('chat_user_id') or chat.get('target_user_id') or chat.get('userid') or '')
        if not uid:
            uid = str(info.get('id') or info.get('user_id') or chat.get('user_id') or '')
        if not uid:
            continue
        summary = _clean_text(chat.get('last_msg_content'))
        if not summary:
            summary = _clean_text(chat.get('last_msg') or chat.get('summary'))
        stamp = chat.get('last_msg_time') or chat.get('update_time') or chat.get('time') or ''
        when = ''
        try:
            value = int(stamp)
            when = time.strftime('%Y-%m-%d %H:%M', time.localtime(value / 1000)) if value > 10 ** 12 else str(stamp)
        except Exception:
            when = str(stamp or '')
        rows.append({
            'conversationId': uid,
            'nickname': str(info.get('nickname') or info.get('user_name') or chat.get('nickname') or ''),
            'avatar': str(info.get('avatar') or chat.get('image') or ''),
            'summary': summary,
            'time': when,
            'unread': chat.get('unread') or chat.get('unread_count') or 0,
            'isGroup': bool(chat.get('is_group_chat') or info.get('is_group_chat')),
        })
    if not rows:
        dom = pub._evaluate("""
            (() => {
                const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
                return [...document.querySelectorAll('.xhs-im-conv-item')].map((n) => ({
                    conversationId: n.getAttribute('data-conv-id') || '',
                    nickname: norm((n.querySelector('.xhs-im-conv-item__name') || {}).innerText),
                    avatar: (n.querySelector('.xhs-im-conv-item__avatar') || {}).src || '',
                    summary: norm((n.querySelector('.xhs-im-conv-item__summary-text') || {}).innerText),
                    time: norm((n.querySelector('.xhs-im-conv-item__time') || {}).innerText),
                })).filter((x) => x.conversationId);
            })()
        """) if _open_chat_home(pub) else []
        rows = [x for x in (dom or []) if isinstance(x, dict)]
        source = 'dom'
    if not rows:
        return {'ok': False, 'message': '没能读到私信列表：接口和页面都没返回会话。可能未登录或页面改版'}
    return {'ok': True, 'source': source, 'accountUserId': me,
            'data': {'items': rows, 'count': len(rows)},
            'message': '已读取私信列表，共 %d 个会话' % len(rows)}


def _open_chat_home(pub):
    pub._navigate(CHAT_URL)
    pub._sleep(3.5, minimum_seconds=1.5)
    return True


def do_dm_thread(pub, conversation_id, limit=30):
    blocked = need_login(pub)
    if blocked:
        return blocked
    cid = str(conversation_id or '').strip()
    if not cid:
        return {'ok': False, 'message': '需要会话 ID（私信列表里的 conversationId）'}
    me = own_user_id(pub)
    path = HISTORY_ENDPOINT % (cid, max(5, min(50, int(limit or 30))))
    ok, status, payload = page_fetch(pub, API_ORIGIN + path)
    messages = []
    if ok:
        data = data_of(payload)
        inner = data.get('out_message_list') or data.get('message_list') or data.get('messages') or []
        if isinstance(inner, list):
            messages = [_message_row(item, me) for item in inner if isinstance(item, dict)]
    source = 'api'
    if not messages:
        _open_chat_home(pub)
        pub._navigate(CHAT_URL_PREFIX + cid)
        pub._sleep(3.0, minimum_seconds=1.2)
        dom = pub._evaluate("""
            (() => {
                const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
                const rows = [...document.querySelectorAll('.chat-item')].slice(-40);
                return rows.map((n) => {
                    const mine = !!n.querySelector('.chat-item__content--right');
                    const bubble = n.querySelector('.chat-item__bubble');
                    return {mine, text: norm(bubble ? bubble.innerText : n.innerText).slice(0, 300)};
                }).filter((x) => x.text);
            })()
        """)
        messages = [{'id': '', 'senderId': '', 'mine': bool(x.get('mine')), 'time': '',
                     'text': str(x.get('text') or ''), 'revoked': False}
                    for x in (dom or []) if isinstance(x, dict)]
        source = 'dom'
    if not messages:
        return {'ok': False, 'message': '没能读到这个会话的消息；可能未登录、会话不存在或被风控拦截'}
    messages = [m for m in messages if m['text']]
    return {'ok': True, 'source': source, 'conversationId': cid, 'accountUserId': me,
            'data': {'items': messages, 'count': len(messages)},
            'message': '已读取 %d 条消息' % len(messages)}


def _last_own_bubble(pub):
    return pub._evaluate("""
        (() => {
            const rows = [...document.querySelectorAll('.chat-item')].slice(-6);
            const out = rows.map((n) => {
                const mine = !!n.querySelector('.chat-item__content--right');
                const bubble = n.querySelector('.chat-item__bubble');
                return {mine, text: ((bubble ? bubble.innerText : n.innerText) || '').replace(/\\s+/g, ' ').trim()};
            });
            return out.filter((x) => x.text);
        })()
    """)


def do_dm_send(pub, conversation_id, content):
    blocked = need_login(pub)
    if blocked:
        return blocked
    cid = str(conversation_id or '').strip()
    text = str(content or '').strip()
    if not text:
        return {'ok': False, 'message': '私信内容不能为空'}
    if len(text) > 1000:
        return {'ok': False, 'message': '私信内容过长（最多 1000 字）'}
    if not cid:
        return {'ok': False, 'message': '需要会话 ID：私信必须定位到一个具体对话'}
    pub._navigate(CHAT_URL_PREFIX + cid)
    pub._sleep(3.5, minimum_seconds=1.5)
    ready = pub._evaluate("""
        (() => {
            const editor = document.querySelector('.xhs-im-input-bar-editor');
            const header = document.querySelector('.xhs-im-chat-window__header-name');
            if (!editor) return {ok: false, reason: '没有找到输入框（可能未登录或需要先打开会话）'};
            editor.focus();
            return {ok: true, peer: (header ? header.innerText : '').trim(), url: location.href};
        })()
    """)
    if not isinstance(ready, dict) or not ready.get('ok'):
        return {'ok': False, 'message': (ready or {}).get('reason') or '没能打开会话输入框，未发送'}
    pub._send('Input.insertText', {'text': text})
    pub._sleep(0.6, minimum_seconds=0.2)
    filled = pub._evaluate("""
        (() => {
            const editor = document.querySelector('.xhs-im-input-bar-editor');
            return editor ? (editor.innerText || '').trim().length : 0;
        })()
    """)
    if not filled:
        return {'ok': False, 'message': '输入框没有接收文字，未发送（页面可能改版）'}
    pub._send('Input.dispatchKeyEvent', {'type': 'keyDown', 'windowsVirtualKeyCode': 13,
                                        'nativeVirtualKeyCode': 13, 'key': 'Enter', 'code': 'Enter',
                                        'text': '\r'})
    pub._send('Input.dispatchKeyEvent', {'type': 'keyUp', 'windowsVirtualKeyCode': 13,
                                        'nativeVirtualKeyCode': 13, 'key': 'Enter', 'code': 'Enter'})
    pub._sleep(2.5, minimum_seconds=1.0)
    bubbles = _last_own_bubble(pub) or []
    tail = str(text)[:12]
    matched = any(b.get('mine') and tail and tail in str(b.get('text') or '') for b in bubbles)
    if matched:
        return {'ok': True, 'conversationId': cid, 'peer': ready.get('peer', ''),
                'message': '私信已发出，页面已显示这条消息'}
    remaining = pub._evaluate("""
        (() => {
            const editor = document.querySelector('.xhs-im-input-bar-editor');
            return editor ? (editor.innerText || '').trim().length : -1;
        })()
    """)
    if remaining and int(remaining) > 0:
        return {'ok': False, 'conversationId': cid,
                'message': '文字还在输入框里，没有发出去；请到小红书手动发送或检查页面'}
    return {'ok': False, 'conversationId': cid,
            'message': '已点击发送但没在页面里看到这条消息，结果不明确，请到小红书核对后再决定是否重试'}


# --------------------------------------------------------------------------
# 写操作：评论 / 回复 / 发布 / 点赞收藏
# --------------------------------------------------------------------------
def do_comment(pub, feed_id, token, content):
    blocked = need_login(pub)
    if blocked:
        return blocked
    data = pub.post_comment_to_feed(feed_id=feed_id, xsec_token=token, content=content)
    ok = bool(data.get('ok', data.get('success', False))) if isinstance(data, dict) else False
    return {'ok': ok, 'data': data, 'message': '评论已提交，请核对平台回执；结果不明确时不要重复提交'}


def _reply_by_dom(pub, feed_id, token, comment_id, content):
    """在笔记页按 `#comment-<id>` 精确定位评论并提交回复。

    平台把评论节点写成 `id="comment-<评论文本 id>"`（没有 data-comment-id），
    技能库按 data 属性匹配会全部落空，所以这里直接按元素 id 定位。
    """
    from urllib.parse import quote
    url = 'https://www.xiaohongshu.com/explore/%s?xsec_token=%s&xsec_source=pc_feed' % (
        feed_id, quote(str(token), safe=''))
    pub._navigate(url)
    pub._sleep(2.6, minimum_seconds=1.0)
    target = '#comment-' + str(comment_id)
    target_literal = json.dumps(target)
    found = False
    for _ in range(12):
        if pub._evaluate('(() => !!document.querySelector(%s))()' % target_literal):
            found = True
            break
        pub._evaluate("""
            (() => {
                const box = document.querySelector('.comments-container') || document.querySelector('.note-scroller');
                if (box) box.scrollTop = box.scrollHeight;
                window.scrollBy(0, 700);
                return true;
            })()
        """)
        pub._sleep(0.8, minimum_seconds=0.3)
    if not found:
        return {'ok': False, 'message': '笔记页里没加载出这条评论（可能被折叠、已删除或排序靠后），没有回复'}
    clicked = pub._evaluate("""
        ((sel) => {
            const node = document.querySelector(sel);
            if (!node) return {ok: false, reason: 'node-lost'};
            const reply = node.querySelector('.reply');
            if (!reply) return {ok: false, reason: 'no-reply-control'};
            reply.click();
            return {ok: true};
        })(%s)
    """ % target_literal)
    if not (isinstance(clicked, dict) and clicked.get('ok')):
        return {'ok': False, 'message': '这条评论没有可点的「回复」，没有回复'}
    pub._sleep(1.0, minimum_seconds=0.3)
    ready = pub._evaluate("""
        (() => {
            const box = document.querySelector('.content-input');
            if (!box) return false;
            box.click();
            if (typeof box.focus === 'function') box.focus();
            return box.getAttribute('contenteditable') === 'true' || box.tagName === 'TEXTAREA';
        })()
    """)
    if not ready:
        return {'ok': False, 'message': '没找到评论输入框，没有回复（页面可能改版）'}
    pub._send('Input.insertText', {'text': content})
    pub._sleep(0.7, minimum_seconds=0.3)
    typed = pub._evaluate("(() => { const b = document.querySelector('.content-input'); return b ? (b.innerText || '').trim() : ''; })()")
    if not typed:
        return {'ok': False, 'message': '文字没有进入输入框，没有回复'}
    submit = pub._evaluate("""
        (() => {
            const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
            const btn = [...document.querySelectorAll('button.btn.submit, button.submit')]
                .find((b) => norm(b.innerText) === '发送' && b.offsetParent !== null && !b.disabled);
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return {x: r.x + r.width / 2, y: r.y + r.height / 2};
        })()
    """)
    if not submit:
        return {'ok': False, 'message': '找不到「发送」按钮，没有回复'}
    pub._click_mouse(float(submit['x']), float(submit['y']))
    pub._sleep(2.8, minimum_seconds=1.0)
    check = pub._evaluate("""
        ((args) => {
            const [sel, needle] = args;
            const node = document.querySelector(sel);
            const holder = node ? (node.parentElement || node) : null;
            const text = (holder ? holder.innerText : '').replace(/\\s+/g, ' ');
            const box = document.querySelector('.content-input');
            return {hit: text.includes(needle), cleared: box ? !(box.innerText || '').trim() : true,
                    tail: text.slice(-80)};
        })(%s)
    """ % json.dumps([target, str(content)[:8]], ensure_ascii=False))
    if isinstance(check, dict) and check.get('hit'):
        return {'ok': True, 'data': {'mode': 'dom', 'commentId': comment_id},
                'message': '回复已提交，页面里能看到这条回复'}
    return {'ok': False, 'data': {'mode': 'dom', 'cleared': (check or {}).get('cleared')},
            'message': '点了发送但页面里没看到这条回复，结果不明确，请到小红书核对后再决定是否重试'}


def do_reply(pub, feed_id, token, comment_id, content, snippet=''):
    blocked = need_login(pub)
    if blocked:
        return blocked
    if comment_id:
        return _reply_by_dom(pub, feed_id, token, comment_id, content)
    return {'ok': False, 'message': '缺少评论 ID，无法精确定位要回复的那一条'}


def do_publish(pub, title, content, images, video):
    blocked = need_login(pub)
    if blocked:
        return blocked
    media = [video] if video else list(images or [])
    if not media:
        return {'ok': False, 'message': '发布需要图片或视频'}
    for path in media:
        p = pathlib.Path(path)
        if not p.is_absolute() or not p.is_file():
            return {'ok': False, 'message': '素材必须是存在的本地绝对路径：' + str(path)}
    if video:
        pub.publish_video(title=title, content=content, video_path=video)
    else:
        pub.publish(title=title, content=content, image_paths=images)
    pub._click_publish()
    return {'ok': True, 'message': '已执行发布操作，请到创作者中心核对最终发布结果'}


def do_reaction(pub, mode, feed_id, token):
    blocked = need_login(pub)
    if blocked:
        return blocked
    fn = {'upvote': pub.set_note_upvote_state, 'bookmark': pub.set_note_bookmark_state}.get(mode)
    if not fn:
        return {'ok': False, 'message': '不支持的操作'}
    data = fn(feed_id=feed_id, xsec_token=token, state=True)
    return {'ok': True, 'data': data, 'message': '已执行' + ('点赞' if mode == 'upvote' else '收藏') + '，请到小红书核对'}


# --------------------------------------------------------------------------
# 诊断
# --------------------------------------------------------------------------
def do_probe(pub, url, seconds=8):
    """打开一个页面，收集它发出的接口请求，用来确认平台当前接口。"""
    target = str(url or MESSAGES_URL)
    pub._send('Network.enable')
    msg_id = pub._msg_id + 1
    pub._msg_id = msg_id
    pub.ws.send(json.dumps({'id': msg_id, 'method': 'Page.navigate', 'params': {'url': target}}))
    seen, deadline = [], time.time() + max(3, min(30, int(seconds or 8)))
    while time.time() < deadline:
        try:
            raw = pub.ws.recv(timeout=1.0)
        except Exception:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if data.get('id') == msg_id:
            continue
        if data.get('method') != 'Network.requestWillBeSent':
            continue
        req = data.get('params', {}).get('request', {})
        link = str(req.get('url') or '')
        method = str(req.get('method') or 'GET')
        if not ('/api/' in link or 'edith' in link):
            continue
        key = link.split('?')[0]
        exists = next((x for x in seen if x['url'] == key), None)
        if exists:
            if exists['method'] == 'OPTIONS' and method != 'OPTIONS':
                exists['method'] = method
                exists['full'] = link
            continue
        seen.append({'url': key, 'method': method, 'full': link})
    return {'ok': True, 'data': {'url': target, 'endpoints': seen}, 'message': '已收集页面接口 %d 个' % len(seen)}


def cdp(pub, method, params=None, timeout=12):
    """直接走 CDP 发一条命令并等它的回执（和 do_probe 同一套用法）。"""
    msg_id = pub._msg_id + 1
    pub._msg_id = msg_id
    pub.ws.send(json.dumps({'id': msg_id, 'method': method, 'params': params or {}}))
    deadline = time.time() + max(2, timeout)
    while time.time() < deadline:
        try:
            raw = pub.ws.recv(timeout=1.0)
        except Exception:
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get('id') == msg_id:
            return msg
    return None


def do_shot(pub, feed_id, token, quality=82):
    """给一篇笔记截一张图（整屏，不滚到底），交给上层的截图库 / 视觉用。"""
    blocked = need_login(pub)
    if blocked:
        return blocked
    fid = str(feed_id or '').strip()
    if not fid:
        return {'ok': False, 'message': '没给笔记 id'}
    url = EXPLORE_URL + '/explore/' + fid
    if token:
        url += '?xsec_token=' + str(token) + '&xsec_source=pc_feed'
    try:
        cdp(pub, 'Page.navigate', {'url': url}, timeout=15)
        time.sleep(3.2)
        # 页面里如果还在加载，再等一下；顺便滚一点点让头图完整露出
        try:
            pub._evaluate('window.scrollTo(0, 0)')
        except Exception:
            pass
        r = cdp(pub, 'Page.captureScreenshot', {'format': 'jpeg', 'quality': int(quality or 82)}, timeout=20)
    except Exception as exc:
        return {'ok': False, 'message': '截图失败：' + (str(exc)[:140] or '页面没响应')}
    b64 = (((r or {}).get('result') or {}).get('data') or '')
    if not b64:
        return {'ok': False, 'message': '截图没拿到（页面可能还没加载完）'}
    return {'ok': True, 'data': {'image': b64, 'url': url, 'feedId': fid}, 'message': '截了一张'}


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
READ_ONLY = {'status', 'qrcode', 'qrcode_wait', 'feeds', 'search', 'detail', 'mentions', 'metrics',
             'my_notes', 'profile', 'dms', 'dm_thread', 'probe'}
KEEP_BROWSER = {'qrcode', 'open'}


def main(request):
    op = str(request.get('op') or '')
    allowed = READ_ONLY | {'open', 'close', 'cookie', 'logout', 'comment', 'reply', 'publish',
                           'upvote', 'bookmark', 'dm_send', 'shot'}
    if op not in allowed:
        raise ValueError('不支持的操作')

    headless = op not in ('qrcode', 'open')
    proc, reused = launch(headless=headless)
    pub = None
    try:
        pub = attach()
        if op == 'close':
            return {'ok': True, 'message': '已关闭小红书专用浏览器'}
        if op == 'open':
            pub._navigate(EXPLORE_URL)
            return {'ok': True, 'message': '已打开小红书专用浏览器窗口；登录完点「检查登录」'}
        # 其余操作依赖页面上下文（页面内 fetch / localStorage）
        ensure_page(pub)
        if op == 'status':
            return do_status(pub)
        if op == 'qrcode':
            return do_qrcode(pub)
        if op == 'qrcode_wait':
            return do_qrcode_wait(pub, request.get('seconds'))
        if op == 'cookie':
            return do_cookie(pub, request.get('cookie'))
        if op == 'logout':
            return do_logout(pub)
        if op == 'feeds':
            return do_feeds(pub)
        if op == 'search':
            return do_search(pub, request.get('query'))
        if op == 'detail':
            return do_detail(pub, request['feedId'], request['xsecToken'], bool(request.get('loadAll')))
        if op == 'mentions':
            return do_mentions(pub)
        if op == 'metrics':
            return do_metrics(pub)
        if op == 'my_notes':
            return do_my_notes(pub, request.get('userId'), request.get('limit'))
        if op == 'profile':
            return do_profile(pub, request.get('userId'))
        if op == 'dms':
            return do_dms(pub)
        if op == 'dm_thread':
            return do_dm_thread(pub, str(request.get('conversationId') or ''))
        if op == 'dm_send':
            return do_dm_send(pub, str(request.get('conversationId') or ''), request.get('content'))
        if op == 'comment':
            return do_comment(pub, request['feedId'], request['xsecToken'], request['content'])
        if op == 'reply':
            return do_reply(pub, request['feedId'], request['xsecToken'], request['commentId'], request['content'], request.get('snippet') or '')
        if op == 'publish':
            return do_publish(pub, request['title'], request['content'],
                              request.get('images') or [], request.get('video') or '')
        if op == 'shot':
            return do_shot(pub, request['feedId'], request.get('xsecToken'), request.get('quality'))
        if op in ('upvote', 'bookmark'):
            return do_reaction(pub, op, request['feedId'], request['xsecToken'])
        if op == 'probe':
            return do_probe(pub, request.get('url'), request.get('seconds'))
        return {'ok': False, 'message': '不支持的操作'}
    finally:
        if op in KEEP_BROWSER:
            if pub is not None and pub.ws:
                try:
                    pub.disconnect()
                except Exception:
                    pass
        else:
            shutdown(pub, proc)


if __name__ == '__main__':
    payload = {}
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(io.StringIO()):
            result = main(payload)
    except Exception as exc:
        message = str(exc)[:300] or exc.__class__.__name__
        if payload.get('op') == 'cookie':
            message = 'Cookie 导入失败：' + message
        result = {'ok': False, 'message': message}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))