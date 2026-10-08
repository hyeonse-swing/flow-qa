# Flow QA local UI

Use the target app's URL and a user flow to review cases, run them, and inspect results. The local example is a to-do app; the UI does not bundle an organization's product list, internal URLs, accounts, model catalog, work cases, or run history.

## Start

Node.js 24 or later is required. Install the alpha and start the local demo:

```sh
npm install -g @ihyeon/flow-qa@0.1.0-alpha.1
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

1. **Connections:** Register a target name and URL. Planner and browser agent models have separate settings.
2. **Scenario:** Describe the initial state, actions, screen elements, and expected results. If a planner is ready, ask it to create cases. Without a model, download the planning prompt and paste a JSON response from an AI you already use.
3. **Review and save cases:** Expand each case to read preconditions, actions, expected results, and unresolved questions. Editing the JSON keeps the linked flow; if that source flow changes, design the cases again. Planning and running are separate actions. Editing inputs or connection settings alone does not call a model.
4. **Run QA:** Review the saved case file, select a target, and check the review confirmation before running. If the file changes after review, reload and review it again. Fixed steps need no agent model. `act` and `assertAgent` require a compatible agent; missing models and unresolved questions are reported as blocked cases.
5. **Case library and Run history:** Save cases as new files and load them again. Open run details to see each case, attempt, and evidence; download the Markdown or JSON report.

The top bar shows planning, running, and stopping states, plus a cancel button. A late planning response cannot change the draft after cancellation. The UI does not estimate progress inside an individual browser action. If the server disconnects, reconnect; runs started in another tab also appear. Refreshing settings rereads targets and models, so save edits first.

For each attempt, the report can open or download an approved screenshot or text evidence item. It serves only evidence linked to the report and marked as redacted or not needing redaction. It does not serve arbitrary files, raw run logs, HTML, or SVG. Markdown and JSON downloads summarize results but do not include evidence files. Keep the original run directory structure if you need relative evidence links in an offline Markdown report.

**Connections** shows whether Chromium is installed. A model key marked ready means only that the named environment variable exists; it does not prove authentication or model compatibility. Case review shows runnable and pre-blocked counts. Login and target reachability are established only by an actual run.

To enter fresh JSON after changing a scenario, open the JSON editor in case review and choose **New JSON draft**. Existing saved files remain; validate and save the new JSON before reviewing it for a run.

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
