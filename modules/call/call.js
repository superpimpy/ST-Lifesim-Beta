/**
 * call.js
 * 통화 & 통화기록 모듈
 * - AI 응답에서 통화 감지 키워드 탐지
 * - 유저가 직접 통화 시작 가능
 * - 통화 중 상단 배너 표시
 * - 통화 시작/종료 마커 삽입
 * - 종료 시 AI가 통화 내용 자동 요약
 * - 통화 기록 아카이브 관리
 * - 부재중 전화 연출
 */

import { getContext } from '../../utils/st-context.js';
import { slashSend, slashSendAs, slashGen } from '../../utils/slash.js';
import { loadData, saveData, getDefaultBinding, getExtensionSettings } from '../../utils/storage.js';
import { showToast, escapeHtml, generateId, showConfirm } from '../../utils/ui.js';
import { createPopup } from '../../utils/popup.js';
import { getContacts } from '../contacts/contacts.js';

const MODULE_KEY = 'call-logs';
const COLLAPSED_KEY = 'call-log-collapsed';

// 통화 감지 키워드 설정 저장 키
const KEYWORDS_KEY = 'call-keywords';

// char 측 통화 종료 감지 정규식 및 키워드
const EXPLICIT_CHAR_HANG_UP_RE = /(전화\s*(끊을게|끊겠어|끊어야|끊자|끊어도\s*될까|이만\s*끊을게|이만\s*끊겠어|끊어|끊어야\s*할|끊어야\s*겠어|끊을\s*게요|끊을\s*게|끊는다)|이만\s*(끊을게|끊겠어|끊어야|끊자|전화\s*끊)|통화\s*(끊을게|끊겠어|끊어야|끊자|종료할게|종료하겠어|종료한다)|그럼\s*(끊을게|끊겠어|끊자)|나\s*먼저\s*끊을게|먼저\s*끊을게|먼저\s*끊겠어|끊어야겠다|끊어야\s*될\s*것\s*같|끊을\s*수\s*밖에|I(?:'m| am)\s*hanging\s*up|gotta\s*(go|hang\s*up)|I\s*have\s*to\s*go\s*now|let\s*me\s*hang\s*up|I('ll|'d| will| would)\s*hang\s*up|bye\s+for\s+now|talk\s+later|hanging\s+up\s+now|I\s*need\s*to\s*hang\s*up|I('ll|'d| will| would)\s*let\s*you\s*go|got\s*to\s*go\s*now|gotta\s*run)/i;
const CHAR_HANG_UP_KEYWORDS = ['전화 끊', '끊을게', '끊겠어', '이만 끊', '통화 종료', '먼저 끊', '끊어야', '끊는다', '끊을 수', 'hang up', 'gotta go', 'have to go', 'talk later', 'bye for now', 'hanging up', 'let you go', 'gotta run', 'got to go'];

// 통화 중 컨텍스트 주입 태그
const CALL_INJECT_TAG = 'st-lifesim-call';
const CALL_POLICY_TAG = 'st-lifesim-call-policy';
const INCOMING_CALL_CONFIDENCE_THRESHOLD = 0.5;
const PROACTIVE_CALL_COOLDOWN_MS = 30000;
const PROACTIVE_CALL_DELAY_MS = 1600;
const PROACTIVE_CALL_AFTER_AI_DELAY_MS = 3000;
const PROACTIVE_CALL_DEFER_MAX_WAIT_MS = 45000;
const MODEL_KEY_BY_SOURCE = {
    openai: 'openai_model',
    claude: 'claude_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    mistralai: 'mistralai_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    chutes: 'chutes_model',
    siliconflow: 'siliconflow_model',
    electronhub: 'electronhub_model',
    nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model',
    aimlapi: 'aimlapi_model',
    xai: 'xai_model',
    pollinations: 'pollinations_model',
    cometapi: 'cometapi_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    azure_openai: 'azure_openai_model',
    custom: 'custom_model',
    zai: 'zai_model',
};

/**
 * 음성메세지 포맷: 텍스트 내 첫 번째 `<br>` 이후의 내용을 `**...**`로 감싸 이탤릭체 처리한다.
 * `<br>` 태그가 없으면 원본 텍스트를 그대로 반환한다.
 * @param {string} text - 포맷할 텍스트
 * @returns {string} `<br>` 뒤 내용이 `**`로 감싸진 텍스트
 */
function formatVoiceMsg(text) {
    if (!text.includes('<br>')) return text;
    const idx = text.indexOf('<br>');
    const before = text.slice(0, idx);
    const after = text.slice(idx + 4).trim();
    return after ? `${before}<br>**${after}**` : text;
}

/**
 * 한국어 주격 조사(이/가)를 이름 끝 글자의 받침 여부에 따라 선택한다.
 * @param {string} name
 * @returns {string} "이" 또는 "가"
 */
function pickParticle(name) {
    if (!name) return '이';
    const lastChar = name.charCodeAt(name.length - 1);
    // 한글 유니코드 범위: 0xAC00 ~ 0xD7A3
    if (lastChar >= 0xAC00 && lastChar <= 0xD7A3) {
        return (lastChar - 0xAC00) % 28 !== 0 ? '이' : '가';
    }
    return '이(가)';
}

// 통화 감지 키워드 (설정에서 변경 가능)
const DEFAULT_KEYWORDS = ['전화할게', '전화 걸게', '전화해도 돼', '전화 줄게', 'call', 'phone'];
const EXPLICIT_CHAR_CALL_INTENT_RE = /(지금\s*전화(할게|걸게)|곧\s*전화(할게|걸게)|I['’]m calling( you)? now|calling you now)/i;

// 통화 진행 중 상태
let callActive = false;

/**
 * 현재 통화 중인지 여부를 반환한다
 * @returns {boolean}
 */
export function isCallActive() {
    return callActive;
}
let callStartTime = null;
let callContact = '';
let callStartMessageIdx = -1; // 통화 시작 당시 채팅 메시지 인덱스
let callIsMainChar = true;   // 통화 상대가 {{char}}인지 여부
let isReinjectingCallMessage = false; // 비-char 통화 메시지 재주입 중복 방지
let lastIncomingCallCheckedIdx = -1;
let incomingCallUiOpen = false;
let lastProactiveCallAt = 0;
let proactiveCallPending = false;
let deferredProactiveCaller = '';
let deferredProactiveTimeoutId = 0;

function isCallModuleEnabled() {
    const ext = getExtensionSettings();
    const settings = ext?.['st-lifesim'];
    return settings?.enabled !== false && settings?.modules?.call !== false;
}

function getCallAudioSettings() {
    const audio = getExtensionSettings()?.['st-lifesim']?.callAudio || {};
    return {
        startSoundUrl: String(audio.startSoundUrl || '').trim(),
        endSoundUrl: String(audio.endSoundUrl || '').trim(),
        ringtoneUrl: String(audio.ringtoneUrl || '').trim(),
        vibrateOnIncoming: audio.vibrateOnIncoming === true,
    };
}

function playCustomSound(url, loop = false) {
    if (!url) return null;
    try {
        const audio = new Audio(url);
        audio.loop = loop;
        void audio.play().catch(() => {});
        return audio;
    } catch {
        return null;
    }
}

function getCallSummaryAiRouteSettings() {
    const route = getExtensionSettings()?.['st-lifesim']?.aiRoutes?.callSummary || {};
    return {
        api: String(route.api || '').trim(),
        chatSource: String(route.chatSource || '').trim(),
        modelSettingKey: String(route.modelSettingKey || '').trim(),
        model: String(route.model || '').trim(),
    };
}

/**
 * 설정에서 통화 요약 프롬프트를 가져온다
 * @param {string} contactName - 통화 상대 이름
 * @param {string} transcript - 통화 내용 텍스트
 * @returns {string}
 */
function buildCallSummaryPrompt(contactName, transcript) {
    const tmpl = getExtensionSettings()?.['st-lifesim']?.callSummaryPrompt;
    if (tmpl && tmpl.trim()) {
        return tmpl
            .replace(/\{contactName\}/g, contactName)
            .replace(/\{transcript\}/g, transcript);
    }
    return `The following is the conversation transcript from a call with ${contactName}. Write a concise 2-3 sentence summary IN KOREAN of what was discussed during the call. The summary must be written in Korean regardless of the conversation language. Character names may be kept as-is:\n${transcript}`;
}

/**
 * 설정에서 통화 시작 메시지 템플릿을 가져온다
 * @param {string} charName - 통화 상대 이름
 * @param {'incoming'|'outgoing'} direction
 * @returns {string}
 */
function getCallStartMessage(charName, direction) {
    const settings = getExtensionSettings()?.['st-lifesim']?.messageTemplates;
    if (direction === 'incoming') {
        const tmpl = settings?.callStart_incoming;
        if (tmpl) return tmpl.replace(/\{charName\}/g, charName);
        return `📞 ${charName}님께서 전화를 거셨습니다. {{user}}님께서 전화를 받으셨습니다.`;
    } else {
        const tmpl = settings?.callStart_outgoing;
        if (tmpl) return tmpl.replace(/\{charName\}/g, charName);
        return `📞 ${charName}님께 전화를 걸었습니다. ${charName}님께서 전화를 받으셨습니다.`;
    }
}

/**
 * 설정에서 통화 종료 메시지 템플릿을 가져온다
 * @param {string} timeStr - 통화 시간 문자열
 * @returns {string}
 */
function getCallEndMessage(timeStr) {
    const tmpl = getExtensionSettings()?.['st-lifesim']?.messageTemplates?.callEnd;
    if (tmpl) return tmpl.replace(/\{timeStr\}/g, timeStr);
    return `📵 통화 종료 (통화시간: ${timeStr})`;
}

/**
 * char가 통화를 종료했을 때의 메시지를 반환한다
 * @param {string} charName - 통화 상대 이름
 * @param {string} timeStr - 통화 시간 문자열
 * @returns {string}
 */
function getCallEndByCharMessage(charName, timeStr) {
    const p = pickParticle(charName);
    return `📵 ${charName}${p} 통화를 종료했습니다. (통화시간: ${timeStr})`;
}

function inferModelSettingKey(source) {
    return MODEL_KEY_BY_SOURCE[String(source || '').toLowerCase()] || '';
}

async function generateCallSummaryText(ctx, quietPrompt, quietName) {
    if (!ctx) return '';
    if (typeof ctx.generateRaw === 'function') {
        const aiRoute = getCallSummaryAiRouteSettings();
        const chatSettings = ctx.chatCompletionSettings;
        const sourceBefore = chatSettings?.chat_completion_source;
        let modelKey = '';
        let modelBefore;
        if (chatSettings && aiRoute.chatSource) {
            chatSettings.chat_completion_source = aiRoute.chatSource;
        }
        if (chatSettings) {
            modelKey = aiRoute.modelSettingKey || inferModelSettingKey(aiRoute.chatSource || sourceBefore);
            if (modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0) {
                modelBefore = chatSettings[modelKey];
                chatSettings[modelKey] = aiRoute.model;
            }
        }
        try {
            return (await ctx.generateRaw({
                prompt: quietPrompt,
                quietToLoud: false,
                trimNames: true,
                api: aiRoute.api || null,
            }) || '').trim();
        } finally {
            if (chatSettings && aiRoute.chatSource) {
                chatSettings.chat_completion_source = sourceBefore;
            }
            if (chatSettings && modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0) {
                chatSettings[modelKey] = modelBefore;
            }
        }
    }
    if (typeof ctx.generateQuietPrompt === 'function') {
        return (await ctx.generateQuietPrompt({ quietPrompt, quietName }) || '').trim();
    }
    return '';
}

/**
 * 통화 로그 데이터 불러오기
 * @returns {Object[]}
 */
function loadCallLogs() {
    const logs = loadData(MODULE_KEY, [], 'chat');
    if (!Array.isArray(logs)) return [];
    const chatMsgCount = getContext()?.chat?.length ?? 0;
    const sanitized = logs.filter((log) => {
        if (log?.missed) return true;
        if (typeof log?.startMessageIdx !== 'number' || typeof log?.endMessageIdx !== 'number') return false;
        if (log.startMessageIdx < 0 || log.endMessageIdx < log.startMessageIdx) return false;
        return log.endMessageIdx < chatMsgCount;
    });
    if (sanitized.length !== logs.length) saveCallLogs(sanitized);
    return sanitized;
}

/**
 * 통화 로그 저장
 * @param {Object[]} logs
 */
function saveCallLogs(logs) {
    saveData(MODULE_KEY, logs, 'chat');
}

function loadCollapsedState() {
    return loadData(COLLAPSED_KEY, {}, 'chat');
}

function saveCollapsedState(state) {
    saveData(COLLAPSED_KEY, state, 'chat');
}

/**
 * 비-char 통화 중 컨텍스트 주입
 * @param {string} charName - 통화 상대 이름
 * @param {Object|null} matchedContact - 연락처 정보
 */
function injectCallContext(charName, matchedContact) {
    const ctx = getContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;

    let prompt = `[ACTIVE PHONE CALL]\n{{user}}는 지금 ${charName}와(과) 전화 통화 중입니다. ${charName}는 {{char}}가 아닙니다.\n`;
    if (matchedContact?.personality) prompt += `${charName}의 성격: ${matchedContact.personality}\n`;
    if (matchedContact?.relationToUser) prompt += `${charName}의 {{user}}와의 관계: ${matchedContact.relationToUser}\n`;
    if (matchedContact?.description) prompt += `${charName} 설명: ${matchedContact.description}\n`;
    prompt += `중요: 이 전화 통화 동안 반드시 ${charName}로서만 응답하고, {{char}}로서는 응답하지 마십시오. 통화 내내 ${charName}의 프로필과 성격에 충실하게 유지하세요.`;

    ctx.setExtensionPrompt(CALL_INJECT_TAG, prompt, 1, 0);
}

/**
 * 통화 컨텍스트 주입 제거
 */
function clearCallContext() {
    const ctx = getContext();
    if (ctx && typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(CALL_INJECT_TAG, '', 1, 0);
    }
}

/**
 * 통화 모듈을 초기화한다 — AI 응답 감지 이벤트 리스너 등록
 */
export function initCall() {
    const ctx = getContext();
    if (!ctx || !ctx.eventSource) return;
    injectCallPolicyPrompt();

    const eventTypes = ctx.event_types || ctx.eventTypes;
    if (!eventTypes?.CHARACTER_MESSAGE_RENDERED) return;

    // AI 응답 완료 시 통화 키워드 감지 + 통화 중 char 종료 감지 + 비-char 통화 메시지 재주입
    ctx.eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async () => {
        if (!isCallModuleEnabled()) return;

        // 통화 중: char 측 통화 종료 감지
        if (callActive) {
            await detectCharCallTermination();
        }

        await detectCallKeywords();

        // 비-char 통화 중: AI 응답을 "전화" 이름으로 재주입
        if (callActive && !callIsMainChar && !isReinjectingCallMessage) {
            const freshCtx = getContext();
            if (!freshCtx) return;
            const lastMsg = freshCtx.chat?.[freshCtx.chat.length - 1];
            if (!lastMsg || lastMsg.is_user || lastMsg.name === '전화') return;

            const content = lastMsg.mes;
            const beforeSendLen = freshCtx.chat?.length ?? 0;

            isReinjectingCallMessage = true;
            try {
                await slashSendAs('전화', content);
                const latestIdx = (getContext()?.chat?.length ?? 1) - 1;
                const cutIdx = beforeSendLen > 0 ? Math.min(latestIdx - 1, beforeSendLen - 1) : -1;
                if (cutIdx >= 0) {
                    await freshCtx.executeSlashCommandsWithOptions(`/cut ${cutIdx}`, { showOutput: false });
                }
            } catch (e) {
                console.error('[ST-LifeSim] 통화 메시지 재주입 오류:', e);
            } finally {
                isReinjectingCallMessage = false;
            }
        }
    });
}

/**
 * 유저 메시지 전송 시 확률적으로 수신전화를 트리거한다
 * @param {number} probabilityPercent - 0~100
 * @param {{ deferUntilAiResponse?: boolean, force?: boolean }} [options] - AI 응답 완료 후 실행할지 여부/강제 실행 여부
 */
export async function triggerProactiveIncomingCall(probabilityPercent, options = {}) {
    if (callActive || incomingCallUiOpen || proactiveCallPending) return;
    const chance = Math.max(0, Math.min(100, Number(probabilityPercent) || 0)) / 100;
    const force = options?.force === true;
    if (!force && (chance <= 0 || Math.random() >= chance)) return;
    if (!force && Date.now() - lastProactiveCallAt < PROACTIVE_CALL_COOLDOWN_MS) return;
    const charName = getContext()?.name2;
    if (!charName) return;
    proactiveCallPending = true;
    lastProactiveCallAt = Date.now();
    try {
        if (options.deferUntilAiResponse) {
            deferredProactiveCaller = charName;
            if (deferredProactiveTimeoutId) {
                clearTimeout(deferredProactiveTimeoutId);
                deferredProactiveTimeoutId = 0;
            }
            deferredProactiveTimeoutId = window.setTimeout(() => {
                deferredProactiveCaller = '';
                proactiveCallPending = false;
                deferredProactiveTimeoutId = 0;
            }, PROACTIVE_CALL_DEFER_MAX_WAIT_MS);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, PROACTIVE_CALL_DELAY_MS));
        if (!isCallModuleEnabled()) return;
        if (callActive || incomingCallUiOpen) return;
        await showIncomingCallDialog(charName);
    } finally {
        if (!deferredProactiveCaller) proactiveCallPending = false;
    }
}

export function onCharacterMessageRenderedForProactiveCall() {
    if (!deferredProactiveCaller) return;
    const charName = deferredProactiveCaller;
    deferredProactiveCaller = '';
    if (deferredProactiveTimeoutId) {
        clearTimeout(deferredProactiveTimeoutId);
        deferredProactiveTimeoutId = 0;
    }
    setTimeout(async () => {
        try {
            if (!isCallModuleEnabled()) return;
            if (callActive || incomingCallUiOpen) return;
            await showIncomingCallDialog(charName);
        } finally {
            proactiveCallPending = false;
        }
    }, PROACTIVE_CALL_AFTER_AI_DELAY_MS);
}

function injectCallPolicyPrompt() {
    const ctx = getContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    const charName = ctx.name2 || '{{char}}';
    const prompt = `[PHONE CALL ROLEPLAY POLICY]
- Never assume an active phone call unless an explicit call-start marker appears in chat.
- Before a call starts, speak as normal chat text.
- If you want to call first, explicitly ask or state that you are calling now in a natural way, then wait for user action.
- Do not continue as if the call is already connected until the call is accepted.
- Make call initiation natural and context-driven (emotion, urgency, intimacy), not repetitive.
- During an active call: ${charName} CAN and SHOULD autonomously decide to end the call when it feels natural (e.g. the conversation reaches a natural conclusion, an emergency arises, ${charName} has other plans, emotional reasons, etc.). You do not need to wait for {{user}} to end the call.
- To end the call, explicitly say phrases like: "전화 끊을게", "이만 끊을게", "끊어야겠다", "I have to go", "gotta hang up", "I'll let you go", "talk later". The system will automatically detect these and terminate the call.
- IMPORTANT: Do not just say goodbye without using one of the explicit hang-up phrases above. The system needs these specific phrases to detect the call ending.
- Output format during a call: respond naturally as if speaking on the phone. Do not add narration brackets unless describing non-verbal context. Keep responses concise and conversational.`;
    ctx.setExtensionPrompt(CALL_POLICY_TAG, prompt, 1, 0);
}

/**
 * AI 응답에서 char 측 통화 종료 의도를 감지한다
 * - 명시적 정규식 매치 시 즉시 종료
 * - 키워드 매치 시 즉시 종료 (AI 분류 제거하여 반응 속도 향상)
 */
async function detectCharCallTermination() {
    if (!callActive) return;
    const ctx = getContext();
    if (!ctx) return;
    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;

    const text = String(lastMsg.mes || '');

    // 명시적 종료 패턴 즉시 감지
    if (EXPLICIT_CHAR_HANG_UP_RE.test(text)) {
        await endCallByChar();
        return;
    }

    // 키워드 기반 감지 — 매치되면 즉시 종료 (이전의 AI 분류 단계를 제거하여 신뢰성 향상)
    const lower = text.toLowerCase();
    const found = CHAR_HANG_UP_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    if (found) {
        await endCallByChar();
    }
}

/**
 * AI 응답 텍스트에서 통화 키워드를 감지한다
 */
async function detectCallKeywords() {
    if (callActive || incomingCallUiOpen) return; // 이미 통화 중이면 무시

    // 마지막 AI 메시지 텍스트 가져오기
    const ctx = getContext();
    if (!ctx) return;
    const msgIdx = (ctx.chat?.length ?? 1) - 1;
    if (msgIdx <= lastIncomingCallCheckedIdx) return;
    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;
    lastIncomingCallCheckedIdx = msgIdx;

    const text = (lastMsg.mes || '').toLowerCase();
    const keywords = [
        ...loadData(KEYWORDS_KEY, DEFAULT_KEYWORDS, getDefaultBinding()),
        '전화 받', '전화를 받을', 'call me', 'calling you', 'pick up', 'answer the phone', 'ringing',
    ];
    const found = keywords.some(kw => text.includes(String(kw).toLowerCase()));
    if (!found) return;

    const intent = await classifyIncomingCallIntent(lastMsg.mes || '');
    if (!intent.incoming) return;

    const charName = ctx?.name2 || '{{char}}';
    await showIncomingCallDialog(charName);
}

async function classifyIncomingCallIntent(messageText) {
    if (EXPLICIT_CHAR_CALL_INTENT_RE.test(String(messageText || ''))) {
        return { incoming: true };
    }
    const ctx = getContext();
    const fallback = {
        incoming: /(전화할게|전화 걸게|calling you|pick up|answer)/i.test(messageText),
    };
    if (!ctx || typeof ctx.generateQuietPrompt !== 'function') return fallback;

    const prompt = `You are classifying an assistant message for phone-call intent.
Message:
"""${messageText}"""

Return JSON only:
{"incoming_call":true|false,"confidence":0.0-1.0}

Set incoming_call=true ONLY when the message clearly means "the caller is calling now and user should pick up/accept/reject".
Set false for hypothetical talk, future planning, roleplay narration of an already-active call, or vague mention of phone/call.
No prose, no markdown, JSON only.`;
    try {
        const raw = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: 'call-intent' }) || '';
        const jsonPart = raw.match(/\{[\s\S]*\}/)?.[0];
        if (!jsonPart) return fallback;
        const parsed = JSON.parse(jsonPart);
        return { incoming: !!parsed.incoming_call && Number(parsed.confidence || 0) >= INCOMING_CALL_CONFIDENCE_THRESHOLD };
    } catch {
        return fallback;
    }
}

async function showIncomingCallDialog(charName) {
    if (incomingCallUiOpen) return;
    incomingCallUiOpen = true;
    const displayName = getDisplayNameForContact(charName);

    const existing = document.getElementById('slm-incoming-call-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'slm-incoming-call-overlay';
    overlay.className = 'slm-incoming-call-overlay';

    const card = document.createElement('div');
    card.className = 'slm-incoming-call-card';
    const title = document.createElement('div');
    title.className = 'slm-incoming-call-title';
    title.textContent = '📲 수신 전화';
    const caller = document.createElement('div');
    caller.className = 'slm-incoming-call-caller';
    caller.textContent = displayName;

    const row = document.createElement('div');
    row.className = 'slm-incoming-call-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'slm-btn slm-btn-primary';
    acceptBtn.textContent = '✅ 수락';
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'slm-btn slm-btn-danger';
    rejectBtn.textContent = '❌ 거절';
    const missedBtn = document.createElement('button');
    missedBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm slm-missed-call-btn';
    missedBtn.textContent = '📵 부재중';
    missedBtn.title = '부재중 처리 후 AI 반응 유도';
    row.append(acceptBtn, rejectBtn);

    card.append(title, caller, row, missedBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const callAudio = getCallAudioSettings();
    const ringtone = playCustomSound(callAudio.ringtoneUrl, true);
    // 진동을 반복적으로 실행하여 유저가 수락/거절/부재중 중 하나를 선택할 때까지 유지
    let vibrateIntervalId = 0;
    if (callAudio.vibrateOnIncoming && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        // 패턴: 200ms 진동 → 100ms 대기 → 200ms 진동 → 800ms 대기 = 1300ms 한 사이클
        const vibratePattern = [200, 100, 200, 800];
        navigator.vibrate(vibratePattern);
        // 한 사이클의 총 시간(ms)을 계산하여 사이클이 끝날 때마다 반복 실행
        const patternDuration = vibratePattern.reduce((a, b) => a + b, 0);
        vibrateIntervalId = window.setInterval(() => {
            navigator.vibrate(vibratePattern);
        }, patternDuration);
    }

    const cleanup = () => {
        if (ringtone) {
            ringtone.pause();
            ringtone.currentTime = 0;
        }
        // 진동 중지
        if (vibrateIntervalId) {
            clearInterval(vibrateIntervalId);
            vibrateIntervalId = 0;
        }
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(0);
        }
        overlay.remove();
        incomingCallUiOpen = false;
    };

    acceptBtn.onclick = async () => {
        cleanup();
        const matchedContact = getContacts('chat').find(c => c.name === charName) || null;
        await startCall(charName, matchedContact, 'incoming');
        const recentDialogue = buildRecentDialogueLines(5);
        await slashGen(
            `You just connected a phone call with {{user}}. Start the call naturally with one short opening utterance. Do not narrate that the call was already active before this moment. Base your response on the latest five dialogue lines when relevant.\n${recentDialogue ? `Latest 5 dialogue lines:\n${recentDialogue}` : ''}`,
            charName,
        );
    };

    rejectBtn.onclick = async () => {
        cleanup();
        await slashSend(`📵 수신 거절 — ${displayName}`);
        appendMissedCallLog(displayName, '수신 거절');
        await slashGen(
            `${charName}'s call was rejected by {{user}}. Generate one short follow-up reaction as a normal chat message.`,
            charName,
        );
    };

    missedBtn.onclick = async () => {
        cleanup();
        await slashSend(`📵 부재중 전화 — ${displayName}`);
        appendMissedCallLog(displayName, '부재중');
        await slashGen(
            `${charName} called {{user}} but {{user}} didn't answer. ${charName} noticed the missed call. Generate one short natural follow-up reaction (e.g. a text message or leaving a voicemail comment) as ${charName}.`,
            charName,
        );
    };

}

function getDisplayNameForContact(name) {
    const contact = [...getContacts('chat'), ...getContacts('character')].find(c => c?.name === name);
    return contact?.displayName || name;
}

function appendMissedCallLog(charName, summary) {
    const logs = loadCallLogs();
    logs.push({
        id: generateId(),
        contactName: charName,
        date: new Date().toISOString(),
        durationSeconds: 0,
        summary,
        startMessageIdx: -1,
        endMessageIdx: -1,
        includeInContext: false,
        missed: true,
        binding: getDefaultBinding(),
    });
    saveCallLogs(logs);
}

/**
 * 통화 중 상단 배너를 표시한다
 * @param {string} charName
 */
function showCallBanner(charName) {
    let banner = document.getElementById('slm-call-banner');
    if (banner) banner.remove();

    banner = document.createElement('div');
    banner.id = 'slm-call-banner';

    const textEl = document.createElement('span');
    textEl.id = 'slm-call-banner-text';
    textEl.textContent = `📞 통화 중... ${charName}`;

    const endBtn = document.createElement('button');
    endBtn.id = 'slm-call-banner-end';
    endBtn.textContent = '📵 통화 종료';
    endBtn.onclick = () => endCall();

    banner.appendChild(textEl);
    banner.appendChild(endBtn);
    document.body.appendChild(banner);

    // 배너 시간 업데이트 (통화 경과 시간)
    const timer = setInterval(() => {
        if (!callActive) { clearInterval(timer); return; }
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        textEl.textContent = `📞 통화 중... ${charName}  (${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')})`;
    }, 1000);
}

/**
 * 통화 중 배너를 제거한다
 */
function removeCallBanner() {
    const banner = document.getElementById('slm-call-banner');
    if (banner) banner.remove();
}

/**
 * 통화를 시작한다
 * @param {string} charName - 통화 상대 이름
 * @param {Object|null} [matchedContact] - 연락처 정보 (비-char 통화 시 컨텍스트 주입용)
 */
function buildRecentDialogueLines(limit = 5) {
    const chat = getContext()?.chat || [];
    return chat
        .slice(Math.max(0, chat.length - limit))
        .map((msg) => `${msg?.is_user ? '{{user}}' : (msg?.name || '{{char}}')}: ${String(msg?.mes || '').replace(/\s+/g, ' ').trim()}`)
        .filter((line) => line.length > 0)
        .join('\n');
}

async function startCall(charName, matchedContact = null, direction = 'outgoing') {
    if (callActive) return;

    const ctx = getContext();
    const activeChar = ctx?.name2 || '{{char}}';
    const isMainChar = charName === activeChar;

    callActive = true;
    callIsMainChar = isMainChar;
    callStartTime = Date.now();
    callContact = charName;

    // 통화 시작 안내 메시지가 삽입되는 인덱스부터 통화 구간으로 기록
    callStartMessageIdx = Math.max(0, (ctx?.chat?.length ?? 0));

    // 비-char 통화 시 컨텍스트 주입
    if (!isMainChar) {
        injectCallContext(charName, matchedContact);
    }

    try {
        const startMessage = getCallStartMessage(charName, direction);
        if (isMainChar) {
            await slashSend(formatVoiceMsg(startMessage));
        } else {
            await slashSendAs('전화', formatVoiceMsg(startMessage));
        }
    } catch (e) {
        console.error('[ST-LifeSim] 통화 시작 오류:', e);
    }

    // 상단 배너 표시
    showCallBanner(charName);
    playCustomSound(getCallAudioSettings().startSoundUrl);

    showToast(`통화 시작: ${charName}`, 'info');
}

/**
 * 통화를 종료하고 AI 요약을 생성한다
 */
async function endCall() {
    if (!callActive) return;

    const duration = Math.floor((Date.now() - callStartTime) / 1000);
    const m = Math.floor(duration / 60);
    const s = duration % 60;
    const timeStr = `${String(m).padStart(2, '0')}분 ${String(s).padStart(2, '0')}초`;

    callActive = false;
    const endedContact = callContact;
    const startIdx = callStartMessageIdx;
    const wasMainChar = callIsMainChar;
    callStartTime = null;
    callContact = '';
    callStartMessageIdx = -1;
    callIsMainChar = true;

    // 비-char 통화 컨텍스트 주입 제거
    if (!wasMainChar) {
        clearCallContext();
    }

    // 상단 배너 제거
    removeCallBanner();
    playCustomSound(getCallAudioSettings().endSoundUrl);

    // 통화 종료 메시지 삽입
    const ctx = getContext();

    try {
        const endMessage = getCallEndMessage(timeStr);
        if (wasMainChar) {
            await slashSend(formatVoiceMsg(endMessage));
        } else {
            await slashSendAs('전화', formatVoiceMsg(endMessage));
        }
    } catch (e) {
        console.error('[ST-LifeSim] 통화 종료 오류:', e);
    }
    const endIdx = ((getContext()?.chat?.length ?? 1) - 1);

    // AI가 통화 내용 요약 생성 (채팅창에 보이지 않는 조용한 생성)
    let summary = '';
    try {
        const chatLen = ctx?.chat?.length ?? 0;
        const startFrom = Math.max(0, startIdx);
        const callMsgs = ctx?.chat?.slice(startFrom, chatLen) ?? [];
        if (callMsgs.length > 0) {
            const msgText = callMsgs.map(m => `${m.is_user ? '{{user}}' : m.name}: ${m.mes}`).join('\n');
            const summaryPrompt = buildCallSummaryPrompt(endedContact, msgText);
            summary = await generateCallSummaryText(ctx, summaryPrompt, endedContact);
        }
    } catch (e) {
        console.error('[ST-LifeSim] 통화 요약 생성 오류:', e);
        showToast('통화 요약 생성 실패 (기록은 저장됩니다)', 'warn', 2500);
    }

    // 통화 기록 저장
    const logs = loadCallLogs();
    logs.push({
        id: generateId(),
        contactName: endedContact,
        date: new Date().toISOString(),
        durationSeconds: duration,
        summary,
        startMessageIdx: startIdx,
        endMessageIdx: endIdx,
        includeInContext: false,
        binding: getDefaultBinding(),
    });
    saveCallLogs(logs);

    showToast(`통화 종료 (${timeStr})`, 'success');
}

/**
 * char가 자율적으로 통화를 종료할 때 호출된다.
 * - 배너를 "char가 통화를 종료했습니다" 텍스트로 전환 후 제거
 * - 통화 종료 메시지에 char가 끊었음을 명시
 */
async function endCallByChar() {
    if (!callActive) return;

    const duration = Math.floor((Date.now() - callStartTime) / 1000);
    const m = Math.floor(duration / 60);
    const s = duration % 60;
    const timeStr = `${String(m).padStart(2, '0')}분 ${String(s).padStart(2, '0')}초`;

    const endedContact = callContact;
    const startIdx = callStartMessageIdx;
    const wasMainChar = callIsMainChar;

    callActive = false;
    callStartTime = null;
    callContact = '';
    callStartMessageIdx = -1;
    callIsMainChar = true;

    // 비-char 통화 컨텍스트 주입 제거
    if (!wasMainChar) {
        clearCallContext();
    }

    // 배너를 "상대방이 통화를 종료했습니다" 텍스트로 업데이트 후 제거
    const banner = document.getElementById('slm-call-banner');
    if (banner) {
        const textEl = banner.querySelector('#slm-call-banner-text');
        const endBtn = banner.querySelector('#slm-call-banner-end');
        if (textEl) textEl.textContent = `📵 ${endedContact}${pickParticle(endedContact)} 통화를 종료했습니다.`;
        if (endBtn) endBtn.remove();
        setTimeout(() => removeCallBanner(), 3000);
    }
    playCustomSound(getCallAudioSettings().endSoundUrl);

    // 통화 종료 메시지 삽입 (char가 끊었음을 명시)
    const ctx = getContext();
    try {
        const endMessage = getCallEndByCharMessage(endedContact, timeStr);
        if (wasMainChar) {
            await slashSend(formatVoiceMsg(endMessage));
        } else {
            await slashSendAs('전화', formatVoiceMsg(endMessage));
        }
    } catch (e) {
        console.error('[ST-LifeSim] 통화 종료 오류:', e);
    }
    const endIdx = ((getContext()?.chat?.length ?? 1) - 1);

    // AI가 통화 내용 요약 생성
    let summary = '';
    try {
        const chatLen = ctx?.chat?.length ?? 0;
        const startFrom = Math.max(0, startIdx);
        const callMsgs = ctx?.chat?.slice(startFrom, chatLen) ?? [];
        if (callMsgs.length > 0) {
            const msgText = callMsgs.map(msg => `${msg.is_user ? '{{user}}' : msg.name}: ${msg.mes}`).join('\n');
            const summaryPrompt = buildCallSummaryPrompt(endedContact, msgText);
            summary = await generateCallSummaryText(ctx, summaryPrompt, endedContact);
        }
    } catch (e) {
        console.error('[ST-LifeSim] 통화 요약 생성 오류:', e);
        showToast('통화 요약 생성 실패 (기록은 저장됩니다)', 'warn', 2500);
    }

    // 통화 기록 저장
    const logs = loadCallLogs();
    logs.push({
        id: generateId(),
        contactName: endedContact,
        date: new Date().toISOString(),
        durationSeconds: duration,
        summary,
        startMessageIdx: startIdx,
        endMessageIdx: endIdx,
        includeInContext: false,
        binding: getDefaultBinding(),
    });
    saveCallLogs(logs);

    showToast(`${endedContact}${pickParticle(endedContact)} 통화를 종료했습니다. (${timeStr})`, 'info', 3000);
}

/**
 * 발신 시 AI가 착신/거부를 결정한다
 * 거부 시 부재중 처리, 착신 시 통화 시작
 * @param {string} charName
 */
async function initiateCallWithAiDecision(charName) {
    const ctx = getContext();
    const activeChar = ctx?.name2 || '{{char}}';
    const isMainChar = charName === activeChar;
    const matchedContact = getContacts('chat').find(c => c.name === charName);

    // 발신 중 메시지 삽입
    try {
        if (isMainChar) {
            await slashSend(`📱 ${charName}님께 전화를 거는 중입니다.`);
        } else {
            await slashSendAs(charName, '📱 {{user}}님께서 전화를 거는 중입니다.');
        }
    } catch (e) {
        console.error('[ST-LifeSim] 발신 메시지 오류:', e);
    }

    // AI에게 착신 여부를 결정하게 한다
    let acceptCall = true;
    try {
        if (ctx && typeof ctx.generateQuietPrompt === 'function') {
            const userName = ctx.name1 || 'the user';
            const decisionPrompt = buildCallDecisionPrompt({
                charName,
                userName,
                isMainChar,
                matchedContact,
                activeChar,
            });
            const decision = await ctx.generateQuietPrompt({ quietPrompt: decisionPrompt, quietName: charName }) || 'ACCEPT';
            acceptCall = !decision.toUpperCase().includes('REJECT');
        }
    } catch (e) {
        console.error('[ST-LifeSim] 착신 결정 오류:', e);
    }

    if (!acceptCall) {
        // 거부: 부재중 처리
        try {
            await slashSend(`📵 부재중 전화 — ${charName} (착신 거부)`);
        } catch (e) {
            console.error('[ST-LifeSim] 착신 거부 메시지 오류:', e);
        }
        // 부재중 로그 저장
        const logs = loadCallLogs();
        logs.push({
            id: generateId(),
            contactName: charName,
            date: new Date().toISOString(),
            durationSeconds: 0,
            summary: '착신 거부',
            startMessageIdx: -1,
            endMessageIdx: -1,
            includeInContext: false,
            missed: true,
            binding: getDefaultBinding(),
        });
        saveCallLogs(logs);
        showToast(`${charName}이(가) 전화를 거부했습니다.`, 'warn', 3000);
    } else {
        // 착신 수락: 통화 시작 (matchedContact 전달)
        await startCall(charName, matchedContact, 'outgoing');
    }
}

function buildCallDecisionPrompt({ charName, userName, isMainChar, matchedContact, activeChar }) {
    if (isMainChar) {
        return `${charName} is receiving a phone call from ${userName}. Decide whether to ACCEPT or REJECT based on context, mood, and personality. Rules: output only one word ("ACCEPT" or "REJECT"), avoid neutral/extra text, and be decisive.`;
    }
    const personality = matchedContact?.personality ? ` Personality: ${matchedContact.personality}.` : '';
    const relation = matchedContact?.relationToUser ? ` Relationship to {{user}}: ${matchedContact.relationToUser}.` : '';
    return `${charName} is NOT {{char}}. ${charName} is a contact of {{user}}.${personality}${relation} Decide if ${charName} accepts the incoming call from ${userName}. If ${activeChar} is mentioned, refer to ${activeChar} indirectly. Reply with only one word: "ACCEPT" or "REJECT".`;
}

export async function requestActiveCharacterCall() {
    const ctx = getContext();
    const charName = String(ctx?.name2 || '').trim();
    if (!charName) {
        showToast('통화할 캐릭터를 찾을 수 없습니다.', 'warn', 1800);
        return;
    }
    await initiateCallWithAiDecision(charName);
}


export function openCallLogsPopup(onBack) {
    const content = buildCallLogsContent();
    createPopup({
        id: 'call-logs',
        title: '📞 통화기록',
        content,
        className: 'slm-call-panel',
        onBack,
    });
}

/**
 * 통화 기록 팝업 내용을 빌드한다
 * @returns {HTMLElement}
 */
function buildCallLogsContent() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-call-wrapper';

    // 직접 전화 걸기 섹션
    const dialSection = document.createElement('div');
    dialSection.className = 'slm-dial-wrapper slm-form';

    const dialTitle = document.createElement('h4');
    dialTitle.style.cssText = 'margin:0 0 8px;font-size:14px;font-weight:600;color:var(--slm-text)';
    dialTitle.textContent = '📲 전화 걸기';
    dialSection.appendChild(dialTitle);

    const dialRow = document.createElement('div');
    dialRow.className = 'slm-input-row';

    // 연락처 드롭다운
    const ctx0 = getContext();
    const charName0 = ctx0?.name2;
    const dialSelect = document.createElement('select');
    dialSelect.className = 'slm-select';
    const customOpt = document.createElement('option');
    customOpt.value = '';
    customOpt.textContent = '직접 입력...';
    dialSelect.appendChild(customOpt);
    if (charName0) {
        const opt = document.createElement('option');
        opt.value = charName0;
        opt.textContent = `📞 ${charName0} (캐릭터)`;
        opt.selected = true;
        dialSelect.appendChild(opt);
    }
    getContacts('chat').forEach(c => {
        if (c.name !== charName0) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            dialSelect.appendChild(opt);
        }
    });

    const dialInput = document.createElement('input');
    dialInput.className = 'slm-input';
    dialInput.type = 'text';
    dialInput.placeholder = '직접 이름 입력';
    dialInput.style.display = 'none';

    dialSelect.onchange = () => {
        dialInput.style.display = dialSelect.value === '' ? 'block' : 'none';
    };

    const dialBtn = document.createElement('button');
    dialBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    dialBtn.innerHTML = '📞 발신';
    dialBtn.onclick = async () => {
        const name = (dialSelect.value || dialInput.value).trim();
        if (!name) { showToast('이름을 입력해주세요.', 'warn'); return; }
        if (callActive) { showToast('이미 통화 중입니다.', 'warn'); return; }
        // 팝업 닫고 AI 착신 여부 판단
        const overlay = document.getElementById('slm-overlay-call-logs');
        if (overlay) overlay.remove();
        await initiateCallWithAiDecision(name);
    };

    dialRow.appendChild(dialSelect);
    dialRow.appendChild(dialInput);
    dialRow.appendChild(dialBtn);
    dialSection.appendChild(dialRow);
    wrapper.appendChild(dialSection);

    const hr0 = document.createElement('hr');
    hr0.className = 'slm-hr';
    wrapper.appendChild(hr0);

    const logs = loadCallLogs();
    const collapsedState = loadCollapsedState();

    if (logs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'slm-empty';
        empty.textContent = '통화 기록이 없습니다.';
        wrapper.appendChild(empty);
        return wrapper;
    }

    // 연락처 탭 (전체 + 각 인물)
    const contacts = ['전체', ...new Set(logs.map(l => l.contactName))];
    const tabBar = document.createElement('div');
    tabBar.className = 'slm-tab-bar';

    let currentContact = '전체';

    const logList = document.createElement('div');
    logList.className = 'slm-call-list';

    function renderLogs() {
        logList.innerHTML = '';
        const filtered = currentContact === '전체'
            ? logs
            : logs.filter(l => l.contactName === currentContact);

        filtered.slice().reverse().forEach(log => {
            const row = document.createElement('div');
            row.className = 'slm-call-row';
            const isCollapsed = collapsedState[log.id] === true;
            row.classList.toggle('slm-call-collapsed', isCollapsed);

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'slm-call-row-close';
            toggleBtn.type = 'button';
            toggleBtn.title = isCollapsed ? '펼치기' : '접기';
            toggleBtn.textContent = isCollapsed ? '▸' : '▾';
            toggleBtn.onclick = () => {
                const collapsed = row.classList.toggle('slm-call-collapsed');
                toggleBtn.title = collapsed ? '펼치기' : '접기';
                toggleBtn.textContent = collapsed ? '▸' : '▾';
                collapsedState[log.id] = collapsed;
                saveCollapsedState(collapsedState);
            };
            row.appendChild(toggleBtn);

            const mMin = Math.floor(log.durationSeconds / 60);
            const sSec = log.durationSeconds % 60;
            const durStr = `${mMin}분 ${String(sSec).padStart(2, '0')}초`;

            const infoDiv = document.createElement('div');
            infoDiv.className = 'slm-call-info';
            infoDiv.innerHTML = `
                <span class="slm-call-icon">${log.missed ? '📵' : '📞'}</span>
                <span class="slm-call-name">${escapeHtml(log.contactName)}</span>
                <span class="slm-call-dur">${escapeHtml(durStr)}</span>
            `;
            row.appendChild(infoDiv);

            const detailWrap = document.createElement('div');
            detailWrap.className = 'slm-call-detail';

            // 요약 표시 (인라인 수정 가능)
            const sumDiv = document.createElement('div');
            sumDiv.className = 'slm-call-summary';
            sumDiv.textContent = log.summary ? `📝 ${log.summary}` : '';
            detailWrap.appendChild(sumDiv);

            // 통화 시작 위치로 점프 버튼
            if (typeof log.startMessageIdx === 'number' && log.startMessageIdx >= 0) {
                const jumpBtn = document.createElement('button');
                jumpBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm slm-jump-btn';
                jumpBtn.textContent = '📌 대화 이동';
                jumpBtn.onclick = async () => {
                    try {
                        const ctx = getContext();
                        await ctx.executeSlashCommandsWithOptions(`/chat-jump ${log.startMessageIdx}`, { showOutput: false });
                    } catch (e) {
                        showToast('이동 실패', 'error', 2000);
                    }
                };
                detailWrap.appendChild(jumpBtn);
            }

            const actionRow = document.createElement('div');
            actionRow.className = 'slm-btn-row';

            if (typeof log.startMessageIdx === 'number' && typeof log.endMessageIdx === 'number'
                && log.startMessageIdx >= 0 && log.endMessageIdx >= log.startMessageIdx) {
                const hideBtn = document.createElement('button');
                hideBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
                hideBtn.textContent = log.includeInContext ? '🙈 컨텍스트 제외' : '🙉 컨텍스트 포함';
                hideBtn.onclick = async () => {
                    try {
                        const ctx = getContext();
                        const isCurrentlyIncluded = !!log.includeInContext;
                        await ctx.executeSlashCommandsWithOptions(`/${isCurrentlyIncluded ? 'hide' : 'unhide'} ${log.startMessageIdx}-${log.endMessageIdx}`, { showOutput: false });
                        const all = loadCallLogs();
                        const hit = all.find(x => x.id === log.id);
                        if (hit) hit.includeInContext = !isCurrentlyIncluded;
                        saveCallLogs(all);
                        log.includeInContext = !isCurrentlyIncluded;
                        hideBtn.textContent = log.includeInContext ? '🙈 컨텍스트 제외' : '🙉 컨텍스트 포함';
                        showToast(log.includeInContext ? '통화 구간을 컨텍스트에 포함했습니다.' : '통화 구간을 컨텍스트에서 제외했습니다.', 'success', 1600);
                    } catch (e) {
                        showToast('컨텍스트 설정 실패', 'error', 2000);
                    }
                };
                actionRow.appendChild(hideBtn);
            }

            // 수정 버튼
            const editBtn = document.createElement('button');
            editBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            editBtn.textContent = '✏️ 수정';
            editBtn.onclick = () => {
                openCallLogEditDialog(log, logs, renderLogs);
            };
            actionRow.appendChild(editBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
            deleteBtn.textContent = '🗑️ 로그 삭제';
            deleteBtn.onclick = () => {
                const all = loadCallLogs().filter(x => x.id !== log.id);
                saveCallLogs(all);
                const idx = logs.findIndex(x => x.id === log.id);
                if (idx !== -1) logs.splice(idx, 1);
                renderLogs();
                showToast('통화 기록 삭제됨', 'success', 1400);
            };
            actionRow.appendChild(deleteBtn);

            if (typeof log.startMessageIdx === 'number' && typeof log.endMessageIdx === 'number'
                && log.startMessageIdx >= 0 && log.endMessageIdx >= log.startMessageIdx) {
                const hardDeleteBtn = document.createElement('button');
                hardDeleteBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
                hardDeleteBtn.textContent = '🧨 완전삭제';
                hardDeleteBtn.onclick = async () => {
                    const confirmed = await showConfirm('정말로 삭제하시겠습니까? 통화 내역과 대화 구간이 함께 삭제됩니다.', '예', '아니오');
                    if (!confirmed) return;
                    try {
                        const ctx = getContext();
                        const chatLen = Math.max(0, (ctx?.chat?.length ?? 0) - 1);
                        const start = Math.max(0, Math.min(chatLen, Number(log.startMessageIdx)));
                        const end = Math.max(start, Math.min(chatLen, Number(log.endMessageIdx)));
                        if (!ctx || typeof ctx.executeSlashCommandsWithOptions !== 'function' || !Number.isFinite(start) || !Number.isFinite(end)) {
                            throw new Error('대화 구간 정보를 찾을 수 없습니다.');
                        }
                        await ctx.executeSlashCommandsWithOptions(`/cut ${start}-${end}`, { showOutput: false });
                        const all = loadCallLogs().filter(x => x.id !== log.id);
                        saveCallLogs(all);
                        const idx = logs.findIndex(x => x.id === log.id);
                        if (idx !== -1) logs.splice(idx, 1);
                        renderLogs();
                        showToast('통화 기록과 대화 구간이 삭제되었습니다.', 'success', 1600);
                    } catch (e) {
                        showToast(`완전삭제 실패: ${e?.message || '알 수 없는 오류'}`, 'error', 2200);
                    }
                };
                actionRow.appendChild(hardDeleteBtn);
            }
            detailWrap.appendChild(actionRow);
            row.appendChild(detailWrap);

            logList.appendChild(row);
        });
    }

    contacts.forEach(name => {
        const btn = document.createElement('button');
        btn.className = 'slm-tab-btn' + (name === currentContact ? ' active' : '');
        btn.textContent = name;
        btn.onclick = () => {
            currentContact = name;
            tabBar.querySelectorAll('.slm-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderLogs();
        };
        tabBar.appendChild(btn);
    });

    wrapper.appendChild(tabBar);
    wrapper.appendChild(logList);

    renderLogs();
    return wrapper;
}

/**
 * 통화 기록 수정 다이얼로그를 연다
 * @param {Object} log - 통화 기록
 * @param {Object[]} logs - 전체 기록 배열 (참조)
 * @param {Function} onUpdate - 갱신 콜백
 */
function openCallLogEditDialog(log, logs, onUpdate) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const sumLabel = document.createElement('label');
    sumLabel.className = 'slm-label';
    sumLabel.textContent = '통화 요약';
    const sumInput = document.createElement('textarea');
    sumInput.className = 'slm-textarea';
    sumInput.rows = 3;
    sumInput.value = log.summary || '';

    wrapper.appendChild(sumLabel);
    wrapper.appendChild(sumInput);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = '저장';

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    const { close } = createPopup({
        id: 'call-log-edit',
        title: '✏️ 통화 기록 수정',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack: () => openCallLogsPopup(),
    });

    cancelBtn.onclick = () => close();
    saveBtn.onclick = () => {
        const newSummary = sumInput.value.trim();
        const all = loadCallLogs();
        const idx = all.findIndex(x => x.id === log.id);
        if (idx !== -1) {
            all[idx].summary = newSummary;
            saveCallLogs(all);
            const logIdx = logs.findIndex(x => x.id === log.id);
            if (logIdx !== -1) logs[logIdx].summary = newSummary;
        }
        close();
        onUpdate();
        showToast('수정 완료', 'success', 1200);
    };
}
