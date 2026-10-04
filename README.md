# mimi app

[![CI](https://github.com/Mimi-agent-os/app/actions/workflows/ci.yml/badge.svg)](https://github.com/Mimi-agent-os/app/actions/workflows/ci.yml)

The client app of mimi-os, a personal agent runtime: where you chat with your agents, approve what they ask to do, and set up models and limits.
It is a React control panel, packaged by a Tauri v2 shell as a desktop app and an Android app.
It pairs once with your gateway (the mimi-os daemon), then talks to it over an end-to-end encrypted channel.

Requires Node.js 24 or newer and pnpm (`corepack enable pnpm`). Desktop and Android builds also need Rust and the Tauri CLI v2.

## Platforms

- Desktop: macOS (an app bundle) and Windows (an NSIS installer).
- Android: debug and signed release APKs, with phone notifications: [tauri/TEST-MOBILE.md](tauri/TEST-MOBILE.md).
- Agent interfaces (mini-apps: web pages an agent serves) open in the macOS desktop app.

## Setup

The app depends on `protocol` through `link:../protocol`, so clone both side by side and build protocol first:

```sh
git clone https://github.com/Mimi-agent-os/protocol.git
git clone https://github.com/Mimi-agent-os/app.git
(cd protocol && pnpm install && pnpm build)
cd app && pnpm install
```

## Commands

```sh
pnpm dev                  # the control panel in a browser at http://localhost:5273/app/
pnpm check                # tsc --noEmit
pnpm test                 # node --test "test/**/*.test.ts"
pnpm build                # web build into dist/
pnpm desktop:doctor       # read-only check of Node, Rust, Cargo and Tauri CLI v2
pnpm desktop:dev          # vite on 127.0.0.1:1420 plus cargo tauri dev, with live reload
pnpm desktop:check        # icons, cargo check, native library tests
pnpm desktop:build:test   # debug executable, unbundled
pnpm desktop:build        # macOS: mimi.app, which can also dial plain http://; Windows: NSIS installer
pnpm desktop:icons        # regenerate icons from tauri/src-tauri/icons/icon.png
pnpm android:apk          # debug APK for an arm64 phone
pnpm android:release      # signed release APK that can also dial plain http://
```

`pnpm check` and `pnpm test` run on Node.js alone. CI runs `check`, `test` and `build` on Node.js 24;
`pnpm desktop:check` checks and tests the Tauri (Rust) side locally.

## Desktop on a Mac

Install Rust with [rustup](https://rustup.rs/), the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
and the Tauri CLI (`cargo install tauri-cli --version "^2.0.0" --locked`). Then `pnpm desktop:doctor`,
`pnpm desktop:dev`, and `pnpm desktop:build` for `tauri/src-tauri/target/release/bundle/macos/mimi.app`.
Details and the mini-app check: [tauri/README.md](tauri/README.md).

## Pairing

```sh
mimi start                # the gateway
mimi pair                 # prints one link: single use, valid for 2 minutes
```

Paste the link into the app's Connect screen. It names the address to dial: the gateway's public URL
(`MIMI_PUBLIC_URL`) if set, then Tailscale, then LAN when the gateway runs with `--lan <host>`, else
loopback; `mimi pair --address <url>` picks another. A device paired this way is active at once.
The device key lives in the page's `localStorage`, so the browser dev server, `desktop:dev` and the
bundled app each pair separately.

## Layout

```text
src/main.tsx, App.tsx    entry and the app shell
src/channel.ts           device key, pairing, the encrypted channel
src/api.ts, *-api.ts     gateway calls over the channel
src/views/               screens: chat, agent page, gateway, pair, models, limits, usage
src/components/          shared UI
src/mini-app*            agent interfaces: request relay, bridge script, cookies, WebSocket
tauri/                   the desktop and Android shell (Rust)
scripts/desktop.mjs      the runner behind desktop:* and android:*
test/                    node --test suites
```

## Neighbours

- [launch](https://github.com/Mimi-agent-os/launch): sets up a workspace for a gateway server or an agent developer.
- [protocol](https://github.com/Mimi-agent-os/protocol): the channel this app speaks.
- [gateway](https://github.com/Mimi-agent-os/gateway): `mimi start`, `mimi pair`, the other end of the channel.
- [sdk](https://github.com/Mimi-agent-os/sdk): build an agent; one that runs its own web server (`runAgent({ app })`)
  opens here as a mini-app. A first agent: the [wiki](https://mimi-agent-os.github.io/wiki/#/sdk).

Licensed under Apache-2.0, see LICENSE.
