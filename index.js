/**
 * dsh-web-chat — Host 半部（纯 node，没有 electron 模块）。
 *
 * 页面本身由 client 半部创建：渲染器通过 preload 暴露的
 * `globalThis.dshDesktop.browser` 申请 guest lease，再自己挂 `<webview>`。
 * Host 只负责两件必须落盘的事：
 *
 *   1. 登录态快照 —— DSH 给内嵌浏览器的分区是进程内内存分区，重启即丢，
 *      靠回填 localStorage 让用户不用每次重新登录（httpOnly cookie 不在范围内）。
 *   2. 上次停留的会话 —— 存在 Host 侧文件而不是页面 localStorage：Web GUI
 *      每次启动端口可能不同，而 localStorage 按 origin（含端口）隔离。
 *
 * 路由（同源，client 用 fetch 调）：
 *   - GET  /api/dsh-web-chat/ping
 *   - GET  /api/dsh-web-chat/session     读登录态快照
 *   - POST /api/dsh-web-chat/session     写登录态快照
 *   - GET  /api/dsh-web-chat/last-url    读上次停留的会话地址
 *   - POST /api/dsh-web-chat/last-url    写上次停留的会话地址（空串表示清除）
 *   - POST /api/dsh-web-chat/log         client 诊断日志
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-web-chat'
export const inject = ['webServer']

const CHAT_ORIGIN = 'https://chat.deepseek.com/'
const DATA_DIR = join(homedir(), '.dsh', 'dsh-web-chat')
const LOG_FILE = join(DATA_DIR, 'client.log')
const SESSION_FILE = join(DATA_DIR, 'storage.json')
const LAST_URL_FILE = join(DATA_DIR, 'last-url.json')

function sendJson(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readSession() {
  try {
    const parsed = JSON.parse(await readFile(SESSION_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function readLastUrl() {
  try {
    const parsed = JSON.parse(await readFile(LAST_URL_FILE, 'utf8'))
    return typeof parsed?.url === 'string' ? parsed.url : ''
  } catch {
    return ''
  }
}

async function writeLastUrl(url) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(LAST_URL_FILE, JSON.stringify({ url }), { encoding: 'utf8', mode: 0o600 })
}

/** 只接受 DeepSeek 自己的地址，避免把任意 URL 写进配置。 */
function acceptableUrl(url) {
  return url === '' || (typeof url === 'string' && url.startsWith(CHAT_ORIGIN) && url.length <= 2048)
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-web-chat',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        if (req.method === 'GET' && url.pathname === '/api/dsh-web-chat/ping') {
          sendJson(res, 200, { ok: true, plugin: name, origin: ctx.webServer.getOrigin() })
          return
        }

        if (req.method === 'GET' && url.pathname === '/api/dsh-web-chat/session') {
          sendJson(res, 200, { ok: true, storage: await readSession() })
          return
        }

        if (req.method === 'POST' && url.pathname === '/api/dsh-web-chat/session') {
          const text = await readBody(req, 1024 * 1024)
          if (text === null) {
            sendJson(res, 413, { ok: false, error: 'body too large' })
            return
          }
          let parsed
          try { parsed = JSON.parse(text) } catch { parsed = null }
          const storage = parsed?.storage
          if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
            sendJson(res, 400, { ok: false, error: 'storage object required' })
            return
          }
          await mkdir(DATA_DIR, { recursive: true })
          await writeFile(SESSION_FILE, JSON.stringify(storage), { encoding: 'utf8', mode: 0o600 })
          sendJson(res, 200, { ok: true, keys: Object.keys(storage).length })
          return
        }

        if (req.method === 'GET' && url.pathname === '/api/dsh-web-chat/last-url') {
          sendJson(res, 200, { ok: true, url: await readLastUrl() })
          return
        }

        if (req.method === 'POST' && url.pathname === '/api/dsh-web-chat/last-url') {
          const text = await readBody(req, 8 * 1024)
          if (text === null) {
            sendJson(res, 413, { ok: false, error: 'body too large' })
            return
          }
          let parsed
          try { parsed = JSON.parse(text) } catch { parsed = null }
          const next = typeof parsed?.url === 'string' ? parsed.url.trim() : null
          if (next === null || !acceptableUrl(next)) {
            sendJson(res, 400, { ok: false, error: 'chat.deepseek.com URL required' })
            return
          }
          await writeLastUrl(next)
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && url.pathname === '/api/dsh-web-chat/log') {
          const text = await readBody(req, 64 * 1024)
          if (text === null) {
            sendJson(res, 413, { ok: false, error: 'body too large' })
            return
          }
          await mkdir(DATA_DIR, { recursive: true })
          await appendFile(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8')
          sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-web-chat: http routes')
}
