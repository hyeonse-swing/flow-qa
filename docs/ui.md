# Flow QA local UI

Describe a user flow, review cases, and configure a target when ready to run. Web targets use a URL; native targets use an iOS/Android app ID and an explicit device. Mobile targets require version `0.2.0` or later. The local example is a to-do web app; the UI does not bundle an organization's product list, internal URLs, accounts, model catalog, work cases, or run history.

## Start

Node.js 24.x (24.22.1 or later) or 26.12.1 or later is required. Node 25 is unsupported. Upgrade the Node runtime and restart any running UI process; updating Flow QA alone does not patch Node. Install Flow QA and start the web demo:

```sh
npm install -g @ihyeon/flow-qa@0.8.7
flow-qa browser install
flow-qa ui --demo
```

The default UI address is `http://127.0.0.1:4310`. The command prints the demo app address. Use `flow-qa ui --demo --port 4311` for another port. Ctrl+C stops the active run and the servers started by this command.

To open an existing workspace:

```sh
flow-qa ui
# or specify another Flow QA workspace
flow-qa ui --workspace ./my-qa --port 4311
```

Create a workspace first with `flow-qa init ./my-qa`. From source, use `npm ci`, `npx playwright install chromium`, and `npm run ui:demo`. The server binds only to `127.0.0.1`; it is not a hosted team service.

The UI starts in **English**, regardless of browser language. Switch to **한국어** from the top bar. The selection is saved under `flowqa-language` in this browser and applies on the next visit. It changes product copy and the labels in Markdown reports downloaded from the UI; it does not translate user-written flows, target descriptions, case titles, target apps, or model responses. Saved `qa-report.json` and `qa-report.md` use English product wording and unchanged status codes. CLI messages default to English; `--lang en|ko` takes precedence over `FLOW_QA_LANG`.

## Workflow

1. **Scenario:** Choose Web or Mobile and describe the initial state, actions, screen elements, and expected results. No target is required yet. If a planner is ready, ask it to create cases. Without a model, download the planning prompt and paste a JSON response from an AI you already use.
2. **Connections:** When ready, register a target name and web URL, or choose iOS/Android and enter an installed app's bundle/package ID and device. Planner and execution agent models have separate settings. Saving settings does not start an app or model request.
3. **Review and save cases:** Expand each case, or use **Expand all cases**, to read preconditions, actions, expected results, and unresolved questions. **Collapse all cases** returns to the case titles. Editing the JSON keeps the linked flow; if that source flow changes, design the cases again. Planning and running are separate actions. Editing inputs or connection settings alone does not call a model.
4. **Run QA:** Review the saved case file, select a matching web/mobile target, and check the review confirmation before running. If the file or target settings change after review, reload and review them again. Fixed steps need no agent model. `act` and `assertAgent` require a compatible agent; missing models and unresolved questions are reported as blocked cases.
5. **Case library and Run history:** Save cases as new files, search by title, suite ID, or file name, and load them again. Search run history by suite ID, run ID, or target name, combine it with a status filter, then open run details to see each case, attempt, and evidence; download the Markdown or JSON report.

The top bar shows planning, running, and stopping states, plus a cancel button. A late planning response cannot change the draft after cancellation. The UI does not estimate progress inside an individual browser action. If the server disconnects, reconnect; runs started in another tab also appear. Refreshing settings rereads targets and models, so save edits first.

For each attempt, the report can open or download an approved screenshot or text evidence item. It serves only evidence linked to the report and marked as redacted or not needing redaction. It does not serve arbitrary files, raw run logs, HTML, or SVG. Markdown and JSON downloads summarize results but do not include evidence files. Keep the original run directory structure if you need relative evidence links in an offline Markdown report.

**Connections** shows whether Chromium is installed for web targets. Mobile execution requires a prepared device and installed app; Chromium readiness does not determine mobile readiness. See [mobile setup](mobile.md). A model key marked ready means only that the named environment variable exists; it does not prove authentication or model compatibility. Case review shows runnable and pre-blocked counts. Login and target reachability are established only by an actual run.

To enter fresh JSON after changing a scenario, open the JSON editor in case review and choose **New JSON draft**. Existing saved files remain; validate and save the new JSON before reviewing it for a run.

From version `0.2.2`, the UI requests the browser's leave-page confirmation when refreshing or closing a tab with an unsaved scenario or case draft. Unchanged saved cases do not trigger it; saving clears the warning. Choose to stay on the page to keep editing. The browser controls the prompt wording and availability. This is not automatic saving.

From version `0.2.4`, loading a suite from the library or importing valid case files also asks before replacing unsaved scenario or case content. **New JSON draft** asks before clearing unsaved JSON and keeps the scenario text. Cancel keeps the current content and selected import files. Unchanged saved cases and ordinary navigation between screens do not prompt; invalid imports still show their validation error without replacing anything.

### Run selected cases

From version `0.4.0`, **Scenario → Review, then run → Cases to run** lists the validated suite's cases. Initially all are selected. Use individual checkboxes, **Select all**, or **Clear selection** to choose a nonempty set. A changed selection clears the review confirmation; choose the target, inspect the selected cases, and confirm review again before execution. Selection controls are disabled during a run or another busy operation. Navigation, language changes, and polling keep the selection. Loading/importing/validating a new draft resets it to all cases. It is not saved across page reloads.

The selected cases alone determine runnable/blocked counts and the run result. A selected case with unresolved questions or an unavailable required model stays blocked. Unselected cases do not execute and are not reported as passed or skipped. Flow QA does not infer prerequisites: each selected case must establish its own starting state. The source flow and full saved suite still pass existing validation and review-hash checks. Selection does not edit the saved file; the script preview and script/case downloads continue to include the full suite.

The run directory keeps the complete original `suite.json` and its hash. A partial `qa-report.json` retains `flow-qa/report-1` and adds `selection: { caseIds, totalCases }`; its `cases` list contains exactly the selected IDs in original suite order. A full run, including explicitly selecting every case, omits this field as before. History, detailed reports, and Markdown exports show selected/total counts and explain that omitted cases were not assessed. Comparison exports retain each run's scope, warn on partial runs and differing selections, and describe absent cases as missing results rather than recovered defects. Invalid selection metadata is not accepted as a valid report.

For the CLI, repeat `--case`: `flow-qa run cases/task-flow.json --target demo --case TC-001 --case TC-003`. Unknown, duplicate, or empty IDs are rejected before execution. The command keeps existing exit semantics: a partial pass is exit 0, a failure/block is exit 1, interrupted is 130, and invalid input is 2. If CI requires complete-suite coverage, omit `--case` and check that report selection metadata is absent.

### Expand or collapse case review

From version `0.2.8`, **Expand all cases** and **Collapse all cases** control the case details in Scenario. Individual case titles still toggle their own details. Language changes and navigation preserve which cases are open; loading a new suite keeps the original first-case-open default. These controls only change the view: they do not approve cases, modify the draft, or change the JSON editor disclosure. Review confirmation is still required before execution.

### Search saved cases

From version `0.2.6`, **Case library** filters saved suites as you type in **Search saved suites**. Search matches part of a title, suite ID, or file name, ignores letter case and surrounding whitespace, and supports Korean text. Clear the field to show all suites. The query stays while navigating, changing language, or receiving updated saved cases; it resets when the page reloads. Search covers the listed top-level case files, not individual steps or source Markdown.

### Filter run history

**Run history → Run status** filters reports by passed, failed, blocked, error, or interrupted. Choose **All statuses** to remove the status condition. From `0.6.0`, filtering searches all valid saved reports before pagination, including older records beyond the most recent 50. The selection stays while navigating, changing language, or receiving updated reports, and resets on page reload. Filtering keeps the report already open and its downloads available.

### Search run history

**Run history → Search runs** matches part of a suite ID, run ID, or target name. Matching ignores letter case and surrounding whitespace, and supports Korean target names. Search combines with **Run status**; clear the search to return to the selected status. From `0.6.0`, search covers all valid saved reports, including older records. Target URLs and individual case content are not searched. Queries are limited to 200 characters.

Results load 50 at a time, newest first by run-directory modification time, with run ID as a stable tie-breaker. **Load more** appends older matches. The displayed count describes loaded matches, not a global total. End-of-results, loading, and retry guidance distinguish an empty result from an unavailable request. A failed page request preserves loaded rows so you can retry.

Changing search or status restarts at the first page. The query, status, and loaded pages stay through navigation and language changes, and reset on page reload. The open report, its downloads, and scenario draft stay intact. A delayed response from an older query cannot replace newer results. Older reports support the same report downloads and failed/error-case preparation.

When recent run records change, a single loaded page refreshes automatically. If several pages are loaded, the UI keeps them and shows an update hint. **Refresh history** restarts at the first page with the current filters and also picks up external edits or deletions of older records. Pagination is a live view, not a frozen snapshot: newly added records appear when refreshed, and reports changed externally while paging may move. Invalid, incomplete, or unsafe report files are excluded. Use the row actions to select any listed report for comparison, including older results.

### Explore cases in a report

From `0.8.1`, each case heading also shows the number of attempts recorded in that report. Zero attempts is shown explicitly. This count does not infer a retry policy or change the recorded case status. From `0.8.2`, **Total attempt time** sums the recorded attempt durations in milliseconds. It is not the overall elapsed run time. The total is shown only when at least one attempt exists and every duration is a finite, nonnegative number; incomplete/invalid timing is omitted, while a recorded total of zero is shown.

From `0.8.3`, **Case order → Longest attempt time first** sorts visible cases by their total recorded attempt time. Equal totals keep their recorded order. Missing, incomplete, invalid, or overflowing totals appear after valid totals, including zero. **Recorded order** restores the original report order.

From `0.8.4`, **Case order → Most attempts first** brings cases with more recorded attempts to the top. Equal counts retain recorded order; cases with zero attempts follow attempted cases. This uses the saved attempt list only and does not infer a retry policy, change case status, or depend on duration availability.

From `0.8.5`, **Copy case ID** below a case heading copies only that case ID, including after filtering or sorting. Success or failure is shown beside that button. If the browser blocks clipboard access or the API is unavailable, select the ID in the heading and copy it manually. Copying does not start a run or change report data.

From `0.8.7`, check **At least 2 attempts** to show cases with two or more saved attempts, regardless of their final status or recorded timing. It combines with the search and status filters. The visible ID list uses the same filter.

From `0.8.6`, **Download visible case IDs** saves `<run-id>-case-ids.txt`: one ID per line, in the order shown after case search, status filtering, and sorting. The list is UTF-8 text with a final newline. The button is disabled when no cases match. If a legacy ID contains a line break, narrow the filter to exclude that ID or download the full JSON report.

From `0.8.0`, open **Run history → Detailed report** and use **Search cases** with **Case status** to narrow the displayed results. Search ignores case and surrounding whitespace, and matches case IDs, titles, reasons, expected results, attempt errors, secondary errors, step labels, and step errors. User-written Korean text is supported. Artifact paths and translated status labels are not search fields.

**Failed/error only** shows those two recorded statuses; the other status choices distinguish passed, failed, error, blocked, flaky, and skipped. Status-option counts describe the entire open report, while the displayed count shows matches out of that report's recorded cases. A partial run's omitted cases are not included in those counts; its selected/full-suite scope remains visible separately. Report-level warnings remain visible even when no case matches. **Reset filters** clears search and status, unchecks **At least 2 attempts**, and restores recorded order.

Filters and sorting stay while navigating, changing language, refreshing history/settings, or reopening the same report. Successfully opening another report resets them; a failed report load preserves the current report, filters, and sorting. Filters and sorting reset on page reload. Evidence links still refer to each case's original attempt and artifact.

These controls change only displayed cases. Markdown and JSON downloads contain every recorded case, and **Prepare failed/error cases** still prepares every recorded failed/error case from the report, even if hidden by the current filters. Filtering and sorting do not alter a saved report, the scenario draft, review confirmation, or execution selection.

### Prepare failed cases

From `0.5.0`, open **Run history → Detailed report → Prepare failed/error cases**. Only cases whose recorded status is `failed` or `error` are selected; `passed`, `flaky`, `blocked`, and `skipped` are excluded. The button is unavailable when no eligible cases exist or an operation is active. Preparation does not execute tests, call a model, or change files.

The UI finds exactly one saved case file with the report's suite ID, verifies its complete parsed content against the run's snapshot hash, and verifies its linked source Markdown. Missing, changed, ambiguous, or unreadable inputs stop preparation without replacing your draft. Open the current case file from the library and review it manually when the test definition has changed. An unsaved draft requires confirmation before replacement.

Successful preparation opens Scenario with the original source and failed/error selection. The prior target is selected only when its current name and settings still match the recorded target. Otherwise the target is cleared for explicit selection. Review confirmation is always cleared; inspect the selected cases and target before pressing **Run QA**. The normal execution-time file, source, and target checks still apply. Each selected case must establish its own starting state. Mobile target matching compares configured selectors, not physical device identity.

The preparation notice identifies the original run. The next execution creates a separate ordinary report with its selected scope; it does not overwrite the original report or store a persistent parent-run link. Selection stays through navigation, language changes, and polling, but resets on page reload.

### Compare two runs

From version `0.3.0`, open **Run history → Compare two runs**, choose a **Baseline run** and **Current run**, then compare. From `0.7.0`, each history row offers **Use as baseline** and **Use as current**. Search or load older pages to choose any saved run, then press **Compare**. The selectors include the most recent 50 reports, currently loaded history rows, and the two selected runs. Selected runs stay available when searches or filters hide their rows. The reports must belong to the same suite ID and recorded target settings: a matching web URL, or mobile platform, app ID, and device. Target display names may differ. Mobile reports record the configured device selector, which can be a name; all mobile comparisons warn that matching selectors do not establish that the same physical device was used. Comparing does not run tests, call a model, or change case review.

Cases are matched by ID. **Newly failed** means only `passed → failed`; **Now passed** means only `failed → passed`. Other status transitions, including flaky, blocked, skipped, and execution errors, appear under **Changed status**. Equal statuses are **Same status**. **Added to current** and **Missing from current** mean present in only one selected report; missing does not mean passed or deleted from the suite. Filter the visible rows by category, open either detailed report for its evidence, or download the complete comparison as Markdown or JSON. Downloads include every category, regardless of the display filter, and do not include evidence files. Markdown follows the existing report URL/link hiding policy; JSON retains the recorded target settings and case text.

When suite hashes differ, the UI and exports warn that steps or expectations may have changed. These are recorded outcomes, not proof of equivalent tests, a product regression, or a fixed defect. Additional warnings identify reversed chronological order and interrupted/error runs. The comparison never treats a flaky pass as a clean pass. The existing report format remains unchanged; comparison JSON uses `flow-qa/comparison-1`.

Swap reverses the baseline and current selections. Changing either selection clears the old result and downloads until a new comparison succeeds. Navigation, language changes, and history updates preserve valid selections and results; leaving the latest 50 or the visible history page does not clear a selected run. Background checks validate selected older records directly; a confirmed missing, invalid, or unsafe report clears that selection and invalidates the comparison. Temporary request failures preserve the pair for the next check. Choices reset on page reload. Markdown product labels follow the selected language, while user-written case content and status codes are preserved.

### Import existing case files

From version `0.2.1`, select a `flow-qa/suite-1` JSON file and, when it declares a source, its Markdown file in case review, then choose **Import case files**. The two file controls let you select files from different folders. For an error-to-test export, select `cases/error-to-test.json` and `flows/error-to-test.md`. A JSON file without a source can be imported alone or with a Markdown file.

Import validates the suite and checks the selected Markdown against its declared SHA-256 before replacing the draft. Cancelling or selecting invalid files preserves the current draft. The Markdown text, including line endings and trailing whitespace, is retained for saving. Markdown is limited to 128 KiB; the combined JSON request is limited to 256 KiB.

This creates an unsaved review copy. Choose **Save cases separately**, review the cases, and confirm review before running. Unresolved questions remain blocked. Saving assigns a new workspace source path and hash; it does not overwrite the input files or import `provenance.json`. If you need error-to-test `verify` / `link-run` provenance, keep the original bundle and use its original suite instead of this saved copy.

### Download saved cases

From version `0.2.3`, case review offers **Download case JSON** and **Download source Markdown** for the saved case currently shown. Save or reload the case first; unsaved or outdated drafts cannot be downloaded with these controls. A case without a linked source offers JSON only. Downloading needs no run target or execution review confirmation and does not change either.

The JSON keeps the case content and source reference. The Markdown retains its exact text, line endings, and trailing whitespace so its SHA-256 still matches. Select both downloaded files through **Import case files** to reuse them in another workspace, then save and review the new copy before running. These downloads contain the case and source, not run reports or an error-to-test provenance bundle.

## Display and language

The UI uses role tokens and preference utilities from `@hyeonse/design-system`, pinned to GitHub commit `38978c6a86f422fc0e63e919f600bc2dd3451e5c`. Flow QA implements its own workflow layout, buttons, and fields with those tokens.

The top-bar theme button and **Connections → Display settings** control theme, accent, density, corners, and motion. Preferences are saved under `flowqa-display-preferences` in the browser and shared across tabs. The device's reduced-motion setting takes priority. The saved preferences are applied before the token CSS appears on first load.

Local DM Sans and a Noto Sans KR subset are used for typography; missing Korean glyphs fall back to installed system fonts. See the [font and package notices](../THIRD_PARTY_NOTICES.md).

## Model connections

In the UI, configure an OpenAI-compatible Chat Completions base URL, model ID, and the **name** of an environment variable containing an API key. A local model can be used if it supports the same contract; confirm its API, tool, and image capabilities separately.

There is no field for the token value. Supply keys to the environment that starts the UI server. Flow QA does not read `.env` files automatically and does not save keys in browser storage. Changing a variable name does not create its value.

Without a model, you can still download prompts, review existing cases, and run fixed steps. If a generated response does not satisfy the suite schema, the UI identifies fields to fix (for example, `cases.0.steps` means the first case's steps). Clarify missing expectations in the scenario and regenerate, or edit JSON from a downloaded prompt. There is no automatic retry. Canceling a request stops this app from accepting its result; it does not guarantee that the provider stops processing or charging.

The report displays token use and estimated cost only when supplied by the execution engine. Case-planning cost is separate; there is no total cost aggregation or spending cap.

## Storage and limits

- A normal UI workspace uses `flowqa.config.json`, `flows/`, `cases/`, and `.flowqa/runs/` in the selected directory.
- Demo mode writes to `.flowqa/ui-demo-en/`, keeping earlier Korean demo data separate. On restart it reconnects the demo app to its new local URL and resets model settings; saved cases and run history remain. Switching the UI language does not translate either demo data or user-authored text.
- The UI library lists only top-level `cases/*.json` and their linked `flows/*.md`. Use the CLI to validate and run cases in nested directories.
- Saving creates a new case file. The UI does not overwrite or delete an existing one.
- Run history may contain data from the tested app. Inspect reports and evidence before downloading or sharing them.
- A failed assertion is an observed result, not proof of a product defect. Unverified cases are never shown as passed.
- This UI has no login-session capture, automatic regression recording, batch execution, CI scheduler, or team permissions. It uses the same run and report contract as the CLI.
