---
name: sillytavern-builder
description: >
  SillyTavern 확장(Extension), JS-Slash-Runner 스크립트, ST-Prompt-Template 작업을 비개발자 유저와 함께 설계·구현하는 빌드 가이드 스킬.
  다음 상황에서 반드시 이 스킬을 사용할 것:
  SillyTavern 확장 만들기, Extension 제작, JS-Slash-Runner 스크립트 작성,
  ST-Prompt-Template 템플릿 설정, LALib 슬래시 커맨드 활용,
  SillyTavern 커스터마이징 전반(월드인포 자동화, 캐릭터카드 동적 로직, 프롬프트 인젝션, UI 버튼/패널 추가 등).
  유저가 "SillyTavern", "실리타번", "ST", "주점", "酒馆", "실리태번" 등을 언급하며 기능 구현이나 자동화를 요청하면 이 스킬을 트리거할 것.
  Extension manifest.json, getContext(), eventSource, extensionSettings 등 ST Extension API에 대한 질문도 포함.
---

# SillyTavern Builder Skill

비개발자 유저가 원하는 기능을 자연어로 설명하면, Claude가 요구사항을 정리하고 최적의 구현 경로를 선택하여 빌드를 완성하는 스킬이다.

이 스킬은 **한국어와 영어** 이중 언어로 운용된다. 유저의 언어에 맞춰 응답하되, 코드 주석은 영어를 기본으로 한다.

---

## Step 0: 참조 문서 읽기 (매 세션 필수)

코드를 작성하기 전에, 아래 참조 문서들을 `web_fetch`로 읽어 최신 API/명령어를 확인한다. **절대 추측하지 말 것.**

### 필수 참조 (구현 시작 전 반드시 읽기)

| 문서 | URL | 용도 |
|------|-----|------|
| **ST 공식 Extension 가이드** | `https://docs.sillytavern.app/for-contributors/writing-extensions/` | Extension 개발 공식 문서 (manifest, getContext, events, state 등) |
| ST-Prompt-Template README | `https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/README.md` | EJS 템플릿, 변수 스코프, 인젝션 문법 |
| ST-Prompt-Template features | `https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/docs/features.md` | Content/Prompt Injection 상세 |
| ST-Prompt-Template reference | `https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/docs/reference.md` | 빌트인 함수 전체 목록 |
| LALib README | `https://raw.githubusercontent.com/LenAnderson/SillyTavern-LALib/master/README.md` | 슬래시 커맨드 라이브러리 |
| JS-Slash-Runner Guide | `https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/关于酒馆助手/介绍.html` | Runner 기능 범위·보안 |
| **ST getContext 소스** | `https://raw.githubusercontent.com/SillyTavern/SillyTavern/staging/public/scripts/st-context.js` | getContext() 반환값 전체 목록 |
| **ST events 소스** | `https://raw.githubusercontent.com/SillyTavern/SillyTavern/staging/public/scripts/events.js` | event_types 전체 목록 |

### Extension 구현 시 추가 참조

Extension 제작이 결정되면 아래도 읽는다:

| 문서 | URL | 용도 |
|------|-----|------|
| Extension 기본 예제 | `https://github.com/city-unit/st-extension-example` | manifest, settings UI, 설정 저장 패턴 |
| Webpack 번들링 템플릿 | `https://github.com/SillyTavern/Extension-WebpackTemplate` | TypeScript + Webpack 사용 시 |
| React 번들링 템플릿 | `https://github.com/SillyTavern/Extension-ReactTemplate` | React 사용 시 |

### 읽기 규칙

1. 구현에 필요한 문서만 선택적으로 읽는다 (전부 읽을 필요 없음).
2. 문서에 없는 함수명·이벤트명·API를 **절대 지어내지 않는다**.
3. 불확실하면 유저에게 파일 내용이나 GitHub 링크를 요청한다.
4. Extension 관련 상세 패턴은 이 스킬의 `references/extension-patterns.md`를 읽는다.

---

## Step 1: 요구사항 인터뷰

유저가 기능을 설명하면, 아래 순서로 **한 번에 1~3개 질문**만 한다. 모든 질문에 선택지를 제공하고, "잘 모르겠어요"도 유효한 답으로 수용한다.

### 질문 흐름

**(1) 목표 Goal**
- "어떤 문제를 해결하려는 건가요?"
- "성공하면 눈에 보이는 변화가 뭔가요?"

**(2) 트리거 Trigger**
- A. 버튼 클릭
- B. 슬래시 커맨드 (예: /something)
- C. 메시지 보내기 직전/직후
- D. AI 응답 생성 직후
- E. 특정 키워드/태그 등장 시
- F. 기타

**(3) 입력 Inputs**
- A. 현재 채팅 (최근 N턴)
- B. 캐릭터 데이터
- C. 월드인포
- D. 프리셋/설정
- E. 외부 텍스트/웹 데이터

**(4) 출력 Outputs**
- A. 채팅에 메시지 출력
- B. LLM에 보내는 프롬프트 수정/추가
- C. UI 표시 (패널/버튼/상태바)
- D. 데이터 저장 (요약/메모/상태)
- E. 기타

**(5) 설정 Settings**
- ON/OFF 토글 필요?
- 슬라이더 (길이/강도) 필요?
- 기본값은?

**(6) 저장 범위 Persistence**
- A. 이 채팅만 → chatMetadata
- B. 캐릭터별 → character card extensions field
- C. 전역 → extensionSettings
- D. 메시지(턴)별 → chat message extra field

**(7) 실패/엣지케이스**
- 실패 시 조용히? 경고 표시?
- 로그 필요?

**(8) 제약/보안**
- 모바일 지원?
- 외부로 보내면 안 되는 데이터?
- API 키/토큰 처리?

---

## Step 2: 구현 경로 결정 (Decision Phase)

요구사항이 대략 정리되면, **바로 코딩하지 말고** 아래 비교표를 유저에게 보여주고 선택을 받는다.

### 구현 단계 (Stages)

| Stage | 방법 | 언제 사용 |
|-------|------|-----------|
| **Stage 0** | ST-Prompt-Template만 | UI 불필요, 프롬프트 조건/변수/인젝션으로 해결 가능 |
| **Stage 1** | ST-Prompt-Template + LALib | 데이터 처리(루프/정규식/리스트 조작) 추가 필요 |
| **Stage 2** | + JS-Slash-Runner | 버튼/UI/이벤트 리스너/외부 연동 필요 |
| **Stage 3** | Full Extension | 배포 필요, 복잡한 UI, 설정 패널, 영구 저장, Runner로 부족 |

항상 **가장 낮은 Stage부터** 시도한다.

### Stage 결정 트리

```
기능이 프롬프트 조건/변수만으로 되는가?
├── YES → Stage 0
└── NO → 데이터 처리(루프/정규식)가 필요한가?
    ├── YES, LALib 커맨드로 충분 → Stage 1
    └── NO → DOM 조작/이벤트/외부 API가 필요한가?
        ├── YES, 단발성 → Stage 2 (JS-Slash-Runner)
        └── YES, 영구 설정/배포/복잡 UI → Stage 3 (Extension)
```

### Stage 3 (Extension) 선택 시 추가 결정

유저에게 아래를 제시한다:

| Option | 설명 | 추천 상황 |
|--------|------|-----------|
| **Option A: 바닐라 JS** | 번들러 없이 index.js + style.css | 단순한 기능, 외부 의존성 없음 |
| **Option B: Webpack 번들** | TypeScript/React/Vue 사용 가능 | 복잡한 UI, NPM 패키지 필요 |

대부분의 경우 **Option A**가 적합하다. 비개발자에게는 항상 Option A를 추천한다.

---

## Step 3: 기능 명세 작성 (Spec Phase)

유저가 경로를 확인한 후, 아래 템플릿으로 기능 명세를 작성하여 **유저에게 보여주고 확인받는다**.

```markdown
## 기능 명세 / Feature Spec

**이름**: [Extension/스크립트 이름]
**구현 방식**: Stage [0/1/2/3]
**트리거**: [언제 실행되는지]
**입력**: [어떤 데이터를 사용하는지]
**출력**: [눈에 보이는 결과]
**저장**: [어디에 무엇을 저장하는지]
**설정**: [ON/OFF, 슬라이더 등]
**의존성**: [ST-Prompt-Template / LALib / JS-Slash-Runner / 없음]

### 동작 흐름
1. ...
2. ...
3. ...

### 예상 파일 구조 (Stage 3인 경우)
extension-name/
├── manifest.json
├── index.js
├── style.css (선택)
└── settings.html (선택)
```

**확인 후에만 구현에 착수한다.**

---

## Step 4: 구현 (Build Phase)

### Stage 0~2: 스크립트 구현

- ST-Prompt-Template 문법은 참조 문서 확인 후 사용
- LALib 커맨드는 README에서 정확한 문법 확인
- JS-Slash-Runner 스크립트는 Step 5 보안 경고 후 진행

### Stage 3: Extension 구현

Extension 구현 시 반드시 `references/extension-patterns.md`를 읽고 아래 규칙을 따른다:

#### manifest.json 필수 필드

```json
{
    "display_name": "Extension Name",
    "loading_order": 1,
    "requires": [],
    "optional": [],
    "dependencies": [],
    "js": "index.js",
    "css": "style.css",
    "author": "Author Name",
    "version": "1.0.0",
    "homePage": "https://github.com/...",
    "auto_update": true
}
```

- `display_name`, `js`, `author`는 필수
- `loading_order`: 높을수록 나중에 로드
- `dependencies`: 다른 Extension 의존 시 폴더명으로 지정 (예: `"third-party/Extension-WebLLM"`)
- `generate_interceptor`: 텍스트 생성 가로채기 함수명 (선택)
- `minimum_client_version`: 최소 ST 버전 (선택)

#### index.js 기본 구조

```javascript
// Extension entry point
const MODULE_NAME = 'my_extension';

// Get context - 항상 이 패턴 사용 (import 대신)
const {
    extensionSettings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    getPresetManager,
} = SillyTavern.getContext();

// Default settings
const defaultSettings = Object.freeze({
    enabled: false,
});

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// Initialize
(function init() {
    const settings = getSettings();
    // Setup event listeners, UI, etc.
})();
```

#### 핵심 API 패턴

**상태 접근 (getContext)**:
```javascript
const ctx = SillyTavern.getContext();
ctx.chat;           // 채팅 로그 (MUTABLE)
ctx.characters;     // 캐릭터 목록
ctx.characterId;    // 현재 캐릭터 인덱스 (그룹/미선택 시 undefined!)
ctx.groups;         // 그룹 목록
ctx.groupId;        // 현재 그룹 ID
```

**이벤트 수신**:
```javascript
const { eventSource, event_types } = SillyTavern.getContext();
eventSource.on(event_types.MESSAGE_RECEIVED, (data) => { /* ... */ });
eventSource.on(event_types.CHAT_CHANGED, () => { /* ... */ });
eventSource.on(event_types.APP_READY, () => { /* 초기화 */ });
```

**주요 이벤트**:
- `APP_READY`: 앱 완전 로드 후 (초기화에 사용)
- `MESSAGE_RECEIVED`: LLM 메시지 생성 후 (렌더링 전)
- `MESSAGE_SENT`: 유저 메시지 전송 후 (렌더링 전)
- `CHARACTER_MESSAGE_RENDERED`: LLM 메시지 렌더링 완료
- `USER_MESSAGE_RENDERED`: 유저 메시지 렌더링 완료
- `CHAT_CHANGED`: 채팅 전환 시
- `GENERATION_AFTER_COMMANDS`: 생성 직전 (슬래시 커맨드 처리 후)
- `GENERATION_ENDED`: 생성 완료/에러

**텍스트 생성**:
```javascript
const { generateQuietPrompt, generateRaw } = SillyTavern.getContext();
// 채팅 컨텍스트 포함 (조용한 생성)
const result = await generateQuietPrompt({ quietPrompt: 'Summarize this chat.' });
// 원시 생성 (컨텍스트 없음)
const raw = await generateRaw({ prompt: 'Hello', systemPrompt: 'You are helpful.' });
```

**설정 저장**:
- 전역 설정: `extensionSettings[MODULE_NAME]` + `saveSettingsDebounced()`
- 채팅별: `chatMetadata['key']` + `saveMetadata()`
- 캐릭터별: `writeExtensionField(characterId, 'key', value)`

**공유 라이브러리**:
```javascript
const { DOMPurify, lodash, moment, Fuse, Handlebars, localforage } = SillyTavern.libs;
```

**사용자 알림**:
```javascript
toastr.success('완료!');
toastr.error('실패');
toastr.warning('주의');
// 확인 팝업
const { Popup } = SillyTavern.getContext();
const confirmed = await Popup.show.confirm('제목', '내용');
```

#### 슬래시 커맨드 등록

Extension에서 슬래시 커맨드를 등록할 때는 `SlashCommandParser.addCommandObject()` 사용:
```javascript
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'mycommand',
    callback: (namedArgs, unnamedArgs) => { /* ... */ },
    helpString: '<div>설명</div>',
    // namedArgumentList, unnamedArgumentList 등
}));
```

#### ST 내부 API를 통한 슬래시 커맨드 실행

Extension에서 프로그래밍 방식으로 슬래시 커맨드를 실행해야 할 때:

**중요**: ST 버전마다 함수명이 다를 수 있으므로, 확실하지 않으면 유저에게 확인을 요청한다:
> "SillyTavern의 `public/scripts/slash-commands.js` 파일에서 프로그래밍 방식으로 커맨드를 실행하는 함수명을 확인해주세요 (예: `executeSlashCommands` 등)."

#### Prompt Interceptor (생성 가로채기)

manifest.json에 `"generate_interceptor": "myInterceptor"` 추가 후:
```javascript
globalThis.myInterceptor = async function(chat, contextSize, abort, type) {
    // chat: 메시지 배열 (직접 수정 가능, 주의: mutable!)
    // contextSize: 토큰 수
    // abort(): 생성 중단
    // type: 'quiet', 'regenerate', 'impersonate', 'swipe' 등
};
```

#### 보안 주의사항

- API 키를 `extensionSettings`에 저장하지 말 것 (평문 저장됨)
- 유저 입력은 반드시 `DOMPurify.sanitize()` 처리
- `eval()`, `Function()` 사용 금지
- 큰 데이터는 `localforage` 사용 (extensionSettings은 메모리 상주)

---

## Step 5: 보안 경고 (JS-Slash-Runner 사용 시 필수)

JS-Slash-Runner는 **임의의 JavaScript 실행**이 가능하다. 유저에게 반드시 아래를 안내한다:

1. **스크립트 출처 신뢰성** 확인 — 모르는 사람의 스크립트는 위험하다
2. **스크립트 내용 검토** — 어떤 데이터를 보내고/저장하고/요청하는지
3. **영향 범위 이해** — API 키, 채팅 로그, 설정값에 접근 가능

이 경고는 **한 번 이상** 반드시 표시하고, 유저가 이해했음을 확인한 후 진행한다.

---

## Step 6: 테스트 & 디버깅 안내

### 유저에게 요청하는 방법 (비개발자 친화)

| 상황 | 요청 메시지 |
|------|-------------|
| **파일 내용 필요** | "정확한 안내를 위해 파일 하나만 확인하면 됩니다. Extension 폴더의 `manifest.json` 전체 내용을 복사해서 붙여넣어주세요." |
| **파일 링크 필요** | "GitHub 파일 페이지 링크를 보내주세요. (일반 링크도 괜찮아요.)" |
| **키워드 주변 확인** | "그 파일에서 '(키워드)'를 찾아서 위아래 1~2화면 정도 복사해주세요." |
| **에러 로그 필요** | "문제가 발생하면 브라우저 콘솔(F12)에 빨간 에러가 뜰 수 있어요. 복사하거나 스크린샷을 보내주세요. 그리고 재현 순서를 1~5단계로 적어주세요." |

### Extension 설치 확인 체크리스트

- [ ] Extension 폴더가 `data/<user-handle>/extensions/` 또는 `public/scripts/extensions/third-party/`에 있는가?
- [ ] 폴더명 대소문자가 맞는가?
- [ ] manifest.json의 js/css 파일명이 실제 파일명과 일치하는가?
- [ ] `display_name`이 manifest.json에 있는가?
- [ ] ST를 리로드했는가? (Extension 변경 후 필수)
- [ ] Extensions 패널에서 해당 Extension이 활성화되어 있는가?
- [ ] 브라우저 콘솔(F12)에 에러가 있는가?
- [ ] `dependencies`에 명시된 다른 Extension이 설치/활성화되어 있는가?

### 일반적인 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| Extension이 목록에 안 보임 | manifest.json 오류 또는 폴더 위치 | manifest 검증, 폴더 경로 확인 |
| 로드 후 아무 동작 안 함 | init 코드 에러 | F12 콘솔 확인, `console.log` 추가 |
| 설정이 저장 안 됨 | `saveSettingsDebounced()` 미호출 | 설정 변경 후 반드시 호출 |
| 이벤트가 안 잡힘 | 이벤트명 오타 또는 타이밍 | `event_types` enum 확인, `APP_READY` 후 등록 |
| `characterId` undefined | 그룹 채팅이거나 캐릭터 미선택 | null check 추가 |

---

## 기억해야 할 핵심 원칙

1. **최소 구현 우선**: Stage 0 → 1 → 2 → 3 순서로, 가장 간단한 방법부터 시도한다.
2. **추측 금지**: 문서에 없으면 만들어내지 않고, 유저에게 확인한다.
3. **getContext() 우선**: import보다 `SillyTavern.getContext()` 사용 (안정적).
4. **비개발자 배려**: 기술 용어에 설명 추가, 경로 안내는 단계별로.
5. **보안 우선**: JS 실행이 포함되면 반드시 경고한다. API 키는 extensionSettings에 저장 금지.
6. **확인 후 진행**: 기능 명세를 유저가 확인한 후에만 구현에 착수한다.
7. **이벤트 정리**: 이벤트 리스너 등록 시 cleanup 방법도 함께 안내.
