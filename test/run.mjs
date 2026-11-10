/**
 * 自测：不碰真实 ~/.dsh，用临时 DSH_HOME；断言全部走真 HTTP 处理函数（假 req/res）。
 * 用法: npm test
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-chat-test-'))
process.env.DSH_HOME = HOME

const { apply } = await import(new URL('../index.js', import.meta.url).href)

const SELF_ORIGIN = 'http://127.0.0.1:59681'
const HOST = '127.0.0.1:59681'

let handler = null
apply({
  webServer: { register: (route) => { handler = route.handler }, getOrigin: () => SELF_ORIGIN },
  /** 宿主 effect：立即执行注册函数（真实实现返回清理函数，这里不需要）。 */
  effect: (fn) => fn(),
})

let passed = 0
let failed = 0
const check = (name, condition, extra = '') => {
  if (condition) passed++
  else {
    failed++
    console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`)
  }
}

/** 假 req：readBody 用 for await 读流，所以这里实现 async iterator。 */
const makeReq = (url, method = 'GET', headers = { host: HOST }, body = null) => ({
  url,
  method,
  headers,
  async *[Symbol.asyncIterator]() {
    if (body !== null) yield Buffer.from(body)
  },
})

const call = async (url, method = 'GET', body = null, headers = { host: HOST }) => {
  let status = 200
  let payload = null
  const res = {
    setHeader() {},
    end(value) { payload = value },
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => status,
    set: (value) => { status = value },
  })
  await handler(makeReq(url, method, headers, body), res)
  let parsed = null
  try { parsed = JSON.parse(payload) } catch { parsed = payload }
  return { status, body: parsed }
}

// ---- 1. 基本可用 ----
const ping = await call('/api/dsh-web-chat/ping')
check('ping 200', ping.status === 200 && ping.body.ok === true)
check('ping 带 origin', ping.body.origin === SELF_ORIGIN)

const empty = await call('/api/dsh-web-chat/session')
check('空快照返回 {}', empty.status === 200 && Object.keys(empty.body.storage).length === 0)

// ---- 2. 登录快照读写 ----
const storage = { userToken: 'ut-123', __appKit_userInfo: '{"name":"x"}' }
const saved = await call('/api/dsh-web-chat/session', 'POST', JSON.stringify({ storage }))
check('写快照 200', saved.status === 200 && saved.body.keys === 2)
const readback = await call('/api/dsh-web-chat/session')
check('读回一致', readback.body.storage.userToken === 'ut-123')
check('落盘在 DSH_HOME 下', fs.existsSync(path.join(HOME, 'dsh-web-chat', 'storage.json')))

// ---- 3. last-url ----
const okUrl = await call('/api/dsh-web-chat/last-url', 'POST', JSON.stringify({ url: 'https://chat.deepseek.com/a/chat/s/abc' }))
check('合法会话地址 200', okUrl.status === 200)
check('last-url 读回', (await call('/api/dsh-web-chat/last-url')).body.url === 'https://chat.deepseek.com/a/chat/s/abc')
const badUrl = await call('/api/dsh-web-chat/last-url', 'POST', JSON.stringify({ url: 'https://evil.example/' }))
check('非 DeepSeek 地址被拒', badUrl.status === 400)

// ---- 4. 诊断日志 ----
const logged = await call('/api/dsh-web-chat/log', 'POST', 'hello')
check('日志 200', logged.status === 200)
check('日志落盘', fs.readFileSync(path.join(HOME, 'dsh-web-chat', 'client.log'), 'utf8').includes('hello'))

// ---- 5. 本机同源防护 ----
const rebind = await call('/api/dsh-web-chat/session', 'GET', null, { host: 'evil.example' })
check('伪造 Host 被拒（DNS rebinding）', rebind.status === 403 && rebind.body.error === 'forbidden-host', `实际 ${rebind.status}`)

const csrf = await call('/api/dsh-web-chat/session', 'POST', JSON.stringify({ storage: {} }), { host: HOST, origin: 'https://evil.example' })
check('跨站 Origin 被拒（CSRF）', csrf.status === 403 && csrf.body.error === 'forbidden-origin', `实际 ${csrf.status}`)

const nullOrigin = await call('/api/dsh-web-chat/session', 'POST', JSON.stringify({ storage: {} }), { host: HOST, origin: 'null' })
check('Origin: null 被拒', nullOrigin.status === 403)

const sameOrigin = await call('/api/dsh-web-chat/session', 'POST', JSON.stringify({ storage: { userToken: 'ut-2' } }), { host: HOST, origin: SELF_ORIGIN })
check('同源 POST 放行', sameOrigin.status === 200)

// 从 localhost 打开 GUI 与从 127.0.0.1 打开是同一服务：端口一致应放行
const localhostOrigin = await call('/api/dsh-web-chat/session', 'GET', null, { host: HOST, origin: 'http://localhost:59681' })
check('localhost 同端口放行', localhostOrigin.status === 200, `实际 ${localhostOrigin.status}`)

const otherPort = await call('/api/dsh-web-chat/session', 'GET', null, { host: HOST, origin: 'http://localhost:6000' })
check('端口不同被拒', otherPort.status === 403, `实际 ${otherPort.status}`)

// ---- 6. 体积上限 ----
const huge = await call('/api/dsh-web-chat/session', 'POST', 'x'.repeat(1024 * 1024 + 64))
check('超 1MB 返回 413', huge.status === 413, `实际 ${huge.status}`)

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
