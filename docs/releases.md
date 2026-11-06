# Releases and verification

The alpha entries below are historical release records. They document earlier package versions and checks.

## 0.7.0: compare archived runs directly from history

History rows now offer **Use as baseline** and **Use as current**, so older runs found by search or paging can be compared. The chosen pair stays available through query/status changes, history refresh, polling, navigation, and language changes. Selected row actions expose their pressed state, and changing a selection or swapping roles clears the old comparison and exports until compared again.

A read-only summary lookup validates selected runs outside the recent 50 using the existing safe JSON report loader; comparison does not require a saved Markdown file. A confirmed deleted, invalid, or unsafe report clears its selection and comparison. Temporary request failures preserve the pair, and stale validation responses cannot change a newer selection. Choosing reports preserves the scenario draft, review state, and open detailed report, and never starts QA execution.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-06: 118 tests, type checking, UI syntax/design-system audit, all existing UI checks, and the real Chromium demo passed. A dedicated browser smoke used 61 synthetic records to verify comparison beyond the latest 50, JSON-only reports, row selection, filtering/paging, polling, navigation/language preservation, swaps, temporary failures, stale missing-file responses after changing away and back to the same selection, deleted archived files, and a 390px layout. A fresh tarball installation ran seven passing browser cases and verified archived summary lookup and comparison. No model calls, external logins, or native-device runs were used.

- Package: [`@ihyeon/flow-qa@0.7.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.7.0)
- Release: [GitHub 0.7.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.7.0)

## 0.6.0: search and page through the full run history

Run-history search and status filters now cover every valid saved report instead of only the latest 50. **Load more** appends up to 50 older matches, and **Refresh history** restarts the list with the same filters. Loaded counts, end-of-results, loading, and retry messages make the current scope explicit. Opening an older report supports the existing downloads and failed/error-case preparation.

The read-only `/api/runs` endpoint applies search and status before pagination, reuses the safe report loader, and uses a bounded cursor tied to the normalized filters. Ordering is by run-directory modification time with a UUID tie-breaker; new records ahead of the cursor do not duplicate earlier pages. External changes to an existing directory's modification time can reorder it, so this remains a live view rather than a snapshot. `/api/state` and comparison selectors retain their most recent 50-report contract.

The UI retains loaded pages through navigation and language changes, ignores late responses for previous queries, and preserves rows/cursors on a failed append. A first page updates when recent records change; multiple loaded pages stay visible with refresh guidance. Updates arriving during a pending first-page request trigger a follow-up refresh. Search and paging preserve the open report and scenario draft.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-06: 118 tests, type checking, UI syntax/design-system audit, existing demo and UI checks passed. A dedicated Chromium smoke created 72 synthetic reports to check older-record search, combined filters, page boundaries, retry, duplicate prevention, polling/query races, old-report download/preparation, English/Korean, and 390px layout. A fresh tarball installation verified full-history search and paging beyond 50 alongside the existing seven passing browser cases. No model calls, external logins, or native-device runs were used.

- Package: [`@ihyeon/flow-qa@0.6.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.6.0)
- Release: [GitHub 0.6.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.6.0)

## 0.5.0: prepare failed cases from a report

Adds **Prepare failed/error cases** to detailed reports. It loads the unchanged saved suite, selects only recorded `failed` and `error` cases in suite order, and opens Scenario with a fresh review requirement. Passed, flaky, blocked, and skipped cases are excluded. Preparation is read-only and never starts a run or calls a model. Unsaved drafts require confirmation; failed preparation and late responses after navigation preserve the draft.

Preparation requires one matching saved suite, the exact parsed suite snapshot hash, a valid linked source, and coherent full/partial report IDs. Missing, changed, or ambiguous inputs stop preparation with guidance. A changed or missing target is cleared for explicit selection; even a matching target requires renewed review. Existing execution-time checks remain in force. The next run writes its own ordinary selected-scope report; the original report remains unchanged, and no persistent parent-run link is added.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-03: 117 tests, type checking, UI syntax and design-system audit, and demo/UI checks passed. The dedicated Chromium smoke covered all six case statuses, unsaved-draft acceptance/cancellation, changed suite and target, navigation during a delayed response, English/Korean, and a 390px layout. It executed two prepared cases successfully with zero requests from the excluded sentinel. A fresh tarball installation prepared a synthetic failed report and ran that selection in a real browser, alongside full-run/comparison checks (seven passing browser cases). The existing import smoke now waits for save completion before asserting download readiness. No model calls, external logins, or native-device runs were used.

- Package: [`@ihyeon/flow-qa@0.5.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.5.0)
- Release: [GitHub 0.5.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.5.0)

## 0.4.0: run selected cases

Adds case selection to the execution panel and repeated `--case <id>` flags to CLI runs. Selecting or clearing cases resets UI review, and execution still requires the reviewed file and target fingerprints. Unknown, duplicate, and empty selections are rejected. Selection is preserved across navigation, language changes, and polling, while a new draft starts with all cases selected.

Each run retains the full original suite snapshot/hash and verifies its source, while compiling and assessing only the chosen cases. Partial reports add explicit `selection` metadata to `flow-qa/report-1`; unselected cases are neither executed nor reported as passed/skipped. Selected blocked/error/interrupted cases retain their normal meaning. History, report downloads, and comparisons display the partial scope; comparisons warn when selected case sets differ. Existing full runs and their report shape are preserved.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-03: 115 tests, type checking, UI syntax and design-system audit, and existing demo/UI checks passed. The dedicated Chromium smoke ran two selected cases successfully, confirmed zero requests from an excluded sentinel case, and kept a selected unresolved-question case blocked without attempts. It covered review invalidation, bulk selection, navigation/language preservation, 390px layout, original snapshot/hash preservation, and report/comparison scope. A fresh tarball install executed two full runs plus a one-case partial run (seven passing browser cases) and compared their reports. No model calls or native-device execution were used.

- Package: [`@ihyeon/flow-qa@0.4.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.4.0)
- Release: [GitHub 0.4.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.4.0)

## 0.3.0: compare recorded runs

Adds a two-run comparison workspace to Run history. Select a baseline and current report, swap their direction, filter by case transition, open either detailed report, and export the complete comparison as Markdown or JSON. Cases are matched by ID, with distinct categories for passed-to-failed, failed-to-passed, other changes, equal statuses, added, and missing. Flaky, blocked, skipped, and execution-error results retain their meaning.

The read-only comparison endpoint requires the same suite ID and recorded target settings, rejects ambiguous case IDs, and uses the existing safe report loader. Suite changes, reversed dates, and interrupted/error runs are explicitly flagged. Mobile comparisons also warn that recorded device selectors do not establish physical device identity. Comparisons describe saved outcomes, not proof of a regression or fixed defect. Shared Markdown hides URLs and links under the existing report policy; JSON retains recorded metadata. Selections remain across navigation, language changes, and history updates; selection changes or disappeared runs invalidate old exports, and late responses cannot replace a newer comparison. The existing report format is unchanged.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-02: 101 tests, type checking, UI syntax and design-system audit, existing browser/demo checks, and comparison UI checks using synthetic report fixtures. All 36 terminal-status combinations, compatibility gates, URL/link hiding, English/Korean exports, filtering, polling, navigation, 390px layout, late responses, and stale downloads were covered. A fresh tarball installation ran two real Chromium demo runs (six passing cases) and compared their saved reports. No model calls or native-device execution were used.

- Package: [`@ihyeon/flow-qa@0.3.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.3.0)
- Release: [GitHub 0.3.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.3.0)

## 0.2.9: search run history

Adds Search runs to run history, matching suite IDs, run IDs, and target names with case-insensitive partial search. Surrounding whitespace is ignored, and the search combines with the existing status filter. Clearing the query preserves the selected status. The current query stays through navigation, language changes, and automatic history updates; open reports and downloads remain available. Search covers only the most recent 50 reports already loaded by the UI.

Locally verified on macOS with Node.js 24.22.1 on 2026-11-02: 92 tests, type checking, UI syntax and design-system audit, and real Chromium search checks using report fixtures alongside a real passing run. All three fields, Korean target names, case and whitespace handling, combined status filtering, empty results, clearing, navigation, language changes, new reports, filtered report opening and download, and a 390px viewport passed. Existing UI and demo checks, package validation, and a fresh tarball installation with three passing browser cases also passed. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.9`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.9)
- Release: [GitHub 0.2.9](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.9)

## 0.2.8: expand and collapse all case details

Adds Expand all cases and Collapse all cases to Scenario case review. The controls appear when cases are available and change only the case details. Individual toggles, the first-case-open default on loading, and expansion state across language changes and navigation remain available. Bulk actions preserve the draft, JSON editor disclosure, review confirmation, and execution readiness.

Locally verified on macOS with Node.js 24.22.1 on 2026-10-28: 92 tests, type checking, UI syntax and design-system audit, and real Chromium checks for empty and loaded reviews, bulk and individual toggles, mixed expansion state across language changes, keyboard activation, navigation, unchanged draft/review state, and a 390px viewport. Existing UI and demo checks, package validation, and a fresh tarball installation with three passing browser cases also passed. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.8`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.8)
- Release: [GitHub 0.2.8](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.8)

## 0.2.7: filter run history by status

Adds a Run status selector to run history for passed, failed, blocked, error, and interrupted reports. All statuses restores the loaded list, and a separate message explains when the selected status has no matches. The selected status stays through navigation, language changes, and automatic report updates. This filters the UI's existing most recent 50 reports and preserves the open report, downloads, and scenario review state.

Locally verified on macOS with Node.js 24.22.1 on 2026-10-26: 92 tests, type checking, UI syntax and design-system audit, and real Chromium filter checks for all five statuses using report fixtures alongside a real passing run. Empty results, restoring all reports, English/Korean selection, navigation, newly saved reports, filtered report opening and download, and a 390px viewport passed. Existing UI and demo checks, package validation, and a fresh tarball installation with three passing browser cases also passed. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.7`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.7)
- Release: [GitHub 0.2.7](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.7)

## 0.2.6: search the case library

Adds a search field to the case library. Filter saved suites by title, suite ID, or file name with case-insensitive partial matching; surrounding whitespace is ignored. Clearing the query restores the full list. English and Korean labels and no-match guidance are included. The current query stays through navigation, language changes, and automatic library updates. Existing case loading, unsaved-draft confirmation, review, and execution behavior stays in place.

Locally verified on macOS with Node.js 24.22.1 on 2026-10-26: 92 tests, type checking, UI syntax and design-system audit, real Chromium search checks for all three fields, Korean text, no matches, clearing, navigation, language changes, newly saved files, filtered loading, and a 390px viewport. Existing UI and demo checks, package validation, and a fresh tarball install with three passing browser cases also passed. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.6`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.6)
- Release: [GitHub 0.2.6](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.6)

## 0.2.5: update the Node.js security baseline

Raises the Node.js requirement to `^24.22.1 || >=26.12.1` for the [October 21, 2026 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), including fixes in TLS, DNS, HTTP, and Brotli. Vulnerable Node 24/26 versions and the unsupported Node 25 line no longer satisfy the package engine requirement. Local development and all release jobs use Node 24.22.1 from `.nvmrc`.

Upgrade Node itself and restart Flow QA; installing this package does not replace an existing Node process. With nvm, run `nvm install 24.22.1` and `nvm use 24.22.1` before installing Flow QA. The locked Undici dependency is also updated from 7.30.0 to 7.30.1 for its [security fixes](https://github.com/nodejs/undici/releases/tag/v7.30.1). Application behavior and direct dependency versions remain unchanged.

The separate MCP server SDK findings in `npm audit` remain in the pinned e2e dependency. Flow QA invokes `e2e run`, not the MCP server command; upgrading that runner requires separate compatibility validation and is outside this Node security patch.

Locally verified on macOS with Node.js 24.22.1 on 2026-10-22: 92 tests, type checking, UI syntax and design-system audit, real Chromium UI and demo checks, package validation, and a fresh tarball install with three passing browser cases. The engine range rejects older Node 24/26 versions and Node 25, and all release jobs read the same runtime pin. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.5`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.5)
- Release: [GitHub 0.2.5](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.5)

## 0.2.4: confirm before replacing unsaved cases

Loading a library suite, importing valid case files, or starting a new JSON draft now asks before discarding unsaved content. Cancel preserves the current draft and selected import files. New JSON drafts keep the scenario text; unchanged saved cases, flow-only JSON resets, and ordinary screen navigation stay quiet. Failed imports still report validation errors without replacing the draft. Existing save, review, generation, and execution behavior remains unchanged.

Locally verified on macOS with Node.js 24.14.1 on 2026-10-21: 92 tests, type checking, UI syntax and design-system audit, real Chromium confirmation acceptance/cancellation in English and Korean, preserved inputs and import selections, unchanged navigation and validation errors, and a fresh package install with three passing browser cases. Existing file download, re-import, and browser leave-page checks passed without model calls.

- Package: [`@ihyeon/flow-qa@0.2.4`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.4)
- Release: [GitHub 0.2.4](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.4)

## 0.2.3: download saved case files

Adds separate case JSON and source Markdown download buttons to case review. Saved cases can be reused without finding workspace files manually; source-less cases offer JSON only. Unsaved or outdated drafts are excluded. The source text and hash remain compatible with file import, while existing save, review, and execution gates stay in place.

Locally verified on macOS with Node.js 24.14.1 on 2026-10-20: 92 tests, type checking, UI syntax and design-system audit, real Chromium downloads and re-import with unchanged source hashes, JSON-only downloads for source-less cases, disabled controls for unsaved edits, and a fresh package install with three passing browser cases. Existing demo pass/failure/blocked classifications and English/Korean UI checks passed without model calls.

- Package: [`@ihyeon/flow-qa@0.2.3`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.3)
- Release: [GitHub 0.2.3](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.3)

## 0.2.2: warn before leaving an unsaved draft

Requests the browser's confirmation before a refresh or tab close would discard an unsaved scenario or TC draft. Imported and manually edited cases are covered, including scenario edits to a saved case without a linked source. Unchanged saved cases stay quiet, and successful saving clears the warning. The browser controls the prompt; this does not add automatic saving or change review and execution gates.

Locally verified on macOS with Node.js 24.14.1 on 2026-10-20: 92 tests, type checking, UI syntax and design-system audit, a real Chromium reload prompt that preserves input when dismissed, clean/saved/imported/edited draft checks, existing browser and UI smoke tests, and a fresh tarball install with three passing browser cases. No model calls were used.

- Package: [`@ihyeon/flow-qa@0.2.2`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.2)
- Release: [GitHub 0.2.2](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.2)

## 0.2.1: import case files from the UI

Adds a file picker for a TC JSON file and its optional source Markdown. Import checks the suite and source hash before replacing the current draft, preserves unresolved review questions, and creates a separate copy when saved. Source text retains its line endings and trailing whitespace. This does not import error-to-test provenance metadata; original bundles remain separate. See [case file import](ui.md#import-existing-case-files).

Locally verified on macOS with Node.js 24.14.1 on 2026-10-15: 92 tests, type checking, UI syntax and design-system audit, real Chromium import/save/retry checks in English and Korean, existing demo pass/failure/blocked classifications, and a fresh tarball install with three passing browser cases. No model calls or native-device runs were used for this patch.

- Package: [`@ihyeon/flow-qa@0.2.1`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.1)
- Release: [GitHub 0.2.1](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.1)

## 0.2.0: configurable mobile targets

Adds native iOS/Android target settings, mobile case authoring before device setup, platform-aware compilation and execution, and app/device identity in review and reports. Users register an installed app and a prepared device when ready; no product-specific app is bundled. Existing web settings and suites remain readable. Node.js 24.8 or later is required by the mobile runtime. Actual native-device success requires a user-selected app and device. See [mobile setup and verification limits](mobile.md).

Locally verified on macOS with Node.js 24.14.1 on 2026-10-12: 89 tests, type checking, UI syntax and design-system audit, package build and fresh tarball installation. Chromium smoke preserved web pass/failure/unavailable classifications and English/Korean UI behavior. The installed package can create a mobile prompt, validate and compile mobile cases before target setup, and save iOS/Android settings. Native generated code was type-checked against the installed SDK; device selection and blocking were tested with inventory fixtures. These checks did not execute a native app or call a model.

- Package: [`@ihyeon/flow-qa@0.2.0`](https://www.npmjs.com/package/@ihyeon/flow-qa/v/0.2.0)
- Release: [GitHub 0.2.0](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.2.0)

## Automated npm and GitHub releases

A push to `main` publishes only when `package.json` changes to a new plain `X.Y.Z` version. Pull requests and pushes without a version change run verification without publishing. The package and lockfile versions must agree; the version must increase, and registry errors stop the release. Rerunning a successful publication skips the existing immutable npm version.

The `publish` job in [ci.yml](../.github/workflows/ci.yml) waits for the full verification matrix on Ubuntu and macOS, then publishes through npm trusted publishing (OIDC). It uses the `latest` tag, requires the registry's `gitHead` to match the workflow commit, and checks the published package with a fresh consumer installation, two full Chromium demo runs plus a one-case selected run prepared from a synthetic failed report (seven cases), and comparison of their saved reports. The commit check also applies when retrying an already published version. No npm token is stored in GitHub secrets. After the published package passes its consumer smoke check, a separate job creates the matching GitHub tag and release at the exact verified commit. It preserves existing releases and rejects a tag pointing to another commit. Rerunning an older release does not replace a newer latest release.

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
