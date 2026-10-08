export type Locale = 'en' | 'ko';

export function localeFromEnv(value = process.env.FLOW_QA_LANG): Locale {
  return value === 'ko' ? 'ko' : 'en';
}

export function localeFromAcceptLanguage(value: string | string[] | undefined): Locale {
  if (typeof value !== 'string' || value.length > 256) return 'en';
  const choices = value.split(',').map((part, order) => {
    const [tag, ...parameters] = part.trim().split(';');
    const language = tag?.toLowerCase().split('-')[0];
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='))?.trim().slice(2);
    const weight = quality === undefined ? 1 : Number(quality);
    return { language, weight, order };
  }).filter((choice) => (choice.language === 'en' || choice.language === 'ko') &&
    Number.isFinite(choice.weight) && choice.weight > 0 && choice.weight <= 1);
  choices.sort((a, b) => b.weight - a.weight || a.order - b.order);
  return choices[0]?.language === 'ko' ? 'ko' : 'en';
}

export function localized(locale: Locale, english: string, korean: string): string {
  return locale === 'ko' ? korean : english;
}

// Only call this for product-owned guidance, never for suite titles, flow text, or provider payloads.
const koreanMessages: Record<string, string> = {
  'Invalid input.': '입력 형식이 올바르지 않습니다.',
  'The requested item was not found.': '요청한 항목을 찾을 수 없습니다.',
  'IDs must be unique.': 'ID가 중복됐습니다.',
  'Every requirement must be covered by a case, including blocked cases.': '모든 요구사항을 하나 이상의 케이스에 연결하세요.',
  'Unknown requirement ID.': '존재하지 않는 요구사항 ID를 참조합니다.',
  'A runnable case needs an explicit assertion.': '실행 가능한 케이스에는 명시적인 검증 단계가 필요합니다.',
  'A required value is missing or has the wrong type.': '필수 값 또는 값의 형식이 올바르지 않습니다.',
  'The value is shorter or smaller than allowed.': '값이 허용된 최소 길이 또는 개수보다 작습니다.',
  'The value is longer or larger than allowed.': '값이 허용된 최대 길이 또는 개수를 넘었습니다.',
  'The value has an invalid format.': '값의 형식이 올바르지 않습니다.',
  'The value is not allowed.': '허용되지 않는 값입니다.',
  'An unsupported field is present.': '지원하지 않는 필드가 있습니다.',
  'The value does not meet the schema rules.': '스키마 규칙을 충족하지 않습니다.',
  'Check model authentication and access permissions.': '모델 인증 또는 접근 권한을 확인하세요.',
  'Check the model request limit.': '모델 요청 한도를 확인하세요.',
  'The model service is unavailable. Try again later.': '모델 서비스가 응답하지 않았습니다. 잠시 후 다시 시도하세요.',
  'Check the model URL and request settings.': '모델 연결 주소와 요청 설정을 확인하세요.',
  'A JSON object response is required.': 'JSON 객체 응답이 필요합니다.',
  'A runnable case needs an expected-result assertion.': '실행 가능한 케이스에는 기대 결과 검증이 필요합니다.',
  'Check requirement links, duplicate IDs, and assertions.': '요구사항 연결·중복 ID·검증 조건을 확인하세요.',
  'Check required values, types, and limits in the case schema.': '케이스 스키마의 필수 값·타입·허용 범위를 확인하세요.',
  'Check the case schema.': '케이스 스키마를 확인하세요.',
  'The model returned an invalid case suite.': '모델이 올바른 케이스 형식을 반환하지 않았습니다.',
  'Planning was cancelled or timed out.': '계획 생성이 중단되거나 제한 시간을 넘었습니다.',
  'Could not reach the model service. Check its URL and network connection.': '모델 서비스에 연결하지 못했습니다. 주소와 네트워크를 확인하세요.',
  'Invalid JSON.': 'JSON 형식이 올바르지 않습니다.',
  'Invalid file name.': '파일 이름이 올바르지 않습니다.',
  'Invalid source flow path.': '원본 플로우 경로가 올바르지 않습니다.',
  'Only JSON requests are supported.': 'JSON 요청만 사용할 수 있습니다.',
  'The request body is too large.': '요청 본문이 너무 큽니다.',
  'Invalid workspace path.': '작업 공간 경로가 올바르지 않습니다.',
  'Could not read the Flow QA configuration.': 'Flow QA 설정을 읽을 수 없습니다.',
  'Invalid configuration file path.': '설정 파일 경로가 올바르지 않습니다.',
  'The source flow changed. Save the cases again.': '원본 플로우가 변경됐습니다. 케이스를 다시 저장하세요.',
  'Invalid run ID.': '실행 ID가 올바르지 않습니다.',
  'The UI server is shutting down.': 'UI 서버가 종료 중입니다.',
  'Another operation is in progress.': '다른 작업이 진행 중입니다.',
  'Invalid request origin.': '요청 출처가 올바르지 않습니다.',
  'A case file name is required.': '케이스 파일 이름이 필요합니다.',
  'A run ID is required.': '실행 ID가 필요합니다.',
  'Invalid evidence selection.': '증거 파일 선택이 올바르지 않습니다.',
  'The request is not allowed.': '허용되지 않은 요청입니다.',
  'Invalid request token.': '요청 토큰이 올바르지 않습니다.',
  'The flow is too large.': '플로우가 너무 큽니다.',
  'A compatible planner model must be configured.': '호환 모델 planner 설정이 필요합니다.',
  'The model key environment variable is missing.': '모델 키 환경 변수가 준비되지 않았습니다.',
  'Generating cases': '케이스 생성',
  'Planning timed out.': '계획 생성 시간이 제한을 넘었습니다.',
  'Planning was cancelled.': '계획 생성이 중단됐습니다.',
  'The model returned an invalid suite.': '모델이 유효한 케이스를 반환하지 않았습니다.',
  'Could not generate the plan.': '계획을 생성하지 못했습니다.',
  'Could not prepare the cases directory.': '케이스 폴더를 준비하지 못했습니다.',
  'Could not prepare the flows directory.': '플로우 폴더를 준비하지 못했습니다.',
  'The reviewed case file changed. Open it again to review.': '검토한 케이스 파일이 변경됐습니다. 다시 열어 확인하세요.',
  'The selected target was not found.': '실행 대상을 찾을 수 없습니다.',
  'The selected target URL changed. Review it again.': '선택한 실행 대상 주소가 변경됐습니다. 다시 확인하세요.',
  'Could not complete the run. Check the local records.': '실행을 완료하지 못했습니다. 로컬 기록을 확인하세요.',
  'Could not handle the request.': '요청을 처리하지 못했습니다.',
  'Evidence files must be 10 MiB or smaller.': '증거 파일은 10 MiB 이하만 열 수 있습니다.',
  'No readable evidence file was found.': '열 수 있는 증거 파일이 없습니다.',
  'The raw report has no result for this case.': '원본 보고서에 이 케이스의 결과가 없습니다.',
  'One or more cases ended without a result or were interrupted.': '하나 이상의 케이스가 실행 결과 없이 끝났거나 중단되었습니다.',
  'The e2e blocked status conflicts with a failed case result.': 'e2e의 차단 상태와 케이스별 실패 상태가 일치하지 않습니다.',
  'The agent model or its API key environment variable is missing, so this case was not run.': '에이전트 모델 설정 또는 지정된 API 키 환경 변수가 없어 실행하지 않았습니다.',
  'An interrupt signal arrived before the run started.': '실행 전 중단 신호를 받았습니다.',
  'There are no runnable cases.': '실행 가능한 케이스가 없습니다.',
  'The e2e run stopped after an interrupt signal.': '사용자 중단 신호로 e2e 실행을 종료했습니다.',
  'The e2e run exceeded its overall time limit.': 'e2e 전체 실행 시간이 제한을 초과해 종료했습니다.',
  'The e2e exit status and report result disagree.': 'e2e 종료 상태와 보고서 결과가 일치하지 않습니다.',
  'flowqa.config.json is missing. Run flow-qa init first.': 'flowqa.config.json이 없습니다. 먼저 flow-qa init을 실행하세요.',
  'Cannot read the source flow for these cases. Restore the file or regenerate the cases from the specification.': '케이스의 원본 플로우 파일을 읽을 수 없습니다. 원본을 복원하거나 명세에서 케이스를 다시 생성하세요.',
  'STALE_SUITE: The flow changed. Regenerate the cases from the current specification.': 'STALE_SUITE: 플로우가 변경되었습니다. 현재 명세로 케이스를 다시 생성하세요.',
};

export function localizeProductMessage(message: string, locale: Locale): string {
  return locale === 'ko' ? koreanMessages[message] ?? message : message;
}
