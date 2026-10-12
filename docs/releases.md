# Alpha release and verification

## 0.1.0-alpha.3

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

## 0.1.0-alpha.2

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
