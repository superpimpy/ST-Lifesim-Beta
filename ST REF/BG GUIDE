# 백그라운드 처리 인수인계서

## 목적

`/sd quiet=true` 같은 호출이 일반 메시지 생성처럼 사용자 입력 흐름을 막거나, 사용자가 전면 생성과 같은 방식으로 중지할 수 있는 문제를 이해하고, SillyTavern 내부에서 이미 제공하는 **백그라운드성 처리 구조**를 재사용하는 방법을 정리한 문서입니다.

이 문서는 "무엇이 이미 구현되어 있는지", "어떤 매크로/슬래시 커맨드 조합을 써야 하는지", "완전히 분리된 백그라운드 작업이 필요한 경우 어디를 확장해야 하는지"를 빠르게 파악하는 데 목적이 있습니다.

## 핵심 요약

- **텍스트 계열 백그라운드 생성의 공용 진입점은 `generateQuietPrompt()` 입니다.**
  - 위치: `/home/runner/work/TESR/TESR/public/script.js`
  - 내부적으로 `Generate('quiet', generateOptions)`를 사용합니다.
- **`/sd quiet=true`는 현재 "생성을 별도 워커로 분리"하는 구조가 아니라, 생성 완료 후 채팅에 올리는 콜백을 비활성화하는 구조입니다.**
  - 위치: `/home/runner/work/TESR/TESR/public/scripts/extensions/stable-diffusion/index.js`
- **배경 변경은 별도 이벤트(`FORCE_SET_BACKGROUND`)를 통해 처리할 수 있습니다.**
  - 위치: `/home/runner/work/TESR/TESR/public/scripts/events.js`
  - 수신부: `/home/runner/work/TESR/TESR/public/scripts/backgrounds.js`
- **슬래시 커맨드/매크로 레벨에서는 `/gen lock=off`, `/genraw lock=off`, `||`, `{{pipe}}`, `/let` 조합이 백그라운드성 흐름을 만들 때 가장 재사용하기 쉽습니다.**

## 관련 파일과 역할

### 1. 백그라운드 텍스트 생성

- 파일: `/home/runner/work/TESR/TESR/public/script.js`
- 함수: `generateQuietPrompt({ ... })`

역할:

- 채팅 메시지를 직접 추가하지 않고 텍스트를 생성합니다.
- 호출자는 생성 결과 문자열만 받아서 후속 로직에 사용할 수 있습니다.
- 응답 길이, 캐릭터 ID 강제, JSON schema, reasoning 제거 같은 옵션도 함께 처리합니다.

핵심 코드:

```js
export async function generateQuietPrompt({ quietPrompt = '', quietToLoud = false, skipWIAN = false, quietImage = null, quietName = null, responseLength = null, forceChId = null, jsonSchema = null, removeReasoning = true, trimToSentence = false } = {}) {
    const generateOptions = {
        quiet_prompt: quietPrompt ?? '',
        quietToLoud: quietToLoud ?? false,
        skipWIAN: skipWIAN ?? false,
        force_name2: true,
        quietImage: quietImage ?? null,
        quietName: quietName ?? null,
        force_chid: forceChId ?? null,
        jsonSchema: jsonSchema ?? null,
    };

    let result = await Generate('quiet', generateOptions);
    return result;
}
```

이 함수를 쓰면 생성 결과를 채팅에 바로 노출하지 않고, 내부 계산/판단/후처리에 활용할 수 있습니다.

### 2. `/gen` / `/genraw` 슬래시 커맨드

- 파일: `/home/runner/work/TESR/TESR/public/scripts/slash-commands.js`

역할:

- `generateQuietPrompt()` 또는 raw generation을 슬래시 커맨드에서 재사용할 수 있게 감쌉니다.
- 결과를 채팅에 쓰는 대신 **파이프(`{{pipe}}`)로 다음 커맨드에 전달**합니다.
- `lock` 인자로 사용자 입력 잠금 여부를 제어할 수 있습니다.

핵심 포인트:

- `/gen`
  - chat history / character 문맥을 활용하는 quiet generation
  - `lock=off`로 사용자 입력 잠금 최소화 가능
- `/genraw`
  - chat history / character card 없이 raw generation
  - 백그라운드성 데이터 생성에 더 적합한 경우가 많음

관련 도움말 요약:

- `/gen`: "결과를 다음 커맨드에 pipe로 전달"
- `/genraw`: "채팅 이력/캐릭터 카드 없이 생성 후 pipe로 전달"

### 3. `/sd quiet=true`

- 파일: `/home/runner/work/TESR/TESR/public/scripts/extensions/stable-diffusion/index.js`

현재 동작:

```js
if (isTrueBoolean(args?.quiet)) {
    callback = () => { };
}
```

의미:

- 이미지 생성 자체를 별도 백그라운드 엔진으로 분리하는 것이 아닙니다.
- 생성이 끝났을 때 원래 하던 `sendMessage(...)` 경로를 타지 않게 만들어, **생성물을 채팅에 게시하지 않도록 하는 조치**입니다.

즉, `quiet=true`의 현재 의미는 아래에 더 가깝습니다.

- "조용히 생성하고 결과 게시를 생략한다"
- "완전히 분리된 작업 큐/워커에서 돈다"는 의미는 아님

### 4. 배경 교체 이벤트

같은 파일에서 배경 생성 타입은 다음 이벤트로 연결됩니다.

```js
await eventSource.emit(event_types.FORCE_SET_BACKGROUND, { url: imgUrl, path: imagePath });
```

이 이벤트는 `/home/runner/work/TESR/TESR/public/scripts/backgrounds.js`에서 받아 실제 배경 교체를 수행합니다.

따라서 **"이미지 생성"과 "채팅 게시"와 "배경 적용"은 분리된 관심사**로 이해하는 것이 중요합니다.

## 실무에서 권장하는 구조

### 1안: 텍스트 판단/가공은 `generateQuietPrompt()` 계열로 처리

권장 상황:

- UI에 메시지를 남기지 않고 내부 판단값만 필요할 때
- 요약, 분류, JSON 생성, 라우팅 결정, 제목 생성 등에 사용할 때

추천 구현:

- 프런트 확장 코드에서 `generateQuietPrompt()` 직접 호출
- 또는 STscript에서 `/gen lock=off` / `/genraw lock=off` 사용

장점:

- 결과를 문자열로 받아 후속 액션으로 연결하기 쉬움
- 채팅 오염이 적음
- 기존 슬래시 커맨드/매크로 파이프와 쉽게 결합됨

### 2안: 이미지 생성은 `/sd quiet=true` + 후속 액션 분리

권장 상황:

- 이미지는 만들되, 채팅에는 남기지 않고 다른 소비 경로로 보내고 싶을 때
- 예: 배경 교체, 외부 패널 표시, 별도 저장 처리

주의:

- 현재 `quiet=true`만으로는 "완전 비동기 백그라운드 워커"가 되지 않습니다.
- **채팅 게시를 생략하는 것**과 **생성 제어 자체를 분리하는 것**은 다른 문제입니다.

### 3안: 완전 분리된 백그라운드 처리 필요 시 확장 포인트

아래 요구가 있으면 현재 구조만으로는 부족할 수 있습니다.

- 사용자가 다른 생성 작업을 계속 진행해야 함
- `/stop`과 독립된 전용 중지/상태 관리가 필요함
- 여러 백그라운드 작업을 큐로 돌려야 함

그 경우 확장 포인트는 아래입니다.

1. **슬래시 커맨드 계층**
   - `/sd` 또는 신규 커맨드에서 "요청만 enqueue" 하도록 분리
2. **확장 계층**
   - `stable-diffusion` 확장 안에서 별도 작업 큐/상태 저장소 도입
3. **이벤트 계층**
   - 완료/실패/취소 이벤트를 `eventSource.emit(...)`로 분리
4. **UI 계층**
   - 일반 생성 stop 버튼과 분리된 상태 표시 UI 제공

즉, 지금 문맥에서 "백그라운드 처리"는 두 수준으로 구분해야 합니다.

- **기존 구조 재사용형 백그라운드 처리**
  - quiet generation
  - pipe 기반 후처리
  - chat posting 생략
- **진짜 분리 실행형 백그라운드 처리**
  - 작업 큐
  - 독립 abort controller
  - 독립 UI/상태 추적

## 매크로/STscript 구성 예시

아래 예시는 **현재 저장소에 이미 있는 슬래시 커맨드 구조**만 사용합니다.

### 예시 1. 내부 판단만 조용히 생성하고 다음 명령으로 전달

```stscript
/gen lock=off 다음 장면에 어울리는 배경 키워드를 한 단어로만 답해줘 || /echo {{pipe}}
```

의도:

- 생성 결과를 채팅 메시지로 남기지 않고
- 다음 명령에서 `{{pipe}}`로 받습니다.

### 예시 2. 생성 결과를 변수에 저장

```stscript
/genraw lock=off instruct=off JSON으로만 답해줘: {"mood":"...","location":"..."} || /let key=sceneMeta {{pipe}}
```

의도:

- raw quiet generation 결과를 변수에 저장
- 이후 다른 커맨드나 확장에서 재사용

### 예시 3. `/sd quiet=true`로 채팅 게시를 생략

```stscript
/sd quiet=true 야경이 보이는 네온 골목, 비 오는 분위기
```

의도:

- 이미지 생성은 수행하되
- 결과 이미지를 일반 chat message로 게시하지 않음

주의:

- 이 예시는 **"생성 완료 후 게시 생략"** 입니다.
- 사용자 입력/중지 제어까지 완전히 분리하는 구조는 아닙니다.

### 예시 4. 배경 후보 이름을 조용히 고른 뒤 `/bg`에 전달

이미 업로드된 배경 파일 중에서 LLM이 하나를 고르게 하고 싶다면 현재 구조상 아래 패턴이 더 안전합니다.

```stscript
/gen lock=off 현재 장면에 가장 맞는 배경 파일명만 답해줘 || /bg {{pipe}}
```

의도:

- 새 이미지를 생성하지 않고
- 기존 배경 자산 중 하나를 조용히 선택해서 적용

### 예시 5. 2단계 구조 권장안

가장 유지보수하기 쉬운 패턴은 아래입니다.

1. **quiet 텍스트 생성으로 의사결정**
2. **결정된 값으로 후속 커맨드 실행**

예:

```stscript
/gen lock=off 현재 대화 분위기를 한 단어 영어 키워드로만 답해줘 || /let key=bgKeyword {{pipe}}
```

그 다음:

- `{{var::bgKeyword}}`를 사용해 `/bg`, `/sd`, 또는 사용자 정의 확장으로 전달

## 확장 개발 시 권장 체크리스트

새 기능을 "백그라운드 처리처럼" 붙일 때는 아래 순서를 권장합니다.

1. **정말 필요한 것이 quiet generation인지, 진짜 분리 실행인지 먼저 구분**
2. 텍스트 결과만 필요하면 `generateQuietPrompt()` 우선 검토
3. 슬래시 커맨드로 엮을 수 있으면 `/gen` 또는 `/genraw` + `||` + `{{pipe}}` 우선 검토
4. 이미지 결과를 채팅에 숨기기만 하면 되면 `/sd quiet=true` 재사용
5. 이미지 결과를 배경으로 바로 적용하려면 `FORCE_SET_BACKGROUND` 이벤트 흐름 검토
6. 독립 중지/큐/상태표시가 필요하면 별도 작업 관리 구조 설계

## 현재 구조의 한계

이 문서를 보는 사람이 가장 많이 헷갈리는 지점은 아래입니다.

### `quiet=true` ≠ 진짜 백그라운드 워커

현재 `/sd quiet=true`는:

- 결과 게시를 생략하고
- 같은 확장 흐름 안에서 작업하며
- abort controller / stop 버튼과 같은 일반 생성 제어에 여전히 연결될 수 있습니다

따라서 아래 요구는 추가 구현이 필요합니다.

- 유저가 다른 생성과 완전히 병행
- 각 작업별 별도 진행률
- 일반 `/stop`과 별개인 취소

### 슬래시 커맨드의 `lock`은 UX 제어이지 작업 분리 그 자체는 아님

`/gen lock=off`는 사용자 입력 잠금을 줄이는 데 유용하지만, 이것만으로 별도 실행 큐가 생기지는 않습니다.

## 실무 판단 기준

- **문자열 결과만 필요하다**  
  → `generateQuietPrompt()` 또는 `/gen`, `/genraw`

- **이미지는 만들되 채팅에 남기고 싶지 않다**  
  → `/sd quiet=true`

- **생성 결과로 배경을 바꾸고 싶다**  
  → `FORCE_SET_BACKGROUND` 이벤트 흐름 또는 `/bg`

- **기존 생성과 완전히 독립된 작업으로 돌리고 싶다**  
  → 별도 큐/상태/취소 구조를 새로 설계

## 바로 확인할 코드 위치

- quiet text generation
  - `/home/runner/work/TESR/TESR/public/script.js`
- slash command generation wrappers
  - `/home/runner/work/TESR/TESR/public/scripts/slash-commands.js`
- SD quiet handling / background event emission
  - `/home/runner/work/TESR/TESR/public/scripts/extensions/stable-diffusion/index.js`
- background event consumer
  - `/home/runner/work/TESR/TESR/public/scripts/backgrounds.js`
- event names
  - `/home/runner/work/TESR/TESR/public/scripts/events.js`

## 결론

현 시점에서 저장소가 이미 제공하는 "백그라운드 처리 기법"의 핵심은 아래 두 가지입니다.

1. **`generateQuietPrompt()` 기반의 조용한 텍스트 생성**
2. **`/sd quiet=true`처럼 결과 게시를 분리하는 후처리 방식**

즉, 대부분의 기능은 **quiet generation + pipe + variable + event** 조합으로 구현할 수 있습니다.  
반대로 "일반 생성과 완전히 분리된 독립 작업"이 요구되면, 현재 구조를 그대로 쓰기보다는 **작업 큐/독립 취소/상태 이벤트**를 추가 설계하는 것이 맞습니다.
