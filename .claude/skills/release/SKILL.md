---
name: release
description: Cut a PR Bunny release — bump the version and codename, compile the `bunny` binaries with apps/app/scripts/build.ts, keep apps/app/scripts/install.sh in step with the build, smoke-test (including the updater), and stage dist/ for upload to prbunny.dev/releases. Use when the user asks to release, ship, cut a version, build bunny binaries, or update the installer.
---

# Releasing PR Bunny

A release is the compiled `bunny` binary (server + UI + migrations + Caddyfile + bunny art in one
file) for each target in `TARGETS` (`apps/app/scripts/build.ts`), plus the installer. The build lays
it out in `apps/app/dist/` so the folder uploads as-is to the releases host:

```
dist/latest                           version number (install.sh reads it first)
dist/latest.json                      { version, name, notesUrl, publishedAt } (the app's updater reads it)
dist/install.sh                       copy of apps/app/scripts/install.sh
dist/<version>/bunny-<os>-<arch>      binaries, with .sha256 next to each
dist/<version>/manifest.json
```

**Where things live:**
- **Release files:** a GitHub Release on the public repo, `DailyStandup-io/pr-bunny`, for tag
  `v<version>`, with every file above attached flat. GitHub's `releases/latest/download/<file>`
  always serves the newest non-draft, non-prerelease release, so "the current version" is simply
  the latest release.
- **prbunny.dev:** `https://prbunny.dev/releases/…` redirects there (`apps/web/next.config.ts`).
  `latest.json` and `latest` go to `releases/latest/download/…`; `<version>/<file>` goes to
  `releases/download/v<version>/<file>`. Set `RELEASES_ORIGIN` on the site to move storage
  elsewhere, laid out like `dist/`.
- **The installer:** served at `https://prbunny.dev/install` by `apps/web/app/install/route.ts`,
  which reads `apps/app/scripts/install.sh` at build time, so installer changes go live with a
  site redeploy. It falls back to GitHub if prbunny.dev can't be reached.
- **The updater:** each install checks prbunny.dev's `latest.json`, then GitHub's if that fails
  (`RELEASE_SOURCES` in `apps/app/src/server/config.ts`). "Update to x" downloads from whichever
  answered, verifies the `.sha256`, checks the binary runs, swaps it in and restarts the service.
  Every build back to 0.1.0 can update this way, as long as either host is up.

The code is public (MIT). The bunny art ships inside the binary, which is fine, but never as loose files.

## Steps

0. **Have the bunny art.** It's licensed and gitignored, so it has to be in
   `packages/brand/private/` on this machine (13 files, see `packages/brand/README.md`). The build
   refuses to run without it. If it's missing, ask the user for it. Don't work around the check.
   Official releases also use Hugeicons Pro: check `bun run icons:pro status`, and if it's not
   installed, run `bun run icons:pro` (needs `HUGEICONS_TOKEN`). The build prints which icon set
   it used.

1. **Check it's releasable.** From the repo root, run `bun run typecheck` and `bun run test`. Stop
   and report if either fails. Don't release around a failure.

2. **Pick the version and codename.** Read `version` and `codename` in `apps/app/package.json`.
   - **Version:** unless the user named one, propose a semver bump based on what changed since the
     last release in `CHANGELOG.md`, and confirm it with them:
     - patch: fixes only
     - minor: new features, or new settings/migrations that stay compatible
     - major: anything that breaks existing installs (data folder, launchd labels, CLI flags users script against)
   - **Codename:** every release gets a new one. They're rabbit food in alphabetical order: Alfalfa
     (0.1.0), Basil, Clover, Dandelion, Endive, Fennel… Pick the next letter.

   Write both to `apps/app/package.json`. The About screen shows them as `Version 0.2.0 “Basil”`.

3. **Update `CHANGELOG.md`** at the repo root. Create it if missing. Add a
   `## <version> “<codename>” — <YYYY-MM-DD>` section, newest first, with short user-facing
   bullets (Added / Changed / Fixed). Call out anything an existing install must do, e.g. re-run
   `bunny setup`. If the notes will be published somewhere, set `PR_BUNNY_NOTES_URL` for the
   build so `latest.json` links to them. The About screen shows a "Release notes" link.

4. **Keep the installer in step.** Run `bun apps/app/scripts/build.ts --check`. Update
   `apps/app/scripts/install.sh` when that check fails, or when this release changes something
   the installer depends on:
   - a target was added or removed in `TARGETS`: update the `# targets:` line and the
     `uname -s` / `uname -m` mapping
   - asset names or the `dist/` layout changed (`bunny-${OS}-${ARCH}`, `$BASE/latest`,
     `$BASE/<version>/…`): the updater in `apps/app/src/server/update.ts` must change to match too
   - the releases host changed: update the `PR_BUNNY_DOWNLOAD_URL` default in install.sh and
     `RELEASES_URL` in `apps/app/src/server/config.ts`
   - what should happen after install changed, e.g. new `bunny setup` flags, or a migration step
     for older installs

   After editing, run the check again and `sh -n apps/app/scripts/install.sh` (plus `shellcheck`
   if it's installed). Keep the installer POSIX `sh`, not bash: it runs as `curl … | sh`.

5. **Build.** Run `bun run build` from the root, or
   `bun apps/app/scripts/build.ts --target darwin-arm64` for a quick single-target build. It
   cross-compiles every target and writes the checksums, `manifest.json`, `latest` and
   `latest.json`. It then smoke-tests the native binary:
   - `bunny version` must print the new version
   - `bunny serve` (on a spare port, with a throwaway data folder) must answer `/api/health` and
     serve the UI
   - its update check, run against a local copy of `dist/`, must report this version as the latest

   If anything fails, fix the cause and rebuild. Never hand-edit files in `dist/`.
   - **Signing:** if the user wants signed binaries, set `PR_BUNNY_SIGN_IDENTITY` to their
     "Developer ID Application: …" identity. `apps/app/scripts/entitlements.plist` holds the JIT
     entitlements Bun needs. Notarizing (`xcrun notarytool submit … --wait`) is a separate step;
     only do it if the user asks and has credentials set up.

6. **Test install and update locally** when install.sh or the updater changed:
   ```sh
   (cd apps/app/dist && python3 -m http.server 8765 --bind 127.0.0.1) &
   H="$(mktemp -d)"
   PR_BUNNY_DOWNLOAD_URL=http://127.0.0.1:8765 PR_BUNNY_HOME="$H" PR_BUNNY_NO_SETUP=1 sh apps/app/dist/install.sh
   "$H/bin/bunny" version
   ```
   To test an update, also build the previous version into that folder, run it with
   `PORT=4491 PR_BUNNY_HOME="$H" PR_BUNNY_UPDATE_URL=http://127.0.0.1:8765 "$H/bin/bunny" serve`,
   then call `POST /api/update/check` and `POST /api/update/install`. Poll `GET /api/update` until
   `status` is `ready`, then run `"$H/bin/bunny" version` again. The restart step needs the launchd
   service, so it can't be tested this way. Stop the servers afterwards.

7. **Publish, only when the user says so.** Uploading makes the release public: every
   `curl | sh` and every running install's update check picks it up. Show the user the version and
   codename, the files with their sha256 values from `dist/<version>/manifest.json`, and the
   changelog entry, then ask before uploading.    If install.sh changed, the web app (`apps/web`) needs a redeploy too. The prbunny.dev deploy
   needs the art as well (set `PR_BUNNY_REQUIRE_ART=1` there, so a deploy without it fails rather
   than shipping a site with no bunny).

   Publish with the GitHub CLI (as the user, from the repo root, once the version commit is pushed):
   ```sh
   V=<version>; C=<codename>
   git tag "v$V" && git push origin "v$V"
   gh release create "v$V" --title "$V “$C”" --notes-file <changelog section as a file> \
     apps/app/dist/$V/* apps/app/dist/latest apps/app/dist/latest.json apps/app/dist/install.sh
   ```
   Creating the release publishes everything in one step. Don't mark it as a draft or prerelease
   unless the user wants that: `releases/latest` skips both, so installs won't see it. Afterwards,
   check that `curl -fsSL https://prbunny.dev/releases/latest` prints the new version.

8. **Report.** Give the version and codename, the targets built, whether the smoke test (including
   the update check) passed, what changed in install.sh (if anything), and whether it was
   published.

## Rules

- Git: if the project is a git repo and the user wants the release committed or tagged, use their
  configured Git identity only. Never add Claude or any AI as author or co-author, and never add
  attribution trailers (see CLAUDE.md). Don't push or tag unless asked.
- Never publish the source, `node_modules`, or anything outside `dist/`. The bunny art is licensed
  (Envato Elements). It ships inside the binary and on the website, but must never be uploaded as
  separate files in a release.
- Don't change `TARGETS` (e.g. to add Linux) as part of a release unless the user asked for it.
  PR Bunny's service setup is macOS-only (launchd, Keychain).
