# Using Flow QA with an AI assistant

Flow QA supplies a local CLI, a case schema, a planning prompt, deterministic test execution, and a separate external agent handoff. An AI assistant can help author or review the inputs, but its proposed product expectations need human review. The [portable Flow QA skill](../skills/flow-qa/SKILL.md) gives an assistant the CLI decision path; it and its reference are included in the npm package.

## Install the project skill

After installing `@ihyeon/flow-qa` in your project, copy the complete skill folder into an agent skill directory. For example:

```sh
mkdir -p .agents/skills
cp -R node_modules/@ihyeon/flow-qa/skills/flow-qa .agents/skills/flow-qa
```

The copied folder is self-contained. Invoke `flow-qa` from the installed package through `npx --no-install flow-qa` (or use a globally installed CLI). The skill never installs a global agent configuration and does not call a model by itself.

## Plan, review, and run

Write a flow with its initial state, actions, observable expected outcomes, and needed test data. Then:

```sh
flow-qa init my-qa
flow-qa plan flows/my-flow.md --prompt-only --workspace my-qa
# Give my-qa/planning/my-flow.prompt.md to an AI you choose; save the JSON as my-qa/cases/my-flow.json.
flow-qa validate cases/my-flow.json --workspace my-qa
flow-qa connect preview --url https://preview.example.test --workspace my-qa
flow-qa run cases/my-flow.json --target preview --workspace my-qa
```

Review the AI's requirements, locators, preconditions, and assertions before execution. Unknown desired behavior belongs in `questions` and blocks the case. Validation verifies case structure, not the truth of a product requirement. A registered target is a choice of app/device, not proof that it is ready or safe for a run. Runs can change data in the connected app. Use `--case TC-001` repeatedly for a selected run; its report does not cover omitted cases. `act` and `assertAgent` require a separately configured agent model; fixed steps do not.

For a coding agent with its own browser tools, use `flow-qa agent-handoff cases/my-flow.json --target preview --workspace my-qa` after review. Give the agent the resulting folder and `AGENT_PROMPT.md`; when it returns `agent-result.json` and evidence files, run `flow-qa agent-review <folder> <folder>/agent-result.json`. The bundle starts `not-run`. Review validates the returned structure and local evidence references; it does not prove the agent visited the app, and its observations stay separate from engine backed `qa-report.json`. Read the [handoff guide](agent-handoff.md) for the bundle contract.

The CLI accepts `--lang ko` for Korean product messages. It does not translate your flow, cases, or evidence. Inspect target URLs, case text, screenshots, and reports for sensitive data before sharing them.
