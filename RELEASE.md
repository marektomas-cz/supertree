# Release process

1) Ensure main is green and your local tree is clean.
2) Bump the version in all locations:
   - `package.json`
   - `sidecar/package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
3) Validate versions:
   - `node scripts/validate-versions.mjs`
4) Run locally:
   - `npm install`
   - `npm --prefix sidecar install`
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run build`
   - `npm --prefix sidecar run build`
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `cargo build --release --manifest-path src-tauri/Cargo.toml`
5) Commit and tag:
   - `git commit -am "Release vX.Y.Z"`
   - `git tag vX.Y.Z`
   - `git push origin main --tags`
6) The `Release` workflow builds installers for macOS, Windows, and Linux and
   attaches them to the GitHub Release for the tag.
7) Verify the GitHub Release assets and run a smoke test on each OS:
   - App launches and renders the main shell.
   - Add a repo, create a workspace, and open a chat session.
   - Notes/todos save and reload on restart.
   - Git panel loads status without errors.
