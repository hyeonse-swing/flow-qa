# External agent handoff

[한국어](#한국어) · [English](#english)

## 2026-11-18 follow-up finding · 후속 조사

The previous independent browser-agent trial produced both failed and passing observations from the same reviewed case. `agent-review` checked the result structure and evidence references, but its summary printed only the agent's observation. A reviewer had to open `request.json` and find the matching step to see what had been expected. The summary should pair each reported assertion with the reviewed expectation and locator, while keeping the agent's observation and evidence reference distinct. The result JSON and its validation rules remain the source record.

지난 독립 브라우저 에이전트 검증에서는 동일한 검토 케이스로 실패와 통과를 관찰했습니다. 기존 `agent-review` 요약에는 에이전트의 관찰 내용만 있어 검토자가 `request.json`에서 기대값과 locator를 따로 찾아야 했습니다. 각 assertion의 기대 조건·관찰·증거를 함께 표시하도록 개선하되 결과 JSON과 검증 규칙은 그대로 사용합니다.

## English

Use an existing, reviewed **web** case suite with a coding agent that has its own browser tools, including Playwright if available. This path creates a portable, readable folder. The agent does not need Flow QA or its `e2e` dependencies installed; the reviewer's Flow QA CLI prepares and checks the folder. The handoff itself does not call a model, open a browser, or run a test.

```sh
flow-qa validate cases/task-flow.json --workspace my-qa
flow-qa agent-handoff cases/task-flow.json --target preview --workspace my-qa
# Optional: add --case TC-001 repeatedly, or --out .flowqa/handoffs/my-review
```

The command prints a new directory under `my-qa/.flowqa/handoffs/`. It refuses to replace an existing directory. Give the agent that directory or its files. Its contents are:

| File | Purpose |
| --- | --- |
| `request.json` | `flow-qa/agent-handoff-1`, validated target URL, selected suite, source/target fingerprints, and explicit `execution: "not-run"` |
| `AGENT_PROMPT.md` | Tool-independent instructions for web steps, assertions, blocked cases, and evidence |
| `agent-result.template.json` | Every selected case starts as `unverified`; the agent copies this to a new result file |
| `agent-result.schema.json` | Standalone JSON Schema for `flow-qa/agent-result-1` |
| `evidence/` | Agent-created, redacted `.png`, `.jpg`, `.jpeg`, `.txt`, or `.json` evidence files |

An agent can use its own browser, record what each assertion showed, and put a screenshot or text note under `evidence/` for every observation. It returns `agent-result.json` with `requestSha256` unchanged and one case entry per selected case. For example, a case with assertion step index 3 could contain:

```json
{
  "id": "TC-001",
  "status": "observed-passed",
  "observations": [{
    "stepIndex": 3,
    "outcome": "matched",
    "detail": "The task list displayed First QA run after Add.",
    "evidence": "evidence/TC-001-step-3.txt"
  }]
}
```

Run the review on the reviewer's machine:

```sh
flow-qa agent-review my-qa/.flowqa/handoffs/<directory> my-qa/.flowqa/handoffs/<directory>/agent-result.json
```

The review requires the same request hash and case IDs in the same order. `observed-passed` requires matching observations for every assertion in step order; `observed-failed` requires a first mismatch after any earlier matching assertions and no later observations. A case with open questions cannot be marked observed. Evidence must be a real, nonempty regular file inside `evidence/`, with an approved extension and at most 10 MB; links and traversal are rejected. The result must be at most 1 MB. These checks make the response reviewable; they do **not** prove that the external agent visited the target or that the screenshot is authentic. The output is labeled **external agent observations** and is never added to Flow QA's engine-backed `qa-report.json` history.

The review summary shows each reported assertion's expected condition and locator from the reviewed case beside the agent's observed detail and evidence path. A failed case therefore identifies the first mismatched expectation without a manual lookup in `request.json`. The summary prints case content and observations, so inspect it before sharing.

Only the registered target identity is exported. Model connections and their key environment variables are omitted. A target URL with credentials, a query, a fragment, or a token-like path is refused rather than silently redacted. Case content is not masked because that would change the reviewed suite: inspect the URL, case text, and evidence before sharing the folder. The handoff accepts at most 1 MB of case/request JSON, supports web targets only, and does not prepare logins, accounts, or test data.

## 한국어

검토한 **웹** 케이스를 자체 브라우저 도구가 있는 코딩 에이전트에 전달할 때 사용합니다. 에이전트는 Flow QA나 `e2e` 패키지를 설치할 필요가 없습니다. 검토자 쪽 Flow QA CLI가 읽을 수 있는 폴더를 만들고, 돌아온 결과의 형식과 증거 파일 참조를 검사합니다. 전달 묶음 생성만으로 모델 호출·브라우저 실행·테스트 실행은 일어나지 않습니다.

```sh
flow-qa agent-handoff cases/task-flow.json --target preview --workspace my-qa
# 필요한 경우 --case TC-001을 반복하거나 --out .flowqa/handoffs/my-review 지정
```

출력 경로의 `request.json`은 대상 URL과 선택 케이스, 원본·대상 식별 해시, `not-run` 상태를 담습니다. `AGENT_PROMPT.md`를 에이전트에 주고, 에이전트가 `agent-result.template.json`을 복사해 관찰 결과를 채우도록 합니다. 결과 형식은 `agent-result.schema.json`에 있습니다. 각 assertion에 대해 실제 보인 내용과 `evidence/` 아래 스크린샷이나 텍스트 메모를 기록합니다. 확인하지 않은 케이스는 `unverified`, 전제나 기대 결과가 불명확하면 이유와 함께 `blocked`로 남깁니다.

```sh
flow-qa agent-review my-qa/.flowqa/handoffs/<폴더> my-qa/.flowqa/handoffs/<폴더>/agent-result.json
```

검토 명령은 요청 해시·케이스 범위·관찰 상태·증거 파일의 존재와 경로를 확인합니다. 에이전트가 실제로 페이지를 방문했는지, 증거가 진짜인지까지 증명하지 않습니다. 이 결과는 에이전트의 관찰 기록으로만 표시하며 기존 `qa-report.json` 실행 기록에 합치지 않습니다. 모델 설정과 키 환경 변수는 묶음에 넣지 않습니다. 쿼리·인증정보·토큰처럼 보이는 경로가 있는 대상 URL은 거부하고, 케이스 본문은 몰래 마스킹하지 않습니다. 외부 공유 전에 케이스·대상·증거의 민감한 내용을 직접 확인하세요.

검토 요약은 각 assertion의 검토된 기대 조건·locator와 에이전트의 관찰 내용·증거 파일 경로를 함께 보여줍니다. 실패한 케이스는 첫 불일치 기대값을 `request.json`에서 따로 찾지 않아도 확인할 수 있습니다. 요약에도 케이스 본문과 관찰 내용이 들어가므로 공유 전에 내용을 확인하세요.
