# Flow QA local UI

Describe a user flow, review cases, and configure a target when ready to run. Web targets use a URL; native targets use an iOS/Android app ID and an explicit device. Mobile targets require version `0.2.0` or later. The local example is a to-do web app; the UI does not bundle an organization's product list, internal URLs, accounts, model catalog, work cases, or run history.

## Start

Node.js 24.x (24.22.1 or later) or 26.12.1 or later is required. Node 25 is unsupported. Upgrade the Node runtime and restart any running UI process; updating Flow QA alone does not patch Node. Install Flow QA and start the web demo:

```sh
npm install -g @ihyeon/flow-qa@0.4.0
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

From version `0.2.7`, **Run history → Run status** filters the loaded reports by passed, failed, blocked, error, or interrupted. Choose **All statuses** to restore the list. The selection stays while navigating, changing language, or receiving updated reports, and resets on page reload. The filter applies to the most recent 50 reports loaded by the UI; it does not search older history or individual case results. Filtering keeps the report already open and its downloads available.

### Search run history

From version `0.2.9`, **Run history → Search runs** matches part of a suite ID, run ID, or target name. Matching ignores letter case and surrounding whitespace, and supports Korean target names. Search combines with **Run status**; clear the search to return to the selected status. The query stays through navigation, language changes, and automatic report updates, and resets on page reload. Search covers the most recent 50 reports loaded by the UI, not older records, target URLs, or individual case content. Changing the query keeps the open report and its downloads available.

### Compare two runs

From version `0.3.0`, open **Run history → Compare two runs**, choose a **Baseline run** and **Current run**, then compare. Both selectors use the most recent 50 loaded reports, independently of the history search and status filter. The reports must belong to the same suite ID and recorded target settings: a matching web URL, or mobile platform, app ID, and device. Target display names may differ. Mobile reports record the configured device selector, which can be a name; all mobile comparisons warn that matching selectors do not establish that the same physical device was used. Comparing does not run tests, call a model, or change case review.

Cases are matched by ID. **Newly failed** means only `passed → failed`; **Now passed** means only `failed → passed`. Other status transitions, including flaky, blocked, skipped, and execution errors, appear under **Changed status**. Equal statuses are **Same status**. **Added to current** and **Missing from current** mean present in only one selected report; missing does not mean passed or deleted from the suite. Filter the visible rows by category, open either detailed report for its evidence, or download the complete comparison as Markdown or JSON. Downloads include every category, regardless of the display filter, and do not include evidence files. Markdown follows the existing report URL/link hiding policy; JSON retains the recorded target settings and case text.

When suite hashes differ, the UI and exports warn that steps or expectations may have changed. These are recorded outcomes, not proof of equivalent tests, a product regression, or a fixed defect. Additional warnings identify reversed chronological order and interrupted/error runs. The comparison never treats a flaky pass as a clean pass. The existing report format remains unchanged; comparison JSON uses `flow-qa/comparison-1`.

Swap reverses the baseline and current selections. Changing either selection clears the old result and downloads until a new comparison succeeds. Navigation, language changes, and history updates preserve valid selections and results; a selected run disappearing from the loaded list invalidates the comparison. Choices reset on page reload. Markdown product labels follow the selected language, while user-written case content and status codes are preserved.

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
