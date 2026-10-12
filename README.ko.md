# Flow QA

[![npm 버전](https://img.shields.io/npm/v/%40ihyeon%2Fflow-qa?label=npm)](https://www.npmjs.com/package/@ihyeon/flow-qa) · [npm 패키지: @ihyeon/flow-qa](https://www.npmjs.com/package/@ihyeon/flow-qa)

[English](https://github.com/hyeonse-swing/flow-qa/blob/main/README.md) · **한국어**

사용자 플로우를 검토 가능한 테스트 케이스로 바꾸고, 실제 브라우저 실행 결과를 증거가 연결된 QA 리포트로 남기는 로컬 도구입니다. 플로우의 기대 결과가 모호하면 추측해 통과시키지 않고 질문과 차단 상태로 남깁니다.

CLI와 `127.0.0.1` 전용 웹 UI를 제공합니다. UI는 영어로 시작하며 상단 언어 전환에서 한국어를 선택할 수 있습니다. 선택은 이 브라우저에 저장됩니다. 테스트 대상의 URL과 화면 계약을 사용하며 앱 소스 또는 데이터베이스 접근은 필수가 아닙니다. 설치 없이 구조를 보려면 [아키텍처](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/architecture.md)와 [UI 안내](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/ui.md)를 참고하세요.

![로컬 데모 화면](https://raw.githubusercontent.com/hyeonse-swing/flow-qa/main/docs/media/flow-qa-demo.png)


## 로컬 데모 시작

Node.js 24 이상이 필요합니다. 브라우저는 첫 실행 전에 설치합니다.

```sh
npm install -g @ihyeon/flow-qa@0.1.2
flow-qa browser install
flow-qa ui --demo
```

출력된 로컬 UI 주소에서 **케이스 보관함 → 예제 불러오기 → 검토 → 실행** 순서로 진행합니다. 데모 앱과 별도 작업 공간이 함께 시작되며 API 키가 필요하지 않습니다. 결과는 현재 디렉터리의 `.flowqa/ui-demo-en/`에 저장됩니다. 기존 한국어 데모 데이터는 별도로 유지되며, 언어 전환은 예제·사용자 문장을 자동 번역하지 않습니다. 문제가 있으면 `flow-qa browser install --with-deps`로 Chromium의 시스템 의존성을 설치할 수 있습니다. 자세한 화면 동작은 [UI 안내](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/ui.md)에 있습니다.

소스에서 개발하거나 검증을 재현하려면:

```sh
npm ci
npx playwright install chromium
npm run ui:demo
npm run check
npm run demo:smoke
```

`demo:smoke`는 정상 케이스, 의도적으로 실패하는 assertion, 앱 접속 불가를 실제 Chromium으로 확인합니다. 모델 호출 품질이나 외부 서비스 인증은 이 검사 범위에 포함되지 않습니다. 패키지 검증과 공개 절차는 [릴리스 기록](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/releases.md)에 따로 적습니다.

## 내 서비스 연결

테스트용 작업 공간에서 시작합니다. 연결한 앱에 실제 클릭과 입력이 발생하므로 테스트 환경과 데이터를 사용하세요.

```sh
flow-qa init my-qa
flow-qa connect preview --url https://preview.example.test --workspace my-qa
flow-qa ui --workspace my-qa
```

CLI만으로도 `flow-qa validate cases/my-flow.json --workspace my-qa`, `flow-qa generate cases/my-flow.json --workspace my-qa`, `flow-qa run cases/my-flow.json --target preview --workspace my-qa` 순서로 사용할 수 있습니다. `flow-qa --help`는 전체 명령을 보여줍니다. 대상과 모델 서버는 HTTPS를 사용하며 HTTP는 루프백 주소에서만 허용합니다.

CLI 제품 문구는 영어가 기본이며 `--lang en|ko`가 선택적 환경 변수 `FLOW_QA_LANG`보다 우선합니다. 저장된 리포트 파일은 영어 제품 문구와 기존 상태 코드를 유지하고, UI에서는 선택한 언어의 제품 라벨로 Markdown 리포트를 내려받을 수 있습니다.

`flows/my-flow.md`에는 시작 상태, 행동, 화면 요소, 기대 결과를 적습니다. 모델 없이 설계 프롬프트를 생성해 기존 AI에 전달하려면 `flow-qa plan flows/my-flow.md --prompt-only --workspace my-qa`를 실행합니다. 응답을 `cases/my-flow.json`에 저장한 뒤 검토하고 검증합니다. OpenAI 호환 모델을 직접 연결할 때는 다음처럼 설계 모델을 설정합니다.

```sh
flow-qa model planner --url http://localhost:11434/v1 --model your-model-id --workspace my-qa
flow-qa plan flows/my-flow.md --workspace my-qa
```

인증이 필요하면 모델 설정에 `--key-env FLOW_QA_API_KEY`를 추가하고 실행 환경에 그 값을 제공하세요. 설정 파일에는 환경 변수 이름만 저장합니다. 플로우 문서는 지정한 설계 모델 서버로 전송됩니다. 브라우저의 자연어 조작 `act` 또는 모델 판정 `assertAgent`를 쓰려면 도구 호출·이미지 입력을 지원하는 **별도** `agent` 모델 설정이 필요합니다. 고정된 클릭·입력·검증 단계는 모델 없이 실행됩니다.

## 설계 원칙과 결과 해석

- 케이스는 요구사항 ID와 명시적인 assertion을 가집니다. `open`, `click`, `fill`, `act`, `assertVisible`, `assertText`, `assertUrl`, `assertAgent` 등 허용된 단계만 스키마로 검증해 컴파일합니다. 모델 응답의 임의 JavaScript나 shell 명령은 실행하지 않습니다.
- 확인되지 않은 전제는 `questions`에 남기고 해당 케이스를 차단합니다. `preconditions`는 설명이며 계정·재고·로그인 상태를 자동 준비하지 않습니다.
- 생성된 케이스는 원본 플로우의 해시를 기록합니다. 원본이 바뀌면 검증·생성·실행을 멈추고 다시 설계하도록 합니다. 생성과 실행은 별도 동작이며 입력 변경만으로 모델을 호출하지 않습니다.
- 실행마다 `.flowqa/runs/<run-id>/`에 새 리포트와 엔진 결과를 만듭니다. `qa-report.json`과 `qa-report.md`는 통과, 실패, 재시도 후 통과, 차단, 오류, 미실행을 구분합니다. assertion 실패는 관찰 결과이며 제품 버그 확정은 아닙니다.
- 취소한 실행은 중단으로 기록합니다. UI의 생성 취소는 늦게 도착한 응답을 반영하지 않지만 모델 제공자의 처리나 과금 취소를 보장하지 않습니다. 엔진의 토큰·추정 비용만 표시하며 전체 비용 상한은 없습니다.

리포트와 원본 증거에는 테스트 앱의 데이터가 포함될 수 있습니다. `.flowqa/`는 Git에서 제외되지만 외부 공유 전에는 내용을 확인하세요. 마스킹이 모든 개인정보를 탐지한다고 보장하지 않습니다. 세션 준비, 모바일 기기, 예약 CI 실행, 팀 권한과 공유 서버는 현재 지원 범위에 포함되지 않습니다.

![실제 세 케이스 실행 결과](https://raw.githubusercontent.com/hyeonse-swing/flow-qa/main/docs/media/flow-qa-report.png)

## 구현과 출처

Flow QA가 구현한 부분은 플로우·케이스 스키마, 설계 모델 연결, 컴파일, 실행 조율, 결과 해석과 로컬 UI입니다. 실제 브라우저 테스트 엔진은 [tester-army/e2e](https://github.com/tester-army/e2e)와 관련 패키지를 의존성으로 사용합니다. UI는 [Hyeonse Design System](https://github.com/hyeonse-swing/hyeonse-design-system)의 스타일 토큰과 선호 설정 유틸을 사용하며 화면 구성은 이 프로젝트에서 작성했습니다. [제3자 고지](https://github.com/hyeonse-swing/flow-qa/blob/main/THIRD_PARTY_NOTICES.md)와 [아키텍처](https://github.com/hyeonse-swing/flow-qa/blob/main/docs/architecture.md)에 경계를 자세히 적었습니다.
