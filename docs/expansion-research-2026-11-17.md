# External agent QA handoff research — 2026-11-17

## Current behavior and gap

- `plan --prompt-only` creates a prompt to design a case suite; it does not help another agent execute or analyze an already reviewed suite (`src/cli.ts`, `src/planner.ts`).
- `run` invokes the installed `e2e` runner and produces `flow-qa/report-1` from its raw report (`src/engine.ts`, `src/report.ts`). That is a useful repeatable path, but an external coding agent cannot use its own browser tools from a portable execution handoff.
- The suite schema already enforces requirement links, explicit assertions for runnable cases, bounded steps, and open questions. Source hashes, target configuration validation, and selected case IDs exist (`src/schema.ts`, `src/workspace.ts`, `src/case-selection.ts`). Reuse these rules instead of inventing a second case format.
- `gh issue list --state open --limit 30` returned no open issues on 2026-11-17. This scope follows the user's explicit request, not an issue claim.

## Decision

Add a CLI handoff for a reviewed web suite and registered target, with a separate review command for a returned agent result. The handoff saves an exclusive private directory containing a versioned request, a Markdown prompt, and an initially unverified result template. It does not call a model, browser, Playwright, or `e2e`; an external agent uses its own environment. The request includes only selected cases and referenced requirements, validated target identity, and hashes, without model connections or configuration secrets. The review command checks the returned structure, the request's IDs and hashes, and the presence of observations before producing a clearly labeled agent-supplied analysis summary. It never writes a native `qa-report.json` or calls a self-reported result an engine-verified pass.

Mobile cases and `agent-review` evidence-file import are deferred: device state, attachment provenance, and raw report compatibility need separate contracts. An external agent can still describe an observation in the result; that statement is self-reported until independently inspected. User-authored case text and target descriptions remain untrusted input. Private files reduce accidental exposure but do not sanitize arbitrary personally identifying text in a user-authored suite; users review the bundle before sharing.

## Acceptance

1. A valid suite and target create a bounded, no-overwrite, owner-private handoff; stale sources, invalid selections, and mismatched platforms fail. The target fingerprint binds the returned result to the exported target identity. A later change to registered target settings is outside this offline review and needs a new handoff.
2. The output marks every selected case `unverified` initially, keeps open questions visible, and contains no planner or agent connection/API key values.
3. A standalone coding agent can follow the prompt and return a versioned result. Review rejects unknown/missing cases, changed hashes, contradictory status/observation pairs, and empty evidence for claimed observations; its output states that findings are agent-supplied.
4. Handoff and review load without the bundled `e2e` or Playwright runtime; the installed CLI path demonstrates this with import blocking.
5. Existing run, report, package and type checks remain valid.

## Evidence checked

- `README.md`, `docs/architecture.md`, `src/{cli,schema,workspace,case-selection,engine,report}.ts`, `tests/cli.test.ts` at `413c07c615bc2f3b02ead438e647147be28088a6`.
- GitHub open issues query above, on 2026-11-17.
