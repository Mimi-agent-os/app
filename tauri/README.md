# mimi desktop and Android shell

The Tauri v2 shell that packages the app's control panel as a native app; the control panel itself is in [the app README](../README.md).
It bundles the built control panel (into `tauri/panel`, loaded from `tauri://localhost`) and connects to the gateway you pair it with; the gateway and agents run separately.
Desktop: macOS 13.3 or newer and Windows. Android: [TEST-MOBILE.md](TEST-MOBILE.md). `pnpm desktop:check` tests this Rust side locally.

Requires Node.js 24 or newer, pnpm, Rust and the Tauri CLI v2.

## Prerequisites

- `pnpm install` done in `app/`, with `protocol/` built beside it.
- Rust through [rustup](https://rustup.rs/), plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS. Windows also needs Visual Studio Build Tools (Desktop development with C++) and WebView2.
- Tauri CLI v2: `cargo install tauri-cli --version "^2.0.0" --locked`.

`pnpm desktop:doctor` checks Node, Rust, Cargo and the Tauri CLI, read-only.

## Build and run

From `app/`:

```sh
pnpm desktop:dev                        # vite on 127.0.0.1:1420 (keep it free), then cargo tauri dev
pnpm desktop:check                      # icons, cargo check, cargo test --lib
pnpm desktop:build:test                 # debug executable, unbundled
./tauri/src-tauri/target/debug/mimi     # run it from a terminal to see the Rust log
pnpm desktop:build                      # macOS: target/release/bundle/macos/mimi.app
                                        # Windows: target/release/bundle/nsis/
```

Arguments after `--` go to cargo. On first start the app shows the Connect screen: paste the link
`mimi pair` prints. The address and the device key stay in the WebView's `localStorage`.

On macOS, closing the window keeps the app in the Dock with its channel up, so system notifications
(approvals, questions, finished replies, Inbox items, device requests) keep coming; a click on the Dock
icon brings the window back, and Cmd+Q or Quit mimi quits. On Windows, closing the window quits.

Desktop builds come out unsigned and unnotarized; signing settings go under `bundle` in `tauri.conf.json`.

The native surface is seven commands (`notify`, `push_token`, `quit_app`, `open_link`, `apps_attach`,
`app_body`, `app_respond`), granted to the control panel's window by `capabilities/main.json`; the
window holds no `shell:*` permission. Each command checks that the call's Origin is the control
panel's. On custom-protocol IPC the browser sets that Origin. On Tauri's postMessage path (the IPC on
Android, and the desktop's fallback) the page sets the headers, so there the guard is Tauri's invoke
key, which is injected into the control panel's main frame alone. `open_link` accepts http(s) and
mailto links; `push_token` serves the Android app.

## Mini-app check on macOS

A mini-app is the web interface an agent serves from its own server (`runAgent({ app })` in the
[sdk](https://github.com/Mimi-agent-os/sdk)). Each one runs in a frame on its own origin,
`mimiapp://<appId>.<pin>.<tag>.localhost/`, and every request goes through the control panel's
encrypted channel. `<pin>` is the first 5 bytes of a hash of the agent's key fingerprint and the time
the gateway admitted it, `<tag>` the first 5 bytes of the gateway key, both in hex. Isolation is
covered by the gateway's tests and `test/mini-app*.test.ts`; the frame itself is checked by hand on
macOS, as follows.

1. `mimi start`, then `pnpm desktop:dev` and pair with `mimi pair`.
2. Run an agent that serves an interface and open its Interfaces tab.
3. Right-click in the frame, Inspect Element, pick the frame's context. `location.origin` is
   `mimiapp://<appId>.<pin>.<tag>.localhost`, `typeof __TAURI_INTERNALS__` is `"undefined"`,
   `localStorage.getItem("mimi-os:device")` is `null`, and `parent.document` throws.
4. Repeat with the `desktop:build:test` executable (pair again: new origin), then with the bundled
   `mimi.app`.

To trace a request, read the Rust log in debug builds (`mimiapp: <METHOD> <URL> body <bytes>
[headers]`, `mimiapp: refused with <status>`), the control panel's console (`mimi-app:` lines), and
the gateway log (`mimi logs -f`). Web Inspector and the Rust log come with debug builds.

## Neighbours

- [app README](../README.md): the control panel, its scripts and pairing.
- [gateway](https://github.com/Mimi-agent-os/gateway): `mimi pair`, `mimi invite`.
- [sdk](https://github.com/Mimi-agent-os/sdk): build an agent, with or without an interface; a first one is in the [wiki](https://mimi-agent-os.github.io/wiki/#/sdk).
