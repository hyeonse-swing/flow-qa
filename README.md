# Flow QA

[![npm version](https://img.shields.io/npm/v/%40ihyeon%2Fflow-qa?label=npm)](https://www.npmjs.com/package/@ihyeon/flow-qa) · [npm package: @ihyeon/flow-qa](https://www.npmjs.com/package/@ihyeon/flow-qa)

**English** · [한국어](https://github.com/hyeonse-swing/flow-qa/blob/main/README.ko.md)

Flow QA turns a user flow into reviewable test cases, runs them in a real browser, and ties the results to evidence in a QA report. When an expected outcome is unclear, it keeps the question visible and blocks that case instead of guessing.

Flow QA is available as a CLI and a web UI bound to `127.0.0.1`. Provide a target URL and describe the screen behavior; access to the application's source code or database is optional. The UI starts in English. Use the language switch in the top bar for Korean; the choice is saved in this browser. See the [architecture](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/architecture.md) and [UI guide](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/ui.md) for the details.

![Flow QA local demo](https://raw.githubusercontent.com/hyeonse-swing/flow-qa/main/docs/media/flow-qa-demo.png)


## Try the local demo

Node.js 24.8 or later is required. Install Chromium before the first web run:

```sh
npm install -g @ihyeon/flow-qa@0.2.2
flow-qa browser install
flow-qa ui --demo
```

Open the printed local UI address, then follow **Case library → Load → Review → Run QA**. The command starts a separate local demo app and workspace; no API key is needed. Results are saved under `.flowqa/ui-demo-en/` in the current directory. If Chromium lacks system libraries, use `flow-qa browser install --with-deps`. See the [UI guide](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/ui.md).

To work from source or reproduce the checks:

```sh
npm ci
npx playwright install chromium
npm run ui:demo
npm run check
npm run demo:smoke
```

`demo:smoke` uses real Chromium to check a passing run, an intentionally wrong assertion, and an unreachable app. It does not establish model quality or authenticated behavior in another service. Package checks and release evidence are recorded in the [release notes](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/releases.md).

## Connect your own app

Start with a test workspace and test data: a run can click and enter text in the connected app.

```sh
flow-qa init my-qa
flow-qa connect preview --url https://preview.example.test --workspace my-qa
flow-qa ui --workspace my-qa
```

The CLI also supports `flow-qa validate cases/my-flow.json --workspace my-qa`, `flow-qa generate cases/my-flow.json --workspace my-qa`, then `flow-qa run cases/my-flow.json --target preview --workspace my-qa`. Run `flow-qa --help` for all commands. Target and model URLs require HTTPS; HTTP is allowed only on loopback.

CLI product messages default to English; `--lang en|ko` overrides the optional `FLOW_QA_LANG` environment variable. Saved report files keep English product wording and unchanged status codes; the UI can download report Markdown with labels in the selected UI language.

Describe the initial state, actions, screen elements, and expected result in `flows/my-flow.md`. To prepare a prompt for an AI you already use, run `flow-qa plan flows/my-flow.md --prompt-only --workspace my-qa`, save its JSON response as `cases/my-flow.json`, then review and validate it. To connect an OpenAI-compatible planner directly:

```sh
flow-qa model planner --url http://localhost:11434/v1 --model your-model-id --workspace my-qa
flow-qa plan flows/my-flow.md --workspace my-qa
```

For authenticated models, add `--key-env FLOW_QA_API_KEY` to the model command and provide that environment variable to the process. The config stores the variable's name, not its value. The flow is sent to the planner endpoint you chose. Natural-language browser action (`act`) and model judgment (`assertAgent`) require a **separately configured** `agent` model that supports tools and images. Fixed clicks, inputs, and assertions run without a model.

`flow-qa doctor --workspace my-qa` checks local dependencies and whether configured model-key environment variables are present. It does not print key values or call the model server; a present key does not confirm remote authentication.

## Mobile targets

Version `0.2.0` adds user-configured iOS and Android targets. Choose **Mobile** in the scenario screen to prepare cases before choosing an app. Later, register the platform, installed app's bundle/package ID, and device in **Connections**, then select that target for execution. Saving settings does not install an app or start a test.

The CLI equivalents are `plan flow.md --platform mobile --prompt-only` and `connect my-ios --platform ios --bundle-id com.example.app --device "QA iPhone"`; replace the example app and device with your own. Existing web targets and suites remain supported. See the [mobile guide](docs/mobile.md) for setup, native steps, and verification limits.

## Design choices and result interpretation

- Every case references requirement IDs and a runnable case needs an explicit assertion. The schema accepts a fixed vocabulary including `open`, `click`, `fill`, `act`, `assertVisible`, `assertText`, `assertUrl`, and `assertAgent`. It never executes arbitrary JavaScript or shell commands returned by a model.
- Unresolved assumptions go into `questions` and block that case. `preconditions` are descriptive; Flow QA does not prepare accounts, inventory, or login state automatically.
- Generated cases record a hash of their source flow. If the flow changes, validation, compilation, and execution stop until the cases are redesigned. Planning and execution are separate actions; editing inputs does not call a model.
- Each run gets a fresh `.flowqa/runs/<run-id>/` directory with engine output and `qa-report.json`/`qa-report.md`. Reports distinguish passed, failed, passed after retry, blocked, error, and skipped cases. A failed assertion is an observation, not proof of a product defect.
- Cancellation records an interrupted run. Canceling generation prevents a late response from changing the draft, but does not guarantee cancellation of a provider's processing or charges. The UI shows token use and estimated cost only when the engine supplies them; there is no overall cost cap.

Reports and raw evidence can contain data from the tested app. `.flowqa/` is Git-ignored, but inspect files before sharing them. Redaction cannot be assumed to catch every personal detail. Session setup, automatic mobile SDK/device/app provisioning, scheduled CI runs, team permissions, and a shared server are outside the current scope.

![QA report from three real passing cases](https://raw.githubusercontent.com/hyeonse-swing/flow-qa/main/docs/media/flow-qa-report.png)

## Implementation and credits

Flow QA owns the flow and case schema, planner integration, compilation, run orchestration, result interpretation, and local UI. [tester-army/e2e](https://github.com/tester-army/e2e) and related packages provide the browser test engine. The UI uses style tokens and preference utilities from [Hyeonse Design System](https://github.com/hyeonse-swing/hyeonse-design-system); this project's workflow screens are its own implementation. See the [third-party notices](https://github.com/hyeonse-swing/flow-qa/blob/main/THIRD_PARTY_NOTICES.md) and [architecture](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/architecture.md) for those boundaries.
