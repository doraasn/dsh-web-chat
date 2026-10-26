/**
 * dsh-web-chat — client 半部。
 *
 * 在侧栏注册「聊天」入口，并占一个 keyed main 面板。面板里通过桌面版 preload
 * 暴露的 `globalThis.dshDesktop.browser` 申请 guest lease，自己挂 `<webview>`
 * 载入 https://chat.deepseek.com/。主进程校验 lease 后才真正 attach，所以隔离
 * 策略与内置侧栏浏览器相同。
 *
 * 三处与「直接嵌一个网页」不同的地方：
 *
 *   1. 面板属于 keyed slot，切到别的面板时宿主会卸载组件。卸载时若释放 guest，
 *      切回来就是整页重载。所以 webview 不放在面板 DOM 里，而是放进一个
 *      body 级的固定浮层：挂载时把浮层对齐到面板区域并显示，卸载时只隐藏。
 *      注意不能在 DOM 之间搬 webview —— Electron 的 <webview> 一旦 detach
 *      就会销毁 guest，效果等同重载。
 *   2. 重启后内嵌分区里的登录态没了。这里把网页版 localStorage 快照存到
 *      Host 侧文件，下次载入先回填再刷新。
 *   3. 每次打开都回首页的话，得在网页侧栏里重新找会话。这里记住上次停留的
 *      会话地址（存 Host 侧，因为 Web GUI 端口每次启动可能不同），下次直接回去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshWebChat'
    const PANEL_ID = 'dsh-web-chat'
    const HOME = 'https://chat.deepseek.com/'
    const API = '/api/dsh-web-chat'
    const WORKSPACE = 'dsh-web-chat'
    const SURFACE_ID = 'dsh-web-chat-surface'
    /** 关掉它就退回「卸载即释放」的行为（切回来会重载）。 */
    const KEEP_ALIVE = true

    const zh = {
      'entry.label': '聊天',
      'panel.starting': '正在打开聊天…',
      'panel.desktopOnly': '这个面板需要 DSH 桌面版；网页版请直接在浏览器里打开 chat.deepseek.com。',
      'panel.acquireFailed': '无法打开内嵌浏览器：{message}',
      'panel.guestDestroyed': '内嵌页面已被关闭，重新打开面板即可恢复。',
      'panel.loadFailed': '页面加载失败（{code} {description}）',
      'action.back': '后退',
      'action.forward': '前进',
      'action.reload': '刷新',
      'action.home': '回到首页',
      'action.external': '在系统浏览器中打开',
    }
    const en = {
      'entry.label': 'Chat',
      'panel.starting': 'Opening chat…',
      'panel.desktopOnly': 'This panel requires DSH Desktop. Open chat.deepseek.com in a browser instead.',
      'panel.acquireFailed': 'Could not open the embedded browser: {message}',
      'panel.guestDestroyed': 'The embedded page was closed. Reopen the panel to restore it.',
      'panel.loadFailed': 'Page failed to load ({code} {description})',
      'action.back': 'Back',
      'action.forward': 'Forward',
      'action.reload': 'Reload',
      'action.home': 'Back to the home page',
      'action.external': 'Open in system browser',
    }

    const STYLE_ID = `${PANEL_ID}/css`
    const CSS = [
      '.dwc-root{display:flex;flex-direction:column;height:100%;min-height:0;flex:1 1 auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dwc-toolbar{display:flex;flex:none;align-items:center;gap:4px;height:38px;padding:5px 6px;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dwc-tool{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dwc-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dwc-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}',
      '.dwc-location{flex:auto;min-width:0;overflow:hidden;padding:0 8px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap}',
      '.dwc-spinner{flex:none;width:12px;height:12px;margin:0 6px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);animation:dwc-spin .8s linear infinite}',
      '@keyframes dwc-spin{to{transform:rotate(360deg)}}',
      '.dwc-viewport{position:relative;flex:auto;min-height:0;background:var(--dsw-alias-bg-base)}',
      '.dwc-host{position:absolute;inset:0}',
      '.dwc-notice{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}',
      '.dwc-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    // ── Host 侧持久化 ────────────────────────────────────────────────
    async function getJson(path) {
      try {
        const response = await fetch(path, { cache: 'no-store' })
        if (!response.ok) return null
        return await response.json()
      } catch { return null }
    }

    async function postJson(path, body) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { ok: response.ok, status: response.status }
      } catch (error) {
        return { ok: false, status: 0, error: String(error) }
      }
    }

    const readSessionBackup = async () => {
      const data = await getJson(`${API}/session`)
      return data && data.storage && typeof data.storage === 'object' ? data.storage : null
    }

    const writeSessionBackup = (storage) => postJson(`${API}/session`, { storage })

    // ── 上次停留的会话 ──────────────────────────────────────────────
    function isChatUrl(url) {
      return typeof url === 'string'
        && url.startsWith(HOME)
        && /\/a\/chat\//.test(url)
    }

    async function readLastUrl() {
      const data = await getJson(`${API}/last-url`)
      return data && isChatUrl(data.url) ? data.url : ''
    }

    function saveLastUrl(url) {
      if (!isChatUrl(url)) return
      void postJson(`${API}/last-url`, { url })
    }

    function clearLastUrl() {
      void postJson(`${API}/last-url`, { url: '' })
    }

    // ── 保活浮层 ────────────────────────────────────────────────────
    // 面板卸载时只隐藏，不释放、不摘 DOM，下次挂载直接复用同一个 guest。
    let shared = null

    function ensureSurface() {
      const previous = document.getElementById(SURFACE_ID)
      if (previous) return previous
      const surface = document.createElement('div')
      surface.id = SURFACE_ID
      surface.dataset.plugin = PANEL_ID
      surface.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;z-index:100;background:var(--dsw-alias-bg-base);'
      document.body.appendChild(surface)
      return surface
    }

    function hideSurface(view) {
      const surface = view && view.surface
      if (!surface) return
      surface.style.visibility = 'hidden'
      surface.style.left = '-10000px'
      surface.style.top = '0'
      surface.style.width = '1px'
      surface.style.height = '1px'
    }

    function placeSurface(view, host) {
      if (!view || !view.surface || !host) return
      // 宿主容器是 absolute inset:0 的占位块；万一它还没量出尺寸，退到视口容器，
      // 再不行就用窗口可视区域，避免浮层一直缩在屏幕外（表现就是面板空白）。
      let rect = host.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) {
        const parent = host.parentElement
        if (parent) rect = parent.getBoundingClientRect()
      }
      if (rect.width < 2 || rect.height < 2) return
      view.surface.style.left = `${rect.left}px`
      view.surface.style.top = `${rect.top}px`
      view.surface.style.width = `${rect.width}px`
      view.surface.style.height = `${rect.height}px`
      view.surface.style.visibility = 'visible'
      if (!view.placed) {
        view.placed = true
        report('surface:placed', { width: Math.round(rect.width), height: Math.round(rect.height) })
      }
    }

    // ── 工具函数 ────────────────────────────────────────────────────
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {}
      const previous = document.getElementById(STYLE_ID)
      if (previous) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.dataset.plugin = PANEL_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    function errorText(error) {
      if (error instanceof Error) return error.message
      if (typeof error === 'string') return error
      try { return JSON.stringify(error) } catch { return String(error) }
    }

    function safeCall(run, fallback) {
      try { return run() } catch { return fallback }
    }

    function report(event, detail) {
      void postJson(`${API}/log`, { event, detail, at: Date.now() })
    }

    /**
     * 内嵌客机的默认 UA 里带着 `Electron/x.y.z` 和应用名，网页版据此判定
     * 「使用环境异常」并盖一层风险提示。这里把它换成同版本号的干净 Chrome UA：
     * 只保留 Chrome 主版本，去掉 Electron 与应用标识，平台段按真实系统拼。
     */
    function cleanUserAgent() {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
      const major = (/Chrome\/(\d+)/.exec(ua) || [])[1] || '134'
      const platform = /Macintosh/.test(ua)
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : /Linux/.test(ua)
          ? 'X11; Linux x86_64'
          : 'Windows NT 10.0; Win64; x64'
      return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    }

    /**
     * 网页版判断「使用环境异常」的条件（main.<hash>.js 里 w9）：
     *   navigator.userAgent 含 "electron"  ||  window.process.type === "renderer"
     * 换 UA 只能去掉前一半；Electron 客机里 window.process 仍然在，所以这个提示
     * 还是会弹。它本身是个可关闭的告示（点 X 会把 `closeUnsafeEnvWarn` 写进
     * localStorage，之后不再显示），这里替用户点一次那个 X：标记写进 localStorage，
     * 并且这个键会随登录态快照一起存下来，重启后也不会再弹。
     * 不想要这个行为，把下面的 DISMISS_ENV_WARNING 改成 false。
     */
    const DISMISS_ENV_WARNING = true
    const ENV_WARNING_KEY = 'closeUnsafeEnvWarn'
    const ENV_WARNING_VALUE = '{"value":true,"__version":"0"}'

    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: 'dwc-tool',
        title: props.label,
        'aria-label': props.label,
        disabled: Boolean(props.disabled),
        onClick: props.onClick,
      }, h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
      }, props.children))
    }

    const STROKE = {
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }
    const strokePath = (d) => h('path', { d, ...STROKE })

    /** 侧栏图标：方口气泡 + 两条对话线 + 左下尾巴，线条与相邻入口一致。 */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M6.4 3.4h11.2a3.6 3.6 0 0 1 3.6 3.6v6.8a3.6 3.6 0 0 1-3.6 3.6h-6.4L7 21.2V17.4H6.4a3.6 3.6 0 0 1-3.6-3.6V7a3.6 3.6 0 0 1 3.6-3.6Z' }),
        h('path', { d: 'M7 8.2h10M7 11.8h6.4' })
      )
    }

    function ChatPanel(props) {
      const t = props.t
      const hostRef = React.useRef(null)
      const viewportRef = React.useRef(null)
      const frameRef = React.useRef(null)
      const tRef = React.useRef(t)
      tRef.current = t

      const [state, setState] = React.useState({
        status: 'starting',
        url: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
        error: null,
      })
      const update = React.useCallback((patch) => {
        setState((previous) => ({ ...previous, ...patch }))
      }, [])

      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        const text = (key, values) => {
          const translate = tRef.current
          return translate ? translate(key, values) : key
        }

        const carrier = globalThis.dshDesktop
        const bridge = carrier && carrier.protocolVersion === 1 ? carrier.browser : undefined
        if (!bridge) {
          update({ status: 'error', loading: false, error: text('panel.desktopOnly') })
          report('unsupported', { carrier: Boolean(carrier) })
          return undefined
        }
        report('panel:mount', {})

        let disposed = false
        let offOpen = undefined
        const reusable = KEEP_ALIVE
          && shared
          && shared.el
          && !shared.destroyed
          && safeCall(() => { shared.el.getURL(); return true }, false)
        const view = reusable
          ? shared
          : {
              el: null,
              lease: undefined,
              surface: null,
              started: false,
              restored: false,
              lastSnapshot: '',
              persisting: false,
              destroyed: false,
              placed: false,
              envSeeded: false,
            }

        const offs = []
        const listen = (el, name, handler) => {
          el.addEventListener(name, handler)
          offs.push(() => el.removeEventListener(name, handler))
        }

        const readUrl = (el) => safeCall(() => el.getURL(), '') || ''
        const syncHistory = (el) => {
          update({
            url: readUrl(el),
            canGoBack: Boolean(safeCall(() => el.canGoBack(), false)),
            canGoForward: Boolean(safeCall(() => el.canGoForward(), false)),
          })
        }

        const anchor = viewportRef.current || host
        const place = () => placeSurface(view, viewportRef.current || host)
        try {
          const observer = new ResizeObserver(place)
          observer.observe(anchor)
          offs.push(() => { try { observer.disconnect() } catch {} })
        } catch {}
        const onResize = () => place()
        window.addEventListener('resize', onResize)
        offs.push(() => window.removeEventListener('resize', onResize))
        // 布局可能在挂载后几帧才稳定，前 30 帧持续对齐一次。
        let frames = 0
        const tick = () => {
          place()
          if (!disposed && frames < 30) { frames += 1; requestAnimationFrame(tick) }
        }
        requestAnimationFrame(tick)

        // 「使用环境异常」告示本身就是可关闭的：点 X 会把 closeUnsafeEnvWarn 写进
        // localStorage，之后不再显示。这里替用户点一次那个 X，标记随登录快照一起
        // 存盘（见 persistSnapshot 的白名单），重启后也不会再弹。
        //
        // 注意不能用 el.getURL() 判断当前文档：dom-ready 触发时它可能还是上一条
        // about:blank#lease，于是整段逻辑被静默跳过（1.0.2 就是这个毛病）。改成在
        // 页面里问 location.origin，只有真正停在 chat.deepseek.com 时才动手。
        const dismissEnvWarning = async (el) => {
          if (!DISMISS_ENV_WARNING || view.envSeeded || view.destroyed) return
          try {
            const origin = await el.executeJavaScript(
              '(() => { try { return location.origin } catch (error) { return "" } })()'
            )
            if (origin !== 'https://chat.deepseek.com') return
            view.envSeeded = true
            const key = JSON.stringify(ENV_WARNING_KEY)
            const current = await el.executeJavaScript(
              `(() => { try { return localStorage.getItem(${key}) } catch (error) { return null } })()`
            )
            if (typeof current === 'string' && current.includes('"value":true')) {
              report('env-warning:already', {})
              return
            }
            const wrote = await el.executeJavaScript(
              `(() => { try { localStorage.setItem(${key}, ${JSON.stringify(ENV_WARNING_VALUE)}); return localStorage.getItem(${key}) } catch (error) { return "ERR:" + error } })()`
            )
            report('env-warning:write', { wrote })
            if (typeof wrote !== 'string' || !wrote.includes('"value":true')) return
            // 让页面重新启动一次读到标记；不等它 resolve，导航会打断这个 promise。
            void el.executeJavaScript('location.reload()').catch(() => {})
          } catch (error) {
            report('env-warning:failed', errorText(error))
          }
        }

        const persistSnapshot = async (el) => {
          if (disposed || view.persisting || !el) return
          view.persisting = true
          try {
            const raw = await el.executeJavaScript(
              '(() => { const out = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key !== null) out[key] = localStorage.getItem(key) ?? "" } } catch (error) { return null } return JSON.stringify(out) })()'
            )
            if (typeof raw !== 'string' || raw.length <= 2 || raw === view.lastSnapshot) return
            let parsed
            try { parsed = JSON.parse(raw) } catch { return }
            if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) return
            // 只备份「已登录」状态：未登录时也会有一堆匿名键，写回去只会污染下次恢复。
            const onSignIn = /\/sign_in/i.test(readUrl(el))
            const looksLoggedIn = Object.keys(parsed).some((key) => /token|user|auth|session/i.test(key))
            if (onSignIn || !looksLoggedIn) return
            // 只留登录相关的键：整份 localStorage 可能几百 KB，既没必要也未必写得进去。
            const relevant = {}
            for (const key of Object.keys(parsed)) {
              if (!/(token|user|auth|session|login|closeUnsafeEnvWarn)/i.test(key)) continue
              const value = parsed[key]
              if (typeof value !== 'string' || value.length > 64 * 1024) continue
              relevant[key] = value
            }
            if (Object.keys(relevant).length === 0) return
            const snapshot = JSON.stringify(relevant)
            if (snapshot === view.lastSnapshot) return
            view.lastSnapshot = snapshot
            await writeSessionBackup(relevant)
          } catch (error) {
            report('persist-failed', errorText(error))
          } finally {
            view.persisting = false
          }
        }

        const restoreSnapshot = async (el) => {
          if (view.restored) return
          view.restored = true
          const storage = await readSessionBackup()
          if (!storage || Object.keys(storage).length === 0) return
          try {
            const code = '(() => { const map = ' + JSON.stringify(storage) + '; let changed = 0; try { for (const key of Object.keys(map)) { if (localStorage.getItem(key) !== map[key]) { localStorage.setItem(key, map[key]); changed += 1 } } } catch (error) { return { error: String(error) } } return { changed } })()'
            const result = await el.executeJavaScript(code)
            if (!result || !(result.changed > 0)) return
            const here = readUrl(el)
            // 停在登录页说明 token 刚回填，重新进入；优先回到上次的会话。
            if (/\/sign_in/i.test(here)) el.loadURL(await readLastUrl() || HOME)
            else await el.executeJavaScript('location.reload()')
          } catch (error) {
            report('restore-failed', errorText(error))
          }
        }

        const register = (el) => {
          listen(el, 'did-start-loading', () => { if (!disposed) update({ loading: true }) })
          listen(el, 'did-stop-loading', () => {
            if (disposed) return
            update({ loading: false })
            syncHistory(el)
            if (view.started) void restoreSnapshot(el)
          })
          listen(el, 'did-finish-load', () => {
            if (disposed) return
            update({ loading: false })
            syncHistory(el)
            if (view.started) void persistSnapshot(el)
            void dismissEnvWarning(el)
          })
          listen(el, 'did-navigate', (event) => {
            if (disposed) return
            update({ url: event.url || readUrl(el) })
            syncHistory(el)
            saveLastUrl(event.url || readUrl(el))
          })
          listen(el, 'did-navigate-in-page', (event) => {
            if (disposed || !event.isMainFrame) return
            update({ url: event.url || readUrl(el) })
            syncHistory(el)
            saveLastUrl(event.url || readUrl(el))
          })
          listen(el, 'page-title-updated', () => { if (!disposed) syncHistory(el) })
          listen(el, 'did-fail-load', (event) => {
            if (disposed || !event.isMainFrame || event.errorCode === -3) return
            report('did-fail-load', { code: event.errorCode, description: event.errorDescription })
            update({
              loading: false,
              error: text('panel.loadFailed', {
                code: event.errorCode,
                description: event.errorDescription || '',
              }),
            })
          })
          offOpen = bridge.onOpenRequested(view.lease, (url) => {
            if (disposed) return
            try { el.loadURL(url) } catch (error) { report('popup-failed', errorText(error)) }
          })
          offs.push(() => { if (offOpen) { try { offOpen() } catch {}; offOpen = undefined } })
        }

        if (view.el) {
          // 复用上一次的 guest：页面、滚动位置、没发出去的草稿都还在。
          frameRef.current = view.el
          place()
          register(view.el)
          update({ status: 'ready', loading: Boolean(safeCall(() => view.el.isLoading(), false)) })
          syncHistory(view.el)
          report('panel:reused', { url: readUrl(view.el) })
        } else {
          ;(async () => {
            let reservation
            try {
              reservation = await bridge.acquire(WORKSPACE)
            } catch (error) {
              if (!disposed) update({ status: 'error', loading: false, error: text('panel.acquireFailed', { message: errorText(error) }) })
              report('acquire-failed', errorText(error))
              return
            }
            if (disposed) {
              Promise.resolve(bridge.release(reservation.lease)).catch(() => {})
              return
            }
            view.lease = reservation.lease
            view.surface = KEEP_ALIVE ? ensureSurface() : null
            if (KEEP_ALIVE) shared = view
            update({ status: 'ready', loading: true })

            const el = document.createElement('webview')
            view.el = el
            frameRef.current = el
            el.className = 'dwc-webview'
            el.style.cssText = 'display:flex;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)'
            el.setAttribute('name', reservation.lease)
            el.setAttribute('partition', reservation.partition)
            el.setAttribute('allowpopups', '')
            // 必须在 attach 之前设置：晚一步页面就带着 Electron UA 出去了。
            el.setAttribute('useragent', cleanUserAgent())
            el.setAttribute('src', `about:blank#${reservation.lease}`)

            // 这两个监听跨越挂载/卸载：guest 的寿命比一次挂载长。
            el.addEventListener('dom-ready', () => {
              if (view.destroyed) return
              if (!view.started) {
                view.started = true
                void (async () => {
                  const target = await readLastUrl() || HOME
                  if (view.destroyed) return
                  report('dom-ready', { restored: target !== HOME })
                  try { el.loadURL(target) } catch (error) { report('load-failed', errorText(error)) }
                })()
                void dismissEnvWarning(el)
                return
              }
              void dismissEnvWarning(el)
            })
            el.addEventListener('destroyed', () => {
              report('guest-destroyed', {})
              view.destroyed = true
              hideSurface(view)
              if (shared === view) shared = null
              if (!disposed) update({ error: text('panel.guestDestroyed') })
            })

            if (view.surface) view.surface.appendChild(el)
            else host.appendChild(el)
            place()
            register(el)
          })()
        }

        return () => {
          disposed = true
          report('panel-unmounted', {})
          for (const off of offs.splice(0)) { try { off() } catch {} }
          frameRef.current = null
          // 只隐藏、不释放：下次切回来直接复用这个 guest。
          hideSurface(view)
          // 浮层只是隐藏，焦点可能还留在内嵌页里，会让对话输入框收不到按键。
          try { view.el?.blur?.() } catch {}
          if ((!KEEP_ALIVE || view.destroyed) && view.lease !== undefined) {
            Promise.resolve(bridge.release(view.lease)).catch((error) => report('release-failed', errorText(error)))
            view.lease = undefined
            if (shared === view) shared = null
            try { view.el?.remove?.() } catch {}
            view.el = null
          }
        }
      }, [update])

      // 出错时藏起浮层，否则内嵌页会盖住这边的错误提示。
      React.useEffect(() => {
        if (state.status === 'error' && shared) hideSurface(shared)
      }, [state.status])

      const el = () => frameRef.current
      const goBack = () => { const view = el(); if (view) safeCall(() => view.goBack()) }
      const goForward = () => { const view = el(); if (view) safeCall(() => view.goForward()) }
      const reload = () => { const view = el(); if (view) safeCall(() => view.reload()) }
      const goHome = () => {
        const view = el()
        if (!view) return
        // 点「回首页」视为放弃记住的会话，否则下次打开又跳回旧会话。
        clearLastUrl()
        safeCall(() => view.loadURL(HOME))
      }
      const openExternal = () => {
        const url = state.url || HOME
        try { window.open(url, '_blank', 'noopener,noreferrer') } catch {}
      }

      const notice = state.status === 'error'
        ? h('div', { className: 'dwc-notice', 'data-kind': 'error', role: 'alert' }, state.error || '')
        : state.status === 'starting'
          ? h('div', { className: 'dwc-notice', role: 'status' }, t('panel.starting'))
          : null

      return h('div', { className: 'dwc-root' },
        h('div', { className: 'dwc-toolbar' },
          h(IconButton, { label: t('action.back'), disabled: !state.canGoBack, onClick: goBack }, strokePath('M10 3.2 5.2 8 10 12.8')),
          h(IconButton, { label: t('action.forward'), disabled: !state.canGoForward, onClick: goForward }, strokePath('M6 3.2 10.8 8 6 12.8')),
          h(IconButton, { label: t('action.reload'), onClick: reload },
            h('path', { d: 'M12.6 8A4.6 4.6 0 1 1 11 4.6', ...STROKE }),
            h('path', { d: 'M12.9 2.4v3h-3', ...STROKE })
          ),
          h(IconButton, { label: t('action.home'), onClick: goHome },
            h('path', { d: 'M3.2 7.4 8 3.4l4.8 4v5.2h-9.6z', ...STROKE })
          ),
          h('span', { className: 'dwc-location', title: state.url }, state.url || HOME),
          state.loading ? h('span', { className: 'dwc-spinner', 'aria-hidden': true }) : null,
          h(IconButton, { label: t('action.external'), onClick: openExternal },
            h('path', { d: 'M9.4 3.2h3.4v3.4', ...STROKE }),
            h('path', { d: 'M12.8 3.2 7.6 8.4', ...STROKE }),
            h('path', { d: 'M11.2 9.4v3.2H3.4V4.8h3.2', ...STROKE })
          )
        ),
        h('div', { className: 'dwc-viewport', ref: viewportRef },
          h('div', { className: 'dwc-host', ref: hostRef }),
          notice
        )
      )
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-chat: locale')
      ctx.effect(() => ensureStyle(), 'dsh-web-chat: styles')
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
        const disposers = []
        disposers.push(ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 45,
          locale: NS,
          label: () => t('entry.label'),
        }, PanelIcon))
        disposers.push(ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, ChatPanel))
        return () => {
          for (const dispose of disposers) { try { dispose() } catch {} }
        }
      })), 'dsh-web-chat: slots')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
