# Flow QA CLI workflow

Install `@ihyeon/flow-qa` in the project with `npm install --save-dev @ihyeon/flow-qa` if needed. Run the local CLI with `npx --no-install flow-qa`; prefix each example below with `npx --no-install` when using a project-local install. Run `npx --no-install flow-qa --help` to inspect the installed version. Paths to flows and cases below are relative to `--workspace`; `flow-qa init my-qa` creates a local example and configuration without replacing existing files.

## Design and review

Describe the starting state, actions, observable expected result, and required test data in `flows/my-flow.md`. For an AI already in use, generate a planning prompt without configuring a model:

```sh
flow-qa plan flows/my-flow.md --prompt-only --workspace my-qa
```

Give the generated `planning/my-flow.prompt.md` to that AI, save its JSON reply as `cases/my-flow.json`, review every requirement, locator, assertion, precondition and open question, then run:

```sh
flow-qa validate cases/my-flow.json --workspace my-qa
```

Validation confirms the schema, not that product expectations are correct. Cases with `questions` are blocked. `preconditions` describe setup but do not create accounts, inventory, login state, or other data. A changed source flow invalidates a suite with recorded source provenance; redesign cases rather than bypassing the check. Planning can also use a configured planner model, which sends the flow to the configured endpoint.

## Choose and execute a target

For web, register a test URL and review that it points to an allowed test environment:

```sh
flow-qa connect preview --url https://preview.example.test --workspace my-qa
flow-qa doctor --workspace my-qa
flow-qa run cases/my-flow.json --target preview --workspace my-qa
```

Web execution needs the package's Chromium (`flow-qa browser install`). The run can click and type in the connected app; prepare test data first. Fixed steps run without a model. `act` and `assertAgent` need a separately configured tool and image capable agent model. `flow-qa generate cases/my-flow.json --workspace my-qa` writes test code without executing it.

To run only named cases, repeat `--case TC-001 --case TC-003` on `run`. Omitted cases were not evaluated. Each case must establish its own starting state; selecting a case does not run earlier cases as prerequisites. The run writes `qa-report.json` and `qa-report.md` under a new `.flowqa/runs/<run-id>/`. Use `flow-qa report <run-directory> --workspace my-qa` to read a saved report. Compare only with attention to suite, target, selection, and external data state.

## External browser agent path (web only)

For a reviewed web suite and an external agent with its own browser tools:

```sh
flow-qa agent-handoff cases/my-flow.json --target preview --workspace my-qa
# Optionally repeat --case TC-001, or set --out to a new directory.
```

The command prints a private handoff directory; no test runs. Inspect `request.json`, the selected case text, target URL, and the generated `AGENT_PROMPT.md` before sharing. The bundle contains a result template and JSON Schema. Have the agent record actual observations and evidence under `evidence/`, leaving unvisited cases `unverified` and cases with unresolved expectations `blocked`. Then run:

```sh
flow-qa agent-review <handoff-directory> <handoff-directory>/agent-result.json
```

This review checks request binding, case scope and order, observation structure, and evidence file references. It does not verify visits or evidence authenticity and does not create an engine QA report. Handoff omits model connection settings but does not mask case content; check material before sharing. See `AGENT_PROMPT.md` and `agent-result.schema.json` inside each generated bundle for that bundle's exact contract.
