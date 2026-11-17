---
name: flow-qa
description: Use Flow QA to turn a user flow into reviewed cases, run a registered test target, or prepare and review a web suite for an external browser agent. Use when the user asks for Flow QA setup, case planning, execution, or result interpretation.
---

# Flow QA

Use the installed `flow-qa` CLI for the user's requested QA work. Read [the workflow reference](references/workflow.md) for actual command forms and the choice between a local run and an external agent handoff. This reference travels with this skill when copied out of the npm package.

Before execution, review the flow, proposed cases, target, and side effects with the user when their authorization does not already cover them. Keep unknown expected results in case `questions`; never convert an observation or assumed product behavior into a passing assertion. Verify the selected case IDs and target identity before a run or handoff.

Report what happened: authored or validated cases, an engine run with its saved report, or external agent observations checked by `agent-review`. A handoff is `not-run`; reviewing an agent result checks its shape and evidence references, not whether the agent actually visited the app. A selected run covers only selected cases. Keep model calls, browser runs, and external sharing within the user's authorization.
