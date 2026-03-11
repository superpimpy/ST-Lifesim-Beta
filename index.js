/**
 * index.js — ST-LifeSim 확장 진입점
 *
 * 역할:
 * 1. 모든 모듈을 로드하고 초기화한다
 * 2. sendform 옆에 퀵 센드 버튼을 삽입한다
 * 3. 화면 우하단에 플로팅 아이콘을 렌더링한다
 *    - 메인 버튼(✉️) 클릭 시 기능별 서브 아이콘 슬라이드
 *    - 서브 아이콘 클릭 시 해당 기능 패널 팝업
 *    - 드래그로 위치 변경 가능
 * 4. AI 응답마다 컨텍스트를 주입한다
 * 5. 유저 메시지 전송 시 설정 확률로 SNS 포스팅/반응 트리거
 * 6. 확장 전체 ON/OFF 및 각 모듈별 개별 활성화 관리
 */

import { getContext } from './utils/st-context.js';
import { getExtensionSettings } from './utils/storage.js';
import { injectContext, clearContext, registerContextBuilder } from './utils/context-inject.js';
import { createPopup, createTabs, closePopup } from './utils/popup.js';
import { showToast, showConfirm, escapeHtml } from './utils/ui.js';
import { exportAllData, importAllData, clearAllData } from './utils/storage.js';
import { renderTimeDividerUI, renderReadReceiptUI, renderNoContactUI, renderEventGeneratorUI, renderVoiceMemoUI, triggerQuickSend, triggerReadReceipt, triggerNoContact, triggerUserImageGenerationAndSend, triggerVoiceMemoInsertion, triggerDeletedMessage } from './modules/quick-tools/quick-tools.js';
import { startFirstMsgTimer, renderFirstMsgSettingsUI } from './modules/firstmsg/firstmsg.js';
import { buildAiEmoticonContext, initEmoticon, openEmoticonPopup, replaceAiSelectedEmoticons } from './modules/emoticon/emoticon.js';
import { initContacts, openContactsPopup, getContacts, getAppearanceTagsByName, buildAppearanceTagVariableMap, resolveAppearanceTagVariables } from './modules/contacts/contacts.js';
import { initCall, isCallActive, onCharacterMessageRenderedForProactiveCall, openCallLogsPopup, triggerProactiveIncomingCall, requestActiveCharacterCall } from './modules/call/call.js';
import { initWallet, openWalletPopup } from './modules/wallet/wallet.js';
import { initSns, openSnsPopup, triggerNpcPosting, triggerPendingCommentReaction, hasPendingCommentReaction } from './modules/sns/sns.js';
import { initCalendar, openCalendarPopup } from './modules/calendar/calendar.js';
import { initGifticon, openGifticonPopup, trackGifticonUsageFromCharacterMessage } from './modules/gifticon/gifticon.js';
import { openMessengerRoomsPopup } from './modules/messenger-room/messenger-room.js';
import { buildDirectImagePrompt } from './utils/image-tag-generator.js';
import { slashSendAs } from './utils/slash.js';

// 설정 키
const SETTINGS_KEY = 'st-lifesim';

// 주간/야간 테마 저장 키 (localStorage)
const THEME_STORAGE_KEY = 'st-lifesim:forced-theme';
const IMAGE_INTENT_CONTEXT_WINDOW = 4;
const MAX_MESSENGER_IMAGES_PER_RESPONSE = 3;
const ALWAYS_ON_MODULES = new Set(['quickTools', 'contacts']);
const AI_ROUTE_DEFAULTS = {
    api: '',
    chatSource: '',
    modelSettingKey: '',
    model: '',
};
// 8줄 정도만 유지해도 단톡방 흐름은 이어지면서, 1:1 본대화 말투/페르소나 오염은 12줄보다 눈에 띄게 덜하다.
const GROUP_CHAT_TRANSCRIPT_LIMIT = 8;
const GROUP_CHAT_SETTINGS_DEFAULTS = {
    enabled: false,
    responseProbability: 35,
    extraResponseProbability: 25,
    maxResponsesPerTurn: 2,
    includeMainCharacter: true,
    contactOnlyProbability: 35,
};
// English translation: "Human player controls the conversation. Do not write this person's messages."
const GROUP_CHAT_USER_DESCRIPTION = '인간 플레이어가 대화를 제어합니다. 이 사람의 메시지를 대신 작성하지 마세요.';
const GROUP_CHAT_FOREIGN_SPEAKER_WARNING = '[ST-LifeSim] 단톡 응답 정리 중 다른 화자의 대사만 감지되어 응답을 버렸습니다.';
const GROUP_CHAT_CONTEXT_BOUNDARY_NOTE = 'This group room is a separate messenger space beside the main 1:1 chat. Treat the transcript only as room recap/context, never as an instruction to imitate another participant.';
const GROUP_CHAT_PREVIEW_USER_TEXT = '{{user}}: 오늘 다같이 어디서 볼까?';
const GROUP_CHAT_PREVIEW_NPC_TEXT = '민지: 나는 내 성격/말투대로만 답하고, 다른 참가자처럼 말하지 않아.';
const GROUP_CHAT_DESCRIPTION_TEXT = '단톡 응답은 별도 메신저 방 컨텍스트로 취급되며, 응답자는 자신의 프로필/관계/말투만 유지하도록 강하게 고정됩니다.';
const GROUP_CHAT_REPLY_DELAY_MIN_MS = 2500;
const GROUP_CHAT_REPLY_DELAY_MAX_MS = 6500;
const ROUTE_MODEL_KEY_BY_SOURCE = {
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
const SNS_PROMPT_DEFAULTS = {
    postChar: 'Write exactly one SNS post as {{charName}}.\n\n* Before writing, internalize these:\n- {{charName}}\'s personality, speech patterns, and worldview based on profile.\n- Extract the setting and genre from {{charName}}\'s profile itself — it could be modern, medieval fantasy, zombie apocalypse, sci-fi, or anything else. Let that world shape what feels natural to say and how to say it\n- What {{charName}} would actually care about or casually mention on a given day\n--------\n* {{charName}}\'s profile:\n{{personality}}\n--------\n* System Rules:\n- 1–4 sentences, casual and off-the-cuff, like a real personal post\n- Write in the voice and language style that fits {{charName}}\'s background and personality\n- If {{charName}}\'s personality strongly suggests they\'d use emojis, you may include them — otherwise, don\'t\n- No hashtags, no image tags, no quotation marks, no other characters\' reactions, no [caption: ...] blocks\n- Word choice, references, and tone must stay true to the detected world — never bleed in elements from the wrong setting\n- Don\'t be stiff or formal. This is a glimpse into {{charName}}\'s actual inner life, not a public announcement\n\n* System Note\n- Output only {{charName}}\'s post text. Nothing else.\n- Please comply with the output language.\n* This is a post aimed at an unspecified number of people. It is not a 1:1 session to communicate with {{user}}.',
    postContact: 'Write exactly one SNS post as {{authorName}}.\n\n* Before writing, internalize these:\n- {{authorName}}\'s personality, speech patterns, and worldview based on profile.\n- Extract the setting and genre from {{authorName}}\'s profile itself — it could be modern, medieval fantasy, zombie apocalypse, sci-fi, or anything else. Let that world shape what feels natural to say and how to say it\n- What {{authorName}} would actually care about or casually mention on a given day\n-------\n* {{authorName}}\'s profile:\n{{personality}}\n-------\n* System Rules:\n- 1–2 sentences, casual and off-the-cuff, like a real personal post\n- Write in the voice and language style that fits {{authorName}}\'s background and personality\n- If {{authorName}}\'s personality strongly suggests they\'d use emojis, you may include them — otherwise, don\'t\n- No hashtags, no image tags, no quotation marks, no other characters\' reactions, no [caption: ...] blocks\n- Word choice, references, and tone must stay true to the detected world — never bleed in elements from the wrong setting\n- Don\'t be stiff or formal. This is a glimpse into {{authorName}}\'s actual inner life, not a public announcement\n\n* System Note\n- Output only {{authorName}}\'s post text. Nothing else.\n- Please comply with the output language.',
    imageDescription: 'For {{authorName}}\'s SNS post "{{postContent}}", write exactly one short sentence describing the attached image. Mention only visible content. Do not use hashtags, quotes, parentheses, or any "caption:" prefix.',
    reply: 'Write exactly one SNS reply for this thread.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nTarget comment author: {{commentAuthorName}} ({{commentAuthorHandle}})\nTarget comment: "{{commentText}}"\nReply author: {{replyAuthorName}} ({{replyAuthorHandle}})\nRules: one sentence only from {{replyAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{replyAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{replyPersonality}}. It should be written vividly, fitting the characteristics of each character.',
    extraComment: 'Write exactly one additional SNS comment for this post.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nComment author: {{extraAuthorName}} ({{extraAuthorHandle}})\nRules: one short sentence from {{extraAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{extraAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{extraPersonality}}. It should be written vividly, fitting the characteristics of each character.',
};

function normalizeQuickAccessImageUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    if (/^(https?:\/\/|data:image\/|\/)/i.test(trimmed)) return trimmed;
    return '';
}

// 메시지 템플릿 기본값
const DEFAULT_MESSAGE_TEMPLATES = {
    callStart_incoming: '📞 {charName}님께서 전화를 거셨습니다. {{user}}님께서 전화를 받으셨습니다.',
    callStart_outgoing: '📞 {charName}님께 전화를 걸었습니다. {charName}님께서 전화를 받으셨습니다.',
    callEnd: '📵 통화 종료 (통화시간: {timeStr})',
    voiceMemo: '🎤 음성메시지 ({timeStr})<br>내용: {hint}',
    voiceMemoAiPrompt: 'As {charName}, send exactly one voice message in Korean. You must choose suitable duration and content yourself based on current context.\nOutput only this HTML format:\n🎤 음성메시지 (M:SS)<br>[actual voice message content]',
    readReceipt: '{charName} sent a message to {{user}}. {{user}} has read {charName}\'s message but has not replied yet. Briefly describe {charName}\'s reaction in 1-2 sentences as dialogue.',
    noContact: '{charName} tried to reach {{user}} but {{user}} has not seen or responded yet. Briefly describe the situation in 1-2 sentences.',
    gifticonSend: '{emoji} **기프티콘 전송 완료**\n- 보내는 사람: {senderName}\n- 받는 사람: {recipient}\n- 품목: {name}{valuePart}{memoPart}',
};

// 기본 설정
const DEFAULT_SETTINGS = {
    enabled: true,
    defaultBinding: 'chat',
    modules: {
        quickTools: true,
        emoticon: true,
        contacts: true,
        call: true,
        wallet: true,
        sns: true,
        calendar: true,
        gifticon: true,
    },
    emoticonSize: 80,   // px
    emoticonRadius: 10, // px
    imageRadius: 10, // px
    defaultSnsImageUrl: '', // SNS 기본 이미지 URL
    snsImageMode: false, // SNS 게시물 이미지 자동 생성 여부
    messageImageGenerationMode: false, // 메신저 이미지 자동 생성 여부 (ON: 이미지 API로 생성, OFF: 줄글 텍스트)
    messageImageTextTemplate: '[사진: {description}]', // OFF일 때 줄글 형식 커스텀 템플릿
    messageImageInjectionPrompt: '<image_generation_rule>\nWhen {{char}} would realistically take a photo with their phone and send it, insert a <pic prompt="concise English Danbooru-style tags"> tag.\n\n"Camera in hand" rule: ONLY photos {{char}} could physically take and send right now.\n\nALLOWED: Selfies, food/drink/surroundings, mirror selfies, objects to share, pet/scenery photos, requested photos.\nFORBIDDEN: Third-person narrative shots, dramatic/cinematic angles, mood illustrations, narration images.\n\nOUTPUT RULES:\n1) <pic prompt="..."> must contain final Danbooru-style English tags ready for direct image generation.\n2) Default subject is {{char}}. Include other character names only if they are in the photo.\n3) Include {{user}} only when explicitly together.\n4) Use pipe-separated format: scene tags | Character 1: (appearance tags) | Character 2: (appearance tags)\n5) Use "Character N:" labels, NOT actual character names, for appearance blocks.\n6) For interactions between characters, tag the performer as source#[action] and receiver as target#[action]. Example: source#kiss, target#kiss\n7) Outfit tags may be freely adjusted to fit the current situation and context.\n8) Each <pic> must describe a NEW unique scene. Never reuse previous images.\n9) Generate <pic> when visual action is implied, even without the word "photo".\n10) Do NOT generate images just because a visual scene is mentioned — only when {{char}} would deliberately take and send a photo.\n11) No explanations, no markdown, no Korean inside the prompt.\n</image_generation_rule>',
    tagGenerationAdditionalPrompt: '',
    snsImagePrompt: '<ImagePrompt>\n<instructions>\nConstruct a concise image prompt for a photo {{char}} posts on SNS right now.\nBased on conversation history and {{char}}\'s persona.\n\nRULES:\n1. Banned tags: handphone, handheld phone\n2. Fuse personality, appearance, and context into a single curated moment.\n3. Reflect posting intent: showing off, indirect message, image crafting.\n4. SNS authenticity: intentionally daily, casually styled, aesthetic but not studio-polished.\n5. Focus on composition, color mood, background, and styling choices.\n6. Use English Danbooru-style tags only.\n7. Format: scene tags | Character 1: (appearance tags)\n8. Use "Character N:" labels, NOT actual character names.\n9. For interactions, use source#[action] and target#[action] tags.\n10. Outfit tags may be freely adjusted to fit the situation.\n11. Keep these tags: human focus, highres, absurdres, ai-generated\n</instructions>\n</ImagePrompt>',
    messageImagePrompt: '<ImagePrompt>\n<instructions>\nConstruct a concise image prompt for a photo {{char}} sends to {{user}} via private messenger.\nBased on conversation history and {{char}}\'s persona.\n\nRULES:\n1. Fuse personality, appearance, and context into a single captured moment.\n2. Reflect intent: teasing, proving a point, showing vulnerability.\n3. Messenger authenticity: slightly unpolished, intimate. Not a social post.\n4. Focus on micro-expressions, hand placement, lighting mood.\n5. Use English Danbooru-style tags only.\n6. Format: scene tags | Character 1: (appearance tags)\n7. Use "Character N:" labels, NOT actual character names.\n8. For interactions, use source#[action] and target#[action] tags.\n9. Outfit tags may be freely adjusted to fit the situation.\n10. Keep these tags: human focus, highres, absurdres, ai-generated\n</instructions>\n</ImagePrompt>',
    characterAppearanceTags: {}, // { [charName]: "tag1, tag2" }
    tagWeight: 5, // 태그 가중치 (예: 5 → "5::(tags)::")
    callAudio: {
        startSoundUrl: '',
        endSoundUrl: '',
        ringtoneUrl: '',
        vibrateOnIncoming: false,
    },
    aiCustomModels: {}, // { [provider]: string[] }
    themeColors: {}, // CSS 커스텀 색상
    toast: {
        offsetY: 16,
        fontColor: '#ffffff',
        colors: {
            info: '#1c1c1e',
            success: '#34c759',
            warn: '#ffd60a',
            error: '#ff3b30',
        },
    },
    firstMsg: {
        enabled: false,
        intervalSec: 10,
        probability: 8,
    },
    hideHelperText: false,
    groupChat: { ...GROUP_CHAT_SETTINGS_DEFAULTS },
    snsPostingProbability: 10, // % (0~100)
    proactiveCallProbability: 0, // % (0~100)
    snsExternalApiUrl: '',
    snsExternalApiTimeoutMs: 12000,
    snsLanguage: 'ko',
    snsKoreanTranslationPrompt: 'Translate the following SNS text into natural Korean. Output Korean text only.\n{{text}}',
    snsPrompts: { ...SNS_PROMPT_DEFAULTS },
    callSummaryPrompt: 'The following is the conversation transcript from a call with {contactName}. Write a concise 2-3 sentence summary IN KOREAN of what was discussed during the call. The summary must be written in Korean regardless of the conversation language. Character names may be kept as-is:\n{transcript}',
    messageTemplates: { ...DEFAULT_MESSAGE_TEMPLATES },
    aiRoutes: {
        sns: { ...AI_ROUTE_DEFAULTS },
        snsTranslation: { ...AI_ROUTE_DEFAULTS },
        callSummary: { ...AI_ROUTE_DEFAULTS },
        contactProfile: { ...AI_ROUTE_DEFAULTS },
        tagGeneration: { ...AI_ROUTE_DEFAULTS },
    },
    quickAccess: {
        enabled: true,
        columns: 1,             // 1, 2, or 3 column layout
        displayMode: 'full',    // 'full' | 'emojiOnly' | 'labelOnly'
        iconSize: 24,           // px (16~64)
        labelFontSize: 14,      // px (8~24) - 퀵 액세스 제목 폰트 크기
        customLabels: {},       // { [key]: string } - custom display names
        customImages: {},       // { [key]: string } - image URL replacement for emoji
        rightSendFormItems: {}, // { [key]: true } - items to show as extra icons in sendform area
        order: ['userImage', 'callRequest', 'contacts', 'messengerRooms', 'divider', 'readReceipt', 'noContact', 'voiceMemo', 'emoticon', 'deletedMessage', 'sns', 'quickSend', 'snsImageToggle', 'messengerImageToggle', 'dayNightToggle', 'settingsShortcut'],
        items: {
            userImage: true,
            callRequest: true,
            contacts: true,
            messengerRooms: true,
            divider: true,
            readReceipt: true,
            noContact: true,
            voiceMemo: true,
            emoticon: true,
            deletedMessage: true,
            sns: true,
            quickSend: true,
            snsImageToggle: true,
            messengerImageToggle: true,
            dayNightToggle: true,
            settingsShortcut: true,
        },
    },
};

/**
 * 현재 설정을 가져온다
 * @returns {Object}
 */
function getSettings() {
    const ext = getExtensionSettings();
    if (!ext) return { ...DEFAULT_SETTINGS };
    if (!ext[SETTINGS_KEY]) {
        ext[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    // 신규 필드 기본값 보완
    if (ext[SETTINGS_KEY].emoticonSize == null) {
        ext[SETTINGS_KEY].emoticonSize = DEFAULT_SETTINGS.emoticonSize;
    }
    if (ext[SETTINGS_KEY].emoticonRadius == null) {
        ext[SETTINGS_KEY].emoticonRadius = DEFAULT_SETTINGS.emoticonRadius;
    }
    if (ext[SETTINGS_KEY].imageRadius == null) {
        ext[SETTINGS_KEY].imageRadius = DEFAULT_SETTINGS.imageRadius;
    }
    if (ext[SETTINGS_KEY].defaultBinding == null) {
        ext[SETTINGS_KEY].defaultBinding = DEFAULT_SETTINGS.defaultBinding;
    }
    if (ext[SETTINGS_KEY].defaultSnsImageUrl == null) {
        ext[SETTINGS_KEY].defaultSnsImageUrl = '';
    }
    if (ext[SETTINGS_KEY].themeColors == null) {
        ext[SETTINGS_KEY].themeColors = {};
    }
    // 메신저 이미지 생성 모드 (boolean)
    if (typeof ext[SETTINGS_KEY].messageImageGenerationMode !== 'boolean') {
        ext[SETTINGS_KEY].messageImageGenerationMode = DEFAULT_SETTINGS.messageImageGenerationMode;
    }
    // 메신저 이미지 OFF 시 줄글 텍스트 템플릿
    if (typeof ext[SETTINGS_KEY].messageImageTextTemplate !== 'string') {
        ext[SETTINGS_KEY].messageImageTextTemplate = DEFAULT_SETTINGS.messageImageTextTemplate;
    }
    // 메신저 이미지 생성 프롬프트 주입
    if (typeof ext[SETTINGS_KEY].messageImageInjectionPrompt !== 'string') {
        ext[SETTINGS_KEY].messageImageInjectionPrompt = DEFAULT_SETTINGS.messageImageInjectionPrompt;
    }
    if (typeof ext[SETTINGS_KEY].tagGenerationAdditionalPrompt !== 'string') {
        ext[SETTINGS_KEY].tagGenerationAdditionalPrompt = DEFAULT_SETTINGS.tagGenerationAdditionalPrompt;
    }
    // 하위 호환: 기존 messageImageDisplayMode가 남아있으면 마이그레이션
    if (ext[SETTINGS_KEY].messageImageDisplayMode != null) {
        if (ext[SETTINGS_KEY].messageImageGenerationMode == null) {
            ext[SETTINGS_KEY].messageImageGenerationMode = ext[SETTINGS_KEY].messageImageDisplayMode === 'image';
        }
        delete ext[SETTINGS_KEY].messageImageDisplayMode;
    }
    if (typeof ext[SETTINGS_KEY].snsImagePrompt !== 'string') {
        ext[SETTINGS_KEY].snsImagePrompt = DEFAULT_SETTINGS.snsImagePrompt;
    }
    if (typeof ext[SETTINGS_KEY].messageImagePrompt !== 'string') {
        ext[SETTINGS_KEY].messageImagePrompt = DEFAULT_SETTINGS.messageImagePrompt;
    }
    if (!ext[SETTINGS_KEY].characterAppearanceTags || typeof ext[SETTINGS_KEY].characterAppearanceTags !== 'object') {
        ext[SETTINGS_KEY].characterAppearanceTags = {};
    }
    // 태그 가중치 (기본 5, 0은 비활성화)
    if (!Number.isFinite(ext[SETTINGS_KEY].tagWeight) || ext[SETTINGS_KEY].tagWeight < 0) {
        ext[SETTINGS_KEY].tagWeight = DEFAULT_SETTINGS.tagWeight;
    }
    if (!ext[SETTINGS_KEY].callAudio || typeof ext[SETTINGS_KEY].callAudio !== 'object') {
        ext[SETTINGS_KEY].callAudio = { ...DEFAULT_SETTINGS.callAudio };
    }
    ['startSoundUrl', 'endSoundUrl', 'ringtoneUrl'].forEach((k) => {
        if (typeof ext[SETTINGS_KEY].callAudio[k] !== 'string') ext[SETTINGS_KEY].callAudio[k] = '';
    });
    if (typeof ext[SETTINGS_KEY].callAudio.vibrateOnIncoming !== 'boolean') {
        ext[SETTINGS_KEY].callAudio.vibrateOnIncoming = DEFAULT_SETTINGS.callAudio.vibrateOnIncoming;
    }
    if (!ext[SETTINGS_KEY].aiCustomModels || typeof ext[SETTINGS_KEY].aiCustomModels !== 'object') {
        ext[SETTINGS_KEY].aiCustomModels = {};
    }
    if (ext[SETTINGS_KEY].toast == null) {
        ext[SETTINGS_KEY].toast = { ...DEFAULT_SETTINGS.toast, colors: { ...DEFAULT_SETTINGS.toast.colors } };
    }
    if (ext[SETTINGS_KEY].toast.offsetY == null) {
        ext[SETTINGS_KEY].toast.offsetY = DEFAULT_SETTINGS.toast.offsetY;
    }
    if (ext[SETTINGS_KEY].toast.colors == null) {
        ext[SETTINGS_KEY].toast.colors = { ...DEFAULT_SETTINGS.toast.colors };
    }
    ['info', 'success', 'warn', 'error'].forEach((key) => {
        if (!ext[SETTINGS_KEY].toast.colors[key]) {
            ext[SETTINGS_KEY].toast.colors[key] = DEFAULT_SETTINGS.toast.colors[key];
        }
    });
    if (typeof ext[SETTINGS_KEY].toast.fontColor !== 'string') {
        ext[SETTINGS_KEY].toast.fontColor = DEFAULT_SETTINGS.toast.fontColor;
    }
    if (ext[SETTINGS_KEY].firstMsg == null) {
        ext[SETTINGS_KEY].firstMsg = { ...DEFAULT_SETTINGS.firstMsg };
    }
    if (typeof ext[SETTINGS_KEY].hideHelperText !== 'boolean') {
        ext[SETTINGS_KEY].hideHelperText = DEFAULT_SETTINGS.hideHelperText;
    }
    if (!ext[SETTINGS_KEY].groupChat || typeof ext[SETTINGS_KEY].groupChat !== 'object') {
        ext[SETTINGS_KEY].groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
    }
    if (typeof ext[SETTINGS_KEY].groupChat.enabled !== 'boolean') {
        ext[SETTINGS_KEY].groupChat.enabled = GROUP_CHAT_SETTINGS_DEFAULTS.enabled;
    }
    if (!Number.isFinite(ext[SETTINGS_KEY].groupChat.responseProbability)) {
        ext[SETTINGS_KEY].groupChat.responseProbability = GROUP_CHAT_SETTINGS_DEFAULTS.responseProbability;
    }
    if (!Number.isFinite(ext[SETTINGS_KEY].groupChat.extraResponseProbability)) {
        ext[SETTINGS_KEY].groupChat.extraResponseProbability = GROUP_CHAT_SETTINGS_DEFAULTS.extraResponseProbability;
    }
    if (!Number.isFinite(ext[SETTINGS_KEY].groupChat.maxResponsesPerTurn)) {
        ext[SETTINGS_KEY].groupChat.maxResponsesPerTurn = GROUP_CHAT_SETTINGS_DEFAULTS.maxResponsesPerTurn;
    }
    if (typeof ext[SETTINGS_KEY].groupChat.includeMainCharacter !== 'boolean') {
        ext[SETTINGS_KEY].groupChat.includeMainCharacter = GROUP_CHAT_SETTINGS_DEFAULTS.includeMainCharacter;
    }
    if (!Number.isFinite(ext[SETTINGS_KEY].groupChat.contactOnlyProbability)) {
        ext[SETTINGS_KEY].groupChat.contactOnlyProbability = GROUP_CHAT_SETTINGS_DEFAULTS.contactOnlyProbability;
    }
    if (ext[SETTINGS_KEY].modules?.gifticon == null) {
        if (!ext[SETTINGS_KEY].modules) ext[SETTINGS_KEY].modules = {};
        ext[SETTINGS_KEY].modules.gifticon = true;
    }
    ALWAYS_ON_MODULES.forEach((moduleKey) => {
        if (!ext[SETTINGS_KEY].modules) ext[SETTINGS_KEY].modules = {};
        ext[SETTINGS_KEY].modules[moduleKey] = true;
    });
    if (ext[SETTINGS_KEY].snsPostingProbability == null) {
        ext[SETTINGS_KEY].snsPostingProbability = DEFAULT_SETTINGS.snsPostingProbability;
    }
    if (ext[SETTINGS_KEY].proactiveCallProbability == null) {
        ext[SETTINGS_KEY].proactiveCallProbability = DEFAULT_SETTINGS.proactiveCallProbability;
    }
    if (typeof ext[SETTINGS_KEY].snsExternalApiUrl !== 'string') {
        ext[SETTINGS_KEY].snsExternalApiUrl = DEFAULT_SETTINGS.snsExternalApiUrl;
    }
    if (!Number.isFinite(ext[SETTINGS_KEY].snsExternalApiTimeoutMs)) {
        ext[SETTINGS_KEY].snsExternalApiTimeoutMs = DEFAULT_SETTINGS.snsExternalApiTimeoutMs;
    }
    if (!['ko', 'en', 'ja', 'zh'].includes(ext[SETTINGS_KEY].snsLanguage)) {
        ext[SETTINGS_KEY].snsLanguage = DEFAULT_SETTINGS.snsLanguage;
    }
    if (typeof ext[SETTINGS_KEY].snsKoreanTranslationPrompt !== 'string') {
        ext[SETTINGS_KEY].snsKoreanTranslationPrompt = DEFAULT_SETTINGS.snsKoreanTranslationPrompt;
    }
    if (!ext[SETTINGS_KEY].snsPrompts || typeof ext[SETTINGS_KEY].snsPrompts !== 'object') {
        ext[SETTINGS_KEY].snsPrompts = { ...SNS_PROMPT_DEFAULTS };
    }
    Object.keys(SNS_PROMPT_DEFAULTS).forEach((key) => {
        if (typeof ext[SETTINGS_KEY].snsPrompts[key] !== 'string') {
            ext[SETTINGS_KEY].snsPrompts[key] = SNS_PROMPT_DEFAULTS[key];
        }
    });
    if (!ext[SETTINGS_KEY].aiRoutes || typeof ext[SETTINGS_KEY].aiRoutes !== 'object') {
        ext[SETTINGS_KEY].aiRoutes = {
            sns: { ...AI_ROUTE_DEFAULTS },
            snsTranslation: { ...AI_ROUTE_DEFAULTS },
            callSummary: { ...AI_ROUTE_DEFAULTS },
            contactProfile: { ...AI_ROUTE_DEFAULTS },
            tagGeneration: { ...AI_ROUTE_DEFAULTS },
        };
    }
    ['sns', 'snsTranslation', 'callSummary', 'contactProfile', 'tagGeneration'].forEach((feature) => {
        if (!ext[SETTINGS_KEY].aiRoutes[feature] || typeof ext[SETTINGS_KEY].aiRoutes[feature] !== 'object') {
            ext[SETTINGS_KEY].aiRoutes[feature] = { ...AI_ROUTE_DEFAULTS };
        }
        Object.keys(AI_ROUTE_DEFAULTS).forEach((key) => {
            if (typeof ext[SETTINGS_KEY].aiRoutes[feature][key] !== 'string') {
                ext[SETTINGS_KEY].aiRoutes[feature][key] = AI_ROUTE_DEFAULTS[key];
            }
        });
    });
    // 신규: 통화 요약 프롬프트
    if (typeof ext[SETTINGS_KEY].callSummaryPrompt !== 'string') {
        ext[SETTINGS_KEY].callSummaryPrompt = DEFAULT_SETTINGS.callSummaryPrompt;
    }
    // 신규: 메시지 템플릿
    if (!ext[SETTINGS_KEY].messageTemplates || typeof ext[SETTINGS_KEY].messageTemplates !== 'object') {
        ext[SETTINGS_KEY].messageTemplates = { ...DEFAULT_MESSAGE_TEMPLATES };
    }
    Object.keys(DEFAULT_MESSAGE_TEMPLATES).forEach((key) => {
        if (typeof ext[SETTINGS_KEY].messageTemplates[key] !== 'string') {
            ext[SETTINGS_KEY].messageTemplates[key] = DEFAULT_MESSAGE_TEMPLATES[key];
        }
    });
    // 신규: SNS 이미지 모드
    if (ext[SETTINGS_KEY].snsImageMode == null) {
        ext[SETTINGS_KEY].snsImageMode = DEFAULT_SETTINGS.snsImageMode;
    }
    // 신규: 퀵 액세스 설정
    if (!ext[SETTINGS_KEY].quickAccess || typeof ext[SETTINGS_KEY].quickAccess !== 'object') {
        ext[SETTINGS_KEY].quickAccess = {
            ...DEFAULT_SETTINGS.quickAccess,
            order: [...DEFAULT_SETTINGS.quickAccess.order],
            items: { ...DEFAULT_SETTINGS.quickAccess.items },
            customLabels: {},
            customImages: {},
        };
    }
    if (ext[SETTINGS_KEY].quickAccess.items == null) {
        ext[SETTINGS_KEY].quickAccess.items = { ...DEFAULT_SETTINGS.quickAccess.items };
    }
    if (!Array.isArray(ext[SETTINGS_KEY].quickAccess.order)) {
        ext[SETTINGS_KEY].quickAccess.order = [...DEFAULT_SETTINGS.quickAccess.order];
    }
    if (typeof ext[SETTINGS_KEY].quickAccess.enabled !== 'boolean') {
        ext[SETTINGS_KEY].quickAccess.enabled = DEFAULT_SETTINGS.quickAccess.enabled;
    }
    // 신규: 퀵 액세스 커스터마이징 설정 마이그레이션
    if (![1, 2, 3].includes(ext[SETTINGS_KEY].quickAccess.columns)) {
        ext[SETTINGS_KEY].quickAccess.columns = DEFAULT_SETTINGS.quickAccess.columns;
    }
    if (!['full', 'emojiOnly', 'labelOnly'].includes(ext[SETTINGS_KEY].quickAccess.displayMode)) {
        ext[SETTINGS_KEY].quickAccess.displayMode = DEFAULT_SETTINGS.quickAccess.displayMode;
    }
    const parsedIconSize = Number(ext[SETTINGS_KEY].quickAccess.iconSize);
    if (!Number.isFinite(parsedIconSize)) {
        ext[SETTINGS_KEY].quickAccess.iconSize = DEFAULT_SETTINGS.quickAccess.iconSize;
    } else {
        ext[SETTINGS_KEY].quickAccess.iconSize = Math.max(16, Math.min(64, Math.round(parsedIconSize)));
    }
    const parsedLabelFontSize = Number(ext[SETTINGS_KEY].quickAccess.labelFontSize);
    if (!Number.isFinite(parsedLabelFontSize)) {
        ext[SETTINGS_KEY].quickAccess.labelFontSize = DEFAULT_SETTINGS.quickAccess.labelFontSize;
    } else {
        ext[SETTINGS_KEY].quickAccess.labelFontSize = Math.max(8, Math.min(24, Math.round(parsedLabelFontSize)));
    }
    if (!ext[SETTINGS_KEY].quickAccess.customLabels || typeof ext[SETTINGS_KEY].quickAccess.customLabels !== 'object') {
        ext[SETTINGS_KEY].quickAccess.customLabels = {};
    }
    if (!ext[SETTINGS_KEY].quickAccess.customImages || typeof ext[SETTINGS_KEY].quickAccess.customImages !== 'object') {
        ext[SETTINGS_KEY].quickAccess.customImages = {};
    }
    if (!ext[SETTINGS_KEY].quickAccess.rightSendFormItems || typeof ext[SETTINGS_KEY].quickAccess.rightSendFormItems !== 'object') {
        ext[SETTINGS_KEY].quickAccess.rightSendFormItems = {};
    }
    const customLabelEntries = Object.entries(ext[SETTINGS_KEY].quickAccess.customLabels)
        .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
        .filter(([key, value]) => key && value);
    ext[SETTINGS_KEY].quickAccess.customLabels = Object.fromEntries(customLabelEntries);
    const customImageEntries = Object.entries(ext[SETTINGS_KEY].quickAccess.customImages)
        .map(([key, value]) => [String(key || '').trim(), normalizeQuickAccessImageUrl(value)])
        .filter(([key, value]) => key && value);
    ext[SETTINGS_KEY].quickAccess.customImages = Object.fromEntries(customImageEntries);
    const qaOrder = ext[SETTINGS_KEY].quickAccess.order
        .map(v => String(v || '').trim())
        .filter(v => v && DEFAULT_SETTINGS.quickAccess.order.includes(v));
    DEFAULT_SETTINGS.quickAccess.order.forEach((key) => {
        if (!qaOrder.includes(key)) qaOrder.push(key);
    });
    ext[SETTINGS_KEY].quickAccess.order = qaOrder;
    Object.keys(DEFAULT_SETTINGS.quickAccess.items).forEach((key) => {
        if (typeof ext[SETTINGS_KEY].quickAccess.items[key] !== 'boolean') {
            ext[SETTINGS_KEY].quickAccess.items[key] = DEFAULT_SETTINGS.quickAccess.items[key];
        }
    });
    return ext[SETTINGS_KEY];
}

/**
 * 확장이 활성화되어 있는지 확인한다
 * @returns {boolean}
 */
function isEnabled() {
    return getSettings().enabled !== false;
}

/**
 * 특정 모듈이 활성화되어 있는지 확인한다
 * @param {string} moduleKey
 * @returns {boolean}
 */
function isModuleEnabled(moduleKey) {
    if (ALWAYS_ON_MODULES.has(moduleKey)) return isEnabled();
    return isEnabled() && getSettings().modules?.[moduleKey] !== false;
}

/**
 * ST-LifeSim 메뉴 버튼을 sendform의 전송 버튼(#send_but) 바로 앞에 삽입한다
 */
function injectLifeSimMenuButton() {
    const existingBtn = document.getElementById('slm-menu-btn');
    const leftSendFormElement = document.getElementById('leftSendForm') || document.getElementById('leftsendform');
    if (existingBtn) {
        if (
            leftSendFormElement
            && existingBtn.parentElement === leftSendFormElement
            && existingBtn !== leftSendFormElement.lastElementChild
        ) {
            leftSendFormElement.appendChild(existingBtn); // 항상 맨 오른쪽(마지막)으로 유지
        }
        return;
    }

    const sendBtn = document.getElementById('send_but');
    if (!sendBtn) {
        const observer = new MutationObserver(() => {
            if (document.getElementById('send_but')) {
                observer.disconnect();
                injectLifeSimMenuButton();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return;
    }

    const btn = document.createElement('button');
    btn.id = 'slm-menu-btn';
    btn.className = 'slm-menu-btn interactable';
    btn.title = 'ST-LifeSim 메뉴';
    btn.innerHTML = '📱';
    btn.setAttribute('aria-label', 'ST-LifeSim 메뉴 열기');
    btn.setAttribute('tabindex', '0');

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (document.getElementById('slm-overlay-quick-access-menu')) {
            closePopup('quick-access-menu');
        } else {
            openQuickAccessPopup();
        }
    });

    if (leftSendFormElement) {
        btn.style.marginLeft = 'auto';
        leftSendFormElement.appendChild(btn);
    } else {
        sendBtn.parentNode.insertBefore(btn, sendBtn);
    }
}

/**
 * 유저 이미지 생성 팝업을 연다 (퀵 액세스용)
 */
function openUserImagePromptPopup() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-settings-wrapper slm-form';

    const desc = document.createElement('p');
    desc.className = 'slm-desc';
    desc.textContent = '이미지 설명을 입력하면 AI가 이미지를 생성하여 유저 메시지로 전송합니다.';
    wrapper.appendChild(desc);

    const inputLabel = document.createElement('label');
    inputLabel.className = 'slm-label';
    inputLabel.textContent = '이미지 설명';
    wrapper.appendChild(inputLabel);

    const input = document.createElement('textarea');
    input.className = 'slm-textarea';
    input.rows = 3;
    input.placeholder = '예: 카페에서 셀카, 공원에서 산책하는 모습, 음식 사진 등';
    wrapper.appendChild(input);

    const hint = document.createElement('p');
    hint.className = 'slm-desc';
    hint.style.marginTop = '4px';
    hint.textContent = '💡 연락처에 등록된 캐릭터 이름을 포함하면 해당 캐릭터의 외형도 반영됩니다.';
    wrapper.appendChild(hint);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const genBtn = document.createElement('button');
    genBtn.className = 'slm-btn slm-btn-primary';
    genBtn.textContent = '🎨 이미지 생성';

    footer.appendChild(cancelBtn);
    footer.appendChild(genBtn);

    const { close } = createPopup({
        id: 'user-image-gen',
        title: '🎨 이미지 생성 (유저)',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });

    cancelBtn.onclick = () => close();

    genBtn.onclick = async () => {
        const prompt = input.value.trim();
        if (!prompt) {
            showToast('이미지 설명을 입력해주세요.', 'warn');
            return;
        }
        genBtn.disabled = true;
        genBtn.textContent = '⏳ 생성 중...';
        try {
            const ok = await triggerUserImageGenerationAndSend(prompt);
            if (ok) {
                close();
            } else {
                showToast('이미지 생성에 실패했습니다.', 'error', 2000);
            }
        } catch (e) {
            showToast('이미지 생성 실패: ' + e.message, 'error');
        } finally {
            genBtn.disabled = false;
            genBtn.textContent = '🎨 이미지 생성';
        }
    };

    // Enter 키로 생성 (Shift+Enter는 줄바꿈)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !genBtn.disabled) {
            e.preventDefault();
            genBtn.click();
        }
    });

    // 자동 포커스
    requestAnimationFrame(() => input.focus());
}

/**
 * 음성메모 삽입 전용 패널을 연다 (퀵 액세스용)
 * 취소 시 전송 안 됨
 */
function openVoiceMemoPanel() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-settings-wrapper slm-form';

    const desc = document.createElement('p');
    desc.className = 'slm-desc';
    desc.textContent = '음성메시지 길이와 내용 힌트를 입력하세요.';
    wrapper.appendChild(desc);

    const durationLabel = document.createElement('label');
    durationLabel.className = 'slm-label';
    durationLabel.textContent = '길이(초)';
    wrapper.appendChild(durationLabel);

    const durationInput = document.createElement('input');
    durationInput.className = 'slm-input';
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.max = '600';
    durationInput.value = '30';
    durationInput.placeholder = '예: 30';
    wrapper.appendChild(durationInput);

    const hintLabel = document.createElement('label');
    hintLabel.className = 'slm-label';
    hintLabel.style.marginTop = '8px';
    hintLabel.textContent = '내용 힌트 (선택)';
    wrapper.appendChild(hintLabel);

    const hintInput = document.createElement('input');
    hintInput.className = 'slm-input';
    hintInput.type = 'text';
    hintInput.placeholder = '예: 오늘 늦겠다고';
    wrapper.appendChild(hintInput);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const sendBtn = document.createElement('button');
    sendBtn.className = 'slm-btn slm-btn-primary';
    sendBtn.textContent = '🎤 전송';

    footer.appendChild(cancelBtn);
    footer.appendChild(sendBtn);

    const { close } = createPopup({
        id: 'voice-memo-quick',
        title: '🎤 음성메모 삽입',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });

    cancelBtn.onclick = () => close();

    sendBtn.onclick = async () => {
        const secs = Math.max(1, Math.min(600, Number(durationInput.value) || 30));
        const hint = hintInput.value.trim();
        sendBtn.disabled = true;
        sendBtn.textContent = '⏳ 전송 중...';
        try {
            await triggerVoiceMemoInsertion(secs, hint);
            close();
        } catch (e) {
            showToast('음성메모 전송 실패: ' + e.message, 'error');
        } finally {
            sendBtn.disabled = false;
            sendBtn.textContent = '🎤 전송';
        }
    };

    // Enter 키로 전송
    hintInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !sendBtn.disabled) {
            e.preventDefault();
            sendBtn.click();
        }
    });

    requestAnimationFrame(() => durationInput.focus());
}

const QUICK_ACCESS_ITEMS = [
    { key: 'userImage', icon: '🎨', label: '유저 이미지 전송', moduleKey: 'quickTools', action: async () => {
        openUserImagePromptPopup();
    } },
    { key: 'callRequest', icon: '📞', label: '통화 요청', moduleKey: 'call', action: async () => { await requestActiveCharacterCall(); } },
    { key: 'contacts', icon: '📋', label: '연락처', action: () => { closePopup('quick-access-menu'); openContactsPopup(); } },
    { key: 'messengerRooms', icon: '💬', label: '메신저 방', action: () => { closePopup('quick-access-menu'); openMessengerRoomsPopup(); } },
    { key: 'divider', icon: '⏱️', label: '구분선 넣기', moduleKey: 'quickTools', action: () => { closePopup('quick-access-menu'); openQuickToolsPanel(); } },
    { key: 'readReceipt', icon: '🔕', label: '읽씹하기', moduleKey: 'quickTools', action: async () => { await triggerReadReceipt(); } },
    { key: 'noContact', icon: '📵', label: '연락 안 됨(안읽씹)', moduleKey: 'quickTools', action: async () => { await triggerNoContact(); } },
    { key: 'voiceMemo', icon: '🎤', label: '음성메모 삽입', moduleKey: 'quickTools', action: () => {
        openVoiceMemoPanel();
    } },
    { key: 'emoticon', icon: '😊', label: '이모티콘 열기', moduleKey: 'emoticon', action: () => openEmoticonPopup() },
    { key: 'deletedMessage', icon: '🚫', label: '삭제된 메시지', moduleKey: 'quickTools', action: async () => { await triggerDeletedMessage(); } },
    { key: 'sns', icon: '📸', label: 'SNS 들어가기', moduleKey: 'sns', action: () => openSnsPopup() },
    { key: 'quickSend', icon: '💌', label: '트리거 없이 메세지 전송', moduleKey: 'quickTools', action: async () => { await triggerQuickSend(); } },
    { key: 'snsImageToggle', icon: '🖼️', label: 'SNS 이미지 허용', isToggle: true, action: () => {
        const s = getSettings();
        s.snsImageMode = !s.snsImageMode;
        saveSettings();
        showToast(`SNS 이미지: ${s.snsImageMode ? 'ON' : 'OFF'}`, 'success', 1500);
    }, getToggleState: () => getSettings().snsImageMode === true },
    { key: 'messengerImageToggle', icon: '💬', label: '메신저 이미지 허용', isToggle: true, action: () => {
        const s = getSettings();
        s.messageImageGenerationMode = !s.messageImageGenerationMode;
        saveSettings();
        updateMessageImageInjection();
        showToast(`메신저 이미지: ${s.messageImageGenerationMode ? 'ON' : 'OFF'}`, 'success', 1500);
    }, getToggleState: () => getSettings().messageImageGenerationMode === true },
    { key: 'dayNightToggle', icon: '🌓', label: '주간/야간 모드', isToggle: true, action: () => {
        const next = cycleTheme();
        const label = next === 'light' ? '주간 모드' : '야간 모드';
        showToast(`테마: ${label}`, 'success', 1200);
    }, getToggleState: () => getEffectiveTheme() === 'dark' },
    { key: 'settingsShortcut', icon: '⚙️', label: '설정', action: () => {
        closePopup('quick-access-menu');
        openSettingsPanel();
    } },
];

function getOrderedQuickAccessItems(includeDisabled = false) {
    const settings = getSettings();
    const itemMap = new Map(QUICK_ACCESS_ITEMS.map(item => [item.key, item]));
    const order = Array.isArray(settings.quickAccess?.order) ? settings.quickAccess.order : [];
    const orderedKeys = [...order, ...QUICK_ACCESS_ITEMS.map(item => item.key)]
        .filter((key, idx, arr) => key && arr.indexOf(key) === idx);
    return orderedKeys
        .map(key => itemMap.get(key))
        .filter(Boolean)
        .filter((item) => includeDisabled || settings.quickAccess?.items?.[item.key] !== false)
        .filter((item) => !item.moduleKey || isModuleEnabled(item.moduleKey));
}

function openQuickAccessPopup() {
    const settings = getSettings();
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-settings-wrapper slm-form';
    const mainBtn = document.createElement('button');
    mainBtn.className = 'slm-btn slm-btn-primary';
    mainBtn.textContent = '📱 메인패널로 이동';
    mainBtn.onclick = () => {
        closePopup('quick-access-menu');
        openMainMenuPopup();
    };
    wrapper.appendChild(mainBtn);
    const quickItems = settings.quickAccess?.enabled ? getOrderedQuickAccessItems() : [];
    const columns = settings.quickAccess?.columns || 1;
    const displayMode = settings.quickAccess?.displayMode || 'full';
    const customLabels = settings.quickAccess?.customLabels || {};
    const customImages = settings.quickAccess?.customImages || {};
    const iconSize = Math.max(16, Math.min(64, Number(settings.quickAccess?.iconSize) || 24));
    const labelFontSize = Math.max(8, Math.min(24, Number(settings.quickAccess?.labelFontSize) || 14));
    if (quickItems.length > 0) {
        const listContainer = document.createElement('div');
        listContainer.className = 'slm-qa-column-container';
        const grid = document.createElement('div');
        grid.className = `slm-qa-grid slm-qa-cols-${columns}`;
        grid.style.setProperty('--slm-qa-icon-size', `${iconSize}px`);
        grid.style.setProperty('--slm-qa-label-font-size', `${labelFontSize}px`);
        quickItems.forEach((item) => {
            const btn = document.createElement('button');
            btn.className = `slm-qa-btn slm-qa-mode-${displayMode}`;
            const label = customLabels[item.key] || item.label;
            const imgUrl = normalizeQuickAccessImageUrl(customImages[item.key] || '');
            // Toggle items show ON/OFF state indicator
            const toggleSuffix = item.isToggle && typeof item.getToggleState === 'function'
                ? (item.getToggleState() ? ' ✅' : ' ❌') : '';
            const displayLabel = label + toggleSuffix;
            if (displayMode === 'emojiOnly') {
                if (imgUrl) {
                    btn.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(displayLabel)}" class="slm-qa-img">`;
                } else {
                    btn.innerHTML = `<span class="slm-qa-icon">${escapeHtml(item.icon)}</span>`;
                }
                btn.title = displayLabel;
            } else if (displayMode === 'labelOnly') {
                btn.textContent = displayLabel;
            } else {
                // full mode
                if (imgUrl) {
                    btn.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="" class="slm-qa-img"> <span>${escapeHtml(displayLabel)}</span>`;
                } else {
                    btn.innerHTML = `<span class="slm-qa-icon">${escapeHtml(item.icon)}</span> <span>${escapeHtml(displayLabel)}</span>`;
                }
            }
            btn.onclick = async () => {
                if (item.isToggle) {
                    // Toggle items: execute action without closing popup, then refresh popup
                    await item.action();
                    closePopup('quick-access-menu');
                    openQuickAccessPopup();
                } else {
                    closePopup('quick-access-menu');
                    await item.action();
                }
            };
            grid.appendChild(btn);
        });
        listContainer.appendChild(grid);
        wrapper.appendChild(listContainer);
    } else {
        wrapper.appendChild(Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: settings.quickAccess?.enabled === false
                ? '퀵 액세스가 비활성화되어 있습니다. 설정에서 다시 활성화할 수 있습니다.'
                : '표시할 퀵 액세스 항목이 없습니다.',
        }));
    }
    createPopup({
        id: 'quick-access-menu',
        title: '⚡ 퀵 액세스',
        content: wrapper,
        className: 'slm-sub-panel',
    });
}

function refreshQuickAccessFab() {
    if (document.getElementById('slm-overlay-quick-access-menu')) {
        closePopup('quick-access-menu');
    }
}

/**
 * 퀵 액세스 항목 중 rightSendFormItems에 등록된 것을 send_but 옆에 아이콘 버튼으로 삽입한다
 */
function injectRightSendFormIcons() {
    // 기존 삽입된 아이콘 제거
    document.querySelectorAll('.slm-rsf-icon').forEach(el => el.remove());
    if (!isEnabled()) return;

    const settings = getSettings();
    const rsfItems = settings.quickAccess?.rightSendFormItems || {};
    const activeKeys = Object.keys(rsfItems).filter(k => rsfItems[k]);
    if (activeKeys.length === 0) return;

    const sendBtn = document.getElementById('send_but');
    if (!sendBtn || !sendBtn.parentNode) return;

    const itemMap = new Map(QUICK_ACCESS_ITEMS.map(item => [item.key, item]));
    const customImages = settings.quickAccess?.customImages || {};

    activeKeys.forEach((key) => {
        const item = itemMap.get(key);
        if (!item) return;
        if (item.moduleKey && !isModuleEnabled(item.moduleKey)) return;

        const btn = document.createElement('button');
        btn.className = 'slm-rsf-icon interactable';
        btn.title = item.label;
        btn.setAttribute('aria-label', item.label);
        btn.setAttribute('tabindex', '0');
        const imgUrl = normalizeQuickAccessImageUrl(customImages[key] || '');
        if (imgUrl) {
            btn.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(item.label)}" style="width:20px;height:20px;object-fit:contain;border-radius:3px;">`;
        } else {
            btn.textContent = item.icon;
        }
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await item.action();
        });
        sendBtn.parentNode.insertBefore(btn, sendBtn);
    });
}

/**
 * ST-LifeSim 메인 메뉴 팝업을 연다
 */
function openMainMenuPopup() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-main-menu';

    const themeBtn = document.createElement('button');
    themeBtn.className = 'slm-theme-toggle-btn';

    function updateThemeBtn() {
        const t = getEffectiveTheme();
        if (t === 'light') {
            themeBtn.innerHTML = '<span class="slm-theme-toggle-icon">☀️</span><span class="slm-theme-toggle-label">주간</span>';
            themeBtn.title = '야간 모드로 전환';
        } else {
            themeBtn.innerHTML = '<span class="slm-theme-toggle-icon">🌙</span><span class="slm-theme-toggle-label">야간</span>';
            themeBtn.title = '주간 모드로 전환';
        }
    }
    updateThemeBtn();

    themeBtn.onclick = (e) => {
        e.stopPropagation();
        const newTheme = cycleTheme();
        updateThemeBtn();
        const label = newTheme === 'light' ? '주간 모드' : '야간 모드';
        showToast(`테마: ${label}`, 'success', 1200);
    };

    const grid = document.createElement('div');
    grid.className = 'slm-menu-grid';
    wrapper.appendChild(grid);

    const popup = createPopup({
        id: 'main-menu',
        title: '📱 ST-LifeSim',
        content: wrapper,
        className: 'slm-main-menu-panel',
    });
    const titleLeft = popup.panel.querySelector('.slm-panel-title-left');
    if (titleLeft) titleLeft.appendChild(themeBtn);

    const menuItems = [
        { key: 'quickTools', icon: '🛠️', label: '퀵 도구', action: openQuickToolsPanel },
        { key: null, icon: '💬', label: '메신저 방', action: openMessengerRoomsPopup },
        { key: 'emoticon', icon: '😊', label: '이모티콘', action: openEmoticonPopup },
        { key: 'contacts', icon: '📋', label: '연락처', action: openContactsPopup },
        { key: 'call', icon: '📞', label: '통화', action: openCallLogsPopup },
        { key: 'wallet', icon: '💰', label: '지갑', action: openWalletPopup },
        { key: 'gifticon', icon: '🎁', label: '기프티콘', action: openGifticonPopup },
        { key: 'sns', icon: '📸', label: 'SNS', action: openSnsPopup },
        { key: 'calendar', icon: '📅', label: '캘린더', action: openCalendarPopup },
        { key: null, icon: '⚙️', label: '설정', action: openSettingsPanel },
    ];

    menuItems.filter(item => item.key === null || isModuleEnabled(item.key)).forEach(item => {
        const itemBtn = document.createElement('button');
        itemBtn.className = 'slm-menu-item';
        itemBtn.innerHTML = `<span class="slm-menu-icon">${item.icon}</span><span class="slm-menu-label">${item.label}</span>`;
        itemBtn.onclick = () => {
            popup.close();
            item.action(openMainMenuPopup);
        };
        grid.appendChild(itemBtn);
    });
}

/**
 * 퀵 도구 패널을 연다 (시간구분선, 읽씹, 연락안됨, 사건생성, 음성메모)
 */
function openQuickToolsPanel(onBack) {
    const tabs = createTabs([
        {
            key: 'divider',
            label: '⏱️ 구분선',
            content: renderTimeDividerUI(),
        },
        {
            key: 'read',
            label: '👻 읽씹/안읽씹',
            content: (() => {
                const c = document.createElement('div');
                c.appendChild(renderReadReceiptUI());
                c.appendChild(renderNoContactUI());
                return c;
            })(),
        },
        {
            key: 'event',
            label: '⚡ 사건 발생',
            content: renderEventGeneratorUI(),
        },
        {
            key: 'media',
            label: '🎤 음성/사진',
            content: renderVoiceMemoUI(),
        },
    ], 'divider');

    createPopup({
        id: 'quick-tools',
        title: '🛠️ 퀵 도구',
        content: tabs,
        className: 'slm-quick-panel',
        onBack,
    });
}

/**
 * 설정 패널을 연다 (탭 분리: 일반 / 모듈 / 이모티콘·SNS / 테마)
 */
function clampPercentage(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, parsed));
}

function getGroupChatRuntimeSettings() {
    const raw = getSettings().groupChat || {};
    return {
        enabled: raw.enabled === true,
        responseProbability: clampPercentage(raw.responseProbability, GROUP_CHAT_SETTINGS_DEFAULTS.responseProbability),
        extraResponseProbability: clampPercentage(raw.extraResponseProbability, GROUP_CHAT_SETTINGS_DEFAULTS.extraResponseProbability),
        maxResponsesPerTurn: Math.max(1, Math.min(3, Number.parseInt(raw.maxResponsesPerTurn, 10) || GROUP_CHAT_SETTINGS_DEFAULTS.maxResponsesPerTurn)),
        includeMainCharacter: raw.includeMainCharacter !== false,
        contactOnlyProbability: clampPercentage(raw.contactOnlyProbability, GROUP_CHAT_SETTINGS_DEFAULTS.contactOnlyProbability),
    };
}

function buildGroupChatContactPool() {
    const allContacts = [...getContacts('character'), ...getContacts('chat')];
    const seen = new Set();
    return allContacts.filter((contact) => {
        const key = String(contact?.id || contact?.name || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return contact?.groupChatParticipant === true && !contact?.isUserAuto && !contact?.isCharAuto;
    });
}

function buildGroupChatRosterEntries(settings) {
    const ctx = getContext();
    const roster = [];
    if (ctx?.name1) {
        roster.push({
            type: 'user',
            name: ctx.name1,
            displayName: ctx.name1,
            relationToUser: '본인 (인간 플레이어)',
            relationToChar: '',
            personality: '',
            description: GROUP_CHAT_USER_DESCRIPTION,
            avatar: '',
        });
    }
    if (settings.includeMainCharacter && ctx?.name2) {
        roster.push({
            type: 'char',
            name: ctx.name2,
            displayName: ctx.name2,
            relationToUser: '현재 대화 상대',
            relationToChar: '',
            personality: String(ctx.characters?.[ctx.characterId]?.personality || '').trim(),
            description: String(ctx.characters?.[ctx.characterId]?.description || '').trim(),
            avatar: ctx.characters?.[ctx.characterId]?.avatar
                ? `/characters/${ctx.characters[ctx.characterId].avatar}`
                : '',
        });
    }
    buildGroupChatContactPool().forEach((contact) => {
        roster.push({
            type: 'contact',
            name: contact.name,
            displayName: contact.displayName || contact.name,
            relationToUser: contact.relationToUser,
            relationToChar: contact.relationToChar,
            personality: contact.personality,
            description: contact.description,
            avatar: contact.avatar,
        });
    });
    return roster;
}

function buildGroupChatContactRoster() {
    return buildGroupChatContactPool().map((contact) => ({
        type: 'contact',
        name: contact.name,
        displayName: contact.displayName || contact.name,
        relationToUser: contact.relationToUser,
        relationToChar: contact.relationToChar,
        personality: contact.personality,
        description: contact.description,
        avatar: contact.avatar,
    }));
}

function normalizeGroupChatText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeGroupChatPromptField(value) {
    return normalizeGroupChatText(value)
        .replace(/[<>{}\[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Cleans up a group-chat response and keeps only the responder's message when other speakers leak in.
 * @param {string} text
 * @param {string} responderName
 * @param {Array<{ name?: string, displayName?: string }>} [roster]
 * @returns {string}
 */
function sanitizeGroupChatReply(text, responderName, roster = []) {
    // 응답 텍스트를 정리하고, 모델이 붙인 화자명/불필요한 접두어를 함께 제거한다.
    let cleaned = normalizeGroupChatText(text);
    if (!cleaned) return '';
    const escapedName = escapeRegex(responderName);
    const prefixPatterns = [
        new RegExp(`^${escapedName}\\s*[:：-]\\s*`, 'i'),
        /^\s*(?:reply|response)\s*[:：-]\s*/i,
    ];
    prefixPatterns.forEach((pattern) => {
        cleaned = cleaned.replace(pattern, '');
    });
    const ctx = getContext();
    const participantNames = [
        responderName,
        ctx?.name1,
        ctx?.name2,
        ...roster.map((entry) => entry?.displayName || entry?.name),
    ]
        .map((name) => String(name || '').trim())
        .filter(Boolean);
    const uniqueNames = [...new Set(participantNames)];
    let earliestForeignSpeakerIndex = -1;
    uniqueNames
        .filter((name) => name.toLowerCase() !== String(responderName || '').trim().toLowerCase())
        .sort((a, b) => b.length - a.length)
        .forEach((name) => {
            const escaped = escapeRegex(name);
            const match = cleaned.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*[:：-]\\s*`, 'i'));
            if (!match) return;
            const index = match.index !== undefined ? match.index : -1;
            if (earliestForeignSpeakerIndex === -1 || index < earliestForeignSpeakerIndex) {
                earliestForeignSpeakerIndex = index;
            }
        });
    if (earliestForeignSpeakerIndex === 0) {
        console.error(GROUP_CHAT_FOREIGN_SPEAKER_WARNING, {
            responderName,
            raw: text,
            guidance: 'Check the responder profile/personality data and the recent group-room recap if the model keeps speaking as another participant.',
        });
        return '';
    }
    if (earliestForeignSpeakerIndex > 0) {
        cleaned = cleaned.slice(0, earliestForeignSpeakerIndex).trim();
    }
    cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    return cleaned;
}

function buildGroupChatTranscript(limit = GROUP_CHAT_TRANSCRIPT_LIMIT) {
    const ctx = getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    // 최근 일부 발화만 사용해 단톡방 맥락은 유지하되 1:1 대화 스타일 오염을 줄인다.
    return chat.slice(-limit).map((msg) => {
        const speaker = msg?.is_user
            ? (ctx?.name1 || '{{user}}')
            : (msg?.name || ctx?.name2 || '{{char}}');
        const text = sanitizeGroupChatPromptField(msg?.mes || '').replace(/\n/g, ' ');
        return `[group-room] ${speaker}: ${text}`;
    }).join('\n');
}

async function enrichGroupChatReplyContent(text, senderName, transcript) {
    const settings = getSettings();
    const normalizedSource = normalizeQuotesForPicTag(String(text || ''));
    PIC_TAG_REGEX.lastIndex = 0;
    const picMatches = [...normalizedSource.matchAll(PIC_TAG_REGEX)];
    let currentMes = normalizedSource;
    const imagePlaceholders = new Map();
    let imageCounter = 0;
    if (picMatches.length > 0) {
        const limitedPicMatches = picMatches.slice(0, MAX_MESSENGER_IMAGES_PER_RESPONSE);
        const limitedSet = new Set(limitedPicMatches.map((match) => match.index));
        const ctx = getContext();
        const userName = ctx?.name1 || '';
        const allContactsList = [...getContacts('character'), ...getContacts('chat')];
        let offset = 0;
        for (const match of picMatches) {
            const fullTag = match[0];
            const rawPrompt = (match[1] || match[2] || '').trim();
            const adjustedIndex = match.index + offset;
            let replacement = '';
            if (rawPrompt) {
                if (limitedSet.has(match.index) && !isCallActive() && settings.messageImageGenerationMode) {
                    const includeNames = [senderName];
                    collectMentionedContactNames(`${transcript}\n${rawPrompt}`, allContactsList).forEach((name) => {
                        if (name && !includeNames.includes(name)) includeNames.push(name);
                    });
                    const userHintRegex = /\buser\b|{{user}}|유저|너|당신|with user|together|둘이|함께/;
                    if (userName && userHintRegex.test(rawPrompt.toLowerCase())) includeNames.push(userName);
                    const result = await processMessengerImageGeneration(rawPrompt, {
                        charName: senderName,
                        includeNames,
                        contacts: allContactsList,
                        settings,
                    });
                    if (result.imageUrl) {
                        const safeUrl = escapeHtml(result.imageUrl);
                        const safePrompt = escapeHtml(rawPrompt);
                        const placeholder = `__GROUP_IMG_${imageCounter++}__`;
                        imagePlaceholders.set(placeholder, `<img src="${safeUrl}" title="${safePrompt}" alt="${safePrompt}" class="slm-msg-generated-image" style="max-width:100%;border-radius:var(--slm-image-radius,10px);margin:4px 0">`);
                        replacement = placeholder;
                    } else {
                        replacement = result.fallbackText;
                    }
                } else {
                    const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
                    replacement = template.replace(/\{description\}/g, rawPrompt);
                }
            }
            currentMes = currentMes.slice(0, adjustedIndex) + replacement + currentMes.slice(adjustedIndex + fullTag.length);
            offset += replacement.length - fullTag.length;
        }
    }
    let richHtml = replaceAiSelectedEmoticons(escapeHtml(currentMes).replace(/\n/g, '<br>'), senderName);
    imagePlaceholders.forEach((imageHtml, placeholder) => {
        richHtml = richHtml.replace(new RegExp(placeholder, 'g'), imageHtml);
    });
    return wrapRichMessageHtml(richHtml);
}

async function generateGroupChatReply(responder, roster) {
    const ctx = getContext();
    if (!ctx) return '';
    const settings = getSettings();
    const transcript = buildGroupChatTranscript();
    const responderName = sanitizeGroupChatPromptField(responder.displayName || responder.name);
    const latestUserMessage = sanitizeGroupChatPromptField(ctx?.chat?.[ctx.chat.length - 1]?.mes || '');
    const emoticonContext = buildAiEmoticonContext(responderName);
    const rosterText = roster.map((entry) => {
        const details = [];
        if (entry.relationToUser) details.push(`Relation to {{user}}: ${sanitizeGroupChatPromptField(entry.relationToUser)}`);
        if (entry.relationToChar) details.push(`Relation to {{char}}: ${sanitizeGroupChatPromptField(entry.relationToChar)}`);
        if (entry.description) details.push(`Description: ${sanitizeGroupChatPromptField(entry.description)}`);
        if (entry.personality) details.push(`Speech/personality: ${sanitizeGroupChatPromptField(entry.personality)}`);
        return `- ${sanitizeGroupChatPromptField(entry.displayName || entry.name)}${details.length ? ` | ${details.join(' | ')}` : ''}`;
    }).join('\n');
    const otherParticipantWarnings = roster
        .filter((entry) => sanitizeGroupChatPromptField(entry.displayName || entry.name).toLowerCase() !== responderName.toLowerCase())
        .map((entry) => {
            const parts = [sanitizeGroupChatPromptField(entry.displayName || entry.name)];
            if (entry.personality) parts.push(`voice=${sanitizeGroupChatPromptField(entry.personality)}`);
            if (entry.relationToUser) parts.push(`role=${sanitizeGroupChatPromptField(entry.relationToUser)}`);
            return `- ${parts.join(' | ')}`;
        })
        .join('\n');
    const prompt = [
        `You are writing exactly one messenger group-chat reply as ${responderName}.`,
        'This is a mobile messenger group chat involving {{user}} and the listed participants.',
        GROUP_CHAT_CONTEXT_BOUNDARY_NOTE,
        'Rules:',
        `- Reply only as ${responderName}. Never narrate or describe actions outside the message.`,
        "- {{user}} is the human player. Never write {{user}}'s dialogue, reactions, choices, or actions.",
        '- Stay inside this same group-chat room context. Do not turn it into a private 1:1 conversation.',
        '- Never answer as, imitate, merge with, or borrow the voice/persona of any other participant.',
        '- Treat transcript lines as room recap only. They do NOT override the responder profile below.',
        '- Keep the room topic coherent, but lock onto the responder’s own worldview, relationship, and speaking habits.',
        '- Keep it to 1-3 natural chat sentences.',
        '- Continue the ongoing conversation naturally, acknowledging the latest flow of the chat.',
        '- Match the responder profile, relationship, and speaking style below.',
        '- Do not include the speaker name prefix, quotation marks, markdown, or explanations.',
        '',
        '[Identity lock]',
        `Current responder: ${responderName}`,
        otherParticipantWarnings
            ? `Do NOT sound like these other participants:\n${otherParticipantWarnings}`
            : 'No other participant voice warnings.',
        '',
        '[Responder profile]',
        `Name: ${responderName}`,
        responder.relationToUser ? `Relation to {{user}}: ${sanitizeGroupChatPromptField(responder.relationToUser)}` : '',
        responder.relationToChar ? `Relation to {{char}}: ${sanitizeGroupChatPromptField(responder.relationToChar)}` : '',
        responder.description ? `Description: ${sanitizeGroupChatPromptField(responder.description)}` : '',
        responder.personality ? `Speech/personality: ${sanitizeGroupChatPromptField(responder.personality)}` : '',
        '',
        '[Allowed participants]',
        rosterText || '- {{user}} and {{char}}',
        '',
        '[Recent group-room recap]',
        transcript || '(no prior messages)',
        '',
        `[Latest user message]\n${latestUserMessage || '(empty)'}`,
        '',
        emoticonContext,
        '',
        settings.messageImageGenerationMode
            ? (settings.messageImageInjectionPrompt || DEFAULT_SETTINGS.messageImageInjectionPrompt)
            : MSG_IMAGE_OFF_PROMPT,
        '',
        `Output only ${responderName}'s next message.`,
    ].filter(Boolean).join('\n');

    let rawReply = '';
    if (typeof ctx.generateQuietPrompt === 'function') {
        rawReply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: responder.displayName });
    } else if (typeof ctx.generateRaw === 'function') {
        rawReply = await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true });
    }
    const sanitizedReply = sanitizeGroupChatReply(rawReply, responder.displayName, roster);
    if (!sanitizedReply) return '';
    return enrichGroupChatReplyContent(sanitizedReply, responderName, transcript);
}

function pickRandomGroupResponder(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function selectGroupChatContacts(candidates, settings) {
    const responders = [];
    const pool = [...candidates];
    const firstResponder = pickRandomGroupResponder(pool);
    if (!firstResponder) return responders;
    responders.push(firstResponder);
    const firstIndex = pool.findIndex((entry) => entry.name === firstResponder.name && entry.type === firstResponder.type);
    if (firstIndex !== -1) pool.splice(firstIndex, 1);

    while (responders.length < settings.maxResponsesPerTurn && pool.length > 0) {
        if (Math.random() >= (settings.extraResponseProbability / 100)) break;
        const nextResponder = pickRandomGroupResponder(pool);
        if (!nextResponder) break;
        responders.push(nextResponder);
        const nextIndex = pool.findIndex((entry) => entry.name === nextResponder.name && entry.type === nextResponder.type);
        if (nextIndex !== -1) pool.splice(nextIndex, 1);
    }
    return responders;
}

function shouldSuppressMainCharacter(settings) {
    if (settings.includeMainCharacter !== true) return true;
    return Math.random() < (settings.contactOnlyProbability / 100);
}

function planGroupChatTurn() {
    const settings = getGroupChatRuntimeSettings();
    if (!settings.enabled) return null;
    const ctx = getContext();
    const latestMessage = ctx?.chat?.[ctx.chat.length - 1];
    if (!latestMessage?.is_user) return null;
    const latestText = normalizeGroupChatText(latestMessage.mes || '');
    if (!latestText || latestText.startsWith('/')) return null;

    const roster = buildGroupChatRosterEntries(settings);
    const contactRoster = buildGroupChatContactRoster();
    if (roster.length === 0 || contactRoster.length === 0) return null;
    if (Math.random() >= (settings.responseProbability / 100)) return null;

    const suppressMainCharacterReply = shouldSuppressMainCharacter(settings);
    const responders = selectGroupChatContacts(contactRoster, settings);
    if (responders.length === 0) return null;

    return {
        userMessageIndex: Number(ctx.chat.length - 1),
        suppressMainCharacterReply,
        responders,
        roster,
    };
}

let pendingGroupChatTurn = null;
let isGroupChatExecutionInFlight = false;
let pendingGroupChatTimeoutId = null;

function clearScheduledGroupChatTurn() {
    if (pendingGroupChatTimeoutId) {
        clearTimeout(pendingGroupChatTimeoutId);
        pendingGroupChatTimeoutId = null;
    }
}

function schedulePlannedGroupChatTurn(plan) {
    clearScheduledGroupChatTurn();
    if (!plan) return;
    const delay = GROUP_CHAT_REPLY_DELAY_MIN_MS + Math.floor(Math.random() * (GROUP_CHAT_REPLY_DELAY_MAX_MS - GROUP_CHAT_REPLY_DELAY_MIN_MS));
    pendingGroupChatTimeoutId = setTimeout(async () => {
        pendingGroupChatTimeoutId = null;
        if (isGroupChatExecutionInFlight) return;
        isGroupChatExecutionInFlight = true;
        try {
            await executePlannedGroupChatTurn(plan);
        } catch (error) {
            console.error('[ST-LifeSim] 단톡 자동 응답 오류:', error);
        } finally {
            isGroupChatExecutionInFlight = false;
        }
    }, delay);
}

async function executePlannedGroupChatTurn(plan) {
    if (!plan?.responders?.length) return;
    const ctx = getContext();
    if (!ctx) return;
    const latestIdx = Number((ctx.chat?.length ?? 0) - 1);
    if (!Number.isFinite(latestIdx) || latestIdx <= Number(plan.userMessageIndex)) return;
    if (!ctx.chat?.[plan.userMessageIndex]?.is_user) return;

    if (plan.suppressMainCharacterReply) {
        const latestMsg = ctx.chat?.[latestIdx];
        const canDeleteLastReply = Number.isFinite(latestIdx)
            && latestIdx >= 0
            && latestMsg
            && !latestMsg.is_user
            && typeof ctx.executeSlashCommandsWithOptions === 'function';
        if (canDeleteLastReply) {
            await ctx.executeSlashCommandsWithOptions(`/cut ${latestIdx}`, { showOutput: false });
        }
    }

    const userName = String(ctx?.name1 || '{{user}}').trim().toLowerCase();
    for (const responder of plan.responders) {
        const responderNames = [responder?.displayName, responder?.name]
            .map((name) => String(name || '').trim().toLowerCase())
            .filter(Boolean);
        if (userName && responderNames.includes(userName)) continue;
        const reply = await generateGroupChatReply(responder, plan.roster);
        if (!reply) continue;
        await slashSendAs(responder.displayName || responder.name, reply);
    }
}

function openSettingsPanel(onBack) {
    const settings = getSettings();

    // ─────────────────────────────────────────
    // 탭 1: 일반 설정
    // ─────────────────────────────────────────
    function buildGeneralTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        // 전체 활성화/비활성화
        const enabledRow = document.createElement('div');
        enabledRow.className = 'slm-settings-row';
        const enabledLabel = document.createElement('label');
        enabledLabel.className = 'slm-toggle-label';
        const enabledCheck = document.createElement('input');
        enabledCheck.type = 'checkbox';
        enabledCheck.checked = settings.enabled !== false;
        enabledCheck.onchange = () => {
            settings.enabled = enabledCheck.checked;
            saveSettings();
            updateMessageImageInjection();
            if (!settings.enabled) {
                clearContext();
                document.querySelectorAll('.slm-rsf-icon').forEach(el => el.remove());
                showToast('ST-LifeSim 비활성화됨', 'info');
            } else {
                injectLifeSimMenuButton();
                injectRightSendFormIcons();
                showToast('ST-LifeSim 활성화됨', 'success');
            }
            syncQuickSendButtons();
        };
        enabledLabel.appendChild(enabledCheck);
        enabledLabel.appendChild(document.createTextNode(' 라이프심 활성화'));
        enabledRow.appendChild(enabledLabel);
        wrapper.appendChild(enabledRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        // 데이터 내보내기 / 가져오기
        const dataTitle = document.createElement('div');
        dataTitle.className = 'slm-label';
        dataTitle.textContent = '💾 데이터 백업 / 복원';
        dataTitle.style.fontWeight = '600';
        dataTitle.style.marginBottom = '6px';
        wrapper.appendChild(dataTitle);

        const dataBtnRow = document.createElement('div');
        dataBtnRow.className = 'slm-btn-row';

        const exportBtn = document.createElement('button');
        exportBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        exportBtn.textContent = '📤 내보내기';
        exportBtn.onclick = () => {
            try {
                const json = exportAllData();
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `st-lifesim-backup-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast('데이터 내보내기 완료', 'success');
            } catch (e) {
                showToast('내보내기 실패: ' + e.message, 'error');
            }
        };

        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json';
        importInput.style.display = 'none';
        importInput.onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                importAllData(text);
                showToast('데이터 가져오기 완료. 페이지를 새로고침하세요.', 'success', 4000);
            } catch (err) {
                showToast('가져오기 실패: ' + err.message, 'error');
            }
            importInput.value = '';
        };

        const importBtn = document.createElement('button');
        importBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        importBtn.textContent = '📥 가져오기';
        importBtn.onclick = () => importInput.click();

        dataBtnRow.appendChild(exportBtn);
        dataBtnRow.appendChild(importBtn);
        dataBtnRow.appendChild(importInput);
        wrapper.appendChild(dataBtnRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        // ── 확률 설정 (기존 확률 탭에서 통합) ──
        const probTitle = document.createElement('div');
        probTitle.className = 'slm-label';
        probTitle.textContent = '🎲 확률 설정';
        probTitle.style.fontWeight = '600';
        probTitle.style.marginBottom = '6px';
        wrapper.appendChild(probTitle);

        wrapper.appendChild(renderFirstMsgSettingsUI(settings, saveSettings));
        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        const groupChatTitle = document.createElement('div');
        groupChatTitle.className = 'slm-label';
        groupChatTitle.textContent = '💬 단톡 / 메신저 방';
        groupChatTitle.style.fontWeight = '600';
        groupChatTitle.style.marginBottom = '6px';
        wrapper.appendChild(groupChatTitle);

        const groupChatPreview = document.createElement('div');
        groupChatPreview.className = 'slm-phone-preview';
        const groupChatPreviewHeader = document.createElement('div');
        groupChatPreviewHeader.className = 'slm-phone-preview-header';
        groupChatPreviewHeader.textContent = '단톡방 미리보기';
        const groupChatPreviewBody = document.createElement('div');
        groupChatPreviewBody.className = 'slm-phone-preview-body';
        const previewUserBubble = document.createElement('div');
        previewUserBubble.className = 'slm-phone-bubble slm-phone-bubble-user';
        previewUserBubble.textContent = GROUP_CHAT_PREVIEW_USER_TEXT;
        const previewNpcBubble = document.createElement('div');
        previewNpcBubble.className = 'slm-phone-bubble';
        previewNpcBubble.textContent = GROUP_CHAT_PREVIEW_NPC_TEXT;
        const previewInput = document.createElement('div');
        previewInput.className = 'slm-phone-inputbar';
        previewInput.textContent = '메시지 입력…   •   전송';
        groupChatPreviewBody.append(previewUserBubble, previewNpcBubble, previewInput);
        groupChatPreview.append(groupChatPreviewHeader, groupChatPreviewBody);
        wrapper.appendChild(groupChatPreview);

        const groupChatDesc = document.createElement('div');
        groupChatDesc.className = 'slm-desc';
        groupChatDesc.textContent = GROUP_CHAT_DESCRIPTION_TEXT;
        wrapper.appendChild(groupChatDesc);

        const roomPopupBtn = document.createElement('button');
        roomPopupBtn.className = 'slm-btn slm-btn-primary';
        roomPopupBtn.textContent = '📱 실제 메신저 방 열기';
        roomPopupBtn.onclick = () => openMessengerRoomsPopup(openSettingsPanel);
        wrapper.appendChild(roomPopupBtn);

        const roomPopupDesc = document.createElement('div');
        roomPopupDesc.className = 'slm-desc';
        roomPopupDesc.textContent = '권장 방식: 유저가 방 멤버를 직접 골라 별도 메신저 방을 만들고, 그 방 안에서만 단톡 흐름을 진행합니다. 아래 설정은 레거시 자동 단톡용입니다.';
        wrapper.appendChild(roomPopupDesc);

        const helperToggleRow = document.createElement('div');
        helperToggleRow.className = 'slm-settings-row';
        const helperToggleLabel = document.createElement('label');
        helperToggleLabel.className = 'slm-toggle-label';
        const helperToggle = document.createElement('input');
        helperToggle.type = 'checkbox';
        helperToggle.checked = settings.hideHelperText === true;
        helperToggle.onchange = () => {
            settings.hideHelperText = helperToggle.checked;
            saveSettings();
            showToast(`도움말/안내: ${settings.hideHelperText ? '표시 안 함' : '표시'}`, 'success', 1500);
        };
        helperToggleLabel.append(helperToggle, document.createTextNode(' 도움말 / 안내 문구 표시 안 함'));
        helperToggleRow.appendChild(helperToggleLabel);
        wrapper.appendChild(helperToggleRow);

        const groupChatToggleRow = document.createElement('div');
        groupChatToggleRow.className = 'slm-settings-row';
        const groupChatToggleLabel = document.createElement('label');
        groupChatToggleLabel.className = 'slm-toggle-label';
        const groupChatToggle = document.createElement('input');
        groupChatToggle.type = 'checkbox';
        groupChatToggle.checked = settings.groupChat?.enabled === true;
        groupChatToggle.onchange = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            settings.groupChat.enabled = groupChatToggle.checked;
            saveSettings();
            showToast(`단톡 자동 응답: ${settings.groupChat.enabled ? 'ON' : 'OFF'}`, 'success', 1500);
        };
        groupChatToggleLabel.append(groupChatToggle, document.createTextNode(' 레거시 자동 단톡 응답 사용 (권장: 위 메신저 방 기능)'));
        groupChatToggleRow.appendChild(groupChatToggleLabel);
        wrapper.appendChild(groupChatToggleRow);

        const groupChatCharRow = document.createElement('div');
        groupChatCharRow.className = 'slm-settings-row';
        const groupChatCharLabel = document.createElement('label');
        groupChatCharLabel.className = 'slm-toggle-label';
        const groupChatCharToggle = document.createElement('input');
        groupChatCharToggle.type = 'checkbox';
        groupChatCharToggle.checked = settings.groupChat?.includeMainCharacter !== false;
        groupChatCharToggle.onchange = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            settings.groupChat.includeMainCharacter = groupChatCharToggle.checked;
            saveSettings();
        };
        groupChatCharLabel.append(groupChatCharToggle, document.createTextNode(' 기본 {{char}}도 단톡 자동 응답 후보에 포함'));
        groupChatCharRow.appendChild(groupChatCharLabel);
        wrapper.appendChild(groupChatCharRow);

        const groupChatProbRow = document.createElement('div');
        groupChatProbRow.className = 'slm-input-row';
        groupChatProbRow.style.marginTop = '8px';
        const groupChatProbLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '첫 단톡 응답 확률:' });
        const groupChatProbInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm',
            type: 'number',
            min: '0',
            max: '100',
            value: String(settings.groupChat?.responseProbability ?? GROUP_CHAT_SETTINGS_DEFAULTS.responseProbability),
        });
        groupChatProbInput.style.width = '70px';
        const groupChatProbPctLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '%' });
        const groupChatProbApplyBtn = document.createElement('button');
        groupChatProbApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        groupChatProbApplyBtn.textContent = '적용';
        groupChatProbApplyBtn.onclick = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            const val = parseInt(groupChatProbInput.value, 10);
            settings.groupChat.responseProbability = Math.max(0, Math.min(100, Number.isNaN(val) ? GROUP_CHAT_SETTINGS_DEFAULTS.responseProbability : val));
            groupChatProbInput.value = String(settings.groupChat.responseProbability);
            saveSettings();
            showToast(`단톡 첫 응답 확률: ${settings.groupChat.responseProbability}%`, 'success', 1500);
        };
        groupChatProbRow.append(groupChatProbLbl, groupChatProbInput, groupChatProbPctLbl, groupChatProbApplyBtn);
        wrapper.appendChild(groupChatProbRow);

        const groupChatExtraRow = document.createElement('div');
        groupChatExtraRow.className = 'slm-input-row';
        groupChatExtraRow.style.marginTop = '8px';
        const groupChatExtraLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '추가 단톡 응답 확률:' });
        const groupChatExtraInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm',
            type: 'number',
            min: '0',
            max: '100',
            value: String(settings.groupChat?.extraResponseProbability ?? GROUP_CHAT_SETTINGS_DEFAULTS.extraResponseProbability),
        });
        groupChatExtraInput.style.width = '70px';
        const groupChatExtraPctLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '%' });
        const groupChatExtraApplyBtn = document.createElement('button');
        groupChatExtraApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        groupChatExtraApplyBtn.textContent = '적용';
        groupChatExtraApplyBtn.onclick = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            const val = parseInt(groupChatExtraInput.value, 10);
            settings.groupChat.extraResponseProbability = Math.max(0, Math.min(100, Number.isNaN(val) ? GROUP_CHAT_SETTINGS_DEFAULTS.extraResponseProbability : val));
            groupChatExtraInput.value = String(settings.groupChat.extraResponseProbability);
            saveSettings();
            showToast(`단톡 추가 응답 확률: ${settings.groupChat.extraResponseProbability}%`, 'success', 1500);
        };
        groupChatExtraRow.append(groupChatExtraLbl, groupChatExtraInput, groupChatExtraPctLbl, groupChatExtraApplyBtn);
        wrapper.appendChild(groupChatExtraRow);

        const groupChatContactOnlyRow = document.createElement('div');
        groupChatContactOnlyRow.className = 'slm-input-row';
        groupChatContactOnlyRow.style.marginTop = '8px';
        const groupChatContactOnlyLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '연락처만 응답 확률:' });
        const groupChatContactOnlyInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm',
            type: 'number',
            min: '0',
            max: '100',
            value: String(settings.groupChat?.contactOnlyProbability ?? GROUP_CHAT_SETTINGS_DEFAULTS.contactOnlyProbability),
        });
        groupChatContactOnlyInput.style.width = '70px';
        const groupChatContactOnlyPctLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '%' });
        const groupChatContactOnlyApplyBtn = document.createElement('button');
        groupChatContactOnlyApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        groupChatContactOnlyApplyBtn.textContent = '적용';
        groupChatContactOnlyApplyBtn.onclick = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            const val = parseInt(groupChatContactOnlyInput.value, 10);
            settings.groupChat.contactOnlyProbability = Math.max(0, Math.min(100, Number.isNaN(val) ? GROUP_CHAT_SETTINGS_DEFAULTS.contactOnlyProbability : val));
            groupChatContactOnlyInput.value = String(settings.groupChat.contactOnlyProbability);
            saveSettings();
            showToast(`연락처만 응답 확률: ${settings.groupChat.contactOnlyProbability}%`, 'success', 1500);
        };
        groupChatContactOnlyRow.append(groupChatContactOnlyLbl, groupChatContactOnlyInput, groupChatContactOnlyPctLbl, groupChatContactOnlyApplyBtn);
        wrapper.appendChild(groupChatContactOnlyRow);

        const groupChatMaxRow = document.createElement('div');
        groupChatMaxRow.className = 'slm-input-row';
        groupChatMaxRow.style.marginTop = '8px';
        const groupChatMaxLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '한 턴 최대 응답 수:' });
        const groupChatMaxInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm',
            type: 'number',
            min: '1',
            max: '3',
            value: String(settings.groupChat?.maxResponsesPerTurn ?? GROUP_CHAT_SETTINGS_DEFAULTS.maxResponsesPerTurn),
        });
        groupChatMaxInput.style.width = '70px';
        const groupChatMaxApplyBtn = document.createElement('button');
        groupChatMaxApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        groupChatMaxApplyBtn.textContent = '적용';
        groupChatMaxApplyBtn.onclick = () => {
            if (!settings.groupChat) settings.groupChat = { ...GROUP_CHAT_SETTINGS_DEFAULTS };
            const val = parseInt(groupChatMaxInput.value, 10);
            settings.groupChat.maxResponsesPerTurn = Math.max(1, Math.min(3, Number.isNaN(val) ? GROUP_CHAT_SETTINGS_DEFAULTS.maxResponsesPerTurn : val));
            groupChatMaxInput.value = String(settings.groupChat.maxResponsesPerTurn);
            saveSettings();
            showToast(`단톡 최대 응답 수: ${settings.groupChat.maxResponsesPerTurn}`, 'success', 1500);
        };
        groupChatMaxRow.append(groupChatMaxLbl, groupChatMaxInput, groupChatMaxApplyBtn);
        wrapper.appendChild(groupChatMaxRow);

        const groupChatHint = document.createElement('div');
        groupChatHint.className = 'slm-label';
        groupChatHint.style.fontSize = '12px';
        groupChatHint.style.opacity = '0.8';
        groupChatHint.style.marginTop = '6px';
        groupChatHint.textContent = '연락처만 응답 확률이 발동하면 이번 턴의 기본 {{char}} 응답은 지우고, 체크된 연락처가 무작위로 답합니다.';
        wrapper.appendChild(groupChatHint);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        const snsProbRow = document.createElement('div');
        snsProbRow.className = 'slm-input-row';
        const snsProbLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: 'SNS 자동 생성 확률:' });
        const snsProbInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '100',
            value: String(settings.snsPostingProbability ?? 10),
        });
        snsProbInput.style.width = '70px';
        const snsProbPctLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '%' });
        const snsProbApplyBtn = document.createElement('button');
        snsProbApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        snsProbApplyBtn.textContent = '적용';
        snsProbApplyBtn.onclick = () => {
            const val = parseInt(snsProbInput.value);
            settings.snsPostingProbability = Math.max(0, Math.min(100, isNaN(val) ? 10 : val));
            snsProbInput.value = String(settings.snsPostingProbability);
            saveSettings();
            showToast(`SNS 자동 생성 확률: ${settings.snsPostingProbability}%`, 'success', 1500);
        };
        snsProbRow.append(snsProbLbl, snsProbInput, snsProbPctLbl, snsProbApplyBtn);
        wrapper.appendChild(snsProbRow);

        const callProbRow = document.createElement('div');
        callProbRow.className = 'slm-input-row';
        callProbRow.style.marginTop = '8px';
        const callProbLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '먼저 전화를 걸 확률:' });
        const callProbInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '100',
            value: String(settings.proactiveCallProbability ?? 0),
        });
        callProbInput.style.width = '70px';
        const callProbPctLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '%' });
        const callProbApplyBtn = document.createElement('button');
        callProbApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        callProbApplyBtn.textContent = '적용';
        callProbApplyBtn.onclick = () => {
            const val = parseInt(callProbInput.value);
            settings.proactiveCallProbability = Math.max(0, Math.min(100, isNaN(val) ? 0 : val));
            callProbInput.value = String(settings.proactiveCallProbability);
            saveSettings();
            showToast(`선전화 확률: ${settings.proactiveCallProbability}%`, 'success', 1500);
        };
        callProbRow.append(callProbLbl, callProbInput, callProbPctLbl, callProbApplyBtn);
        wrapper.appendChild(callProbRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        const resetBtn = document.createElement('button');
        resetBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
        resetBtn.style.marginTop = '10px';
        resetBtn.textContent = '🧹 확장 설정 기본값으로 초기화';
        resetBtn.onclick = async () => {
            const confirmed = await showConfirm('진짜 초기화하시겠습니까?', '예', '아니오');
            if (!confirmed) return;
            clearAllData();
            localStorage.removeItem(THEME_STORAGE_KEY);
            const ext = getExtensionSettings();
            if (ext && ext[SETTINGS_KEY]) {
                delete ext[SETTINGS_KEY];
            }
            saveSettings();
            showToast('ST-LifeSim 설정/데이터가 초기화되었습니다. 새로고침합니다.', 'success', 1800);
            setTimeout(() => location.reload(), 2000);
        };
        wrapper.appendChild(resetBtn);

        return wrapper;
    }

    // ─────────────────────────────────────────
    // 탭 2: 모듈 관리
    // ─────────────────────────────────────────
    function buildModulesTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        const moduleList = [
            { key: 'quickTools', label: '🛠️ 퀵 도구' },
            { key: 'emoticon', label: '😊 이모티콘' },
            { key: 'contacts', label: '📋 연락처' },
            { key: 'call', label: '📞 통화 기록' },
            { key: 'wallet', label: '💰 지갑' },
            { key: 'gifticon', label: '🎁 기프티콘' },
            { key: 'sns', label: '📸 SNS' },
            { key: 'calendar', label: '📅 캘린더' },
        ];

        moduleList.forEach(m => {
            const row = document.createElement('div');
            row.className = 'slm-settings-row';

            const lbl = document.createElement('label');
            lbl.className = 'slm-toggle-label';

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = settings.modules?.[m.key] !== false;
            if (ALWAYS_ON_MODULES.has(m.key)) chk.disabled = true;
            chk.onchange = () => {
                if (!settings.modules) settings.modules = {};
                settings.modules[m.key] = chk.checked;
                saveSettings();
                syncQuickSendButtons();
            };

            lbl.appendChild(chk);
            lbl.appendChild(document.createTextNode(` ${m.label}${ALWAYS_ON_MODULES.has(m.key) ? ' (항상 활성화)' : ''}`));
            row.appendChild(lbl);
            wrapper.appendChild(row);
        });

        return wrapper;
    }

    // ─────────────────────────────────────────
    // 탭: 퀵 액세스 설정
    // ─────────────────────────────────────────
    function buildQuickAccessTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        // 퀵 액세스 전체 ON/OFF
        const enabledRow = document.createElement('div');
        enabledRow.className = 'slm-settings-row';
        const enabledLbl = document.createElement('label');
        enabledLbl.className = 'slm-toggle-label';
        const enabledChk = document.createElement('input');
        enabledChk.type = 'checkbox';
        enabledChk.checked = settings.quickAccess?.enabled !== false;
        enabledChk.onchange = () => {
            if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
            settings.quickAccess.enabled = enabledChk.checked;
            saveSettings();
            refreshQuickAccessFab();
        };
        enabledLbl.appendChild(enabledChk);
        enabledLbl.appendChild(document.createTextNode(' 퀵 액세스 버튼 표시'));
        enabledRow.appendChild(enabledLbl);
        wrapper.appendChild(enabledRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        // ── 커스터마이징: 열 수 설정 ──
        const colTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '🔲 레이아웃 (열 수)',
        });
        colTitle.style.fontWeight = '600';
        colTitle.style.marginBottom = '6px';
        wrapper.appendChild(colTitle);

        const colRow = document.createElement('div');
        colRow.className = 'slm-settings-row';
        colRow.style.display = 'flex';
        colRow.style.gap = '8px';
        [1, 2, 3].forEach((n) => {
            const btn = document.createElement('button');
            btn.className = 'slm-btn slm-btn-sm' + ((settings.quickAccess?.columns || 1) === n ? ' slm-btn-primary' : ' slm-btn-ghost');
            btn.textContent = `${n}열`;
            btn.onclick = () => {
                if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                settings.quickAccess.columns = n;
                saveSettings();
                refreshQuickAccessFab();
                // 버튼 상태 갱신
                colRow.querySelectorAll('button').forEach((b, i) => {
                    b.className = 'slm-btn slm-btn-sm' + (i + 1 === n ? ' slm-btn-primary' : ' slm-btn-ghost');
                });
            };
            colRow.appendChild(btn);
        });
        wrapper.appendChild(colRow);

        // ── 커스터마이징: 표시 모드 ──
        const modeTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '🎭 표시 모드',
        });
        modeTitle.style.fontWeight = '600';
        modeTitle.style.marginTop = '12px';
        modeTitle.style.marginBottom = '6px';
        wrapper.appendChild(modeTitle);

        const modeRow = document.createElement('div');
        modeRow.className = 'slm-settings-row';
        modeRow.style.display = 'flex';
        modeRow.style.gap = '8px';
        const modes = [
            { key: 'full', label: '이모지+텍스트' },
            { key: 'emojiOnly', label: '이모지만' },
            { key: 'labelOnly', label: '텍스트만' },
        ];
        modes.forEach((m) => {
            const btn = document.createElement('button');
            btn.className = 'slm-btn slm-btn-sm' + ((settings.quickAccess?.displayMode || 'full') === m.key ? ' slm-btn-primary' : ' slm-btn-ghost');
            btn.textContent = m.label;
            btn.onclick = () => {
                if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                settings.quickAccess.displayMode = m.key;
                saveSettings();
                refreshQuickAccessFab();
                modeRow.querySelectorAll('button').forEach((b, i) => {
                    b.className = 'slm-btn slm-btn-sm' + (modes[i].key === m.key ? ' slm-btn-primary' : ' slm-btn-ghost');
                });
            };
            modeRow.appendChild(btn);
        });
        wrapper.appendChild(modeRow);

        const iconSizeRow = document.createElement('div');
        iconSizeRow.className = 'slm-input-row';
        iconSizeRow.style.marginTop = '10px';
        const iconSizeLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '아이콘 크기:' });
        const iconSizeInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '16', max: '64',
            value: String(settings.quickAccess?.iconSize || 24),
        });
        iconSizeInput.style.width = '70px';
        const iconSizePx = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const iconSizeBtn = Object.assign(document.createElement('button'), {
            className: 'slm-btn slm-btn-primary slm-btn-sm',
            textContent: '적용',
        });
        iconSizeBtn.onclick = () => {
            if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
            const nextSize = Math.max(16, Math.min(64, Number(iconSizeInput.value) || 24));
            settings.quickAccess.iconSize = nextSize;
            iconSizeInput.value = String(nextSize);
            saveSettings();
            refreshQuickAccessFab();
        };
        iconSizeRow.append(iconSizeLbl, iconSizeInput, iconSizePx, iconSizeBtn);
        wrapper.appendChild(iconSizeRow);

        // ── 제목 폰트 크기 설정 ──
        const labelFontSizeRow = document.createElement('div');
        labelFontSizeRow.className = 'slm-input-row';
        labelFontSizeRow.style.marginTop = '10px';
        const labelFontSizeLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '제목 폰트 크기:' });
        const labelFontSizeInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '8', max: '24',
            value: String(settings.quickAccess?.labelFontSize || 14),
        });
        labelFontSizeInput.style.width = '70px';
        const labelFontSizePx = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const labelFontSizeBtn = Object.assign(document.createElement('button'), {
            className: 'slm-btn slm-btn-primary slm-btn-sm',
            textContent: '적용',
        });
        labelFontSizeBtn.onclick = () => {
            if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
            const nextSize = Math.max(8, Math.min(24, Number(labelFontSizeInput.value) || 14));
            settings.quickAccess.labelFontSize = nextSize;
            labelFontSizeInput.value = String(nextSize);
            saveSettings();
            refreshQuickAccessFab();
        };
        labelFontSizeRow.append(labelFontSizeLbl, labelFontSizeInput, labelFontSizePx, labelFontSizeBtn);
        wrapper.appendChild(labelFontSizeRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        // ── 개별 항목 표시/숨김 + 순서 + 커스텀 이름/이미지 ──
        const itemsTitle = document.createElement('div');
        itemsTitle.className = 'slm-label';
        itemsTitle.textContent = '⚡ 퀵 액세스 항목 설정';
        itemsTitle.style.fontWeight = '600';
        itemsTitle.style.marginBottom = '6px';
        wrapper.appendChild(itemsTitle);
        const hint = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '화살표 버튼으로 순서를 변경하고, 표시명과 이미지를 커스텀할 수 있습니다.',
        });
        wrapper.appendChild(hint);

        // ── 등록/미등록 소분류 탭 ──
        const subTabRow = document.createElement('div');
        subTabRow.style.display = 'flex';
        subTabRow.style.gap = '6px';
        subTabRow.style.marginBottom = '8px';
        subTabRow.style.marginTop = '8px';
        let activeSubTab = 'registered';
        const subTabRegistered = document.createElement('button');
        subTabRegistered.className = 'slm-btn slm-btn-sm slm-btn-primary';
        subTabRegistered.textContent = '✅ 등록';
        const subTabUnregistered = document.createElement('button');
        subTabUnregistered.className = 'slm-btn slm-btn-sm slm-btn-ghost';
        subTabUnregistered.textContent = '⬜ 미등록';
        const updateSubTabStyle = () => {
            subTabRegistered.className = 'slm-btn slm-btn-sm' + (activeSubTab === 'registered' ? ' slm-btn-primary' : ' slm-btn-ghost');
            subTabUnregistered.className = 'slm-btn slm-btn-sm' + (activeSubTab === 'unregistered' ? ' slm-btn-primary' : ' slm-btn-ghost');
        };
        subTabRegistered.onclick = () => { activeSubTab = 'registered'; updateSubTabStyle(); renderItems(); };
        subTabUnregistered.onclick = () => { activeSubTab = 'unregistered'; updateSubTabStyle(); renderItems(); };
        subTabRow.appendChild(subTabRegistered);
        subTabRow.appendChild(subTabUnregistered);
        wrapper.appendChild(subTabRow);

        const list = document.createElement('div');
        list.className = 'slm-form';
        wrapper.appendChild(list);

        const renderItems = () => {
            list.innerHTML = '';
            const ordered = getOrderedQuickAccessItems(true);
            QUICK_ACCESS_ITEMS
                .filter(item => !ordered.some(v => v.key === item.key))
                .forEach(item => ordered.push(item));
            const isRegistered = (item) => settings.quickAccess?.items?.[item.key] !== false;
            const filteredItems = ordered.filter(item =>
                activeSubTab === 'registered' ? isRegistered(item) : !isRegistered(item)
            );
            if (filteredItems.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'slm-desc';
                emptyMsg.style.textAlign = 'center';
                emptyMsg.style.padding = '16px 0';
                emptyMsg.textContent = activeSubTab === 'registered'
                    ? '등록된 퀵 액세스 항목이 없습니다.'
                    : '미등록 항목이 없습니다.';
                list.appendChild(emptyMsg);
                return;
            }
            filteredItems.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'slm-settings-row slm-qa-settings-item';
                row.dataset.qaKey = item.key;

                // 체크박스 + 기본 이름
                const headerRow = document.createElement('div');
                headerRow.style.display = 'flex';
                headerRow.style.alignItems = 'center';
                headerRow.style.gap = '6px';

                // ── 위/아래 화살표 버튼 ──
                const swapOrder = (direction) => {
                    if (!settings.quickAccess?.order) settings.quickAccess.order = [...DEFAULT_SETTINGS.quickAccess.order];
                    const curOrder = settings.quickAccess.order;
                    const curIdx = curOrder.indexOf(item.key);
                    const targetIdx = curIdx + direction;
                    if (curIdx < 0 || targetIdx < 0 || targetIdx >= curOrder.length) return;
                    [curOrder[curIdx], curOrder[targetIdx]] = [curOrder[targetIdx], curOrder[curIdx]];
                    saveSettings();
                    refreshQuickAccessFab();
                    renderItems();
                };
                const upBtn = Object.assign(document.createElement('button'), {
                    type: 'button',
                    className: 'slm-qa-arrow-btn',
                    textContent: '▲',
                    title: '위로 이동',
                });
                upBtn.disabled = idx === 0;
                upBtn.addEventListener('click', () => swapOrder(-1));
                const downBtn = Object.assign(document.createElement('button'), {
                    type: 'button',
                    className: 'slm-qa-arrow-btn',
                    textContent: '▼',
                    title: '아래로 이동',
                });
                downBtn.disabled = idx === filteredItems.length - 1;
                downBtn.addEventListener('click', () => swapOrder(1));
                headerRow.appendChild(upBtn);
                headerRow.appendChild(downBtn);

                const lbl = document.createElement('label');
                lbl.className = 'slm-toggle-label';
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = settings.quickAccess?.items?.[item.key] !== false;
                chk.onchange = () => {
                    if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                    if (!settings.quickAccess.items) settings.quickAccess.items = { ...DEFAULT_SETTINGS.quickAccess.items };
                    settings.quickAccess.items[item.key] = chk.checked;
                    saveSettings();
                    refreshQuickAccessFab();
                    renderItems();
                };
                lbl.appendChild(chk);
                lbl.appendChild(document.createTextNode(` ${item.icon} ${item.label}`));
                headerRow.appendChild(lbl);
                row.appendChild(headerRow);

                // 커스텀 표시명 입력
                const labelInput = document.createElement('input');
                labelInput.type = 'text';
                labelInput.className = 'slm-input slm-qa-custom-input';
                labelInput.placeholder = '커스텀 표시명 (비워두면 기본값)';
                labelInput.setAttribute('aria-label', `${item.label} 커스텀 표시명`);
                labelInput.value = settings.quickAccess?.customLabels?.[item.key] || '';
                labelInput.oninput = () => {
                    if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                    if (!settings.quickAccess.customLabels) settings.quickAccess.customLabels = {};
                    const v = labelInput.value.trim();
                    if (v) {
                        settings.quickAccess.customLabels[item.key] = v;
                    } else {
                        delete settings.quickAccess.customLabels[item.key];
                    }
                    saveSettings();
                };
                const labelRow = document.createElement('div');
                labelRow.className = 'slm-input-row slm-qa-settings-field-row';
                labelRow.appendChild(Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '표시명' }));
                labelRow.appendChild(labelInput);
                row.appendChild(labelRow);

                // 커스텀 이미지 URL 입력 (이모지 대체)
                const imgInput = document.createElement('input');
                imgInput.type = 'text';
                imgInput.className = 'slm-input slm-qa-custom-input';
                imgInput.placeholder = '이모지 대체 이미지 URL (비워두면 이모지 사용)';
                imgInput.setAttribute('aria-label', `${item.label} 이모지 대체 이미지 URL`);
                imgInput.value = settings.quickAccess?.customImages?.[item.key] || '';
                imgInput.oninput = () => {
                    if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                    if (!settings.quickAccess.customImages) settings.quickAccess.customImages = {};
                    const v = normalizeQuickAccessImageUrl(imgInput.value);
                    if (v) {
                        settings.quickAccess.customImages[item.key] = v;
                    } else {
                        delete settings.quickAccess.customImages[item.key];
                    }
                    saveSettings();
                };
                const imgRow = document.createElement('div');
                imgRow.className = 'slm-input-row slm-qa-settings-field-row';
                imgRow.appendChild(Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '이미지 URL' }));
                imgRow.appendChild(imgInput);
                row.appendChild(imgRow);

                // RightSendForm에 아이콘 추가 옵션
                {
                const rsfRow = document.createElement('div');
                rsfRow.className = 'slm-input-row slm-qa-settings-field-row';
                rsfRow.style.marginTop = '2px';
                const rsfLbl = document.createElement('label');
                rsfLbl.className = 'slm-toggle-label';
                rsfLbl.style.fontSize = '12px';
                const rsfChk = document.createElement('input');
                rsfChk.type = 'checkbox';
                rsfChk.checked = !!settings.quickAccess?.rightSendFormItems?.[item.key];
                rsfChk.onchange = () => {
                    if (!settings.quickAccess) settings.quickAccess = { ...DEFAULT_SETTINGS.quickAccess };
                    if (!settings.quickAccess.rightSendFormItems) settings.quickAccess.rightSendFormItems = {};
                    if (rsfChk.checked) {
                        settings.quickAccess.rightSendFormItems[item.key] = true;
                    } else {
                        delete settings.quickAccess.rightSendFormItems[item.key];
                    }
                    saveSettings();
                    injectRightSendFormIcons();
                };
                rsfLbl.appendChild(rsfChk);
                rsfLbl.appendChild(document.createTextNode(' 입력창 옆에 아이콘 추가'));
                rsfRow.appendChild(rsfLbl);
                row.appendChild(rsfRow);
                }

                list.appendChild(row);
            });
        };
        renderItems();

        return wrapper;
    }

    // ─────────────────────────────────────────
    // 탭 3: 이모티콘 & SNS 설정
    // ─────────────────────────────────────────
    function buildMediaTab() {
        // ── 서브 탭 1: 이미지/이모티콘 설정 ──
        function buildImageSubTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        // 이모티콘 크기
        const sizeRow = document.createElement('div');
        sizeRow.className = 'slm-input-row';
        const sizeLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '이모티콘 크기:' });
        const sizeInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '20', max: '300',
            value: String(settings.emoticonSize || 80),
        });
        sizeInput.style.width = '70px';
        const sizePxLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const sizeApplyBtn = document.createElement('button');
        sizeApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        sizeApplyBtn.textContent = '적용';
        sizeApplyBtn.onclick = () => {
            settings.emoticonSize = Math.max(20, Math.min(300, parseInt(sizeInput.value) || 80));
            saveSettings();
            showToast(`이모티콘 크기: ${settings.emoticonSize}px`, 'success', 1500);
        };
        sizeRow.append(sizeLbl, sizeInput, sizePxLbl, sizeApplyBtn);
        wrapper.appendChild(sizeRow);

        // 이모티콘 모서리
        const radiusRow = document.createElement('div');
        radiusRow.className = 'slm-input-row';
        radiusRow.style.marginTop = '8px';
        const radiusLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '이모티콘 모서리:' });
        const radiusInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '50',
            value: String(settings.emoticonRadius ?? 10),
        });
        radiusInput.style.width = '70px';
        const radiusPxLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const radiusApplyBtn = document.createElement('button');
        radiusApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        radiusApplyBtn.textContent = '적용';
        radiusApplyBtn.onclick = () => {
            const val = parseInt(radiusInput.value);
            settings.emoticonRadius = Math.max(0, Math.min(50, isNaN(val) ? 10 : val));
            radiusInput.value = String(settings.emoticonRadius);
            document.documentElement.style.setProperty('--slm-emoticon-radius', settings.emoticonRadius + 'px');
            saveSettings();
            showToast(`이모티콘 모서리: ${settings.emoticonRadius}px`, 'success', 1500);
        };
        radiusRow.append(radiusLbl, radiusInput, radiusPxLbl, radiusApplyBtn);
        wrapper.appendChild(radiusRow);

        const imageRadiusRow = document.createElement('div');
        imageRadiusRow.className = 'slm-input-row';
        imageRadiusRow.style.marginTop = '8px';
        const imageRadiusLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '이미지 모서리:' });
        const imageRadiusInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '50',
            value: String(settings.imageRadius ?? 10),
        });
        imageRadiusInput.style.width = '70px';
        const imageRadiusPxLbl = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const imageRadiusApplyBtn = document.createElement('button');
        imageRadiusApplyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        imageRadiusApplyBtn.textContent = '적용';
        imageRadiusApplyBtn.onclick = () => {
            const val = parseInt(imageRadiusInput.value);
            settings.imageRadius = Math.max(0, Math.min(50, isNaN(val) ? 10 : val));
            imageRadiusInput.value = String(settings.imageRadius);
            document.documentElement.style.setProperty('--slm-image-radius', settings.imageRadius + 'px');
            saveSettings();
            showToast(`이미지 모서리: ${settings.imageRadius}px`, 'success', 1500);
        };
        imageRadiusRow.append(imageRadiusLbl, imageRadiusInput, imageRadiusPxLbl, imageRadiusApplyBtn);
        wrapper.appendChild(imageRadiusRow);

        // SNS 이미지 모드 토글
        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
        const snsImageTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '📸 SNS 이미지 모드',
        });
        snsImageTitle.style.fontWeight = '600';
        wrapper.appendChild(snsImageTitle);

        const snsImageDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '활성화 시 SNS 게시물에 이미지 자동 생성을 사용합니다. 비활성화 시 기본 프리셋 이미지를 사용합니다.',
        });
        wrapper.appendChild(snsImageDesc);

        const snsImageRow = document.createElement('div');
        snsImageRow.className = 'slm-settings-row';
        const snsImageLbl = document.createElement('label');
        snsImageLbl.className = 'slm-toggle-label';
        const snsImageChk = document.createElement('input');
        snsImageChk.type = 'checkbox';
        snsImageChk.checked = settings.snsImageMode === true;
        snsImageChk.onchange = () => {
            settings.snsImageMode = snsImageChk.checked;
            saveSettings();
            showToast(`SNS 이미지 모드: ${settings.snsImageMode ? 'ON' : 'OFF'}`, 'success', 1500);
        };
        snsImageLbl.appendChild(snsImageChk);
        snsImageLbl.appendChild(document.createTextNode(' SNS 이미지 자동 생성 ON'));
        snsImageRow.appendChild(snsImageLbl);
        wrapper.appendChild(snsImageRow);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        // 메신저 이미지 생성 모드
        const msgImageTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '💬 메신저 이미지 생성 모드',
        });
        msgImageTitle.style.fontWeight = '600';
        wrapper.appendChild(msgImageTitle);

        const msgImageDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: 'ON: char 메시지에서 사진을 보낼만한 상황일 때 이미지 생성 API로 실제 이미지를 생성합니다.\nOFF: 이미지 생성 API를 호출하지 않으며 [사진: (상황설명)] 같은 줄글 텍스트로만 출력됩니다.',
        });
        msgImageDesc.style.whiteSpace = 'pre-line';
        wrapper.appendChild(msgImageDesc);

        const msgImageRow = document.createElement('div');
        msgImageRow.className = 'slm-settings-row';
        const msgImageLbl = document.createElement('label');
        msgImageLbl.className = 'slm-toggle-label';
        const msgImageChk = document.createElement('input');
        msgImageChk.type = 'checkbox';
        msgImageChk.checked = settings.messageImageGenerationMode === true;
        msgImageChk.onchange = () => {
            settings.messageImageGenerationMode = msgImageChk.checked;
            saveSettings();
            updateMessageImageInjection();
            showToast(`메신저 이미지 생성 모드: ${settings.messageImageGenerationMode ? 'ON' : 'OFF'}`, 'success', 1500);
        };
        msgImageLbl.appendChild(msgImageChk);
        msgImageLbl.appendChild(document.createTextNode(' 메신저 이미지 자동 생성 ON'));
        msgImageRow.appendChild(msgImageLbl);
        wrapper.appendChild(msgImageRow);

        // 줄글 텍스트 템플릿 (OFF 모드일 때)
        const textTemplateGroup = document.createElement('div');
        textTemplateGroup.className = 'slm-form-group';
        textTemplateGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '📝 OFF 모드 줄글 형식 (커스텀)' }));
        const textTemplateDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '이미지 생성 모드 OFF일 때 사진 대신 표시할 텍스트 형식입니다. {description}에 상황 설명이 들어갑니다.',
        });
        textTemplateGroup.appendChild(textTemplateDesc);
        const textTemplateInput = document.createElement('input');
        textTemplateInput.className = 'slm-input';
        textTemplateInput.type = 'text';
        textTemplateInput.placeholder = '예: [사진: {description}]';
        textTemplateInput.value = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
        textTemplateInput.oninput = () => { settings.messageImageTextTemplate = textTemplateInput.value; saveSettings(); };
        textTemplateGroup.appendChild(textTemplateInput);
        const textTemplateResetBtn = document.createElement('button');
        textTemplateResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        textTemplateResetBtn.textContent = '↺ 기본값';
        textTemplateResetBtn.onclick = () => {
            settings.messageImageTextTemplate = DEFAULT_SETTINGS.messageImageTextTemplate;
            textTemplateInput.value = settings.messageImageTextTemplate;
            saveSettings();
        };
        textTemplateGroup.appendChild(textTemplateResetBtn);
        textTemplateGroup.appendChild(createPromptSaveBtn());
        wrapper.appendChild(textTemplateGroup);

        // ── 태그 가중치 설정 ──
        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
        const tagWeightTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '⚖️ 태그 가중치',
        });
        tagWeightTitle.style.fontWeight = '600';
        wrapper.appendChild(tagWeightTitle);
        const tagWeightDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '외모 태그에 적용할 가중치입니다. 예: 5 → "5::(태그)::" 형식으로 출력됩니다. 0으로 설정하면 가중치 없이 [태그] 형식을 사용합니다.',
        });
        wrapper.appendChild(tagWeightDesc);
        const tagWeightRow = document.createElement('div');
        tagWeightRow.className = 'slm-input-row';
        tagWeightRow.style.marginTop = '6px';
        const tagWeightInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '20',
            value: String(settings.tagWeight ?? DEFAULT_SETTINGS.tagWeight),
        });
        tagWeightInput.style.width = '70px';
        const tagWeightApplyBtn = Object.assign(document.createElement('button'), {
            className: 'slm-btn slm-btn-primary slm-btn-sm',
            textContent: '적용',
        });
        tagWeightApplyBtn.onclick = () => {
            const val = Math.max(0, Math.min(20, parseInt(tagWeightInput.value) || 0));
            settings.tagWeight = val;
            tagWeightInput.value = String(val);
            saveSettings();
            showToast(`태그 가중치: ${val}${val > 0 ? ` → ${val}::(tags)::` : ' (비활성화)'}`, 'success', 1500);
        };
        tagWeightRow.append(tagWeightInput, tagWeightApplyBtn);
        wrapper.appendChild(tagWeightRow);

        return wrapper;
        }

        // ── 서브 탭 2: 이미지 프롬프트/외관 태그 ──
        function buildPromptSubTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        const snsImagePromptGroup = document.createElement('div');
        snsImagePromptGroup.className = 'slm-form-group';
        snsImagePromptGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '📸 SNS 이미지 프롬프트 (커스텀)' }));
        const snsImagePromptInput = document.createElement('textarea');
        snsImagePromptInput.className = 'slm-textarea';
        snsImagePromptInput.rows = 3;
        snsImagePromptInput.placeholder = '예: {authorName}의 외형 태그 {appearanceTags}를 반영해 SNS 사진 설명 프롬프트를 작성';
        snsImagePromptInput.value = settings.snsImagePrompt || DEFAULT_SETTINGS.snsImagePrompt;
        snsImagePromptInput.oninput = () => { settings.snsImagePrompt = snsImagePromptInput.value; saveSettings(); };
        snsImagePromptGroup.appendChild(snsImagePromptInput);
        const snsImagePromptResetBtn = document.createElement('button');
        snsImagePromptResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        snsImagePromptResetBtn.textContent = '↺ 기본값';
        snsImagePromptResetBtn.onclick = () => {
            settings.snsImagePrompt = DEFAULT_SETTINGS.snsImagePrompt;
            snsImagePromptInput.value = settings.snsImagePrompt;
            saveSettings();
        };
        snsImagePromptGroup.appendChild(snsImagePromptResetBtn);
        snsImagePromptGroup.appendChild(createPromptSaveBtn());
        wrapper.appendChild(snsImagePromptGroup);

        const messageImagePromptGroup = document.createElement('div');
        messageImagePromptGroup.className = 'slm-form-group';
        messageImagePromptGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '🖼️ 메신저 이미지 프롬프트 (커스텀)' }));
        const messageImagePromptInput = document.createElement('textarea');
        messageImagePromptInput.className = 'slm-textarea';
        messageImagePromptInput.rows = 3;
        messageImagePromptInput.placeholder = '예: {charName}가 보낸 이미지의 묘사를 생성할 때 사용할 프롬프트';
        messageImagePromptInput.value = settings.messageImagePrompt || DEFAULT_SETTINGS.messageImagePrompt;
        messageImagePromptInput.oninput = () => { settings.messageImagePrompt = messageImagePromptInput.value; saveSettings(); };
        messageImagePromptGroup.appendChild(messageImagePromptInput);
        const messageImagePromptHint = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '메신저 사진용 프롬프트입니다. 실제 생성 시에는 감지된 인물의 핵심 appearance tags가 자동 보강되어 머리/눈/의상 같은 핵심 외형이 누락되지 않도록 합니다.',
        });
        messageImagePromptGroup.appendChild(messageImagePromptHint);
        const messageImagePromptResetBtn = document.createElement('button');
        messageImagePromptResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        messageImagePromptResetBtn.textContent = '↺ 기본값';
        messageImagePromptResetBtn.onclick = () => {
            settings.messageImagePrompt = DEFAULT_SETTINGS.messageImagePrompt;
            messageImagePromptInput.value = settings.messageImagePrompt;
            saveSettings();
        };
        messageImagePromptGroup.appendChild(messageImagePromptResetBtn);
        messageImagePromptGroup.appendChild(createPromptSaveBtn());
        wrapper.appendChild(messageImagePromptGroup);

        // 이미지 생성 프롬프트 주입 (AI에게 보내는 지시)
        const injectionPromptGroup = document.createElement('div');
        injectionPromptGroup.className = 'slm-form-group';
        injectionPromptGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '🤖 이미지 생성 프롬프트 주입 (커스텀)' }));
        const injectionPromptDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: 'AI에게 보내는 이미지 생성 지시 프롬프트입니다. AI가 사진을 보낼만한 상황에서 <pic prompt="설명"> 태그를 출력하도록 유도합니다.',
        });
        injectionPromptGroup.appendChild(injectionPromptDesc);
        const injectionPromptInput = document.createElement('textarea');
        injectionPromptInput.className = 'slm-textarea';
        injectionPromptInput.rows = 4;
        injectionPromptInput.placeholder = 'AI 이미지 생성 지시 프롬프트';
        injectionPromptInput.value = settings.messageImageInjectionPrompt || DEFAULT_SETTINGS.messageImageInjectionPrompt;
        injectionPromptInput.oninput = () => { settings.messageImageInjectionPrompt = injectionPromptInput.value; saveSettings(); };
        injectionPromptGroup.appendChild(injectionPromptInput);
        const injectionPromptResetBtn = document.createElement('button');
        injectionPromptResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        injectionPromptResetBtn.textContent = '↺ 기본값';
        injectionPromptResetBtn.onclick = () => {
            settings.messageImageInjectionPrompt = DEFAULT_SETTINGS.messageImageInjectionPrompt;
            injectionPromptInput.value = settings.messageImageInjectionPrompt;
            saveSettings();
        };
        injectionPromptGroup.appendChild(injectionPromptResetBtn);
        injectionPromptGroup.appendChild(createPromptSaveBtn());
        wrapper.appendChild(injectionPromptGroup);

        const tagAdditionalPromptGroup = document.createElement('div');
        tagAdditionalPromptGroup.className = 'slm-form-group';
        tagAdditionalPromptGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '➕ 태그 생성 추가 프롬프트 (커스텀)' }));
        const tagAdditionalPromptDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '기존 태그 생성 프롬프트는 유지되며, 여기에 입력한 지시문이 추가로 append됩니다.',
        });
        tagAdditionalPromptGroup.appendChild(tagAdditionalPromptDesc);
        const tagAdditionalPromptInput = document.createElement('textarea');
        tagAdditionalPromptInput.className = 'slm-textarea';
        tagAdditionalPromptInput.rows = 3;
        tagAdditionalPromptInput.placeholder = '예: 촬영 구도는 자연스러운 셀카 느낌을 우선';
        tagAdditionalPromptInput.value = settings.tagGenerationAdditionalPrompt || '';
        tagAdditionalPromptInput.oninput = () => { settings.tagGenerationAdditionalPrompt = tagAdditionalPromptInput.value; saveSettings(); };
        tagAdditionalPromptGroup.appendChild(tagAdditionalPromptInput);
        const tagAdditionalPromptResetBtn = document.createElement('button');
        tagAdditionalPromptResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        tagAdditionalPromptResetBtn.textContent = '↺ 비우기';
        tagAdditionalPromptResetBtn.onclick = () => {
            settings.tagGenerationAdditionalPrompt = '';
            tagAdditionalPromptInput.value = '';
            saveSettings();
        };
        tagAdditionalPromptGroup.appendChild(tagAdditionalPromptResetBtn);
        tagAdditionalPromptGroup.appendChild(createPromptSaveBtn());
        wrapper.appendChild(tagAdditionalPromptGroup);

        // 외관 태그 안내 (연락처 탭으로 이동됨)
        const appearanceNotice = document.createElement('div');
        appearanceNotice.className = 'slm-form-group';
        appearanceNotice.appendChild(Object.assign(document.createElement('label'), {
            className: 'slm-label',
            textContent: '🏷️ 외관 태그 설정',
        }));
        const noticeDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '각 캐릭터의 외관 태그는 📋 연락처 탭의 편집 화면에서 개별적으로 설정할 수 있습니다. 이미지 생성 시 해당 연락처의 외관 태그가 자동으로 적용됩니다.',
        });
        appearanceNotice.appendChild(noticeDesc);
        wrapper.appendChild(appearanceNotice);

        return wrapper;
        }

        // ── 서브 탭 3: 통화 사운드/진동 ──
        function buildSoundSubTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        const callSoundTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '🔊 통화 사운드/진동',
        });
        callSoundTitle.style.fontWeight = '600';
        wrapper.appendChild(callSoundTitle);
        const callSoundDefs = [
            { key: 'startSoundUrl', label: '통화 시작 사운드 URL' },
            { key: 'endSoundUrl', label: '통화 종료 사운드 URL' },
            { key: 'ringtoneUrl', label: '수신 착신음 URL' },
        ];
        // 사운드 프리셋 저장/불러오기 (개별 등록 가능)
        const soundInputs = {};
        callSoundDefs.forEach(({ key, label }) => {
            const group = document.createElement('div');
            group.className = 'slm-form-group';
            group.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: label }));
            const inputRow = document.createElement('div');
            inputRow.className = 'slm-input-row';
            const input = document.createElement('input');
            input.className = 'slm-input';
            input.type = 'url';
            input.placeholder = 'https://...';
            input.value = settings.callAudio?.[key] || '';
            input.oninput = () => {
                if (!settings.callAudio || typeof settings.callAudio !== 'object') settings.callAudio = { ...DEFAULT_SETTINGS.callAudio };
                settings.callAudio[key] = input.value.trim();
                saveSettings();
            };
            soundInputs[key] = input;
            const previewBtn = document.createElement('button');
            previewBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            previewBtn.textContent = '▶';
            previewBtn.title = '미리듣기';
            let previewAudio = null;
            previewBtn.onclick = () => {
                if (previewAudio) { previewAudio.pause(); previewAudio = null; previewBtn.textContent = '▶'; return; }
                const url = input.value.trim();
                if (!url) { showToast('URL을 입력해주세요.', 'warn'); return; }
                try {
                    previewAudio = new Audio(url);
                    previewAudio.onended = () => { previewAudio = null; previewBtn.textContent = '▶'; };
                    previewAudio.onerror = () => { showToast('재생 실패', 'error'); previewAudio = null; previewBtn.textContent = '▶'; };
                    previewBtn.textContent = '⏹';
                    void previewAudio.play().catch(() => { showToast('재생 실패', 'error'); previewAudio = null; previewBtn.textContent = '▶'; });
                } catch { showToast('재생 실패', 'error'); }
            };

            // 개별 프리셋 저장/불러오기 버튼
            const indivPresetSaveBtn = document.createElement('button');
            indivPresetSaveBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            indivPresetSaveBtn.textContent = '💾';
            indivPresetSaveBtn.title = '이 사운드를 프리셋으로 저장';
            indivPresetSaveBtn.onclick = () => {
                const url = input.value.trim();
                if (!url) { showToast('URL을 먼저 입력해주세요.', 'warn'); return; }
                const presetName = prompt(`${label} 프리셋 이름:`);
                if (!presetName) return;
                const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets-individual') || '{}');
                if (!presets[key]) presets[key] = {};
                presets[key][presetName] = url;
                localStorage.setItem('st-lifesim:sound-presets-individual', JSON.stringify(presets));
                showToast(`"${presetName}" 저장됨`, 'success', 1500);
                refreshIndivPreset(key);
            };

            const indivPresetSelect = document.createElement('select');
            indivPresetSelect.className = 'slm-select';
            indivPresetSelect.style.flex = '1';
            indivPresetSelect.style.maxWidth = '140px';

            const refreshIndivPreset = (soundKey) => {
                indivPresetSelect.innerHTML = '';
                indivPresetSelect.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '-- 프리셋 --' }));
                const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets-individual') || '{}');
                const entries = presets[soundKey] || {};
                Object.keys(entries).forEach((name) => {
                    indivPresetSelect.appendChild(Object.assign(document.createElement('option'), { value: name, textContent: name }));
                });
            };
            refreshIndivPreset(key);

            indivPresetSelect.onchange = () => {
                const name = indivPresetSelect.value;
                if (!name) return;
                const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets-individual') || '{}');
                const url = presets[key]?.[name];
                if (!url) return;
                input.value = url;
                if (!settings.callAudio || typeof settings.callAudio !== 'object') settings.callAudio = { ...DEFAULT_SETTINGS.callAudio };
                settings.callAudio[key] = url;
                saveSettings();
                showToast(`"${name}" 적용됨`, 'success', 1200);
            };

            const indivPresetDelBtn = document.createElement('button');
            indivPresetDelBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
            indivPresetDelBtn.textContent = '🗑️';
            indivPresetDelBtn.title = '선택된 프리셋 삭제';
            indivPresetDelBtn.onclick = () => {
                const name = indivPresetSelect.value;
                if (!name) return;
                const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets-individual') || '{}');
                if (presets[key]) { delete presets[key][name]; }
                localStorage.setItem('st-lifesim:sound-presets-individual', JSON.stringify(presets));
                refreshIndivPreset(key);
                showToast(`"${name}" 삭제됨`, 'success', 1200);
            };

            inputRow.append(input, previewBtn);
            group.appendChild(inputRow);

            const indivPresetRow = document.createElement('div');
            indivPresetRow.className = 'slm-input-row';
            indivPresetRow.style.marginTop = '4px';
            indivPresetRow.append(indivPresetSaveBtn, indivPresetSelect, indivPresetDelBtn);
            group.appendChild(indivPresetRow);
            wrapper.appendChild(group);
        });

        // 세트 프리셋 저장/불러오기 (기존 호환)
        const presetRow = document.createElement('div');
        presetRow.className = 'slm-btn-row';
        presetRow.style.marginTop = '8px';
        const presetSaveBtn = document.createElement('button');
        presetSaveBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        presetSaveBtn.textContent = '💾 세트 프리셋 저장';
        presetSaveBtn.onclick = () => {
            const presetName = prompt('프리셋 이름을 입력하세요:');
            if (!presetName) return;
            const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets') || '{}');
            presets[presetName] = {
                startSoundUrl: settings.callAudio?.startSoundUrl || '',
                endSoundUrl: settings.callAudio?.endSoundUrl || '',
                ringtoneUrl: settings.callAudio?.ringtoneUrl || '',
            };
            localStorage.setItem('st-lifesim:sound-presets', JSON.stringify(presets));
            showToast(`프리셋 "${presetName}" 저장됨`, 'success', 1500);
            refreshPresetList();
        };
        const presetLoadSelect = document.createElement('select');
        presetLoadSelect.className = 'slm-select';
        presetLoadSelect.style.flex = '1';
        const refreshPresetList = () => {
            presetLoadSelect.innerHTML = '';
            presetLoadSelect.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '-- 세트 프리셋 선택 --' }));
            const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets') || '{}');
            Object.keys(presets).forEach((name) => {
                presetLoadSelect.appendChild(Object.assign(document.createElement('option'), { value: name, textContent: name }));
            });
        };
        refreshPresetList();
        const presetLoadBtn = document.createElement('button');
        presetLoadBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        presetLoadBtn.textContent = '📂 불러오기';
        presetLoadBtn.onclick = () => {
            const name = presetLoadSelect.value;
            if (!name) { showToast('프리셋을 선택하세요.', 'warn'); return; }
            const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets') || '{}');
            const preset = presets[name];
            if (!preset) { showToast('프리셋을 찾을 수 없습니다.', 'error'); return; }
            if (!settings.callAudio || typeof settings.callAudio !== 'object') settings.callAudio = { ...DEFAULT_SETTINGS.callAudio };
            settings.callAudio.startSoundUrl = preset.startSoundUrl || '';
            settings.callAudio.endSoundUrl = preset.endSoundUrl || '';
            settings.callAudio.ringtoneUrl = preset.ringtoneUrl || '';
            saveSettings();
            // 입력 필드 업데이트
            if (soundInputs.startSoundUrl) soundInputs.startSoundUrl.value = settings.callAudio.startSoundUrl;
            if (soundInputs.endSoundUrl) soundInputs.endSoundUrl.value = settings.callAudio.endSoundUrl;
            if (soundInputs.ringtoneUrl) soundInputs.ringtoneUrl.value = settings.callAudio.ringtoneUrl;
            showToast(`프리셋 "${name}" 적용됨`, 'success', 2000);
        };
        const presetDeleteBtn = document.createElement('button');
        presetDeleteBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
        presetDeleteBtn.textContent = '🗑️';
        presetDeleteBtn.title = '선택된 프리셋 삭제';
        presetDeleteBtn.onclick = () => {
            const name = presetLoadSelect.value;
            if (!name) return;
            const presets = JSON.parse(localStorage.getItem('st-lifesim:sound-presets') || '{}');
            delete presets[name];
            localStorage.setItem('st-lifesim:sound-presets', JSON.stringify(presets));
            refreshPresetList();
            showToast(`프리셋 "${name}" 삭제됨`, 'success', 1500);
        };
        presetRow.append(presetSaveBtn, presetLoadSelect, presetLoadBtn, presetDeleteBtn);
        wrapper.appendChild(presetRow);
        const vibrateRow = document.createElement('div');
        vibrateRow.className = 'slm-settings-row';
        const vibrateLbl = document.createElement('label');
        vibrateLbl.className = 'slm-toggle-label';
        const vibrateChk = document.createElement('input');
        vibrateChk.type = 'checkbox';
        vibrateChk.checked = settings.callAudio?.vibrateOnIncoming === true;
        vibrateChk.onchange = () => {
            if (!settings.callAudio || typeof settings.callAudio !== 'object') settings.callAudio = { ...DEFAULT_SETTINGS.callAudio };
            settings.callAudio.vibrateOnIncoming = vibrateChk.checked;
            saveSettings();
        };
        vibrateLbl.append(vibrateChk, document.createTextNode(' 수신 시 진동 사용'));
        vibrateRow.appendChild(vibrateLbl);
        wrapper.appendChild(vibrateRow);

        return wrapper;
        }

        return createTabs([
            { key: 'image', label: '🖼️ 이미지/이모티콘', content: buildImageSubTab() },
            { key: 'imgprompt', label: '🎨 프롬프트/태그', content: buildPromptSubTab() },
            { key: 'sound', label: '🔊 사운드', content: buildSoundSubTab() },
        ], 'image');
    }

    // ─────────────────────────────────────────
    // 탭 4: 테마 (CSS 색상 커스터마이징)
    // ─────────────────────────────────────────
    function buildThemeTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        const desc = document.createElement('p');
        desc.className = 'slm-desc';
        desc.textContent = '컬러 피커로 ST-LifeSim UI 색상을 자유롭게 변경하세요. 변경 즉시 적용됩니다.';
        wrapper.appendChild(desc);

        if (!settings.themeColors) settings.themeColors = {};

        const colorDefs = [
            { key: '--slm-primary', label: '주요 색 (버튼/강조)', defaultVal: '#007aff' },
            { key: '--slm-bg', label: '패널 배경', defaultVal: '#ffffff' },
            { key: '--slm-surface', label: '카드/셀 배경', defaultVal: '#ffffff' },
            { key: '--slm-text', label: '텍스트 색', defaultVal: '#1c1c1e' },
            { key: '--slm-text-secondary', label: '보조 텍스트 색', defaultVal: '#6d6d72' },
            { key: '--slm-border', label: '테두리 색', defaultVal: '#c7c7cc' },
            { key: '--slm-accent', label: '액센트 색 (SNS 헤더 등)', defaultVal: '#007aff' },
        ];

        colorDefs.forEach(def => {
            const row = document.createElement('div');
            row.className = 'slm-input-row';
            row.style.marginBottom = '8px';

            const lbl = document.createElement('label');
            lbl.className = 'slm-label';
            lbl.style.flex = '1';
            lbl.textContent = def.label;

            const picker = document.createElement('input');
            picker.type = 'color';
            picker.className = 'slm-color-picker';
            // 저장된 색상 또는 현재 CSS 변수값 또는 기본값
            const savedColor = settings.themeColors[def.key];
            const currentCssVal = getComputedStyle(document.documentElement).getPropertyValue(def.key).trim();
            picker.value = normalizeColorValue(savedColor || currentCssVal, def.defaultVal);

            picker.oninput = () => {
                document.documentElement.style.setProperty(def.key, picker.value, 'important');
                settings.themeColors[def.key] = picker.value;
                saveSettings();
            };

            const resetBtn = document.createElement('button');
            resetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            resetBtn.textContent = '↺';
            resetBtn.title = '기본값으로 복원';
            resetBtn.onclick = () => {
                document.documentElement.style.setProperty(def.key, def.defaultVal, 'important');
                settings.themeColors[def.key] = def.defaultVal;
                picker.value = def.defaultVal;
                saveSettings();
            };

            row.appendChild(lbl);
            row.appendChild(picker);
            row.appendChild(resetBtn);
            wrapper.appendChild(row);
        });

        const resetAllBtn = document.createElement('button');
        resetAllBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        resetAllBtn.style.marginTop = '12px';
        resetAllBtn.textContent = '🔄 전체 색상 초기화';
        resetAllBtn.onclick = () => {
            colorDefs.forEach((def, i) => {
                document.documentElement.style.setProperty(def.key, def.defaultVal, 'important');
                settings.themeColors[def.key] = def.defaultVal;
                // Update each color picker in place
                const pickers = wrapper.querySelectorAll('input[type="color"]');
                if (pickers[i]) pickers[i].value = def.defaultVal;
            });
            saveSettings();
            showToast('색상 초기화됨', 'success', 1500);
        };
        wrapper.appendChild(resetAllBtn);

        wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
        const toastTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '🔔 팝업 알림(토스트)',
        });
        toastTitle.style.fontWeight = '700';
        wrapper.appendChild(toastTitle);

        const toastOffsetRow = document.createElement('div');
        toastOffsetRow.className = 'slm-input-row';
        const toastOffsetLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '세로 위치:' });
        const toastOffsetInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '0', max: '300',
            value: String(settings.toast?.offsetY ?? 16),
        });
        toastOffsetInput.style.width = '80px';
        const toastOffsetUnit = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'px' });
        const toastOffsetApply = document.createElement('button');
        toastOffsetApply.className = 'slm-btn slm-btn-primary slm-btn-sm';
        toastOffsetApply.textContent = '적용';
        toastOffsetApply.onclick = () => {
            settings.toast.offsetY = Math.max(0, Math.min(300, parseInt(toastOffsetInput.value) || 16));
            toastOffsetInput.value = String(settings.toast.offsetY);
            document.documentElement.style.setProperty('--slm-toast-top', `${settings.toast.offsetY}px`);
            saveSettings();
            showToast(`토스트 위치: ${settings.toast.offsetY}px`, 'success', 1200);
        };
        toastOffsetRow.append(toastOffsetLbl, toastOffsetInput, toastOffsetUnit, toastOffsetApply);
        wrapper.appendChild(toastOffsetRow);

        const toastColorDefs = [
            { key: 'info', label: '기본' },
            { key: 'success', label: '성공' },
            { key: 'warn', label: '경고' },
            { key: 'error', label: '오류' },
        ];
        toastColorDefs.forEach(({ key, label }) => {
            const row = document.createElement('div');
            row.className = 'slm-input-row';
            const lbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: `토스트 ${label}:` });
            lbl.style.flex = '1';
            const picker = document.createElement('input');
            picker.type = 'color';
            picker.className = 'slm-color-picker';
            const fallback = DEFAULT_SETTINGS.toast.colors[key];
            picker.value = normalizeColorValue(settings.toast?.colors?.[key], fallback);
            picker.oninput = () => {
                settings.toast.colors[key] = picker.value;
                document.documentElement.style.setProperty(`--slm-toast-${key}`, picker.value);
                saveSettings();
            };
            row.append(lbl, picker);
            wrapper.appendChild(row);
        });

        // 토스트 폰트 색상 설정
        const toastFontRow = document.createElement('div');
        toastFontRow.className = 'slm-input-row';
        toastFontRow.style.marginTop = '8px';
        const toastFontLbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '토스트 폰트 색:' });
        toastFontLbl.style.flex = '1';
        const toastFontPicker = document.createElement('input');
        toastFontPicker.type = 'color';
        toastFontPicker.className = 'slm-color-picker';
        toastFontPicker.value = normalizeColorValue(settings.toast?.fontColor, DEFAULT_SETTINGS.toast.fontColor);
        toastFontPicker.oninput = () => {
            settings.toast.fontColor = toastFontPicker.value;
            document.documentElement.style.setProperty('--slm-toast-font-color', toastFontPicker.value);
            saveSettings();
        };
        toastFontRow.append(toastFontLbl, toastFontPicker);
        wrapper.appendChild(toastFontRow);

        return wrapper;
    }

    function buildSnsPromptTab() {
        const routeSection = document.createElement('div');
        routeSection.className = 'slm-settings-wrapper slm-form';
        const snsSection = document.createElement('div');
        snsSection.className = 'slm-settings-wrapper slm-form';
        const messageSection = document.createElement('div');
        messageSection.className = 'slm-settings-wrapper slm-form';
        if (!settings.aiRoutes) settings.aiRoutes = { sns: { ...AI_ROUTE_DEFAULTS }, snsTranslation: { ...AI_ROUTE_DEFAULTS }, callSummary: { ...AI_ROUTE_DEFAULTS }, contactProfile: { ...AI_ROUTE_DEFAULTS }, tagGeneration: { ...AI_ROUTE_DEFAULTS } };
        if (!settings.aiRoutes.sns) settings.aiRoutes.sns = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.snsTranslation) settings.aiRoutes.snsTranslation = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.callSummary) settings.aiRoutes.callSummary = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.contactProfile) settings.aiRoutes.contactProfile = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.tagGeneration) settings.aiRoutes.tagGeneration = { ...AI_ROUTE_DEFAULTS };

        const apiRouteTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '🤖 기능별 AI 모델 지정',
        });
        apiRouteTitle.style.fontWeight = '700';
        routeSection.appendChild(apiRouteTitle);

        const apiRouteDesc = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '공급자와 모델을 지정하면 해당 기능에만 별도 AI를 사용합니다. 비워두면 현재 전역 설정을 사용합니다.',
        });
        apiRouteDesc.style.fontSize = '12px';
        apiRouteDesc.style.marginBottom = '8px';
        routeSection.appendChild(apiRouteDesc);

        // 공급자별 표시 레이블 및 예시 모델
        const PROVIDER_OPTIONS = [
            { value: '', label: '전역 설정 사용 (기본)', models: [] },
            { value: 'openai', label: 'OpenAI (GPT)', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
            { value: 'claude', label: 'Claude (Anthropic)', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'] },
            { value: 'makersuite', label: 'Google AI (Gemini)', models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'] },
            { value: 'openrouter', label: 'OpenRouter', models: ['google/gemini-2.0-flash-001', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.3-70b-instruct'] },
            { value: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
            { value: 'groq', label: 'Groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
            { value: 'mistralai', label: 'Mistral AI', models: ['mistral-large-latest', 'mistral-small-latest'] },
            { value: 'xai', label: 'xAI (Grok)', models: ['grok-2-latest', 'grok-beta'] },
            { value: 'cohere', label: 'Cohere', models: ['command-r-plus', 'command-r'] },
            { value: 'perplexity', label: 'Perplexity', models: ['llama-3.1-sonar-large-128k-online'] },
            { value: 'vertexai', label: 'Vertex AI (Google Cloud)', models: ['gemini-2.5-pro', 'gemini-2.0-flash'] },
            { value: 'custom', label: '커스텀 API', models: [] },
        ];
        const customModelsBySource = settings.aiCustomModels && typeof settings.aiCustomModels === 'object' ? settings.aiCustomModels : (settings.aiCustomModels = {});

        function buildAiRouteEditor(title, route) {
            const group = document.createElement('div');
            group.className = 'slm-form-group';
            const groupTitle = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: title });
            groupTitle.style.fontWeight = '600';
            group.appendChild(groupTitle);

            const sourceSelect = document.createElement('select');
            sourceSelect.className = 'slm-select';
            PROVIDER_OPTIONS.forEach(({ value, label }) => {
                sourceSelect.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
            });
            const validSources = PROVIDER_OPTIONS.map(o => o.value);
            sourceSelect.value = validSources.includes(route.chatSource) ? route.chatSource : '';

            // Model preset dropdown
            const modelSelect = document.createElement('select');
            modelSelect.className = 'slm-select';

            // Direct-input field (shown when '✏️ 직접 입력' is chosen)
            const modelInput = document.createElement('input');
            modelInput.className = 'slm-input';
            modelInput.type = 'text';
            modelInput.placeholder = '모델명 직접 입력';
            modelInput.style.display = 'none';
            const addModelBtn = document.createElement('button');
            addModelBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            addModelBtn.textContent = '+ 모델 추가';
            addModelBtn.style.display = 'none';

            function refreshModelSelect() {
                const providerPresets = PROVIDER_OPTIONS.find(o => o.value === sourceSelect.value)?.models || [];
                const customPresets = Array.isArray(customModelsBySource[sourceSelect.value]) ? customModelsBySource[sourceSelect.value] : [];
                const presets = [...providerPresets, ...customPresets.filter(m => !providerPresets.includes(m))];
                modelSelect.innerHTML = '';
                modelSelect.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '-- 모델 선택 (전역 기본) --' }));
                presets.forEach(m => {
                    modelSelect.appendChild(Object.assign(document.createElement('option'), { value: m, textContent: m }));
                });
                modelSelect.appendChild(Object.assign(document.createElement('option'), { value: '__custom__', textContent: '✏️ 직접 입력' }));
                modelInput.placeholder = presets.length > 0 ? `예: ${presets[0]}` : '모델명 입력 (예: gpt-4o-mini)';

                const currentModel = route.model || '';
                if (!currentModel) {
                    modelSelect.value = '';
                    modelInput.style.display = 'none';
                    addModelBtn.style.display = 'none';
                } else if (presets.includes(currentModel)) {
                    modelSelect.value = currentModel;
                    modelInput.style.display = 'none';
                    addModelBtn.style.display = 'none';
                } else {
                    modelSelect.value = '__custom__';
                    modelInput.value = currentModel;
                    modelInput.style.display = '';
                    addModelBtn.style.display = '';
                }
            }

            sourceSelect.onchange = () => {
                route.chatSource = sourceSelect.value;
                route.api = '';
                route.modelSettingKey = ROUTE_MODEL_KEY_BY_SOURCE[route.chatSource] || '';
                route.model = '';
                refreshModelSelect();
                saveSettings();
            };
            group.appendChild(sourceSelect);

            modelSelect.onchange = () => {
                if (modelSelect.value === '__custom__') {
                    modelInput.style.display = '';
                    addModelBtn.style.display = '';
                    modelInput.focus();
                } else {
                    modelInput.style.display = 'none';
                    addModelBtn.style.display = 'none';
                    route.model = modelSelect.value;
                }
                saveSettings();
            };

            refreshModelSelect();
            modelInput.oninput = () => { route.model = modelInput.value.trim(); saveSettings(); };
            group.appendChild(modelSelect);
            group.appendChild(modelInput);
            addModelBtn.onclick = () => {
                const source = sourceSelect.value;
                const modelName = modelInput.value.trim();
                if (!source || !modelName) return;
                if (!Array.isArray(customModelsBySource[source])) customModelsBySource[source] = [];
                if (!customModelsBySource[source].includes(modelName)) customModelsBySource[source].push(modelName);
                route.model = modelName;
                refreshModelSelect();
                modelSelect.value = modelName;
                modelInput.style.display = 'none';
                addModelBtn.style.display = 'none';
                saveSettings();
            };
            group.appendChild(addModelBtn);

            routeSection.appendChild(group);
        }

        buildAiRouteEditor('SNS 생성 라우팅', settings.aiRoutes.sns);
        buildAiRouteEditor('SNS 번역 라우팅', settings.aiRoutes.snsTranslation);
        buildAiRouteEditor('통화 요약 라우팅', settings.aiRoutes.callSummary);
        buildAiRouteEditor('연락처 AI 생성 라우팅', settings.aiRoutes.contactProfile);
        routeSection.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        const endpointRow = document.createElement('div');
        endpointRow.className = 'slm-form-group';
        endpointRow.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '외부 생성 API URL (선택)' }));
        const endpointSelect = document.createElement('select');
        endpointSelect.className = 'slm-select';
        const endpointOptions = ['', '/api/backends/chat-completions/generate', '/api/openai/chat/completions'];
        if (settings.snsExternalApiUrl && !endpointOptions.includes(settings.snsExternalApiUrl)) endpointOptions.push(settings.snsExternalApiUrl);
        endpointOptions.forEach((value) => {
            endpointSelect.appendChild(Object.assign(document.createElement('option'), {
                value,
                textContent: value || '외부 API 미사용',
            }));
        });
        endpointSelect.value = settings.snsExternalApiUrl || '';
        endpointSelect.onchange = () => {
            settings.snsExternalApiUrl = endpointSelect.value.trim();
            saveSettings();
        };
        endpointRow.appendChild(endpointSelect);
        routeSection.appendChild(endpointRow);

        const timeoutRow = document.createElement('div');
        timeoutRow.className = 'slm-input-row';
        const timeoutLabel = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '외부 API 타임아웃:' });
        const timeoutInput = Object.assign(document.createElement('input'), {
            className: 'slm-input slm-input-sm', type: 'number', min: '1000', max: '60000',
            value: String(settings.snsExternalApiTimeoutMs ?? 12000),
        });
        timeoutInput.style.width = '100px';
        const timeoutUnit = Object.assign(document.createElement('span'), { className: 'slm-label', textContent: 'ms' });
        const timeoutApply = document.createElement('button');
        timeoutApply.className = 'slm-btn slm-btn-primary slm-btn-sm';
        timeoutApply.textContent = '적용';
        timeoutApply.onclick = () => {
            settings.snsExternalApiTimeoutMs = Math.max(1000, Math.min(60000, parseInt(timeoutInput.value) || 12000));
            timeoutInput.value = String(settings.snsExternalApiTimeoutMs);
            saveSettings();
        };
        timeoutRow.append(timeoutLabel, timeoutInput, timeoutUnit, timeoutApply);
        routeSection.appendChild(timeoutRow);
        routeSection.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

        const translationPromptGroup = document.createElement('div');
        translationPromptGroup.className = 'slm-form-group';
        const translationPromptLabel = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '한글 번역 프롬프트 ({{text}} 사용)' });
        const translationPromptInput = document.createElement('textarea');
        translationPromptInput.className = 'slm-textarea';
        translationPromptInput.rows = 3;
        translationPromptInput.value = settings.snsKoreanTranslationPrompt || DEFAULT_SETTINGS.snsKoreanTranslationPrompt;
        translationPromptInput.oninput = () => {
            settings.snsKoreanTranslationPrompt = translationPromptInput.value;
            saveSettings();
        };
        translationPromptGroup.append(translationPromptLabel, translationPromptInput, createPromptSaveBtn());
        snsSection.appendChild(translationPromptGroup);

        if (!settings.snsPrompts) settings.snsPrompts = { ...SNS_PROMPT_DEFAULTS };
        const promptDefs = [
            { key: 'postChar', label: '캐릭터 게시글 프롬프트', hint: '{{charName}}: 캐릭터 이름, {{authorName}}: 작성자 이름, {{personality}}: 성격' },
            { key: 'postContact', label: '연락처 게시글 프롬프트', hint: '{{authorName}}: 작성자 이름, {{personality}}: 성격, {{charName}}: 캐릭터 이름' },
            { key: 'imageDescription', label: '이미지 설명 프롬프트', hint: '{{authorName}}: 작성자 이름, {{postContent}}: 게시글 내용' },
            { key: 'reply', label: '답글 프롬프트', hint: '게시글: {{postAuthorName}}, {{postAuthorHandle}}, {{postContent}} | 댓글: {{commentAuthorName}}, {{commentAuthorHandle}}, {{commentText}} | 답글: {{replyAuthorName}}, {{replyAuthorHandle}}, {{replyPersonality}}' },
            { key: 'extraComment', label: '추가 댓글 프롬프트', hint: '게시글: {{postAuthorName}}, {{postAuthorHandle}}, {{postContent}} | 댓글: {{extraAuthorName}}, {{extraAuthorHandle}}, {{extraPersonality}}' },
        ];
        promptDefs.forEach(({ key, label, hint }) => {
            const group = document.createElement('div');
            group.className = 'slm-form-group';
            const lbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: label });
            const hintEl = Object.assign(document.createElement('div'), { className: 'slm-desc', textContent: `변수: ${hint}` });
            const input = document.createElement('textarea');
            input.className = 'slm-textarea';
            input.rows = 4;
            input.value = settings.snsPrompts[key] || SNS_PROMPT_DEFAULTS[key];
            input.oninput = () => {
                settings.snsPrompts[key] = input.value;
                saveSettings();
            };
            const resetBtn = document.createElement('button');
            resetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            resetBtn.textContent = '↺ 기본값';
            resetBtn.onclick = () => {
                settings.snsPrompts[key] = SNS_PROMPT_DEFAULTS[key];
                input.value = settings.snsPrompts[key];
                saveSettings();
            };
            group.append(lbl, hintEl, input, resetBtn, createPromptSaveBtn());
            snsSection.appendChild(group);
        });

        // 통화 요약 프롬프트 커스터마이징 (Item 4)
        messageSection.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
        const callSummaryTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '📞 통화 요약 프롬프트',
        });
        callSummaryTitle.style.fontWeight = '700';
        messageSection.appendChild(callSummaryTitle);
        const callSummaryDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '통화 종료 후 요약 생성 시 사용할 프롬프트입니다. {contactName}(상대방 이름), {transcript}(통화 내용) 변수를 사용할 수 있습니다. 비워두면 기본 요약 프롬프트를 사용합니다.',
        });
        messageSection.appendChild(callSummaryDesc);
        const callSummaryGroup = document.createElement('div');
        callSummaryGroup.className = 'slm-form-group';
        const callSummaryInput = document.createElement('textarea');
        callSummaryInput.className = 'slm-textarea slm-call-summary-prompt-input';
        callSummaryInput.rows = 4;
        callSummaryInput.value = settings.callSummaryPrompt || DEFAULT_SETTINGS.callSummaryPrompt;
        callSummaryInput.placeholder = '예: {contactName}과의 통화 내용:\n{transcript}\n위 통화를 한국어로 2~3문장 요약하세요.';
        callSummaryInput.oninput = () => {
            settings.callSummaryPrompt = callSummaryInput.value;
            saveSettings();
        };
        const callSummaryResetBtn = document.createElement('button');
        callSummaryResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        callSummaryResetBtn.textContent = '↺ 기본값';
        callSummaryResetBtn.onclick = () => {
            settings.callSummaryPrompt = DEFAULT_SETTINGS.callSummaryPrompt;
            callSummaryInput.value = DEFAULT_SETTINGS.callSummaryPrompt;
            saveSettings();
        };
        callSummaryGroup.append(callSummaryInput, callSummaryResetBtn, createPromptSaveBtn());
        messageSection.appendChild(callSummaryGroup);

        // 메시지 템플릿 커스터마이징 (Item 3)
        messageSection.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
        const templateTitle = Object.assign(document.createElement('div'), {
            className: 'slm-label',
            textContent: '✉️ 메시지 템플릿 커스터마이징',
        });
        templateTitle.style.fontWeight = '700';
        messageSection.appendChild(templateTitle);
        const templateDesc = Object.assign(document.createElement('div'), {
            className: 'slm-desc',
            textContent: '각 기능에서 전송되는 메시지 포맷을 커스터마이징합니다. 사용 가능한 변수는 각 항목 설명을 참고하세요.',
        });
        messageSection.appendChild(templateDesc);

        if (!settings.messageTemplates) settings.messageTemplates = { ...DEFAULT_MESSAGE_TEMPLATES };
        const templateDefs = [
            { key: 'callStart_incoming', label: '📞 통화 시작 (수신)', hint: '{charName}: 상대방 이름' },
            { key: 'callStart_outgoing', label: '📞 통화 시작 (발신)', hint: '{charName}: 상대방 이름' },
            { key: 'callEnd', label: '📵 통화 종료', hint: '{timeStr}: 통화 시간' },
            { key: 'voiceMemo', label: '🎤 음성메시지 (유저)', hint: '{timeStr}: 길이, {hint}: 내용 힌트' },
            { key: 'voiceMemoAiPrompt', label: '🤖 AI 음성메시지 생성 프롬프트', hint: '{charName}: 캐릭터 이름', rows: 4 },
            { key: 'readReceipt', label: '👻 읽씹 프롬프트', hint: '{charName}: 캐릭터 이름 ({{user}}, {{char}} 사용 가능)', rows: 3 },
            { key: 'noContact', label: '📵 연락 안 됨 프롬프트', hint: '{charName}: 캐릭터 이름 ({{user}} 사용 가능)', rows: 3 },
            { key: 'gifticonSend', label: '🎁 기프티콘 전송', hint: '{emoji}, {senderName}, {recipient}, {name}, {valuePart}, {memoPart}', rows: 4 },
        ];
        templateDefs.forEach(({ key, label, hint, rows = 2 }) => {
            const group = document.createElement('div');
            group.className = 'slm-form-group';
            const lbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: label });
            const hintEl = Object.assign(document.createElement('div'), { className: 'slm-desc', textContent: `변수: ${hint}` });
            const input = document.createElement('textarea');
            input.className = 'slm-textarea';
            input.rows = rows;
            input.value = settings.messageTemplates[key] ?? DEFAULT_MESSAGE_TEMPLATES[key];
            const preview = document.createElement('div');
            preview.className = 'slm-call-summary';
            preview.style.whiteSpace = 'normal';
            preview.style.display = 'none';
            const containsHtmlOrCss = (text) => /<\/?[a-z][\s\S]*>/i.test(text) || /(^|\n)\s*[.#a-zA-Z][^{\n]*\{[^}]*:[^}]*\}/.test(text);
            const containsMarkdown = (text) => /(\*\*[^*]+\*\*|\*[^*]+\*|^#{1,6}\s|`[^`]+`|\[.+\]\(.+\)|\n[-*]\s)/m.test(text);
            const simpleMarkdownToHtml = (text) => {
                return String(text)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    .replace(/`(.+?)`/g, '<code>$1</code>')
                    .replace(/\n/g, '<br>');
            };
            const refreshPreview = () => {
                const val = input.value || '';
                const hasHtml = containsHtmlOrCss(val);
                const hasMd = containsMarkdown(val);
                preview.style.display = (hasHtml || hasMd) ? '' : 'none';
                preview.innerHTML = '';
                if (!hasHtml && !hasMd) return;
                preview.appendChild(Object.assign(document.createElement('div'), { textContent: '👀 미리보기 (샌드박스)' }));
                if (hasHtml) {
                    const frame = document.createElement('iframe');
                    frame.sandbox = '';
                    frame.style.cssText = 'width:100%;min-height:80px;border:1px solid var(--slm-border);border-radius:8px;background:#fff;margin-top:6px';
                    frame.srcdoc = String(val);
                    preview.appendChild(frame);
                } else {
                    const mdPreview = document.createElement('div');
                    mdPreview.style.cssText = 'padding:8px 12px;border:1px solid var(--slm-border);border-radius:8px;background:var(--slm-surface,#fff);margin-top:6px;font-size:13px;line-height:1.6';
                    mdPreview.innerHTML = simpleMarkdownToHtml(val);
                    preview.appendChild(mdPreview);
                }
            };
            input.oninput = () => {
                settings.messageTemplates[key] = input.value;
                saveSettings();
                refreshPreview();
            };
            const resetBtn = document.createElement('button');
            resetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            resetBtn.textContent = '↺ 기본값';
            resetBtn.onclick = () => {
                settings.messageTemplates[key] = DEFAULT_MESSAGE_TEMPLATES[key];
                input.value = settings.messageTemplates[key];
                saveSettings();
                refreshPreview();
            };
            refreshPreview();
            group.append(lbl, hintEl, input, preview, resetBtn, createPromptSaveBtn());
            messageSection.appendChild(group);
        });
        return createTabs([
            { key: 'route', label: '🤖 모델/라우팅', content: routeSection },
            { key: 'sns', label: '📸 SNS 프롬프트', content: snsSection },
            { key: 'message', label: '✉️ 메시지/통화', content: messageSection },
        ], 'route');
    }

    const tabs = createTabs([
        { key: 'general', label: '⚙️ 일반', content: buildGeneralTab() },
        { key: 'modules', label: '🧩 모듈', content: buildModulesTab() },
        { key: 'quickAccess', label: '⚡ 퀵 액세스', content: buildQuickAccessTab() },
        { key: 'media', label: '🖼️ 이미지', content: buildMediaTab() },
        { key: 'theme', label: '🎨 테마', content: buildThemeTab() },
        { key: 'prompts', label: '📝 프롬프트', content: buildSnsPromptTab() },
    ], 'general');

    createPopup({
        id: 'settings',
        title: '⚙️ ST-LifeSim 설정',
        content: tabs,
        className: 'slm-sub-panel slm-settings-panel',
        onBack,
    });
}

/**
 * 설정을 저장한다
 */
function saveSettings() {
    const ctx = getContext();
    if (ctx?.saveSettingsDebounced) ctx.saveSettingsDebounced();
}

/**
 * 프롬프트 저장 버튼 클릭 시 사용하는 강제 저장 함수.
 * debounce 되지 않은 즉시 저장을 시도하고, 불가하면 debounced 저장 후 flush를 시도한다.
 * @returns {boolean} 저장 시도 성공 여부
 */
function forceSaveSettings() {
    const ctx = getContext();
    if (!ctx) {
        console.warn('[ST-LifeSim] forceSaveSettings: context not available');
        return false;
    }
    if (typeof ctx.saveSettings === 'function') {
        ctx.saveSettings();
        return true;
    }
    if (ctx.saveSettingsDebounced) {
        ctx.saveSettingsDebounced();
        if (typeof ctx.saveSettingsDebounced.flush === 'function') {
            ctx.saveSettingsDebounced.flush();
        }
        return true;
    }
    console.warn('[ST-LifeSim] forceSaveSettings: no save method available on context');
    return false;
}

/**
 * 프롬프트 커스텀 저장 버튼을 생성한다.
 * @returns {HTMLButtonElement}
 */
function createPromptSaveBtn() {
    const btn = document.createElement('button');
    btn.className = 'slm-btn slm-btn-sm';
    btn.textContent = '💾 저장';
    btn.style.marginLeft = '6px';
    btn.onclick = () => {
        if (forceSaveSettings()) {
            showToast('✅ 프롬프트가 저장되었습니다.', 'success', 1500);
        } else {
            showToast('⚠️ 저장에 실패했습니다. 다시 시도해주세요.', 'error', 2000);
        }
    };
    return btn;
}

function hasForcedCallIntentFromLatestUserMessage() {
    const ctx = getContext();
    const lastUserMsg = ctx?.chat?.[ctx.chat.length - 1];
    if (!lastUserMsg || !lastUserMsg.is_user) return false;
    const text = String(lastUserMsg.mes || '');
    // 전화 요청 패턴: "전화해줘", "call me" 등
    const callRequestRe = /전화\s*해|전화\s*줘|전화\s*걸어|전화\s*해줘|call\s*me|give\s*me\s*a\s*call|call\s*now/i;
    // 그리움/보고싶다 패턴: 전화 유도 강도 있는 표현
    const longingRe = /보고\s*싶[어다]|보고\s*싶[어다]고|그립[다워]|miss\s+you\b/i;
    return callRequestRe.test(text) || longingRe.test(text);
}

function hasExplicitImageIntentAroundLatestMessage() {
    const ctx = getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return false;
    const recentMessages = chat.slice(-IMAGE_INTENT_CONTEXT_WINDOW);
    const userRequestPatterns = [
        /사진.*(보내|줘|보여|찍어)|이미지.*(보내|줘|보여)|셀카.*(보내|줘)|찍은\s*사진/i,
        /photo|picture|pic|image|selfie|screenshot|send\s+(me\s+)?(a\s+)?(photo|picture|pic|image)|show\s+(me\s+)?(a\s+)?(photo|picture|pic|image)/i,
        /브이\s*해|포즈.*(잡아|취해|해줘)|찍어\s*줘|인증.*샷|보여\s*줘/i,
        /take\s+(a\s+)?(photo|pic|selfie|picture)|pose\s+for/i,
        // C1: Implicit visual intent — user requests a visual action without explicitly saying "photo"
        /v\s*sign|peace\s*sign|손가락|브이|윙크|wink|미소.*지어|smile\s+for|손\s*흔들|wave/i,
        /어떤\s*표정|어떻게\s*생겼|입고\s*있|wearing|옷.*보여|outfit|look\s+like/i,
        /어디\s*있|where\s+are\s+you|뭐\s*하고\s*있|what\s+are\s+you\s+doing|지금\s*모습/i,
        // Follow-up image requests — user asks for more images after char already sent one
        /(?:\d+\s*장|한\s*장|두\s*장|세\s*장).*(?:더|추가|또).*(?:보내|줘|보여|찍어)/i,
        /(?:더|추가|또).*(?:\d+\s*장|한\s*장|사진|이미지|셀카).*(?:보내|줘|보여)/i,
        /(?:more|another|one\s+more|send\s+more).*(?:photo|picture|pic|image|selfie)/i,
        /(?:photo|picture|pic|image|selfie).*(?:more|another|again)/i,
    ];
    const charSendIntentPatterns = [
        /사진.*(보낼게|보내줄게|찍어줄게|첨부|보여줄게)|이미지.*(보낼게|보내줄게|첨부|보여줄게)|셀카.*(보낼게|보내줄게)/i,
        /here['’]?s\s+(a\s+)?(photo|picture|pic|image)|i['’]ll\s+send\s+(you\s+)?(a\s+)?(photo|picture|pic|image)|let\s+me\s+show/i,
        /찍어\s*봤|찍었|보내\s*줄게|올려\s*줄게|보여\s*줄게|보낼\s*거/i,
        /took\s+(a\s+)?(photo|pic|selfie|picture)|check\s+this\s+out|look\s+at\s+this/i,
        // C1: Implicit visual intent — character describes a visual action that implies an image
        /v\s*sign|peace\s*sign|브이.*했|윙크.*했|wink|미소.*지었|smiled/i,
        /찍어\s*봄|찍어봤|한\s*장.*찍|잠깐.*봐|이거\s*봐/i,
    ];
        // Existing check: any message independently matches explicit intent
    if (recentMessages.some((msg) => {
        const text = msg?.mes;
        if (!text) return false;
        const patterns = msg?.is_user ? userRequestPatterns : charSendIntentPatterns;
        return patterns.some((re) => re.test(text));
    })) return true;

    // ── NEW: AI offered to send an image → user agreed ──
    // Detect when the AI proposes/offers to send an image (question form)
    // and the user responds with a short affirmative answer.
    const charOfferPatterns = [
        // Korean: image keyword + offer/question ending (줄까, 볼까, 할까)
        /(?:사진|이미지|셀카|인증샷)[\s\S]*?(?:줄까|볼까|할까)/i,
        // Korean: "사진이라도" (casual offer implying sending a photo)
        /사진이라도/i,
        // English: offer/question form + image keyword
        /(?:shall|should|want\s+me\s+to|do\s+you\s+want)[\s\S]*?(?:send|show|take)[\s\S]*?(?:photo|picture|pic|image|selfie)/i,
        /(?:photo|picture|pic|image|selfie)[\s\S]*?(?:shall\s+I|want\s+me\s+to|should\s+I)/i,
        /wanna\s+see\s+(?:a\s+)?(?:photo|picture|pic|image|selfie)/i,
    ];
    const userAgreementRe = /^\s*(?:응|웅|어|그래|좋아|네|예|ㅇㅇ|ㅇ|오키|오케이|고|ㄱㄱ|ㄱ|yes|yeah|yep|yup|ok|okay|sure|please|그럼|당연|물론|해줘|해봐|gogo|당근|좋지|ㅇㅋ|보내|보내줘|보내봐|보여줘|보여봐|응응|그래그래|좋아좋아)[\s.!~?ㅋㅎ]*$/i;
    // Short messages only — prevents long user messages from being misidentified as simple agreement
    const MAX_AGREEMENT_LENGTH = 30;

    for (let i = 0; i < recentMessages.length - 1; i++) {
        const msg = recentMessages[i];
        if (msg?.is_user) continue;
        const text = String(msg?.mes || '');
        if (!charOfferPatterns.some(re => re.test(text))) continue;
        // AI offered an image — check if any subsequent user message is an agreement
        for (let j = i + 1; j < recentMessages.length; j++) {
            const nextMsg = recentMessages[j];
            if (!nextMsg?.is_user) continue;
            const nextText = String(nextMsg?.mes || '').trim();
            if (nextText.length <= MAX_AGREEMENT_LENGTH && userAgreementRe.test(nextText)) {
                return true;
            }
        }
    }

    return false;
}

function isAsciiNameToken(name) {
    return /^[a-z0-9_]+$/i.test(name);
}

const NAME_MENTION_REGEX_CACHE = new Map();

function isNameMentionedInText(textLower, name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return false;
    if (isAsciiNameToken(normalized)) {
        let re = NAME_MENTION_REGEX_CACHE.get(normalized);
        if (!re) {
            re = new RegExp(`(^|[^a-z0-9_])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
            NAME_MENTION_REGEX_CACHE.set(normalized, re);
        }
        return re.test(textLower);
    }
    return textLower.includes(normalized);
}

function collectMentionedContactNames(text, contacts = []) {
    const textLower = String(text || '').toLowerCase();
    if (!textLower) return [];
    const names = [];
    const seen = new Set();
    contacts.forEach((contact) => {
        const aliases = [contact?.name, contact?.displayName, contact?.subName]
            .map(v => String(v || '').trim())
            .filter(Boolean);
        if (!aliases.length) return;
        if (!aliases.some(alias => isNameMentionedInText(textLower, alias))) return;
        const contactName = String(contact?.name || contact?.displayName || '').trim();
        const key = contactName.toLowerCase();
        if (!contactName || seen.has(key)) return;
        seen.add(key);
        names.push(contactName);
    });
    return names;
}

/**
 * 외모 태그 그룹을 중복 없이 배열에 추가한다.
 * @param {string[]} groups
 * @param {string} tagGroup
 * @returns {void}
 */
function pushUniqueTagGroup(groups, tagGroup) {
    const clean = String(tagGroup || '').trim();
    if (!clean) return;
    if (!groups.includes(clean)) groups.push(clean);
}

/**
 * 외모 태그 그룹을 중복 없이 배열 맨 앞에 배치한다.
 * @param {string[]} groups
 * @param {string} tagGroup
 * @returns {void}
 */
function unshiftUniqueTagGroup(groups, tagGroup) {
    const clean = String(tagGroup || '').trim();
    if (!clean) return;
    const existingIndex = groups.indexOf(clean);
    if (existingIndex >= 0) groups.splice(existingIndex, 1);
    groups.unshift(clean);
}

function syncQuickSendButtons() {
    const quickBtn = document.getElementById('slm-quick-send-btn');
    const deletedBtn = document.getElementById('slm-deleted-msg-btn');
    quickBtn?.remove();
    deletedBtn?.remove();
}

// ── 메신저 이미지 생성/텍스트 변환 로직 ──────────────────────────

// 동시 실행 방지 플래그 — 이미지 생성이 진행 중인 동안 중복 호출을 차단한다
let _imageGenInProgress = false;
// 재실행 대기 플래그 — 이미지 생성 진행 중 새로운 호출이 들어오면 완료 후 재실행한다
let _imageGenPendingRetry = false;
// 재실행 횟수 제한 — 무한 재귀를 방지한다
let _imageGenRetryCount = 0;
const MAX_IMAGE_GEN_RETRIES = 3;

// 메신저 이미지 프롬프트 주입 태그
const MSG_IMAGE_INJECT_TAG = 'st-lifesim-msg-image';

// <pic prompt="..."> 패턴 감지 정규식 — 강화된 버전
// 지원 패턴:
//   <pic prompt="...">  /  <pic prompt="..." />  /  <pic prompt='...'>
//   pic prompt="..."  (앵글 브래킷 없음)
//   <pic prompt="..." (닫는 브래킷 누락)
//   다양한 공백, 인용부호, HTML 엔티티 변형
const PIC_TAG_REGEX = /<?pic\s+[^>\n]*?\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s*\/?\s*>)?/gi;

/**
 * AI 모델이 종종 출력하는 유니코드 스마트/커리 인용부호를 ASCII 인용부호로 정규화한다.
 * 또한 HTML 엔티티로 인코딩된 pic 태그, 전각 인용부호, 백틱 래핑 등을 처리한다.
 * 이를 통해 <pic prompt="..."> 정규식이 올바르게 매칭될 수 있도록 한다.
 * @param {string} text
 * @returns {string}
 */
function normalizeQuotesForPicTag(text) {
    return text
        // Smart/curly double quotes + fullwidth quotation mark → ASCII double quote
        .replace(/[\u201C\u201D\u201E\u201F\uFF02]/g, '"')
        // Smart/curly single quotes + fullwidth apostrophe → ASCII single quote
        .replace(/[\u2018\u2019\u201A\u201B\uFF07]/g, "'")
        // HTML-entity-encoded pic tags → decoded for regex matching
        // e.g. &lt;pic prompt=&quot;...&quot;&gt; → <pic prompt="...">
        .replace(/&lt;(\s*pic\s+[^\n]*?prompt\s*=\s*)&quot;([^\n]*?)&quot;(\s*\/?\s*)&gt;/gi, '<$1"$2"$3>')
        .replace(/&lt;(\s*pic\s+[^\n]*?prompt\s*=\s*)&quot;([^\n]*?)&quot;/gi, '<$1"$2"')
        // Strip inline backtick wrapping around pic tags (e.g., `<pic prompt="...">`)
        .replace(/`(<?\s*pic\s+[^`\n]*?prompt\s*=\s*(?:"[^"]*"|'[^']*')(?:\s*\/?\s*>)?)`/gi, '$1');
}

/**
 * 메신저 이미지 모드에 따라 AI 프롬프트 주입을 업데이트한다
 * ON: AI에게 사진 상황에서 <pic prompt="..."> 태그를 출력하도록 지시
 * OFF: 주입을 제거하여 AI가 <pic> 태그를 출력하지 않도록 한다
 */
// OFF 모드 이미지 프롬프트 — AI가 사진 상황을 <pic> 태그로 표시하되, 실제 생성은 하지 않음
const MSG_IMAGE_OFF_PROMPT = '<image_generation_rule>\nWhen {{char}} would naturally TAKE A PHOTO with their phone and SEND IT via messenger, insert a <pic prompt="image description in Korean for the photo situation"> tag at that point in your response.\nThe image must be something {{char}} could physically take with their own phone camera and deliberately choose to send. Do NOT insert <pic> tags for narrative scene descriptions or emotional state illustrations.\nRules:\n1) Default subject is {{char}} only. Always include {{char}}\'s name explicitly.\n2) If other characters from the contacts are involved, include their names explicitly.\n3) Include {{user}} only when context explicitly indicates both are together or the photo is focused on {{user}}. Use {{user}}\'s name explicitly.\n4) Do not mix unrelated character appearance traits.\n5) Keep the situation brief and visual.\n6) Each <pic> tag MUST describe a completely NEW unique scene. NEVER reuse, reference, or modify a previously generated image URL from the conversation.\n7) Analyze visual intent from context — if the user implies a visual action, generate a <pic> tag even without the word "photo".\n8) Do NOT generate images just because the conversation mentions a visual scene. Only when {{char}} deliberately takes and sends a photo.\n</image_generation_rule>';

function updateMessageImageInjection() {
    const ctx = getContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    if (!isEnabled()) {
        ctx.setExtensionPrompt(MSG_IMAGE_INJECT_TAG, '', 1, 0);
        return;
    }
    if (isCallActive()) {
        ctx.setExtensionPrompt(MSG_IMAGE_INJECT_TAG, '', 1, 0);
        return;
    }
    const settings = getSettings();
    if (settings.messageImageGenerationMode) {
        const prompt = settings.messageImageInjectionPrompt || DEFAULT_SETTINGS.messageImageInjectionPrompt;
        ctx.setExtensionPrompt(MSG_IMAGE_INJECT_TAG, prompt, 1, 0);
    } else {
        // OFF 모드에서도 AI가 <pic> 태그를 출력하도록 유도
        // (이후 텍스트로 변환 처리됨)
        ctx.setExtensionPrompt(MSG_IMAGE_INJECT_TAG, MSG_IMAGE_OFF_PROMPT, 1, 0);
    }
}

/**
 * C2: 채팅 기록에 이미 존재하는 이미지 URL인지 확인한다.
 * 이전에 생성된 이미지 URL을 재사용하는 버그를 방지한다.
 * @param {string} url - 확인할 이미지 URL
 * @param {Object} ctx - SillyTavern context
 * @returns {boolean} 이미 존재하면 true
 */
function isUrlAlreadyInChat(url, ctx) {
    if (!url || !ctx?.chat) return false;
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    return chat.some(msg => {
        const mes = String(msg?.mes || '');
        return mes.includes(url);
    });
}

/**
 * 메신저 자동 이미지 생성을 외부 API를 통해 호출한다.
 * @param {string} imagePrompt - 이미지 생성에 사용할 프롬프트
 * @returns {Promise<string>} 생성된 이미지의 URL 또는 빈 문자열
 */
async function generateMessageImageViaApi(imagePrompt) {
    if (!imagePrompt || !imagePrompt.trim()) {
        console.warn('[ST-LifeSim] generateMessageImageViaApi: 빈 프롬프트가 전달됨');
        return '';
    }
    try {
        const ctx = getContext();
        if (!ctx) return '';
        const settings = getSettings();
        const externalApiUrl = String(settings?.snsExternalApiUrl || '').trim();
        const externalApiTimeoutMs = Math.max(1000, Math.min(60000, Number(settings?.snsExternalApiTimeoutMs) || 12000));
        if (externalApiUrl && typeof fetch === 'function') {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), externalApiTimeoutMs);
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (typeof ctx.getRequestHeaders === 'function') {
                    Object.assign(headers, ctx.getRequestHeaders());
                }
                const response = await fetch(externalApiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ prompt: imagePrompt, module: 'st-lifesim-messenger-image' }),
                    signal: controller.signal,
                });
                if (response.ok) {
                    const rawText = await response.text();
                    let resultStr = String(rawText || '').trim();
                    try {
                        const json = JSON.parse(rawText || 'null');
                        if (typeof json === 'string') resultStr = json.trim();
                        else if (typeof json?.url === 'string') resultStr = json.url.trim();
                        else if (typeof json?.imageUrl === 'string') resultStr = json.imageUrl.trim();
                        else if (typeof json?.text === 'string') resultStr = json.text.trim();
                    } catch { /* non-JSON 응답은 그대로 사용 */ }
                    if (resultStr && (resultStr.startsWith('http') || resultStr.startsWith('/') || resultStr.startsWith('data:'))) {
                        if (isUrlAlreadyInChat(resultStr, ctx)) {
                            console.warn('[ST-LifeSim] 외부 API 이미지 URL이 이미 채팅에 존재합니다. 재사용 방지를 위해 거부합니다.');
                            return '';
                        }
                        return resultStr;
                    }
                    console.warn('[ST-LifeSim] 외부 API가 유효한 이미지 URL을 반환하지 않음');
                } else {
                    console.warn('[ST-LifeSim] 메신저 이미지 외부 API 응답 오류:', response.status);
                }
            } catch (error) {
                console.warn('[ST-LifeSim] 메신저 이미지 외부 API 호출 실패:', error);
            } finally {
                clearTimeout(timer);
            }
        } else {
            console.warn('[ST-LifeSim] 메신저 이미지 외부 API가 없어 /sd 이미지 생성으로 폴백합니다.');
        }
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            const result = await ctx.executeSlashCommandsWithOptions(`/sd quiet=true ${imagePrompt}`, { showOutput: false });
            const resultStr = String(result?.pipe || result || '').trim();
            if (resultStr && (resultStr.startsWith('http') || resultStr.startsWith('/') || resultStr.startsWith('data:'))) {
                if (isUrlAlreadyInChat(resultStr, ctx)) {
                    console.warn('[ST-LifeSim] /sd 이미지 URL이 이미 채팅에 존재합니다. 재사용 방지를 위해 거부합니다.');
                    return '';
                }
                return resultStr;
            }
        }
        return '';
    } catch (e) {
        console.warn('[ST-LifeSim] 메신저 이미지 생성 API 호출 실패:', e);
        return '';
    }
}

/**
 * 메신저 이미지 생성 파이프라인 (외부 호출용)
 * 답변/프롬프트가 이미 직접 이미지 프롬프트를 출력한다고 가정하고 Image API만 호출한다.
 * @param {string} rawPrompt - 원본 이미지 설명
 * @param {Object} options
 * @param {string} options.charName - 캐릭터 이름
 * @param {string[]} [options.includeNames] - 포함할 이름 목록
 * @param {Array} [options.contacts] - 연락처 목록
 * @param {Object} [options.settings] - 확장 설정
 * @returns {Promise<{imageUrl: string, fallbackText: string}>}
 */
async function processMessengerImageGeneration(rawPrompt, options = {}) {
    const { includeNames = [], contacts = [], settings = getSettings() } = options;
    const tagResult = buildDirectImagePrompt(rawPrompt, {
        includeNames,
        contacts,
        getAppearanceTagsByName,
        tagWeight: Number(settings.tagWeight) || 0,
    });
    if (!tagResult.finalPrompt) {
        console.warn('[ST-LifeSim] 메신저 이미지 태그 생성 결과 없음');
        const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
        return { imageUrl: '', fallbackText: template.replace(/\{description\}/g, rawPrompt) };
    }
    try {
        console.log('[ST-LifeSim] 메신저 이미지 생성 API 호출 시작, finalPrompt:', tagResult.finalPrompt.substring(0, 150));
        const imageUrl = await generateMessageImageViaApi(tagResult.finalPrompt);
        if (imageUrl) {
            return { imageUrl, fallbackText: '' };
        }
    } catch (err) {
        console.warn('[ST-LifeSim] 메신저 이미지 생성 실패:', err);
    }
    const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
    return { imageUrl: '', fallbackText: template.replace(/\{description\}/g, rawPrompt) };
}

function waitForDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function wrapRichMessageHtml(html) {
    return String(html || '');
}

async function updateRenderedMessageHtml(msgIdx, html, logLabel = '메시지') {
    if (!Number.isFinite(msgIdx) || msgIdx < 0) return false;
    const selectors = [
        `.mes[mesid="${msgIdx}"] .mes_text`,
        `div.mes[mesid="${msgIdx}"] .mes_text`,
        `#chat .mes[mesid="${msgIdx}"] .mes_text`,
    ];
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const mesTextEl = selectors
                .map(selector => document.querySelector(selector))
                .find(Boolean);
            if (mesTextEl) {
                mesTextEl.innerHTML = wrapRichMessageHtml(html);
                return true;
            }
        } catch (uiErr) {
            console.warn(`[ST-LifeSim] ${logLabel} UI 업데이트 실패:`, uiErr);
            return false;
        }
        await waitForDelay(attempt < 2 ? 50 : 120);
    }
    console.warn(`[ST-LifeSim] ${logLabel} UI 업데이트 대상 요소를 찾지 못했습니다.`, { msgIdx });
    return false;
}

/**
 * char 메시지 렌더링 후 이미지 태그를 처리한다
 * - ON: <pic prompt="..."> 태그를 감지하여 이미지 생성 API로 실제 이미지 생성
 *       여러 장인 경우 생성 결과를 순차적으로 UI에 반영한다
 * - OFF: <pic prompt="..."> 태그를 줄글 텍스트 형식으로 변환
 */
async function applyCharacterImageDisplayMode() {
    // 동시 실행 방지: 이전 호출이 완료될 때까지 대기 플래그를 세우고 나중에 재실행한다
    if (_imageGenInProgress) {
        _imageGenPendingRetry = true;
        return;
    }
    _imageGenInProgress = true;
    try {
        const settings = getSettings();
        if (!isEnabled()) return;
        const ctx = getContext();
        if (!ctx) return;
        const lastMsg = ctx.chat?.[ctx.chat.length - 1];
        if (!lastMsg || lastMsg.is_user) return;
        const mes = normalizeQuotesForPicTag(String(lastMsg.mes || ''));

        // <pic prompt="..."> 태그가 있는지 확인 (smart/curly quotes는 정규화 후 매칭)
        PIC_TAG_REGEX.lastIndex = 0; // /g 플래그 정규식의 방어적 리셋 (matchAll은 내부 복제하지만 안전을 위해)
        const picMatches = [...mes.matchAll(PIC_TAG_REGEX)];
        if (picMatches.length === 0) return;

        const charName = String(lastMsg.name || ctx?.name2 || '{{char}}');
        const msgIdx = Number(ctx.chat.length - 1);

        // char의 응답에 <pic prompt="..."> 태그가 포함되어 있으면 그 자체가 이미지 생성 의도이므로,
        // 유저의 명시적 지시("사진 보내줘" 등) 없이도 이미지를 생성한다.
        const allowAutoImageGeneration = !isCallActive() && settings.messageImageGenerationMode;

        if (allowAutoImageGeneration) {
            // ── ON 모드: 이미지 생성 API로 실제 이미지 생성 (순차적 UI 업데이트) ──
            // 응답 내 <pic prompt="...">의 직접 이미지 프롬프트를 추적해 Image API로 생성
            // 최대 이미지 수 제한
            const limitedPicMatches = picMatches.slice(0, MAX_MESSENGER_IMAGES_PER_RESPONSE);
            if (picMatches.length > MAX_MESSENGER_IMAGES_PER_RESPONSE) {
                showToast(`📷 이미지 최대 ${MAX_MESSENGER_IMAGES_PER_RESPONSE}장까지 생성 가능합니다.`, 'warn', 2000);
            }
            showToast(`📷 ${limitedPicMatches.length}개 이미지 생성 중...`, 'info', 2000);
            const userName = ctx?.name1 || '';
            const allContactsList = [...getContacts('character'), ...getContacts('chat')];
            const recentContextText = (Array.isArray(ctx.chat) ? ctx.chat : [])
                .slice(-IMAGE_INTENT_CONTEXT_WINDOW)
                .map(m => String(m?.mes || ''))
                .join('\n');
            // 제한 내 이미지만 생성, 초과분은 텍스트 폴백
            const limitedSet = new Set(limitedPicMatches.map(m => m.index));

            // 순차적 처리: 각 이미지를 생성할 때마다 즉시 메시지와 UI를 업데이트한다
            let currentMes = mes;
            let offset = 0; // 이전 치환으로 인한 누적 인덱스 오프셋
            let generatedCount = 0;

            for (const match of picMatches) {
                const fullTag = match[0];
                const rawPrompt = (match[1] || match[2] || '').trim();
                const adjustedIndex = match.index + offset;

                let replacement;
                if (!rawPrompt) {
                    replacement = '';
                } else if (!limitedSet.has(match.index)) {
                    // 최대 이미지 수를 초과한 매치는 텍스트 폴백
                    const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
                    replacement = template.replace(/\{description\}/g, rawPrompt);
                } else {
                    // 외부 파이프라인으로 이미지 생성 처리 (SNS 게시글 생성 로직 참고)
                    const includeNames = [charName];
                    collectMentionedContactNames(`${recentContextText}\n${rawPrompt}`, allContactsList).forEach((name) => {
                        if (name && !includeNames.includes(name)) includeNames.push(name);
                    });
                    const userHintRegex = /\buser\b|{{user}}|유저|너|당신|with user|together|둘이|함께/;
                    if (userName && userHintRegex.test(rawPrompt.toLowerCase())) {
                        includeNames.push(userName);
                    }
                    const result = await processMessengerImageGeneration(rawPrompt, {
                        charName,
                        includeNames,
                        contacts: allContactsList,
                        settings,
                    });
                    if (result.imageUrl) {
                        const safeUrl = escapeHtml(result.imageUrl);
                        const safePrompt = escapeHtml(rawPrompt);
                        replacement = `<img src="${safeUrl}" title="${safePrompt}" alt="${safePrompt}" class="slm-msg-generated-image" style="max-width:100%;border-radius:var(--slm-image-radius,10px);margin:4px 0">`;
                    } else {
                        replacement = result.fallbackText;
                    }
                    generatedCount++;
                }

                // 즉시 치환 적용 및 오프셋 갱신
                currentMes = currentMes.slice(0, adjustedIndex) + replacement + currentMes.slice(adjustedIndex + fullTag.length);
                offset += replacement.length - fullTag.length;

                // 매 생성마다 메시지 데이터 + UI를 즉시 업데이트하여 순차적으로 결과가 표시되도록 한다
                lastMsg.mes = wrapRichMessageHtml(currentMes);
                await updateRenderedMessageHtml(msgIdx, currentMes, '이미지');
            }

            // 모든 이미지 처리 완료 후 채팅 저장
            if (currentMes !== mes) {
                if (typeof ctx.saveChat === 'function') {
                    await ctx.saveChat();
                }
            }
            if (generatedCount > 0) {
                showToast(`📷 이미지 생성 완료`, 'success', 1500);
            }
        } else {
            // ── OFF 모드: 줄글 텍스트로 변환 ──
            /** @type {Array<{index: number, length: number, replacement: string}>} */
            const replacements = [];
            const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
            for (const match of picMatches) {
                const fullTag = match[0];
                const prompt = (match[1] || match[2] || '').trim();
                const matchIndex = match.index;
                if (!prompt) {
                    replacements.push({ index: matchIndex, length: fullTag.length, replacement: '' });
                    continue;
                }
                const text = template.replace(/\{description\}/g, prompt);
                replacements.push({ index: matchIndex, length: fullTag.length, replacement: text });
            }

            if (replacements.length === 0) return;

            // 역순으로 치환하여 인덱스 오프셋 문제를 방지한다
            let updatedMes = mes;
            for (let i = replacements.length - 1; i >= 0; i--) {
                const { index, length, replacement } = replacements[i];
                updatedMes = updatedMes.slice(0, index) + replacement + updatedMes.slice(index + length);
            }

            if (updatedMes !== mes) {
                lastMsg.mes = wrapRichMessageHtml(updatedMes);
                await updateRenderedMessageHtml(msgIdx, updatedMes, '이미지 텍스트');
                if (typeof ctx.saveChat === 'function') {
                    await ctx.saveChat();
                }
            }
        }
    } finally {
        _imageGenInProgress = false;
        // 진행 중 새로운 호출이 대기 중이었다면 재실행한다 (최대 횟수 제한)
        if (_imageGenPendingRetry && _imageGenRetryCount < MAX_IMAGE_GEN_RETRIES) {
            _imageGenPendingRetry = false;
            _imageGenRetryCount++;
            applyCharacterImageDisplayMode().catch((e) => console.error('[ST-LifeSim] 이미지 표시 모드 재실행 오류:', e));
        } else {
            _imageGenPendingRetry = false;
            _imageGenRetryCount = 0;
        }
    }
}

async function applyCharacterEmoticonDisplayMode() {
    if (!isEnabled()) return;
    const ctx = getContext();
    if (!ctx) return;
    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;

    const mes = String(lastMsg.mes || '');
    const senderName = String(lastMsg.name || ctx?.name2 || '{{char}}');
    const updatedMes = replaceAiSelectedEmoticons(mes, senderName);
    if (updatedMes === mes) return;

    lastMsg.mes = wrapRichMessageHtml(updatedMes);
    // DOM mesid는 숫자 인덱스를 사용하므로 lastMsg 참조와 별개로 마지막 메시지 인덱스를 구한다.
    const msgIdx = Number(ctx.chat.length - 1);
    await updateRenderedMessageHtml(msgIdx, updatedMes, '이모티콘');
    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
    }
}

// ── 주간/야간 테마 토글 ──────────────────────────────────────────
/**
 * 사용자가 명시적으로 저장한 강제 테마를 반환한다.
 * 저장된 값이 없으면 null을 반환한다 (자동 감지 상태).
 * @returns {'light'|'dark'|null}
 */
function getForcedTheme() {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return null;
}

/**
 * 시스템/ST 테마를 포함한 실제 적용 중인 테마를 반환한다.
 * 강제 테마가 없으면 SillyTavern 클래스 및 시스템 설정을 확인한다.
 * @returns {'light'|'dark'}
 */
function getEffectiveTheme() {
    const forced = getForcedTheme();
    if (forced) return forced;
    if (
        document.body.classList.contains('dark-theme') ||
        document.body.dataset.theme === 'dark' ||
        document.body.classList.contains('darkTheme') ||
        window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
        return 'dark';
    }
    return 'light';
}

/**
 * 강제 테마를 적용한다.
 * null을 전달하면 강제 테마를 해제하고 시스템/ST 테마로 복귀한다.
 * 테마 전환 시 패널/카드/텍스트 배경 등 핵심 CSS 변수의 인라인 오버라이드를
 * 제거하여 테마 CSS가 올바르게 적용되도록 한다.
 * @param {'light'|'dark'|null} theme
 */
function applyForcedTheme(theme) {
    // 테마 전환 시 핵심 색상 인라인 오버라이드 제거
    const themeVars = ['--slm-bg', '--slm-bg-secondary', '--slm-bg-tertiary', '--slm-surface', '--slm-text', '--slm-text-secondary', '--slm-border', '--slm-overlay-bg'];
    themeVars.forEach(v => document.documentElement.style.removeProperty(v));

    // 저장된 사용자 커스텀 색상 중 핵심 변수도 제거
    const settings = getSettings();
    if (settings.themeColors) {
        themeVars.forEach(v => { delete settings.themeColors[v]; });
        saveSettings();
    }

    if (theme === 'dark' || theme === 'light') {
        document.documentElement.setAttribute('data-slm-theme', theme);
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    } else {
        document.documentElement.removeAttribute('data-slm-theme');
        localStorage.removeItem(THEME_STORAGE_KEY);
    }
}

/**
 * 주간 ↔ 야간 테마를 순환한다
 * @returns {'light'|'dark'} 새 테마 값
 */
function cycleTheme() {
    const current = getEffectiveTheme();
    const next = current === 'light' ? 'dark' : 'light';
    applyForcedTheme(next);
    return next;
}

/**
 * 컬러피커에서 처리 가능한 HEX 색상값으로 정규화한다
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeColorValue(value, fallback) {
    const raw = (value || '').trim();
    // Already valid 6-digit hex
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
    // 3-digit hex → expand to 6-digit
    const m3 = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
    // rgb(r, g, b) / rgba(r, g, b, a) → hex
    const rgbMatch = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (rgbMatch) {
        const r = Math.min(255, parseInt(rgbMatch[1], 10));
        const g = Math.min(255, parseInt(rgbMatch[2], 10));
        const b = Math.min(255, parseInt(rgbMatch[3], 10));
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(fallback) ? fallback : '#000000';
}

/**
 * 확장 초기화 - SillyTavern이 준비된 후 실행된다
 */
async function init() {
    console.log('[ST-LifeSim] 초기화 시작');

    const ctx = getContext();
    if (!ctx) {
        console.error('[ST-LifeSim] 컨텍스트를 가져올 수 없습니다.');
        return false;
    }

    const settings = getSettings();

    // 이모티콘 모서리 반경 CSS 변수 적용
    document.documentElement.style.setProperty('--slm-emoticon-radius', (settings.emoticonRadius ?? 10) + 'px');
    document.documentElement.style.setProperty('--slm-image-radius', (settings.imageRadius ?? 10) + 'px');

    // 저장된 강제 테마가 있을 때만 적용 (없으면 시스템/ST 테마를 그대로 따름)
    const savedTheme = getForcedTheme();
    if (savedTheme) applyForcedTheme(savedTheme);

    // 저장된 테마 색상 적용
    if (settings.themeColors) {
        Object.entries(settings.themeColors).forEach(([key, val]) => {
            if (key && val) document.documentElement.style.setProperty(key, val, 'important');
        });
    }
    document.documentElement.style.setProperty('--slm-toast-top', `${settings.toast?.offsetY ?? 16}px`);
    ['info', 'success', 'warn', 'error'].forEach((key) => {
        const val = settings.toast?.colors?.[key];
        if (val) document.documentElement.style.setProperty(`--slm-toast-${key}`, val);
    });
    if (settings.toast?.fontColor) {
        document.documentElement.style.setProperty('--slm-toast-font-color', settings.toast.fontColor);
    }

    // 각 모듈 초기화 (활성화된 경우만, 오류 발생 시 개별 모듈만 스킵)
    const moduleInits = [
        { key: 'emoticon', fn: initEmoticon },
        { key: 'contacts', fn: initContacts },
        { key: 'call', fn: initCall },
        { key: 'wallet', fn: initWallet },
        { key: 'sns', fn: initSns },
        { key: 'calendar', fn: initCalendar },
        { key: 'gifticon', fn: initGifticon },
    ];
    for (const { key, fn } of moduleInits) {
        if (isModuleEnabled(key)) {
            try { fn(); } catch (e) { console.error(`[ST-LifeSim] 모듈 초기화 오류 (${key}):`, e); }
        }
    }

    // 메신저 이미지 생성 프롬프트 주입 설정
    try { updateMessageImageInjection(); } catch (e) { console.error('[ST-LifeSim] 이미지 프롬프트 주입 오류:', e); }

    // 비대면 규칙 컨텍스트 주입 (전체 확장에 적용)
    registerContextBuilder('non-face-to-face', () => {
        const charName = getContext()?.name2 || '{{char}}';
        return `[NON-FACE-TO-FACE RULE]\n{{user}} and ${charName} communicate ONLY through mobile phone (text messages and phone calls). They CANNOT meet in person under any circumstances. This is an absolute, unchangeable rule.\n- NEVER suggest, plan, or describe meeting face-to-face.\n- NEVER describe being in the same physical location.\n- NEVER use phrases like "I'm coming over", "let's meet up", "I'm on my way", "기다려, 지금 출발했어", "만나러 갈게", "보러 갈게".\n- All interactions must remain strictly through the phone (messaging or calls).`;
    });

    // ST-LifeSim 메뉴 버튼 삽입 (sendform 옆)
    try { injectLifeSimMenuButton(); } catch (e) { console.error('[ST-LifeSim] 메뉴 버튼 오류:', e); }

    // RightSendForm 아이콘 삽입
    try { injectRightSendFormIcons(); } catch (e) { console.error('[ST-LifeSim] RSF 아이콘 오류:', e); }

    // 선톡 타이머 시작 (활성화된 경우)
    try { startFirstMsgTimer(settings.firstMsg); } catch (e) { console.error('[ST-LifeSim] 선톡 타이머 오류:', e); }

    // AI 응답 후 컨텍스트 주입
    const eventTypes = ctx.eventTypes || ctx.event_types;
    const evSrc = ctx.eventSource;

    const refreshContextAndInjection = async () => {
        if (!isEnabled()) return;
        await injectContext().catch(e => console.error('[ST-LifeSim] 컨텍스트 주입 오류:', e));
        try { updateMessageImageInjection(); } catch (e) { console.error('[ST-LifeSim] 이미지 프롬프트 재주입 오류:', e); }
    };

    if (evSrc && eventTypes?.CHARACTER_MESSAGE_RENDERED) {
        evSrc.on(eventTypes.CHARACTER_MESSAGE_RENDERED, refreshContextAndInjection);
    }

    // 채팅/캐릭터 전환 시 컨텍스트를 즉시 갱신
    if (evSrc && eventTypes?.CHAT_CHANGED) {
        evSrc.on(eventTypes.CHAT_CHANGED, refreshContextAndInjection);
    }
    if (evSrc && eventTypes?.CHARACTER_CHANGED) {
        evSrc.on(eventTypes.CHARACTER_CHANGED, refreshContextAndInjection);
    }
    if (evSrc && eventTypes?.CHARACTER_SELECTED) {
        evSrc.on(eventTypes.CHARACTER_SELECTED, refreshContextAndInjection);
    }
    void refreshContextAndInjection();

    // 유저 메시지 전송 시 설정된 확률로 SNS 포스팅 트리거
    if (evSrc && eventTypes?.MESSAGE_SENT) {
        let snsTriggerInFlight = false;
        let snsReactionInFlight = false;
        evSrc.on(eventTypes.MESSAGE_SENT, () => {
            if (isModuleEnabled('sns')) {
                const prob = (getSettings().snsPostingProbability ?? 10) / 100;
                if (!snsTriggerInFlight && Math.random() < prob) {
                    snsTriggerInFlight = true;
                    triggerNpcPosting()
                        .catch(e => console.error('[ST-LifeSim] SNS 자동 포스팅 오류:', e))
                        .finally(() => { snsTriggerInFlight = false; });
                }
                if (!snsReactionInFlight && Math.random() < prob && hasPendingCommentReaction()) {
                    snsReactionInFlight = true;
                    triggerPendingCommentReaction()
                        .catch(e => console.error('[ST-LifeSim] SNS 댓글 반응 생성 오류:', e))
                        .finally(() => { snsReactionInFlight = false; });
                }
            }
            if (isModuleEnabled('call')) {
                const callProb = getSettings().proactiveCallProbability ?? 0;
                const forceCall = hasForcedCallIntentFromLatestUserMessage();
                if (callProb > 0 || forceCall) {
                    triggerProactiveIncomingCall(callProb, { deferUntilAiResponse: true, force: forceCall })
                        .catch(e => console.error('[ST-LifeSim] 선전화 트리거 오류:', e));
                }
            }
            clearScheduledGroupChatTurn();
            pendingGroupChatTurn = planGroupChatTurn();
        });
    }

    if (evSrc && eventTypes?.CHARACTER_MESSAGE_RENDERED) {
        evSrc.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async () => {
            onCharacterMessageRenderedForProactiveCall();
            trackGifticonUsageFromCharacterMessage();
            await applyCharacterEmoticonDisplayMode().catch((e) => console.error('[ST-LifeSim] 이모티콘 표시 모드 적용 오류:', e));
            await applyCharacterImageDisplayMode().catch((e) => console.error('[ST-LifeSim] 이미지 표시 모드 적용 오류:', e));
            if (pendingGroupChatTurn) {
                const plan = pendingGroupChatTurn;
                pendingGroupChatTurn = null;
                schedulePlannedGroupChatTurn(plan);
            }
        });
    }

    console.log('[ST-LifeSim] 초기화 완료');
    return true;
}

let initialized = false;
let initializing = false;
async function initIfNeeded() {
    if (initialized || initializing) return;
    initializing = true;
    try { initialized = await init(); } catch (e) { console.error('[ST-LifeSim] 초기화 오류:', e); } finally { initializing = false; }
}

// SillyTavern APP_READY 이벤트에서 초기화 실행 (호환성 위해 즉시 시도도 함께 수행)
try {
    const ctx = getContext();
    const evSrc = ctx?.eventSource;
    const eventTypes = ctx?.eventTypes || ctx?.event_types;
    if (evSrc?.on && eventTypes?.APP_READY) {
        evSrc.on(eventTypes.APP_READY, initIfNeeded);
    }
} catch (e) {
    console.error('[ST-LifeSim] 이벤트 등록 오류:', e);
}
void initIfNeeded();
