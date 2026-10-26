# dsh-web-chat

DSH 桌面版里的「聊天」面板：侧栏一个入口，主面板内嵌 [chat.deepseek.com](https://chat.deepseek.com/) 本体，
用网页端自己的登录态，不做代理、不抓内容。

## 安装

```sh
dsh plugin --profile desktop add dsh-web-chat
```

重启 DSH，侧栏出现「聊天」。

## 行为

- **切换面板不重载**：webview 挂在 body 级的固定浮层里，面板卸载时只隐藏、不释放 guest，
  切回来还是同一个页面（滚动位置、输入框草稿都在）。
- **记住会话**：下次打开回到上次停留的会话，而不是首页。地址存在 Host 侧
  `~/.dsh/dsh-web-chat/last-url.json`（Web GUI 端口每次启动可能不同，存页面 localStorage 会丢）。
  点工具栏「回首页」会清掉这条记录。
- **登录态快照**：内嵌浏览器分区是进程内内存分区，重启即丢。登录后把 localStorage 里与
  登录相关的键存到 `~/.dsh/dsh-web-chat/storage.json`（0600），下次载入先回填再刷新。
  httpOnly cookie 不在快照范围内，所以偶尔仍需重登。
- **工具栏**：后退 / 前进 / 刷新 / 回首页 / 当前地址 / 在系统浏览器中打开。
- **环境 UA**：客机默认 UA 带 `Electron/…`，网页版会据此判「使用环境异常」。插件在 attach
  之前把 UA 换成同版本号的干净 Chrome UA。
- **自动关掉那条风险告示**：网页版还会按 `window.process.type === "renderer"` 判一次，这个
  渲染层改不掉，于是它仍会弹「使用环境异常」。该告示本身可关闭（点 × 会写
  `closeUnsafeEnvWarn`），插件替你关一次，并把该键纳入登录快照，重启后不再弹。
  想保留这条告示：把 `client.js` 顶部的 `DISMISS_ENV_WARNING` 改成 `false`。

## 要求

- DSH 桌面版（依赖 preload 暴露的 `globalThis.dshDesktop.browser`），`>= 0.2.1-rc.2`。
- Web 版不工作，面板会显示一行说明。

## 已知限制（宿主策略，插件绕不过）

- guest 内发起的下载会被取消；通知、麦克风、剪贴板等权限一律拒绝。
- 窗口打开请求转成同面板内导航。
- 保活意味着一个网页渲染进程常驻（约一两百 MB），关掉 DSH 才释放。
- 上游网页改版可能让快照/深链失效，失效后重新登录即可。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host：`/api/dsh-web-chat/{ping,session,last-url,log}`，落盘到 `~/.dsh/dsh-web-chat/` |
| `client.js` | Client：侧栏入口、主面板、浮层保活、登录态与地址记忆 |
| `cordis.patch.yml` | bundle 自注册一行 |
| `icon.svg` | 侧栏图标（描边气泡，与其它入口同风格） |

关闭保活：把 `client.js` 顶部的 `KEEP_ALIVE` 改成 `false`，退回「卸载即释放」的行为。

## 安装（国内网络）

DSH 安装 git 插件是由本机直接去 GitHub 下载，不经过插件市场或镜像源。没有代理的网络会报「无法连接 github.com」。

可改用压缩包直链（CDN，无需代理）：

`
https://cdn.jsdelivr.net/gh/doraasn/dsh-web-chat@main/dist/dsh-web-chat-1.0.5.tgz
`

插件市场 →「压缩包」→ 粘贴上面的地址即可安装。

