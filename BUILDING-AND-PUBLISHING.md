# Building and Publishing

How to ship `meadow-integration` to npm and to GitHub Container Registry
(GHCR), and how to consume the published image. This doc follows the
same template as the other dockerized retold tools — the structure is
identical across modules, only the module-specific details (image name,
env vars, lifecycle shape) differ.

`meadow-integration` is a **one-shot job** rather than a long-running
service: the container runs the data-clone command, exits with a status
code, and is meant to be invoked once per sync rather than left running.
That shape difference shows up in the [Module-specific notes](#module-specific-notes)
section below.

---

## TL;DR

```bash
# npm-only release (the default — most common case)
npm run release:patch

# npm release that ALSO rebuilds the GHCR image
npm run release:patch:image
```

The default release is npm-only. Docker images are deliberate, opt-in
artifacts because each multi-arch build burns several minutes of CI
time. Use `:image` (or set `BUILD_DOCKER=1`) when you actually want a
new image — typically when runtime code, dependencies, env-var contract,
or the Dockerfile changed. For a doc-only fix or internal-only patch,
the plain `release:patch` ships to npm and skips the image rebuild.

---

## Prerequisites (one-time setup)

- **npm login** — `npm whoami` should print your username. If not,
  `npm login`.
- **Git remote configured** — `git remote get-url origin` should print
  the GitHub HTTPS or SSH URL. If not, `git remote add origin
  git@github.com:fable-retold/meadow-integration.git`.
- **Push access to the repo** — required so `postversion` /
  `postpublish` can push the tag. The GHCR workflow runs under
  `GITHUB_TOKEN` so no extra registry auth needed for image pushing.
- **Docker** (only if you want to test the image locally before tag) —
  `docker version` should respond.

---

## Ecosystem convention: lockfiles are gitignored

`package-lock.json` is in this repo's `.gitignore` (Quackage convention
shared across the retold ecosystem). That has two consequences for the
Dockerfile and the publish pipeline that are worth knowing:

- **The Dockerfile uses `npm install`, not `npm ci`.** `npm ci` requires
  `package-lock.json` to be present in the build context, and CI runners
  check out only what's in git. Switching to `npm ci` will fail every
  GHCR build with `EUSAGE: The npm ci command can only install with an
  existing package-lock.json`.
- **Builds resolve dep ranges fresh each time.** The tradeoff vs. a
  pinned `npm ci` build is reproducibility — two builds of the same git
  SHA can pick up different transitive versions if anything in the
  range bumps. Acceptable for retold modules because the upstream
  ranges are owned by the same author; for stricter reproducibility,
  the alternative is to commit the lockfile (and revert the
  ecosystem-wide convention here).

If you see `npm ci` errors in the GHCR workflow logs, the fix is always
the same: change `RUN npm ci` to `RUN npm install` in the Dockerfile.

---

## Releasing

### Two flavors of release

| Command                              | npm registry | GHCR image rebuild |
|--------------------------------------|--------------|--------------------|
| `npm run release:patch`              | yes          | no                 |
| `npm run release:patch:image`        | yes          | yes                |
| `npm run release:minor`              | yes          | no                 |
| `npm run release:minor:image`        | yes          | yes                |
| `npm run release:major`              | yes          | no                 |
| `npm run release:major:image`        | yes          | yes                |

The non-`:image` variants are the default because most patch releases
don't change runtime behavior; the `:image` variants tell the pipeline
"this release does change runtime — build me a new image."

### What `release:patch` does (no docker)

1. **`npm version patch`** — bumps `package.json`, creates a commit
   (`1.0.39`), creates a local tag `v1.0.39`.
2. **`postversion`** hook fires — `git push` pushes the commit. The
   tag stays local (intentional — no tag push means no GHCR trigger).
3. **`npm publish`** runs — `prepublishOnly` runs `npm test` first as
   the gate. If tests fail, publish aborts.
4. **`postpublish`** hook fires — checks `BUILD_DOCKER`; unset, so it
   does nothing.

End state: npm has the new version, git has the bump commit, the
`v1.0.39` tag exists locally only, no GHCR build was triggered.

### What `release:patch:image` does (with docker)

Same as above, except `npm publish` runs with `BUILD_DOCKER=1` in the
environment. The `postpublish` hook sees the flag and pushes the
`v1.0.39` tag to the remote, which fires the GHCR workflow.

### Promoting a previous npm release to docker later

If you released `v1.0.39` to npm only, then later decide you do want a
docker image for it:

```bash
git push origin v1.0.39    # pushes the local tag → GHCR fires
```

The local tag is still sitting there from the original `npm version`
step. Pushing it triggers the workflow without touching npm.

### Direct CLI publish (also works)

```bash
# already-bumped, want to publish to npm only (default):
npm publish

# already-bumped, want to publish to npm AND build docker:
npm run publish:docker
# or equivalently:
BUILD_DOCKER=1 npm publish
```

### From `retold-manager` TUI

- `[!]` Publish — npm only. Existing key, behavior unchanged.
- `[D]` Publish with docker image — npm + GHCR build. New key.

---

## The chain

The lifecycle hooks all live in `package.json`. Default path
(`BUILD_DOCKER` unset):

```
npm publish
  ↓
prepublishOnly: npm test                       ← test gate
  ↓ (passes)
publish to npm registry
  ↓ (succeeds)
postpublish: BUILD_DOCKER unset → no-op        ← image NOT triggered
```

Docker-included path (`BUILD_DOCKER=1`):

```
BUILD_DOCKER=1 npm publish    (or: npm run publish:docker)
  ↓
prepublishOnly: npm test                       ← test gate
  ↓ (passes)
publish to npm registry
  ↓ (succeeds)
postpublish: BUILD_DOCKER=1 → tag + push       ← image trigger
  git tag v<version>                           ← creates if not present
  git push origin v<version>
  ↓ (tag arrives at GitHub)
.github/workflows/publish-image.yml fires:
  - docker buildx build --platform linux/amd64,linux/arm64
  - docker push ghcr.io/fable-retold/meadow-integration:<version>
  - tags: <version>, <major>.<minor>, <major>, latest
```

The `release:patch` (no docker) and `release:patch:image` (docker)
scripts both wrap this with a preceding `npm version patch` so you
don't have to bump separately.

---

## Verifying a release

After `release:patch` completes:

1. **npm**: `npm view meadow-integration version` should print the new
   version (may take ~30s for the registry to update).
2. **GHCR workflow**: visit
   `https://github.com/fable-retold/meadow-integration/actions` and
   confirm the "Publish container image" run succeeded.
3. **Image**: `docker pull ghcr.io/fable-retold/meadow-integration:<version>`
   should succeed. The image is also tagged as `latest`, `<major>`, and
   `<major>.<minor>`.
4. **Smoke test** (one-shot — runs the bundled BookStore default schema
   against a non-existent API; expect it to fail at the data-fetch step,
   which proves the binary started correctly):
   ```bash
   docker run --rm ghcr.io/fable-retold/meadow-integration:latest
   ```

---

## Recovery patterns

### Tests fail during `prepublishOnly`

Publish aborts cleanly — npm registry is untouched, no tag is pushed.
Fix the test, then re-run `npm publish` (the version is already bumped
from the earlier `npm version` step, so don't re-bump).

### `npm publish` succeeded but GHCR build didn't start

Usually means the tag push failed silently (network blip during
`postpublish`). Verify:

```bash
git tag --list 'v*' | tail -5             # is the tag local?
git ls-remote --tags origin | tail -5     # is the tag on the remote?
```

If local but not remote, push manually:
```bash
git push origin v<version>
```

The GHCR workflow triggers on tag push, so this re-fires the build with
no other side effects.

### GHCR build failed

Check the workflow logs in the Actions tab. Common failures: Dockerfile
issue, dependency that doesn't install on the build platform, GHCR
permission issue (rare; `GITHUB_TOKEN` should always have
`packages: write`). Re-run the workflow from the Actions UI after
fixing — no need to bump the npm version.

### Need to re-publish at a different commit

The version-tag-to-commit binding is sticky. To re-publish `v1.0.39`
pointing at a different commit:

```bash
# remove old tag locally and remotely
git tag -d v1.0.39
git push origin :refs/tags/v1.0.39

# unpublish from npm if within the 72h window
npm unpublish meadow-integration@1.0.39

# then re-run release at the new commit
npm run release:patch
```

`npm unpublish` is rate-limited and discouraged in general — better
practice is to bump to a new patch version and ship that.

---

## Versioning conventions

Standard semver:
- **patch** (`1.0.38` → `1.0.39`) — bug fixes, internal cleanup, anything
  that doesn't change the public CLI/API or behavior contract.
- **minor** (`1.0.38` → `1.1.0`) — additive features, new env vars, new
  CLI subcommands, new bundled schemas. Existing consumers continue to
  work.
- **major** (`1.0.38` → `2.0.0`) — breaking changes (env var renamed,
  CLI flag removed, default behavior changed). Bump and document in
  CHANGELOG.

GHCR images are tagged with all three tiers (`<version>`,
`<major>.<minor>`, `<major>`, `latest`), so consumers can pin at
whatever stability level fits.

---

## Image consumption

### Pull and run (one-shot)

```bash
docker pull ghcr.io/fable-retold/meadow-integration:latest

# Single sync run; container exits when done
docker run --rm \
  -e MEADOW_INTEGRATION_API_SERVER=http://your-meadow:8080/1.0/ \
  -e MEADOW_INTEGRATION_API_USERNAME=admin \
  -e MEADOW_INTEGRATION_API_PASSWORD_FILE=/run/secrets/api-pass \
  -e MEADOW_INTEGRATION_DB_HOST=mysql.local \
  -e MEADOW_INTEGRATION_DB_USERNAME=root \
  -e MEADOW_INTEGRATION_DB_PASSWORD_FILE=/run/secrets/db-pass \
  -e MEADOW_INTEGRATION_DB_NAME=mydatabase \
  -e MEADOW_INTEGRATION_SCHEMA_PATH=/schemas/my-schema.json \
  -v $(pwd)/schemas:/schemas:ro \
  ghcr.io/fable-retold/meadow-integration:latest
```

### Configuration via env vars

All `MEADOW_INTEGRATION_*` env vars are read at startup. CLI flags
override env vars; env vars override JSON config; JSON config overrides
built-in defaults.

| Variable                              | Purpose                                            |
|---------------------------------------|----------------------------------------------------|
| `MEADOW_INTEGRATION_API_SERVER`       | Source Meadow API URL                              |
| `MEADOW_INTEGRATION_API_USERNAME`     | API username                                       |
| `MEADOW_INTEGRATION_API_PASSWORD`     | API password                                       |
| `MEADOW_INTEGRATION_DB_PROVIDER`      | `MySQL` or `MSSQL` (default `MySQL`)               |
| `MEADOW_INTEGRATION_DB_HOST`          | Destination DB host                                |
| `MEADOW_INTEGRATION_DB_PORT`          | Destination DB port                                |
| `MEADOW_INTEGRATION_DB_USERNAME`      | DB user                                            |
| `MEADOW_INTEGRATION_DB_PASSWORD`      | DB password                                        |
| `MEADOW_INTEGRATION_DB_NAME`          | Destination database name                          |
| `MEADOW_INTEGRATION_SCHEMA_PATH`      | Path to Meadow extended schema JSON                |

Any secret-bearing var also accepts `<NAME>_FILE` pointing at a file
whose contents become the value (mysql/postgres convention). Use this
for docker secret + k8s Secret mounts:

```bash
-e MEADOW_INTEGRATION_DB_PASSWORD_FILE=/run/secrets/db-pass
```

### Volumes

- Mount your schema file(s) (read-only is fine) and point
  `MEADOW_INTEGRATION_SCHEMA_PATH` at the in-container path.

### Default schema

The image ships with a sample BookStore schema at
`/service_root/schema/default.json`. If `MEADOW_INTEGRATION_SCHEMA_PATH`
is unset (or empty), the data-clone command falls back to it. Useful
for smoke-testing the container shape before wiring your real schema.

### No healthcheck

This image deliberately does not declare a `HEALTHCHECK` because the
process is a one-shot job, not a daemon. Compose / k8s should treat
non-zero exit as failure (which is the default).

---

## Module-specific notes

- **One-shot job shape**: this image runs to completion and exits.
  Restart policy in compose / k8s should be `no` or `OnFailure`,
  never `unless-stopped`. Wrap in a Kubernetes Job or compose
  `restart: "no"` to express "run once and stop".
- **No exposed port**: the data-clone command doesn't accept inbound
  connections. It pulls from the source API and pushes to the
  destination DB.
- **Exit code is the contract**: 0 = clone completed, non-zero = error.
  Operators should chain on exit code (cron, k8s Job retries, compose
  `depends_on: condition: service_completed_successfully`).
