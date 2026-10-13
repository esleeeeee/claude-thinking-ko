# thinking-ko — Claude Code 생각·답변 한국어 표시 mod

Claude Code에서 Claude의 **생각(thinking)** 과 **답변**을 반말·구어체 한국어로 보여 주는 비공식 mod(플러그인)입니다. **화면 표시만** 바꿉니다. 대화 기록(transcript)과 Claude가 읽는 내용은 그대로입니다.

원본은 OMP(oh-my-pi)용 확장 [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko)(MIT)이고, 이 저장소는 그 포크를 Claude Code mod로 옮긴 것입니다. 원래 OMP 버전은 [`legacy/`](legacy/)에 그대로 보존돼 있습니다.

## 빠른 시작 (3단계)

1. **마켓플레이스 추가:** Claude 앱(Code 탭)의 플러그인 메뉴에서 마켓플레이스를 추가하고 `esleeeeee/claude-thinking-ko`를 넣습니다. 받지 않으면 `https://github.com/esleeeeee/claude-thinking-ko.git`를 넣으세요. 터미널을 쓴다면 `/plugin install thinking-ko --marketplace esleeeeee/claude-thinking-ko` 한 줄로 끝납니다.
2. **thinking-ko 설치:** 플러그인 목록에서 thinking-ko를 고르고 **사용자(본인 계정) 범위**로 설치합니다. Gemini 키를 묻는 칸은 비워 두면 됩니다(Haiku 사용).
3. **(터미널만) 생각 요약 켜기:** 데스크톱 앱은 생각 요약이 원래 켜져 있어서 이 단계가 필요 없습니다. 생각이 텍스트 없이 들어오면 입력창 위에 `[생각 요약 켜기]` 버튼이 뜹니다. 그때 누르고 누르고 Claude Code를 **껐다 켭니다.** 버튼은 `~/.claude/settings.json`에 `"showThinkingSummaries": true` 한 줄만 더합니다(원래 파일은 `settings.json.thinking-ko.bak`로 백업).

이제 생각이 필요한 질문을 보내면, Claude가 생각하는 **도중에** 입력창 위 띠에 한국어 생각이 문단 단위로 쌓이고, 답변도 반말로 바뀝니다. 띠가 길면 `[접기]`를 누르세요. 앱은 **로컬 세션**에서만 동작합니다(클라우드 세션 제외).

> **설치 전 확인:** 생각·답변 원문이 번역을 위해 별도 모델 요청으로 전송됩니다(기본: 내 Claude 계정의 Haiku, 옵션: Google Gemini API). 생각·답변에 코드·비밀값이 들어 있으면 함께 전송될 수 있으니 민감한 작업에는 쓰지 마세요. 번역 요청만큼 사용량·비용이 늘어납니다.

## 기능

### 생각(thinking)

- Claude가 생각하는 **도중에** 문단이 하나 끝날 때마다 바로 한국어 혼잣말로 옮겨, **입력창 위 띠**에 이번 턴의 생각을 실시간으로 쌓습니다(최신 14줄).
  - 아직 들어오는 중인 부분은 `_생각 중.._`, 번역을 기다리는 문단은 `_생각 옮기는 중.._`으로 보입니다.
  - 번역이 끝내 실패한 문단은 `(번역 실패, 원문)` 표시와 함께 영어 원문을 보여 줍니다.
  - 띠 오른쪽 `[접기]`를 누르면 마지막 한 줄만 보이고, `[펼치기]`로 다시 펼칩니다. 접은 상태는 다음 세션에도 기억합니다.
  - 띠는 다음 질문을 보낼 때까지 이번 턴의 생각을 보여 줍니다.
- 옵션 `thinking_in_reply`를 켜면, 생각 번역을 그 생각 뒤에 나온 답변 맨 위에도 인용문(`> ✻ …`)으로 붙입니다(기록용, 세션 재개 시에도 캐시로 다시 보임). 기본은 꺼짐입니다.
- `/thinking-ko`를 입력하면 최근 생각 20개의 번역을 **패널**로 볼 수 있습니다.
- 생각 번역 프롬프트는 원본 OMP 버전의 생각용 프롬프트·예시를 그대로 씁니다.

### 답변

- Claude의 답변 블록을 한국어 혼잣말 말투로 바꿔 그립니다(제자리 교체). 이미 한국어인 답변도 반말·구어체로 바꿉니다.
- 말투는 원본을 따릅니다: 짧은 반말, 감탄사·말줄임 허용, 가벼운 욕설 허용, 격식체 금지. 업무용 정중체 번역기가 아닙니다. 원본의 ㅆ→ㅅ 표기(`햇어`, `잇어`)는 빼고 표준 맞춤법(`했어`, `있어`)을 씁니다.
- 코드 블록·인라인 코드·파일 경로·명령어·식별자·URL·숫자는 바꾸지 않도록 지시하고, 마크다운 구조를 유지하게 합니다. 번역 결과를 고치는 후처리는 원문의 인라인 코드에 백틱이 빠졌을 때 백틱만 다시 씌우는 것 하나뿐입니다(글자는 바꾸지 않음).
- 답변 표시 흐름
  - 생성 중인 블록: 원문 그대로
  - 번역 대기 중: 원문 끝에 `_옮기는 중.._` (실패 후 재시도 대기면 `_옮기는 중.. (재시도)_`)
  - 번역 완료: 번역문으로 다시 그림
  - 최종 실패: 원문 그대로
- 번역은 백그라운드에서 돌고, 결과가 오면 `$.ui.invalidate`로 화면을 다시 그립니다.


### 공통

- 원본의 안정장치를 옮겼습니다: 순서 보장 큐, 동시 요청 제한(원본처럼 생각 2개·답변 1개, 취소가 안 되는 요청은 끝날 때까지 자리 차지), 길이에 비례한 타임아웃(12초 + 1000자마다 2.5초), 실패 시 1회 재시도(60초 뒤, 또는 다른 번역이 성공한 직후), 대기 8개 초과 시 가장 오래된 항목은 원문으로 확정.
- 답변 번역은 메시지 id 기준으로 `$.store`에 캐시해(최근 100개) 세션을 재개해도 다시 요청하지 않습니다.

예시(2.1.296에서 이 mod의 프롬프트로 Haiku가 실제로 옮긴 결과):

```text
생각 원문: ... I should double-check the edge case at n = 999 before I answer.
생각 표시: ... 답 주기 전에 n = 999 경계 케이스 한 번 더 확인해 봐야겠다.

답변 원문: I fixed the bug in `src/parser.ts`: the date regex didn't accept a trailing `Z`.
답변 표시: 음.. `src/parser.ts`에서 버그 고쳤어. 날짜 정규식이 끝에 붙는 `Z`를 안 받고 있더라고.
```

## 한계

### 생각 번역 방식

- **생각은 제자리에서 바꾸지 못합니다.** Claude Code의 mod API에는 thinking 블록을 그리는 렌더 자리가 없습니다. 그래서 원래 생각 줄은 영어 그대로 두고, 번역은 입력창 위 띠(실시간)와 `/thinking-ko` 패널에 보여 줍니다.
- **생각 요약 설정이 필요합니다.** 데스크톱 앱은 원래 켜져 있습니다. 터미널 Claude Code는 기본값에서 생각 텍스트를 받아 오지 않습니다(`showThinkingSummaries` 꺼짐). 2.1.296에서 확인한 결과, 꺼져 있으면 생각 블록이 서명만 있고 텍스트가 빈 채로 옵니다. 켜면(`--thinking-display summarized`와 같은 효과) 텍스트가 오고 mod가 번역합니다. 생각이 텍스트 없이 들어오면 띠에 안내와 켜기 버튼을 보여 줍니다(설정 파일만 보고 판단하지 않습니다).
- **번역 대상은 API가 주는 생각 요약입니다.** 요즘 Claude 모델은 생각 전문이 아니라 요약본을 돌려주고, Claude Code 화면에 보이는 생각도 같은 요약본입니다. 이 mod는 그 요약본을 옮깁니다.
- 메인 대화의 생각만 옮깁니다(서브에이전트 생각 제외). 생각 뒤에 답변 글이 없이 턴이 끝나면 그 생각은 `/thinking-ko` 패널에서만 보입니다. 패널 목록은 세션을 재개하면 비어 있습니다.

### 그 밖의 한계

- **과거 메시지는 소급 번역하지 않습니다.** mod가 켜진 뒤 이번 실행에서 턴이 시작되기 전에 그려진 답변(재개한 세션의 기록 등)은 캐시가 있을 때만 번역문으로 보이고, 새로 요청하지 않습니다.
- 도구 호출 사이 글의 **요약 행(`isSummary`)** 은 건드리지 않습니다.
- "생성 중" 판정은 응답 스트림의 text 조각과 화면 글을 비교하는 방식입니다. 화면이 원문 일부를 숨기는 경우 등에서 판정이 어긋날 수 있습니다.
- LLM 번역은 무손실을 보장하지 않습니다. 실행할 명령·중요한 수치는 원문과 대조하세요. **ctrl+o**(상세 보기)나 mod를 끈 상태에서 원문을 볼 수 있습니다.
- Claude Code mod API는 early access라 버전이 바뀌면 동작이 달라질 수 있습니다. 확인한 버전은 **2.1.296**입니다.
- 답변은 화면에 그려지는 모든 assistant 답변 블록(서브에이전트 포함)이 대상입니다.

## 준비물

- **Claude Code 2.1.287 이상** (mod 지원 버전). 확인: `claude --version`
- 기본 번역기(Haiku)는 지금 쓰는 Claude Code 계정·인증을 그대로 씁니다. 별도 키가 필요 없습니다.
- Gemini를 쓰려면 본인의 [Gemini API 키](https://aistudio.google.com/apikey)가 필요합니다(선택).

## 설치

위 [빠른 시작](#빠른-시작-3단계)이 기본 방법입니다.

- **앱과 터미널은 설정을 함께 씁니다.** 사용자 범위로 설치하면 터미널(`claude`), 데스크톱 앱의 로컬 세션, VS Code에서 모두 켜집니다.
- **업데이트:** 플러그인 관리 메뉴(앱: **+ → Plugins → Manage plugins**, 터미널: `/plugin`)에서 업데이트하거나, 터미널에서 `claude plugin update thinking-ko@claude-thinking-ko`를 실행합니다.
- **개발·시험용으로 폴더에서 바로 실행:**

  ```sh
  git clone https://github.com/esleeeeee/claude-thinking-ko
  claude --plugin-dir ./claude-thinking-ko
  ```

  `--plugin-dir`은 그 세션에만 적용됩니다. 설치본과 `--plugin-dir`을 **동시에 쓰지 마세요**(번역 요청이 두 번 나갈 수 있습니다).

## 설정

### 생각 요약 켜기 (생각 번역에 필요)

데스크톱 앱은 원래 켜져 있어서 할 일이 없습니다. 터미널 Claude Code는 기본값에서 생각 텍스트를 받아 오지 않습니다. 입력창 위 띠의 `[생각 요약 켜기]` 버튼을 누르는 게 가장 쉽습니다. 직접 하려면 `~/.claude/settings.json`(Windows는 `%USERPROFILE%\.claude\settings.json`)에 아래 항목을 넣고 Claude Code를 다시 켜세요. 이미 다른 설정이 있으면 중괄호 안에 이 항목만 추가합니다(앞 항목 뒤에 쉼표).

```json
{ "showThinkingSummaries": true }
```

- Claude Code 공식 설정으로, "API에 생각 요약을 요청해서 대화와 상세 보기(ctrl+o)에 보여 준다"는 뜻입니다.
- 한 번만 시험하려면 실행할 때 `claude --thinking-display summarized`를 붙여도 됩니다.
- 생각 자체가 나와야 하므로, 생각을 아예 안 하는 짧은 질문에서는 띠에 아무것도 안 뜰 수 있습니다. `/config`에서 생각(thinking)을 켜 두거나 생각이 필요한 질문으로 확인하세요.

### mod 옵션

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `gemini_api_key` | (비어 있음) | 비우면 Claude Haiku로 번역. 넣으면 Gemini 공식 API(`generativelanguage.googleapis.com`)로 번역. 민감 값으로 표시돼 있어 설치형 플러그인은 보안 저장소에 보관됩니다. |
| `gemini_model` | `gemini-flash-latest` | 키가 있을 때 쓸 Gemini 모델 |
| `thinking_in_reply` | 꺼짐 | 켜면 생각 번역을 뒤따르는 답변 맨 위에도 인용문으로 붙임 |
| `claude_model` | `haiku` | 키가 없을 때 쓸 Claude 모델(별칭 또는 전체 id) |

- **기본(Haiku):** 아무것도 설정하지 않으면 `$.model.complete`로 세션의 Claude 클라이언트를 통해 Haiku를 부릅니다.
- **Gemini 키 넣기(마켓플레이스 설치):** 설치 때 설정 화면에서 넣거나, 나중에 터미널에서

  ```sh
  printf '%s' '{"gemini_api_key":"여기에_키"}' | claude plugin configure thinking-ko@claude-thinking-ko --values-stdin
  ```

  키를 빼려면 같은 방법으로 `""`를 넣습니다. 비민감 항목(`gemini_model`, `claude_model`)은 `/config` 메뉴에서도 바꿀 수 있습니다.
- **`--plugin-dir`로 실행할 때:** 옵션은 `~/.claude/settings.json`의 `pluginConfigs`에서 읽습니다(키 이름 `thinking-ko`, 안 되면 `thinking-ko@inline`). 이 경우 키가 **평문으로** 저장되므로 그 파일을 공유·커밋하지 마세요.

  ```json
  { "pluginConfigs": { "thinking-ko": { "options": { "gemini_api_key": "여기에_키" } } } }
  ```

- 키는 **코드나 이 저장소에 절대 넣지 마세요.** mod는 키를 URL이 아닌 `x-goog-api-key` 헤더로만 보내고, 로그에 남기지 않습니다.

## 끄기와 제거

- 끄기: `/plugin`에서 thinking-ko를 비활성화하면 원문 표시로 돌아갑니다(바로 반영되지 않으면 `/reload-plugins`). 대화 기록은 원래 원문이라 따로 되돌릴 것이 없습니다. 다시 켜면 캐시된 번역이 다시 보입니다.
- 제거: `/plugin`에서 제거하거나 `claude plugin uninstall thinking-ko@claude-thinking-ko`. `--plugin-dir`이면 그 옵션 없이 실행하면 됩니다.
- 남는 데이터: 번역 캐시(`$.store`, mod 전용 저장소)와 로그 파일(아래). 로그는 직접 지워도 됩니다.

## 개인정보·보안·사용량

- 이 저장소에는 API 키, 토큰, 개인 설정, 대화 기록, 로그가 들어 있지 않습니다.
- 생각·답변 원문은 비밀값을 걸러 내지 않고 그대로 번역기에 전송됩니다. Haiku는 내 Claude 계정으로, Gemini는 내 키로 Google에 보내집니다. 각 서비스의 약관·요금·데이터 정책이 적용됩니다.
- 번역 요청은 생각 블록·답변 블록마다 1회, 실패 시 재시도 1회입니다. 생각이 많을수록, 답변이 길고 잦을수록 사용량이 늘어납니다.
- 로그: `~/.claude/thinking-ko/thinking-ko.log` (Windows는 `%USERPROFILE%\.claude\thinking-ko\thinking-ko.log`). 상태·글자 수·소요 시간·오류 종류만 기록하고 **원문·번역문·키는 남기지 않습니다**(최근 500줄 유지). 토큰처럼 생긴 문자열은 한 번 더 가립니다. 그래도 로그를 공개 이슈에 붙일 때는 내용을 확인하세요.
- 답변 번역 캐시에는 번역문이 저장됩니다(원문은 해시만). 로컬 데이터입니다. 생각 번역은 메모리에만 두고 저장하지 않습니다.
- 표시만 바꿉니다: 세션에 행을 추가(`session.append`)하거나 모델에 가는 내용을 고치지 않습니다. 응답 스트림 훅(`turn.step`)은 생각 원문을 모으고 "생성 중"을 판정하려고 조각을 읽기만 하고 그대로 넘깁니다.

## 동작 방식 (개발자용)

```
.claude-plugin/plugin.json       mod 매니페스트(userConfig 포함)
.claude-plugin/marketplace.json  이 저장소를 마켓플레이스로 쓰기 위한 파일
hooks/hooks.json                 훅 모듈 지정
hooks/register.tsx               훅 연결: ui.render(AssistantMessage·AbovePrompt·Pane), turn.start/step,
                                 session.start/end, /thinking-ko 명령
hooks/core.ts                    $에 의존하지 않는 로직: 프롬프트, 큐, 슬롯, 타임아웃, 재시도, 정리
hooks/translators.ts             Haiku($.model.complete) / Gemini($.http.fetch) 요청·응답 처리
tests/*.test.ts                  claude plugin test용 테스트(모델·HTTP 모킹)
legacy/                          원래 OMP 확장과 테스트(변경 없음)
```

- `ui.render`의 `AssistantMessage` 자리에서 `next({ ...e, props: { ...e.props, text } })`로 그릴 글만 바꿉니다. 엔진 문서상 이 방식은 그림만 바꾸고 저장된 메시지는 그대로 둡니다.
- 번역 id는 `메시지 id + 원문 해시`입니다. 같은 메시지의 글이 바뀌면 다시 번역합니다.
- 생각은 `turn.step` 스트림의 thinking 조각을 블록별로 모으면서, 빈 줄로 끝난 문단(코드 펜스 안은 제외, 600자가 넘으면 문장 끝)이 생길 때마다 바로 번역을 맡깁니다. 블록이 끝나면 남은 부분도 맡깁니다. `thinking_in_reply`가 켜져 있으면 같은 턴에서 생각 다음에 처음 시작되는 text 블록에 그 생각들을 묶어 두고, 그 답변 블록이 그려질 때 글이 같으면(공백 차이 무시) 맨 위에 인용문으로 붙입니다. 답변 블록·띠(`AbovePrompt`)·패널(`Pane`)은 번역 상태가 바뀔 때 `$.ui.invalidate`로 다시 그립니다.

검증:

```sh
claude plugin validate --strict .
claude plugin test .
```

원래 OMP 버전 테스트는 `legacy/`에서 `npm test`(Node.js 24)로 돌립니다.

## 원본 출처와 라이선스

- 원본: [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko) — MIT License, Copyright (c) 2026 hvvsdcm
- Claude Code mod 포팅: esleeeeee
- 이 저장소도 [MIT License](LICENSE)입니다. Anthropic·Google·OMP의 공식 제품이 아닙니다.

## 로컬 확인 체크리스트 (`claude --plugin-dir`)

클라우드 세션에서는 mod 화면이 그려지지 않아 아래는 직접 확인이 필요합니다.

(앱으로 설치했다면 3~13번만 앱의 로컬 세션에서 확인하면 됩니다.)

1. `claude --version`이 2.1.287 이상인지 확인.
2. 저장소 폴더에서 `claude plugin validate --strict .`와 `claude plugin test .`가 통과하는지 확인.
3. `~/.claude/settings.json`에 `"showThinkingSummaries": true`를 넣고 `claude --plugin-dir /path/to/claude-thinking-ko`로 시작. 시작 화면이나 `claude --debug` 로그에 thinking-ko 로드 오류(`ui.render (AssistantMessage) refused` 등)가 없는지 확인.
4. 영어로 답할 만한 질문을 보냄(예: "Explain what a race condition is in two sentences, in English.").
   - 답변이 생성되는 동안은 원문 그대로인지.
   - 블록이 끝나면 원문 끝에 `_옮기는 중.._`이 붙는지.
   - 잠시 뒤 반말 한국어로 바뀌는지, `햇어`·`잇어` 같은 틀린 표기가 없는지.
   - **생각:** 생각이 필요한 질문(예: "How many n < 1000 have n^2+1 divisible by 5 and n not divisible by 3? Think it through.")을 보내서 Claude가 생각하는 **도중에** 입력창 위 띠에 한국어 생각이 문단 단위로 쌓이는지, `[접기]`·`[펼치기]`가 되는지.
   - `/thinking-ko`로 패널이 열리고 최근 생각 번역이 쌓이는지.
   - (터미널) `showThinkingSummaries` 없이 실행하면 띠에 `[생각 요약 켜기]` 버튼이 뜨는지, 누르면 `settings.json`에 그 한 줄만 추가되고 `.thinking-ko.bak` 백업이 생기는지.
5. 코드 블록·경로·명령어·URL·숫자가 들어간 답변을 받아서 그 부분이 그대로인지 확인.
6. **ctrl+o**(상세 보기)로 원문이 그대로 남아 있는지, 다음 질문에서 Claude가 영어 원문 기준으로 대화를 이어 가는지 확인(대화 기록 무변경).
7. 도구 호출이 섞인 작업(파일 읽기 등)을 시켜서 도구 사이의 글도 번역되는지, 화면이 깨지지 않는지 확인.
8. `~/.claude/thinking-ko/thinking-ko.log`에 `start backend=claude:haiku`, `ok backend=... kind=thinking`, `ok backend=... kind=answer` 줄이 생기고 원문·번역문이 없는지 확인.
9. 세션을 끝내고 `claude --plugin-dir ... --continue`로 재개: 이전 답변이 요청 없이 캐시로 번역 표시되는지(로그에 새 `ok` 줄이 없는지).
10. (선택) Gemini: `~/.claude/settings.json`의 `pluginConfigs.thinking-ko.options.gemini_api_key`에 키를 넣고 재시작 → 로그에 `backend=gemini:gemini-flash-latest`가 찍히고 번역이 되는지. 확인 후 키를 지우세요.
11. (선택) 실패 경로: 존재하지 않는 `claude_model`(예: `no-such-model`)을 넣고 재시작 → `_옮기는 중.. (재시도)_`를 거쳐 원문으로 돌아오는지.
12. (마켓플레이스 설치 시) `/plugin`에서 비활성화(필요하면 `/reload-plugins`) → 원문 표시로 돌아오는지. 다시 활성화 → 캐시된 번역이 보이는지.
13. 전체화면 모드·좁은 터미널에서 띠·패널·답변의 줄바꿈과 한글 폭이 깨지지 않는지 눈으로 확인. 띠의 `[접기]`로 한 줄로 줄어드는지도 확인.
