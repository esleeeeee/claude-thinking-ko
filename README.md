# thinking-ko

Claude Code에서 Claude의 **생각(thinking)** 과 **답변**을 반말 한국어로 보여 주는 플러그인입니다.

- Claude가 생각하는 **동안** 생각을 문장 단위로 한국어로 옮겨, 대화창에 바로바로 보여 줍니다.
- 답변도 반말·구어체 한국어로 바꿔 보여 줍니다. 코드, 파일 경로, 명령어, 숫자, URL은 그대로 둡니다.
- **화면에 보이는 것만** 바꿉니다. 대화 기록과 Claude가 읽는 내용은 원문 그대로입니다.

<!-- IMAGE: hero (답변 위 생각 묶음 + 반말 답변) -->

OMP(oh-my-pi)용 확장 [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko)를 Claude Code 플러그인으로 옮긴 비공식 플러그인입니다.

[설치](#설치) · [기능](#기능) · [설정](#설정) · [문제 해결](#문제-해결) · [동작 원리](#동작-원리)

## 설치

아래 셋 중 편한 방법 하나로 한 번만 설치하면 됩니다. **사용자(본인 계정) 범위**로 설치하면 같은 컴퓨터의 Claude 앱, 터미널, VS Code에서 모두 켜집니다. 셋 다 `~/.claude`(Windows는 `%USERPROFILE%\.claude`) 폴더의 설정을 같이 쓰기 때문입니다.

> **설치 전에 알아 둘 것**
> - 번역하려고 생각·답변 원문을 별도 모델 요청으로 보냅니다. 기본은 내 Claude 계정의 Haiku이고, 키를 넣으면 Google Gemini를 씁니다. 원문에 코드나 비밀값이 있으면 같이 전송되니, 민감한 작업에는 쓰지 마세요.
> - 번역 요청만큼 사용량이 늘어납니다.
> - 한국어 생각을 먼저 보여 주려고, 답변이 생각 블록마다 최대 3초 늦게 나올 수 있습니다(옵션으로 끌 수 있음).
> - Claude Code 2.1.287 이상이 필요합니다.

### 1. Claude 앱 (데스크톱)

<!-- IMAGE: app-1 (+ 메뉴 → Plugins) -->

1. **Code** 탭 입력창 옆 **+** 를 누르고 **Plugins** → **Add plugin**으로 들어갑니다.
2. 마켓플레이스를 추가하는 칸에 아래 주소를 넣습니다. `esleeeeee/claude-thinking-ko`처럼 줄여 써도 됩니다.

   ```text
   https://github.com/esleeeeee/claude-thinking-ko.git
   ```

   <!-- IMAGE: app-2 (마켓플레이스 추가) -->

3. 목록에서 **thinking-ko**를 고르고, 범위는 **사용자(본인 계정)** 로 설치합니다.

   <!-- IMAGE: app-3 (thinking-ko 설치) -->

4. 앱을 **완전히** 껐다 켭니다(트레이 아이콘까지). 그다음 **로컬 세션**에서 생각이 필요한 질문을 보내 보세요.

알아 둘 것:

- 처음 켜질 때 "생각 요약을 켜 뒀어" 알림이 한 번 뜰 수 있습니다. 생각 번역에 필요한 설정을 플러그인이 켠 것입니다([자세히](#생각-요약-설정-자동)).
- **로컬 세션에서만** 동작합니다. 클라우드 세션, WSL 세션, Cowork 탭에서는 켜지지 않습니다.
- 업데이트·끄기·제거는 **+** → **Plugins** → **Manage plugins**에서 합니다. 업데이트한 뒤에는 앱을 다시 켜야 적용됩니다. 업데이트 버튼이 꺼져 있으면 [문제 해결](#windows-앱에서-업데이트-버튼이-꺼져-있어요)을 보세요.

### 2. 터미널 (CLI)

Claude Code CLI가 없으면 먼저 설치합니다([공식 설치 안내](https://code.claude.com/docs/en/setup)).

```sh
# macOS·Linux·WSL
curl -fsSL https://claude.ai/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

그다음 플러그인을 설치합니다.

```sh
claude plugin marketplace add esleeeeee/claude-thinking-ko
claude plugin install thinking-ko@claude-thinking-ko
```

- 기본 범위가 사용자(user)라서 따로 고를 것이 없습니다. `claude plugin list`로 설치됐는지 확인할 수 있습니다.
- 다음에 Claude Code를 켤 때 적용됩니다. 이미 켜 둔 세션에서는 `/reload-plugins`를 입력하세요.
- Claude Code 안에서 설치하려면 `/plugin marketplace add esleeeeee/claude-thinking-ko`를 입력한 뒤 `/plugin install thinking-ko@claude-thinking-ko`를 입력합니다.

업데이트·끄기·제거:

```sh
# 업데이트(적용하려면 Claude Code를 다시 켬)
claude plugin marketplace update claude-thinking-ko
claude plugin update thinking-ko@claude-thinking-ko

# 끄기 / 다시 켜기
claude plugin disable thinking-ko@claude-thinking-ko
claude plugin enable thinking-ko@claude-thinking-ko

# 제거(저장해 둔 옵션과 Gemini 키도 함께 지워짐)
claude plugin uninstall thinking-ko@claude-thinking-ko
```

이 저장소처럼 공식 목록 밖의 마켓플레이스는 자동 업데이트가 기본으로 꺼져 있습니다. 켜려면 Claude Code에서 `/plugin` → **Marketplaces** → **claude-thinking-ko** → **Enable auto-update**를 고르세요.

### 3. VS Code 확장

1. VS Code(1.94 이상)의 확장 탭에서 **Claude Code**를 검색해 설치합니다.
2. Claude Code 채팅 입력창에 `/plugins`를 입력해 **Manage plugins** 창을 엽니다.
3. **Marketplaces** 탭에 `esleeeeee/claude-thinking-ko`를 넣어 추가합니다.
4. **Plugins** 탭에서 thinking-ko를 찾아 **Install** → **Install for you**(사용자 범위)를 고릅니다.
5. 설치하고 나서 옵션 창이 뜨면, Gemini 키 칸은 비워 둬도 됩니다(Haiku로 번역). 나중에 그 줄의 톱니바퀴로 다시 열 수 있습니다.

아래 주소를 브라우저 주소창에 붙여 넣으면 VS Code에서 바로 설치 창이 열립니다. GitHub에서는 이런 링크가 눌리지 않아서 글자로 적어 둡니다.

```text
vscode://anthropic.claude-code/install-plugin?plugin=thinking-ko&marketplace=esleeeeee/claude-thinking-ko
```

- 끄기는 그 줄의 스위치, 제거는 휴지통 아이콘입니다.
- VS Code 확장은 자체 CLI를 품고 있어서, 확장만 설치하면 터미널에서 `claude` 명령을 쓸 수 없습니다. 터미널 명령이 필요하면 위의 CLI를 따로 설치하세요.
- VS Code 화면에서는 직접 확인하지 못했습니다. 생각은 앱과 같은 방식(질문·도구 줄 아래)으로 보이게 만들어 두었습니다.

## 기능

### 생각을 실시간으로

Claude가 생각하는 **동안**, 문장이 끝날 때마다 한국어 혼잣말로 옮겨 `✻ 생각` 묶음에 쌓습니다. 생각이 한 문단으로 길게 이어져도 번역이 계속 따라옵니다.

| 어디서 | 생각이 쌓이는 자리 |
| --- | --- |
| Claude 앱 | 보낸 질문 바로 아래. Claude가 도구를 쓰면(파일 읽기, 명령 실행 등) 그 뒤의 생각은 방금 쓴 도구 줄 아래로 따라갑니다. |
| 터미널 | 대화창 맨 아래 진행 줄(`Running … 24초`) 바로 위 |
| VS Code | 보낸 질문이나 마지막 도구 줄 아래(앱과 같은 방식) |

- 아직 들어오는 중인 부분은 *생각 중..*, 번역을 기다리는 부분은 *생각 옮기는 중..* 으로 보입니다.
- 최신 20줄까지 보이고, 그보다 앞부분은 `/thinking-ko` 패널에서 봅니다.

### 생각은 답변 위로

- Claude가 답변을 쓰기 시작하면, 그 앞의 생각 묶음이 **답변 바로 위**로 옮겨 갑니다. 도구를 쓰는 사이에 나온 생각은 그다음 답변 위에 붙습니다.
- 한국어 생각이 답변보다 먼저 보이도록, 생각이 끝나면 그 번역이 나올 때까지 답변이 **최대 3초** 기다렸다 나옵니다. 글자는 하나도 바꾸지 않고 나오는 시점만 늦춥니다(`thinking_first` 옵션으로 끌 수 있음).
- 답변 위에 붙은 생각은 저장돼서, 세션을 다시 열어도 그대로 보입니다.

### 접기

- 묶음 머리 줄의 `▾ 접기`를 누르면 마지막 줄만 남고(실시간 묶음은 마지막 세 줄), `▸ 펼치기`로 다시 펼칩니다.
- 접은 상태는 모든 묶음에 함께 적용되고, 다음에 켤 때도 유지됩니다.

### 답변 번역

- Claude의 답변을 반말·구어체 한국어로 바꿔 보여 줍니다. 이미 한국어인 답변도 같은 말투로 바꿉니다.
- 쓰는 중에는 원문 그대로 → 다 쓰면 끝에 *옮기는 중..* → 번역문으로 바뀝니다. 번역이 끝내 실패하면 원문을 그대로 둡니다.
- 번역문은 저장돼서(최근 100개) 세션을 다시 열어도 다시 요청하지 않습니다.

### 말투

- 원본(OMP 버전)의 말투를 따릅니다: 짧은 반말, 감탄사·말줄임 허용, 가벼운 욕설 허용, 격식체 금지. 업무용 정중체 번역기가 아닙니다.
- 맞춤법은 표준대로 씁니다. 원본의 `햇어`·`잇어` 같은 표기는 쓰지 않습니다.
- 코드 블록, 인라인 코드, 파일 경로, 명령어, 식별자, URL, 숫자는 바꾸지 않게 하고 마크다운 모양을 지킵니다.

실제 번역 예시(Haiku):

```text
생각 원문: ... I should double-check the edge case at n = 999 before I answer.
생각 표시: ... 답 주기 전에 n = 999 경계 케이스 한 번 더 확인해 봐야겠다.

답변 원문: I fixed the bug in `src/parser.ts`: the date regex didn't accept a trailing `Z`.
답변 표시: 음.. `src/parser.ts`에서 버그 고쳤어. 날짜 정규식이 끝에 붙는 `Z`를 안 받고 있더라고.
```

### `/thinking-ko` 패널

입력창에 `/thinking-ko`를 치면 최근 생각 20개의 번역을 패널로 봅니다.

## 설정

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `gemini_api_key` | (비어 있음) | 비우면 Claude Haiku로, 넣으면 Google Gemini로 번역합니다. 민감한 값이라 보안 저장소에 따로 보관됩니다. |
| `gemini_model` | `gemini-flash-latest` | Gemini 키가 있을 때 쓸 모델 |
| `claude_model` | `haiku` | Gemini 키가 없을 때 쓸 Claude 모델(별칭 또는 전체 id) |
| `thinking_in_reply` | 켜짐 | 생각 묶음을 답변 위로 옮겨 붙입니다. 끄면 작업 중 실시간 표시와 패널만 남습니다. |
| `thinking_first` | 켜짐 | 생각이 끝나면 그 번역이 나올 때까지 답변·도구 호출이 최대 3초 기다립니다. 끄면 기다리지 않습니다. |
| `auto_thinking_summaries` | 켜짐 | 생각 요약 설정을 자동으로 켭니다([아래](#생각-요약-설정-자동)). 끄면 설정 파일을 건드리지 않습니다. |

옵션을 바꾸는 곳:

- **터미널:** Claude Code 안에서 `/plugin configure thinking-ko@claude-thinking-ko`를 입력하면 옵션 창이 열립니다. `/plugin` → **Installed** → thinking-ko → **Configure options**로 들어가도 됩니다. 셸에서 `claude plugin configure thinking-ko@claude-thinking-ko`를 실행하면 지금 값을 볼 수 있습니다.
- **VS Code:** `/plugins` 창에서 thinking-ko 줄의 톱니바퀴를 누릅니다.
- **Claude 앱:** 앱에서 옵션 창을 찾기 어려우면 위 두 곳 중 하나에서 바꾸세요. 설정을 같이 써서 앱에도 적용됩니다.

바꾼 옵션은 Claude Code(또는 앱)를 다시 켜야 적용됩니다.

### Gemini로 번역하기 (선택)

본인의 [Gemini API 키](https://aistudio.google.com/apikey)가 있으면 Haiku 대신 Gemini로 번역합니다.

- 위의 옵션 창(터미널의 `/plugin configure thinking-ko@claude-thinking-ko`, VS Code의 톱니바퀴)에서 `gemini_api_key` 칸에 넣으세요. 입력한 키는 가려서 보이고, 컴퓨터의 보안 저장소에 따로 보관됩니다.
- 셸 명령에 키를 직접 쓰면(예: `--config gemini_api_key=…`) 셸 기록에 남으니 피하세요.
- 키를 빼려면 같은 칸을 비웁니다. 플러그인을 제거하면 저장된 키도 함께 지워집니다.
- 키는 **코드나 이 저장소에 절대 넣지 마세요.** 플러그인은 키를 URL이 아닌 `x-goog-api-key` 헤더로만 보내고 로그에 남기지 않습니다.

### 생각 요약 설정 (자동)

Claude Code는 `"showThinkingSummaries": true` 설정이 있어야 생각 글을 받아 옵니다. 이 설정이 없으면(특히 터미널은 기본값이 꺼짐) 생각이 빈 채로 와서 옮길 수 없습니다.

그래서 플러그인이 처음 켜질 때 이렇게 합니다.

- 어느 설정에도 이 값이 없으면 `~/.claude/settings.json`(Windows는 `%USERPROFILE%\.claude\settings.json`)을 `settings.json.thinking-ko.bak`로 백업한 뒤 `"showThinkingSummaries": true` 한 줄만 더하고, 알림을 한 번 띄웁니다.
- 직접 정해 둔 값은 `false`라도 그대로 둡니다. 파일이 JSON으로 읽히지 않으면 건드리지 않습니다.
- 자동으로 켜는 게 싫으면 `auto_thinking_summaries` 옵션을 끄고 위 한 줄을 직접 넣으세요. 한 번만 시험하려면 `claude --thinking-display summarized`로 실행해도 됩니다.

## 문제 해결

### 생각이 안 보여요

1. **로컬 세션인지** 확인하세요. 클라우드 세션에서는 동작하지 않습니다.
2. **생각이 필요한 질문인지** 확인하세요. 짧은 질문은 생각 없이 바로 답하기도 합니다.
3. 설치·업데이트 뒤 앱(또는 Claude Code)을 **완전히 껐다 켰는지** 확인하세요.
4. 입력창 위에 안내가 뜨면 따라 하세요.
   - "생각 요약이 꺼져 있어서…": `[생각 요약 켜기]`를 누르고 다시 켭니다.
   - "생각 요약은 켜져 있는데 생각이 비어서 와…": 앱이 예전에 정한 값이 남아 있는 경우입니다. 완전히 껐다 켭니다.
5. 그래도 안 되면 [로그](#로그-보기)를 확인하세요.

### 답변이 영어 그대로예요

- 쓰는 중인 답변은 원래 원문 그대로입니다. 다 쓰면 *옮기는 중..* 이 붙었다가 바뀝니다.
- 플러그인을 켜기 전에 오간 메시지는 새로 번역하지 않습니다(저장된 번역이 있을 때만 번역문으로 보임).
- *옮기는 중.. (재시도)* 를 거쳐 원문으로 돌아오면 번역 요청이 실패한 것입니다. 로그의 `fail` 줄을 확인하세요.

### (Windows) 앱에서 업데이트 버튼이 꺼져 있어요

앱이 새 버전을 받아 놓고도 제자리로 옮기지 못해 임시 폴더(`temp_git_…`)만 남는 경우가 있습니다. 앱을 **완전히 종료**(트레이 아이콘까지)한 뒤 PowerShell에서 아래를 실행하세요. thinking-ko의 임시 사본 중 가장 최근 것을 제자리로 옮기고 나머지 임시 사본은 지웁니다. 다른 마켓플레이스 폴더는 건드리지 않습니다.

```powershell
$m = "$HOME\.claude\plugins\marketplaces"
$temps = Get-ChildItem $m -Directory -Filter 'temp_git_*' | Where-Object { (Get-Content "$($_.FullName)\.claude-plugin\marketplace.json" -Raw -ErrorAction SilentlyContinue) -match '"claude-thinking-ko"' } | Sort-Object Name
if ($temps) {
  Remove-Item -Recurse -Force "$m\claude-thinking-ko" -ErrorAction SilentlyContinue
  Rename-Item $temps[-1].FullName 'claude-thinking-ko'
  $temps | Select-Object -SkipLast 1 | Remove-Item -Recurse -Force
}
(Get-Content "$m\claude-thinking-ko\.claude-plugin\plugin.json" -Raw | ConvertFrom-Json).version
```

마지막에 최신 버전 번호가 나오면, 앱을 켜고 **Manage plugins**에서 thinking-ko를 업데이트하세요. 그래도 버튼이 꺼져 있으면 thinking-ko만 제거했다가 다시 설치하세요(마켓플레이스는 지우지 마세요).

### 로그 보기

로그 파일: `~/.claude/thinking-ko/thinking-ko.log` (Windows는 `%USERPROFILE%\.claude\thinking-ko\thinking-ko.log`)

```powershell
Get-Content $HOME\.claude\thinking-ko\thinking-ko.log -Tail 30
```

| 이런 줄이 있으면 | 뜻 |
| --- | --- |
| `start backend=claude:haiku` | 플러그인이 켜졌습니다(번역기 Haiku). |
| `ok backend=… kind=thinking` / `kind=answer` | 생각·답변 번역이 됐습니다. |
| `render live-thinking site=UserMessage surface=desktop` | 앱에서 실시간 생각을 질문 아래에 그렸습니다(도구 뒤면 `site=ToolUse`·`ToolGroup`, 터미널은 `site=Spinner`). |
| `thinking arrived without text` | 생각이 글 없이 왔습니다(생각 요약 설정이 적용 안 됨). |
| `fail backend=…` | 번역 요청이 실패했습니다(`err=` 뒤에 이유). |

로그에는 원문·번역문·키가 들어가지 않습니다. 그래도 공개 이슈에 붙일 때는 한 번 훑어보세요.

## 동작 원리

### 화면만 바꿉니다

Claude Code의 플러그인(mod) API로 화면의 그리는 자리(render site)만 바꿉니다. 저장되는 대화 기록과 Claude에게 가는 요청은 그대로이고, 세션에 줄을 더하지도 않습니다. 그래서 **ctrl+o**(상세 보기)나 플러그인을 끈 화면에서는 원문이 보이고, Claude는 계속 원문을 기준으로 대화를 이어 갑니다.

### 답변

답변 블록을 그리는 자리(`AssistantMessage`)에서 그릴 글만 번역문으로 바꿉니다. 처음엔 원문을 그리고, 번역은 뒤에서 돌리고, 끝나면 다시 그립니다. 번역은 `메시지 id + 원문 해시` 기준으로 저장합니다.

### 생각

1. **읽기:** Claude Code에는 생각 블록을 그리는 자리가 없어서, 영어 생각 줄은 그대로 두고 번역을 다른 자리에 그립니다. 생각 글은 응답 스트림(`turn.step`)에서 읽기만 하고, 조각은 그대로 넘깁니다.
2. **문장 단위 번역:** 문단이 끝나거나, 끝난 문장이 40자 이상 모이면(뒤에 다음 문장이 이어질 때) 바로 번역을 맡깁니다. 원문의 문단·줄바꿈·띄어쓰기를 기억해 번역을 이어 붙입니다.
3. **생각 먼저:** 생각 블록이 끝나면 다음 조각(답변이나 도구 호출)을 최대 3초 붙잡아 그 생각의 번역을 기다린 뒤, 그대로 내보냅니다. 훅에 주어진 시간(응답당 10초) 중 4초는 늘 남겨 둡니다.
4. **그리는 자리:** 답변이 아직 안 나온 생각은 터미널에서는 진행 줄(`Spinner`) 위에 그립니다. 앱처럼 진행 줄을 한 줄로만 그리는 곳에서는 그 턴의 질문 줄(`UserMessage`)이나 마지막 도구 줄(`ToolUse`·`ToolGroup`) 아래에 그립니다. 그런 줄을 아직 못 찾았으면 입력창 위(`AbovePrompt`)에 잠깐 그립니다. 답변이 시작되면 그 답변 블록 위로 옮깁니다.
5. **생각 요약:** 요즘 Claude 모델은 생각 전문 대신 요약을 돌려주고, 화면의 영어 생각도 그 요약입니다. 이 플러그인도 그 요약을 옮깁니다. Claude Code는 `showThinkingSummaries`가 켜져 있을 때만 이 글을 받아 옵니다.

### 번역기와 안정장치

- 기본은 지금 쓰는 Claude Code 계정으로 Haiku를 부르고(`$.model.complete`), Gemini 키가 있으면 Gemini 공식 API(`generativelanguage.googleapis.com`)를 부릅니다(`$.http.fetch`).
- 원본 OMP 버전의 안정장치를 그대로 옮겼습니다.
  - 순서 보장 큐
  - 동시 요청 제한: 생각 2개, 답변 1개
  - 길이에 비례한 시간 제한: 12초 + 1000자마다 2.5초
  - 실패하면 1회 재시도: 60초 뒤, 또는 다른 번역이 성공한 직후
  - 대기 상한: 답변 8개, 생각 24개. 넘치면 가장 오래된 것을 원문으로 확정

## 한계

- **생각을 제자리에서 바꾸지는 못합니다.** 영어 생각 줄은 그대로 보이고, 한국어는 그 근처(질문·도구 줄 아래, 진행 줄 위, 답변 위)에 따로 보입니다.
- 메인 대화의 생각만 옮깁니다(서브에이전트 제외). 답변 없이 끝난 턴의 생각은 `/thinking-ko` 패널에서만 보이고, 패널은 세션을 다시 열면 비어 있습니다.
- 지난 메시지는 소급해서 번역하지 않습니다.
- 도구 사이의 글을 앱이 요약 줄로 보여 주면 그 요약을 번역합니다. 요약이 원래 글과 많이 다르면 생각 묶음이 그다음 답변 위에 붙을 수 있습니다.
- LLM 번역은 완벽하지 않습니다. 실행할 명령이나 중요한 수치는 원문과 대조하세요.
- Claude Code 플러그인 API는 아직 early access라 버전이 바뀌면 동작이 달라질 수 있습니다. Claude Code 2.1.296과 Claude 앱 로컬 세션에서 확인했습니다. VS Code 확장은 직접 확인하지 못했습니다.

## 개인정보·보안·비용

- 이 저장소에는 키, 토큰, 개인 설정, 대화 기록, 로그가 없습니다.
- 생각·답변 원문은 비밀값을 걸러 내지 않고 번역기로 보냅니다. Haiku는 내 Claude 계정으로, Gemini는 내 키로 Google에 보냅니다. 각 서비스의 약관·요금·데이터 정책을 따릅니다.
- 번역 요청은 생각은 문장 묶음마다, 답변은 블록마다 한 번씩 나갑니다(실패하면 재시도 한 번). 생각과 답변이 길고 잦을수록 사용량이 늘어납니다.
- 로그에는 상태, 글자 수, 걸린 시간, 오류 종류만 남깁니다(최근 500줄). 원문·번역문·키는 남기지 않고, 토큰처럼 생긴 문자열은 한 번 더 가립니다.
- 답변 번역문과 답변 위 생각 번역문은 플러그인 전용 저장소에 로컬로 저장됩니다(원문은 해시만).
- 설정 파일은 생각 요약을 켤 때 한 줄만 고치고, 고치기 전에 백업합니다.

## 개발자용

### 구조

```
.claude-plugin/plugin.json       플러그인 매니페스트(옵션 포함)
.claude-plugin/marketplace.json  이 저장소를 마켓플레이스로 쓰기 위한 파일
hooks/hooks.json                 훅 모듈 지정
hooks/register.tsx               훅 연결: ui.render(AssistantMessage·Spinner·UserMessage·ToolUse·ToolGroup·
                                 AbovePrompt·Pane), turn.start/step/complete, session.start/end, /thinking-ko 명령
hooks/core.ts                    $에 의존하지 않는 로직: 프롬프트, 큐, 슬롯, 시간 제한, 재시도, 정리
hooks/translators.ts             Haiku($.model.complete) / Gemini($.http.fetch) 요청·응답 처리
tests/*.test.ts                  claude plugin test용 테스트(모델·HTTP 모킹)
legacy/                          원래 OMP 확장과 테스트(변경 없음)
```

### 폴더에서 바로 실행

```sh
git clone https://github.com/esleeeeee/claude-thinking-ko
claude --plugin-dir ./claude-thinking-ko
```

- `--plugin-dir`은 그 세션에만 적용됩니다. 설치본과 함께 쓰지 마세요(번역 요청이 두 번 나갈 수 있음).
- 이때 옵션은 `~/.claude/settings.json`의 `pluginConfigs`에서 읽습니다(키 이름 `thinking-ko`, 안 되면 `thinking-ko@inline`). 키가 **평문으로** 저장되니 그 파일을 공유하거나 커밋하지 마세요.

  ```json
  { "pluginConfigs": { "thinking-ko": { "options": { "gemini_api_key": "여기에_키" } } } }
  ```

### 검증

```sh
claude plugin validate --strict .
claude plugin test .
```

원래 OMP 버전 테스트는 `legacy/`에서 `npm test`(Node.js 24)로 돌립니다.

### 로컬 확인 체크리스트

클라우드 세션에서는 플러그인 화면이 그려지지 않아, 아래는 직접 확인해야 합니다. 앱으로 설치했다면 3~13번을 앱의 로컬 세션에서 확인하면 됩니다.

1. `claude --version`이 2.1.287 이상인지 확인.
2. 저장소 폴더에서 `claude plugin validate --strict .`와 `claude plugin test .`가 통과하는지 확인.
3. `claude --plugin-dir /path/to/claude-thinking-ko`로 시작. `claude --debug` 로그에 thinking-ko 로드 오류(`ui.render (AssistantMessage) refused` 등)가 없는지 확인. `showThinkingSummaries`를 정해 둔 적이 없으면 알림이 뜨고, `settings.json`에 그 한 줄만 더해지고 `settings.json.thinking-ko.bak` 백업이 생기는지 확인. `false`로 정해 두었으면 그대로인지.
4. 영어로 답할 만한 질문(예: "Explain what a race condition is in two sentences, in English.")을 보내서:
   - 답변이 생성되는 동안은 원문 그대로인지
   - 다 쓰면 원문 끝에 *옮기는 중..* 이 붙는지
   - 잠시 뒤 반말 한국어로 바뀌는지, `햇어`·`잇어` 같은 틀린 표기가 없는지
5. 생각이 필요한 질문(예: "How many n < 1000 have n^2+1 divisible by 5 and n not divisible by 3? Think it through.")을 보내서:
   - 생각하는 **도중에** 한국어 생각이 문장 단위로 쌓이는지(터미널은 진행 줄 위, 앱은 질문 아래, 한 줄로 잘리지 않고 여러 줄)
   - 답변보다 한국어 생각이 먼저 보이는지, 답변이 나오면 그 위로 옮겨 붙는지
   - `▾ 접기`·`▸ 펼치기`가 되는지
   - `/thinking-ko`로 패널이 열리고 최근 생각 번역이 쌓이는지
6. 도구를 쓰는 작업(파일 읽기 등)을 시켜서, 생각이 도구 줄 아래로 따라가는지(앱), 도구 사이 글도 번역되는지, 화면이 깨지지 않는지 확인.
7. 코드 블록·경로·명령어·URL·숫자가 들어간 답변에서 그 부분이 그대로인지 확인.
8. **ctrl+o**(상세 보기)에 원문이 그대로 남는지, 다음 질문에서 Claude가 원문 기준으로 대화를 이어 가는지 확인(대화 기록 무변경).
9. 로그에 `start backend=claude:haiku`, `ok backend=… kind=thinking`, `ok backend=… kind=answer`가 생기고 원문·번역문이 없는지 확인.
10. 세션을 끝내고 `--continue`로 다시 열었을 때, 이전 답변과 그 위 생각이 요청 없이 저장된 번역으로 보이는지(로그에 새 `ok` 줄이 없는지) 확인.
11. (선택) Gemini: 키를 넣고 다시 켜서 로그에 `backend=gemini:gemini-flash-latest`가 찍히고 번역이 되는지 확인. 확인한 뒤 키를 지우세요.
12. (선택) 실패 경로: 없는 `claude_model`(예: `no-such-model`)을 넣고 다시 켜서 *옮기는 중.. (재시도)* 를 거쳐 원문으로 돌아오는지 확인.
13. 플러그인을 끄면 원문 표시로 돌아오는지, 다시 켜면 저장된 번역이 보이는지 확인. 전체화면·좁은 터미널에서 줄바꿈과 한글 폭이 깨지지 않는지도 확인.

## 출처·라이선스

- 원본: [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko) — MIT License, Copyright (c) 2026 hvvsdcm
- Claude Code 플러그인 포팅: esleeeeee
- 이 저장소도 [MIT License](LICENSE)입니다. Anthropic, Google, OMP의 공식 제품이 아닙니다.
