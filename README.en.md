# dsh-web-chat

A **Chat** panel for DeepSeek Harness (DSH) Desktop: one sidebar entry that embeds
[chat.deepseek.com](https://chat.deepseek.com/) as-is, on the web app's own session.
No proxy, no scraping, no API key.

## What it does

- **No reload when you switch panels.** The webview lives in a body-level fixed
  surface. When the panel unmounts, the surface is only hidden — the guest is not
  released — so switching back returns to the same page, scroll position and draft.
- **Remembers the conversation.** Reopening the panel returns to the last chat
  instead of the home page. The URL is stored host-side
  (`~/.dsh/dsh-web-chat/last-url.json`) because the Web GUI port changes between
  launches and page localStorage is origin-scoped. The toolbar's *Home* button
  clears it.
- **Login snapshot.** The embedded browser partition is process-local and memory-only,
  so it is gone after a restart. After you sign in, the plugin copies the
  login-related localStorage keys to `~/.dsh/dsh-web-chat/storage.json` (0600) and
  restores them before the next load. `httpOnly` cookies are not part of the
  snapshot, so an occasional re-login is expected.
- **Toolbar**: back, forward, reload, home, current URL, open in the system browser.

## Install

```sh
dsh plugin --profile desktop add dsh-web-chat
```

Restart DSH. A **Chat** entry appears in the sidebar.

## Requirements

- DSH Desktop (needs `globalThis.dshDesktop.browser` from the preload bridge),
  `>= 0.2.1-rc.2`.
- The web build only shows a notice: the panel needs the desktop browser bridge.

## Known limits (host policy, not fixable in the plugin)

- Downloads started inside the guest are cancelled; notification, microphone and
  clipboard permission requests are denied.
- Window-open requests become in-panel navigation.
- Keeping the page alive costs one resident web renderer process (roughly 100–200 MB)
  until DSH exits.
- The web app may change; if the deep link or the snapshot stops working, sign in
  again.

## Structure

| File | Role |
| --- | --- |
| `index.js` | Host: `/api/dsh-web-chat/{ping,session,last-url,log}`, persisted under `~/.dsh/dsh-web-chat/` |
| `client.js` | Client: sidebar entry, panel, keep-alive surface, login snapshot and URL memory |
| `cordis.patch.yml` | Bundle self-registration |
| `icon.svg` | Sidebar icon |

Set `KEEP_ALIVE = false` at the top of `client.js` to fall back to
"release on unmount" behaviour.

## Disclaimer

Not affiliated with DeepSeek. The panel renders their official web app with your own
logged-in session; review their terms before use.

## License

MIT. See `LICENSE` and `NOTICE` (embedding approach credits `dsh-dschat`, MIT).
