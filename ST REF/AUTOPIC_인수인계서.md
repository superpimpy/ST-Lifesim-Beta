# AUTOPIC.js 인수인계서

대상 파일: `/home/runner/work/Testtt/Testtt/ST REF/REF/AUTOPIC.js`

---

## 1) 파일 목적과 전반 구조

`AUTOPIC.js`는 SillyTavern 확장 구조를 기준으로, 응답 텍스트 내 이미지 생성 태그(`\<pic prompt="..."\>`)를 감지해 Stable Diffusion(`/sd`) 이미지 생성과 메시지 후처리를 수행하는 참조 구현입니다.

핵심 축은 아래 4가지입니다.

1. **모드 제어 (`INSERT_TYPE`)**
   - 비활성/삽입/치환 방식에 따라 저장 위치(`message.mes` vs `message.extra`)를 분기
2. **프롬프트 주입 (`CHAT_COMPLETION_PROMPT_READY`)**
   - 모델 호출 직전 시스템/딥 프롬프트에 이미지 태그 지시문 삽입
3. **자동 생성 트리거 (`MESSAGE_RECEIVED`)**
   - 생성된 답변에서 태그를 파싱해 실제 이미지 생성 실행
4. **후처리/UI 부착 (`MESSAGE_UPDATED`, `MESSAGE_RENDERED`)**
   - 메시지 갤러리 렌더링, 리롤 버튼/스와이프/태그 이미지 컨트롤 부착

---

## 2) 모드별 동작 방식

모드 상수는 아래와 같이 정의됩니다.

- `DISABLED: 'disabled'`
- `INLINE: 'inline'`
- `NEW_MESSAGE: 'new'`
- `REPLACE: 'replace'`

> 참고: 현재 코드에서는 `NEW_MESSAGE`가 **정의만 되어 있고 실제 분기에서 사용되지 않습니다.** 실 동작 모드는 `DISABLED`, `INLINE`, `REPLACE` 중심입니다.

### A. `DISABLED` (비활성)

- 자동 프롬프트 주입 차단
- `MESSAGE_RECEIVED` 자동 생성 루틴 진입 차단
- 토글 버튼은 `lastNonDisabledType`를 기억했다가 재활성 시 이전 모드 복구

즉, 확장 UI는 살아있어도 생성 파이프라인은 조기 `return`으로 멈춥니다.

### B. `INLINE` (메시지에 삽입/갤러리 방식)

핵심 원칙: **본문(`message.mes`)은 건드리지 않고**, 생성 결과를 `message.extra`에 적재합니다.

- 태그 파싱 후 이미지 생성 성공 시:
  - `message.extra.image_swipes.push(resultUrl)`
  - 마지막 결과를 `message.extra.image`에 반영
  - `message.extra.title`, `message.extra.inline_image = true` 반영
- `appendMediaToMessage(message, messageElement)`로 갤러리 UI 렌더링
- 이후 `updateMessageBlock` + `saveChat` + `MESSAGE_UPDATED/RENDERED` 이벤트 발행

**의도**
- 텍스트 원문 보존
- 이미지/텍스트 저장 영역 분리
- ST 기본 미디어 컨테이너(swipes, controls) 활용

### C. `REPLACE` (태그 치환 모드)

핵심 원칙: **본문의 태그를 실제 이미지 태그로 치환**합니다.

- `\<pic prompt="..."\>` 매치마다 생성 성공 시:
  - `data-autopic-id`를 가진 `\<img ...\>` 태그 문자열 생성
  - `updatedMes = updatedMes.replace(fullTag, newTag)`
- 루프 완료 후 `message.mes = updatedMes`
- `appendMediaToMessage`는 핵심 경로가 아니며, 본문 이미지 렌더링 기반

`data-autopic-id`는 후속 후처리(태그 이미지 전용 컨트롤 부착)의 식별자로 사용됩니다.

### D. `NEW_MESSAGE` (현재 미구현 상태)

- enum에는 있으나 실제 자동 생성/후처리 분기에서 사용되지 않음
- 향후 구현 시에는 `INLINE`/`REPLACE`와 충돌 없이 저장 스키마(`extra` vs `mes`)를 명확히 분리해야 함

---

## 3) 생성 파이프라인 상세 (이벤트 기준)

## 3-1. 사전 단계: 프롬프트 주입

이벤트: `CHAT_COMPLETION_PROMPT_READY`

1. `promptInjection.enabled` + `insertType !== DISABLED` 확인
2. `getFinalPrompt()` 호출
   - 캐릭터 링크 프리셋(`linkedPresets`) 적용
   - `{autopic_char1..6}` 플레이스홀더 치환
3. 설정(`position`, `depth`)에 따라 `eventData.chat`에 시스템 메시지 삽입

이 단계는 모델이 출력에 `\<pic prompt="..."\>`를 포함하도록 유도합니다.

## 3-2. 실행 단계: 태그 파싱 및 이미지 생성

이벤트: `MESSAGE_RECEIVED`

1. 비활성 모드면 중단
2. 최신 어시스턴트 메시지에서 regex로 태그 추출
   - 기본: `/\<pic[^>]*\sprompt="([^"]*)"[^>]*?>/g`
   - 사용자 regex 실패 시 기본값 fallback
3. 각 매치별 `/sd quiet=true` 호출 (`sdCallWithRescale`)
4. 모드별 저장/치환 분기 (`INLINE`/`REPLACE`)
5. 저장, 렌더 이벤트 재발행

---

## 4) 후처리 구조 (핵심)

`AUTOPIC.js`의 핵심은 **생성 이후 UI/메시지 일관성 유지**입니다.

### 4-1. 공통 후처리 트리거

이벤트: `MESSAGE_RENDERED`, `MESSAGE_UPDATED`

두 이벤트에서 공통적으로 실행:

1. `message.extra.title` 보정
   - `message.mes`의 `\<pic ...\>` 또는 `\<img title="..."\>`에서 title 추론
2. `addRerollButtonToMessage(mesId)`
   - ST 미디어 컨트롤 영역에 리롤 버튼 추가
3. `addMobileToggleToMessage(mesId)`
   - 모바일 UI 토글 버튼 부착
4. `attachSwipeRerollListeners(mesId)`
   - 스와이프 경계/카운터 클릭을 리롤 팝업으로 연결
5. `attachTagControls(mesId)`
   - 본문 이미지(`.mes_text img`)에 태그 전용 래퍼/컨트롤 부착

### 4-2. 태그 이미지 후처리 (`attachTagControls`)

대상 탐색: `.mes_text img`

판별 조건:
- `data-autopic-id`가 있거나,
- title 힌트(예: `Character`, `indoors`, `outdoors`, 다중 키워드) 기반으로 Autopic 생성 이미지로 추정

후처리:
- 이미지 래핑: `.autopic-tag-img-wrapper`
- 오버레이 컨트롤 삽입: `.autopic-tag-controls` + `.reroll-trigger`
- 클릭 시 `handleReroll`로 프롬프트 기반 재생성

### 4-3. 리롤 재생성(`handleReroll`) 분기

리롤 대상 수집 우선순위:
1. 본문 `\<pic ...\>`
2. 본문 `\<img ... title="..."\>`
3. `message.extra.image_swipes`

팝업에서 대상/프롬프트를 수정 후 재생성하며,
- `REPLACE` + 본문태그 대상이면 `message.mes` 치환
- 그 외(`INLINE` 포함)는 `message.extra.image_swipes` 갱신

마지막에 `updateMessageBlock` + `appendMediaToMessage` + `saveChat` + 이벤트 재발행으로 화면 동기화합니다.

---

## 5) CSS/렌더링 결합 포인트

이 파일은 실행 시점에 `#autopic-clean-ui-style` 스타일 태그를 동적으로 주입합니다.

주요 목적:
- `.mes_media_container`/`.mes_img_swipes`/`.mes_img_controls` 재배치
- 모바일에서 UI 노출 제어(`ui-active`)
- 태그 치환 이미지 스타일링:
  - `.mes_text img[data-autopic-id]`
  - `.autopic-tag-img-wrapper img`
- 태그 이미지 호버 시 컨트롤 노출

즉, **모드별 저장 방식 + CSS 선택자 + 후처리 부착 함수**가 함께 맞물려야 정상 동작합니다.

---

## 6) 데이터 저장 스키마 요약

- 본문 기반(치환): `message.mes` 내 `\<img data-autopic-id ...\>`
- 갤러리 기반(삽입):
  - `message.extra.image_swipes: string[]`
  - `message.extra.image: string` (대표 이미지)
  - `message.extra.title: string` (프롬프트/캡션)
  - `message.extra.inline_image: boolean`

운영 관점에서 중요한 점은, **REPLACE와 INLINE이 저장 계층이 다르기 때문에 후처리 진입점도 달라진다**는 것입니다.

---

## 7) 유지보수 시 주의사항

1. **모드별 저장 원칙 유지**
   - REPLACE만 `message.mes` 수정
   - INLINE은 `message.extra` 중심
2. **이모티콘/기타 img와 충돌 방지**
   - `data-autopic-id` 또는 안전한 식별 규칙 우선
   - 광범위한 `.mes_text img` 일괄 처리 시 오탐 주의
3. **이벤트 재발행 누락 금지**
   - 저장 후 `MESSAGE_UPDATED`, `MESSAGE_RENDERED`가 누락되면 컨트롤/미디어 UI 동기화가 깨짐
4. **`NEW_MESSAGE` 확장 시 명세 선행**
   - 현재 미사용 enum을 실제 동작으로 확장할 때는 저장 스키마와 렌더 규칙을 먼저 정의

---

## 8) 빠른 동작 추적 체크리스트

- 모드가 `DISABLED`인데도 이미지가 생성되는가? → early return 누락 확인
- `INLINE`인데 본문 태그가 치환되는가? → 잘못된 분기
- `REPLACE`인데 갤러리만 갱신되는가? → 본문 치환 누락
- 리롤 후 UI 버튼이 사라지는가? → `MESSAGE_UPDATED/RENDERED` 후처리 체인 확인
- 태그 이미지에만 컨트롤이 붙어야 하는데 일반 이모티콘에도 붙는가? → 식별 로직 재검토

