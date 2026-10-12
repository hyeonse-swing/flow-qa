# Releases and verification

The alpha entries below are historical release records. They document earlier package versions and checks.

## 0.2.0: configurable mobile targets

Adds native iOS/Android target settings, mobile case authoring before device setup, platform-aware compilation and execution, and app/device identity in review and reports. Users register an installed app and a prepared device when ready; no product-specific app is bundled. Existing web settings and suites remain readable. Node.js 24.8 or later is required by the mobile runtime. Actual native-device success requires a user-selected app and device. See [mobile setup and verification limits](mobile.md).

Locally verified on macOS with Node.js 24.14.1 on 2026-10-12: 89 tests, type checking, UI syntax and design-system audit, package build and fresh tarball installation. Chromium smoke preserved web pass/failure/unavailable classifications and English/Korean UI behavior. The installed package can create a mobile prompt, validate and compile mobile cases before target setup, and save iOS/Android settings. Native generated code was type-checked against the installed SDK; device selection and blocking were tested with inventory fixtures. These checks did not execute a native app or call a model.

- Package: [`@ihyeon/flow-qa@0.2.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.0)
- Release: [GitHub 0.2.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.0)

## Automated npm and GitHub releases

A push to `main` publishes only when `package.json` changes to a new plain `X.Y.Z` version. Pull requests and pushes without a version change run verification without publishing. The package and lockfile versions must agree; the version must increase, and registry errors stop the release. Rerunning a successful publication skips the existing immutable npm version.

The `publish` job in [ci.yml](../.github/workflows/ci.yml) waits for the full verification matrix on Ubuntu and macOS, then publishes through npm trusted publishing (OIDC). It uses the `latest` tag, requires the registry's `gitHead` to match the workflow commit, and checks the published package with a fresh consumer installation and three real Chromium demo cases. The commit check also applies when retrying an already published version. No npm token is stored in GitHub secrets. After the published package passes its consumer smoke check, a separate job creates the matching GitHub tag and release at the exact verified commit. It preserves existing releases and rejects a tag pointing to another commit. Rerunning an older release does not replace a newer latest release.

For the next release, update the release notes and current installation examples, then bump the version before committing and pushing:

```sh
npm version patch --no-git-tag-version
npm run check
```

Push the version change to `main` and check the **Verify release** workflow. A successful verification job alone does not confirm publication: the publish job and its registry smoke check must also pass. GitHub release completion is reported by the separate release job. Retry a transient failure by rerunning the same workflow; do not reuse a published version for different package contents.

The npm trusted publisher is configured for GitHub repository `hyeonse-swing/flow-qa`, workflow `ci.yml`, with direct publishing allowed. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for account setup.

## 0.1.3

- `doctor` reports whether each configured planner or agent key environment variable is present, missing, or not configured. English and Korean diagnostics show no credential values and make no model requests. The command remains informational.
- CLI target and model configuration updates write a private temporary file, synchronize it, and replace the configuration only after the new JSON is complete. Existing initialization and exclusive case-file creation behavior are preserved. This protects against partially written configuration during process interruption; it does not serialize concurrent CLI updates or guarantee rename durability after power loss.
- CI runs the existing test, browser, UI, and package-install checks on Ubuntu and macOS before publishing. Successful npm publication and its consumer smoke check now also create the corresponding GitHub release.

- Package: [`@ihyeon/flow-qa@0.1.3`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.1.3)
- Release: [GitHub 0.1.3](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.3)
- Verification: [GitHub Actions](https://github.com/hyeonse-swing/flow-qa/actions/workflows/ci.yml)

## 0.1.2

Adds version-gated npm publishing from GitHub Actions and npm links in both README languages. Runtime behavior is unchanged from 0.1.1.

- Package: [`@ihyeon/flow-qa@0.1.2`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.1.2)
- Verification and publication: [GitHub Actions](https://github.com/hyeonse-swing/flow-qa/actions/workflows/ci.yml)

## 0.1.1

This release uses plain semver and the npm `latest` dist-tag. It includes the runtime fixes documented in the historical entry below, with no additional runtime changes. The existing runtime passed 47 tests and the browser checks recorded there. Version 0.1.1 metadata, package contents, and a fresh consumer installation were also verified: the installed `flow-qa` command worked and all three Chromium demo cases passed without model calls.

- Package target: [`@ihyeon/flow-qa@0.1.1`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.1.1), npm `latest` dist-tag
- Source and package: [GitHub release](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.1)
- Public checks: [GitHub Actions](https://github.com/hyeonse-swing/flow-qa/actions/workflows/ci.yml)

Use the matching source revision when checking this historical package:

```sh
FLOWQA_PACKAGE_SPEC=@ihyeon/flow-qa@0.1.1 npm run smoke:package
```

## Historical: 0.1.0-alpha.3

This maintenance release keeps the existing CLI, UI, and case schema. It tightens result validation, bounds UI shutdown, and checks the command that npm installs for consumers.

- A result marked `passed` must contain a single first attempt that passed. A passing retry must have a consistent `flaky` history. Contradictory histories are rejected instead of producing a misleading success report.
- UI shutdown stops accepting connections immediately, allows existing requests up to one second to finish, and then closes remaining HTTP connections. An incomplete JSON request can no longer hold shutdown open. Planner cancellation responses and run cancellation are preserved.
- Consumer smoke checks verify npm's installed `flow-qa` command and invoke it offline for help, workspace initialization, validation, and runtime diagnostics. The installed UI still runs three real Chromium cases.

Both runtime fixes have regression tests that failed before the changes and passed afterward. Verification uses local test data and no model calls; it does not establish external authentication or model quality.

Checked on macOS with Node.js 24.14.1 on 2026-10-12: all 47 tests, type checking, UI syntax, and the design-system audit passed. Real Chromium checks preserved normal pass, intentional assertion failure, and unreachable-app classifications. The bilingual UI smoke passed, including report downloads and a 390px viewport. The runtime dependency audit reported zero known vulnerabilities at that time.

- Package: [`@ihyeon/flow-qa@0.1.0-alpha.3`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.1.0-alpha.3)
- Source and package: [GitHub alpha release](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.0-alpha.3)
- Public checks: [GitHub Actions](https://github.com/hyeonse-swing/flow-qa/actions/workflows/ci.yml)

To reproduce this release's checks from its source:

```sh
npm ci
npm run check
npm run qa -- browser install
npm run demo:smoke
npm run smoke:ui
npm run check:package
npm run smoke:package
FLOWQA_PACKAGE_SPEC=@ihyeon/flow-qa@0.1.0-alpha.3 npm run smoke:package
```

## Historical: 0.1.0-alpha.2

This update replaces the introductory video link with two UI screenshots. Runtime behavior is unchanged from alpha.1. Media files are not included in the npm tarball.

The verification record and reproduction commands below describe alpha.2. Use its matching source tag when reproducing that historical release.

This public alpha provides a local CLI and UI, structured case validation, browser-run orchestration, and QA reports linked to evidence. Its bundled to-do app demo runs without a model.

- Package: [`@ihyeon/flow-qa@0.1.0-alpha.2`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.1.0-alpha.2), with the `alpha` dist-tag
- Source and package: [GitHub alpha release](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.0-alpha.2)
- Public checks: [GitHub Actions](https://github.com/hyeonse-swing/flow-qa/actions/workflows/ci.yml)

### Local evidence

Checked on macOS with Node.js 24.14.1 on 2026-10-08. The English-default and Korean UI share the same execution and data contracts.

| Check | Observed result |
| --- | --- |
| Types, unit tests, UI static checks | 45 tests, type checking, JavaScript syntax, and the design-system token audit passed |
| Real Chromium | Three normal cases passed; an intentional assertion failure and an unreachable app were classified separately |
| Package contents | Compiled CLI, UI, demo, and bundled design system included; workspace data, run results, and secret files excluded |
| Tarball in a fresh consumer workspace | Installed with Git execution disabled; CLI, UI, fonts, and the three actual cases passed |
| Language behavior in Chromium | English first visit, Korean switching, persisted preference, cross-tab sync, preserved edits and review, live run completion, localized Markdown downloads, and 390px viewport passed |
| Runtime dependency audit | `npm audit --omit=dev` found no known vulnerabilities at the time of the check |

These browser checks used a locally installed Chromium. They do not prove first install on a clean OS, authenticated behavior in another service, or real-model quality and cost. Dependency audit results are time-sensitive.

### Reproduce

```sh
npm ci
npm run check
npm run qa -- browser install
npm run demo:smoke
npm run smoke:ui
npm run check:package
npm run smoke:package
```

`check:package` checks the distribution file list and required resources. `smoke:package` installs the tarball into a temporary consumer workspace, then checks the CLI, UI, and real browser run. It writes results to `output/package/tarball-smoke.json`, outside the published package.

Check the published registry version separately. The script requires the installed package name and version to match the current `package.json` exactly.

```sh
FLOWQA_PACKAGE_SPEC=@ihyeon/flow-qa@0.1.0-alpha.2 npm run smoke:package
```

Registry results are written to `output/package/registry-smoke.json`. GitHub CI checks types and tests, Chromium pass/fail/blocked cases, and tarball installation on Linux; its artifacts contain the check results. Confirm publication and CI independently on the package page and the workflow run for the relevant commit.

### Scope and credits

This alpha does not provide login-session setup, a model-spending cap, scheduled CI runs, or a shared team server. Case planning and natural-language browser action use separately configured OpenAI-compatible APIs; local demo checks do not establish model quality or behavior in an external authenticated app. The UI library lists only top-level `cases/*.json` and linked `flows/*.md` files.

The browser engine is `e2e@0.16.0` with `@e2e-dev/web@0.11.1`. The design system is fetched from a pinned public HTTPS source and bundled with the npm package, so consumers do not need GitHub authentication to install it. See the [third-party notices](../THIRD_PARTY_NOTICES.md) for component licenses.
