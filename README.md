# Supertree

Supertree is a local-first desktop app for running coding agents against real repositories with
isolated workspaces and built-in review workflows.

## Requirements

- Node.js 20+
- Rust stable (cargo, rustc)
- Platform dependencies for Tauri (GTK/WebKit on Linux)

## Setup

```bash
npm install
npm --prefix sidecar install
npm --prefix sidecar run build
```

If you prefer pnpm:

```bash
pnpm install
pnpm --filter sidecar run build
```

## Development

Start just the UI (Vite):

```bash
npm run dev
```

Or with pnpm:

```bash
pnpm dev
```

Start the full desktop shell (Tauri):

```bash
cargo tauri dev
```

`cargo tauri dev` runs the helper at `scripts/dev-tauri.mjs` to start the UI and the sidecar
watcher together. Sidecar logs should appear in the same terminal.

## Build

```bash
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
```

## CI

GitHub Actions runs lint, typecheck, tests, and builds on macOS, Windows, and Linux.
