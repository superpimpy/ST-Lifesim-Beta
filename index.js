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
import { injectContext, clearContext } from './utils/context-inject.js';
import { createPopup, createTabs, closePopup } from './utils/popup.js';
import { showToast, showConfirm, escapeHtml } from './utils/ui.js';
import { exportAllData, importAllData, clearAllData } from './utils/storage.js';
import { injectQuickSendButton, renderTimeDividerUI, renderReadReceiptUI, renderNoContactUI, renderEventGeneratorUI, renderVoiceMemoUI } from './modules/quick-tools/quick-tools.js';
import { startFirstMsgTimer, renderFirstMsgSettingsUI } from './modules/firstmsg/firstmsg.js';
import { initEmoticon, openEmoticonPopup } from './modules/emoticon/emoticon.js';
import { initContacts, openContactsPopup, getAppearanceTagsByName } from './modules/contacts/contacts.js';
import { initCall, onCharacterMessageRenderedForProactiveCall, openCallLogsPopup, triggerProactiveIncomingCall } from './modules/call/call.js';
import { initWallet, openWalletPopup } from './modules/wallet/wallet.js';
import { initSns, openSnsPopup, triggerNpcPosting, triggerPendingCommentReaction, hasPendingCommentReaction } from './modules/sns/sns.js';
import { initCalendar, openCalendarPopup } from './modules/calendar/calendar.js';
import { initGifticon, openGifticonPopup, trackGifticonUsageFromCharacterMessage } from './modules/gifticon/gifticon.js';

// 설정 키
const SETTINGS_KEY = 'st-lifesim';

// 주간/야간 테마 저장 키 (localStorage)
const THEME_STORAGE_KEY = 'st-lifesim:forced-theme';
const THEME_MODE_PRESETS_KEY = 'st-lifesim:theme-mode-presets';
const IMAGE_INTENT_CONTEXT_WINDOW = 4;
const ALWAYS_ON_MODULES = new Set(['quickTools', 'contacts']);
const AI_ROUTE_DEFAULTS = {
    api: '',
    chatSource: '',
    modelSettingKey: '',
    model: '',
};
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
    postChar: 'Write exactly one SNS post for {{charName}}. Use natural language and tone that fit {{charName}}\'s nationality/background, personality, and current situation. Keep it 1-2 casual daily-life sentences. Avoid repeating topics or phrasing from recent posts. Do not include hashtags, image tags, quotation marks, other people\'s reactions/comments, or [caption: ...] blocks. Output only {{charName}}\'s own post text.',
    postContact: 'Write exactly one SNS post for {{authorName}}. Personality: {{personality}}. Use natural language and tone that fit {{authorName}}\'s nationality/background and daily context. Keep it 1-2 casual daily-life sentences and avoid repeating recent topics/phrasing. Do not include hashtags, image tags, quotation marks, other people\'s reactions/comments, or [caption: ...] blocks. Output only {{authorName}}\'s own post text.',
    imageDescription: 'For {{authorName}}\'s SNS post "{{postContent}}", write exactly one short sentence describing the attached image. Mention only visible content. Do not use hashtags, quotes, parentheses, or any "caption:" prefix.',
    reply: 'Write exactly one SNS reply for this thread.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nTarget comment author: {{commentAuthorName}} ({{commentAuthorHandle}})\nTarget comment: "{{commentText}}"\nReply author: {{replyAuthorName}} ({{replyAuthorHandle}})\nRules: one sentence only from {{replyAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{replyAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{replyPersonality}}.',
    extraComment: 'Write exactly one additional SNS comment for this post.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nComment author: {{extraAuthorName}} ({{extraAuthorHandle}})\nRules: one short sentence from {{extraAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{extraAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{extraPersonality}}.',
};

// 메시지 템플릿 기본값
const DEFAULT_MESSAGE_TEMPLATES = {
    callStart_incoming: '📞 {charName}님께서 전화를 거셨습니다. {{user}}님께서 전화를 받으셨습니다.',
    callStart_outgoing: '📞 {charName}님께 전화를 걸었습니다. {charName}님께서 전화를 받으셨습니다.',
    callEnd: '📵 통화 종료 (통화시간: {timeStr})',
    voiceMemo: '🎤 음성메시지 ({timeStr})<br>{hint}',
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
    messageImageInjectionPrompt: '<image_generation_rule>\nWhen {{char}} would naturally send a photo or picture in the conversation (e.g., selfie, scenery, food, screenshot, etc.), insert a <pic prompt="image description in English for stable diffusion"> tag at that point in your response.\nRules:\n1) Default subject is {{char}} only.\n2) Include {{user}} only when the context explicitly says both are together or the photo is clearly about {{user}}.\n3) Do not mix appearance traits of multiple people unless the scene explicitly includes multiple people.\n4) Keep the prompt visual and concise.\n</image_generation_rule>',
    snsImagePrompt: 'Create a photorealistic image for {authorName}\'s SNS post. Character appearance: {appearanceTags}. Post content: "{postContent}". The image must accurately depict the scene described in the post. Focus on matching the subject, setting, and mood of the post text. Style: casual daily-life smartphone photo, natural lighting, candid feel.',
    messageImagePrompt: 'Generate a photorealistic image that {charName} would send via messenger. Character appearance: {appearanceTags}. The image must reflect the character\'s physical appearance accurately based on the appearance tags. Style: personal candid photo matching the conversation context, natural and authentic feel.',
    characterAppearanceTags: {}, // { [charName]: "tag1, tag2" }
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
        };
    }
    ['sns', 'snsTranslation', 'callSummary', 'contactProfile'].forEach((feature) => {
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
    if (document.getElementById('slm-menu-btn')) return;

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
        if (document.getElementById('slm-overlay-main-menu')) {
            closePopup('main-menu');
        } else {
            openMainMenuPopup();
        }
    });

    sendBtn.parentNode.insertBefore(btn, sendBtn);
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
            if (!settings.enabled) {
                clearContext();
                showToast('ST-LifeSim 비활성화됨', 'info');
            } else {
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
        wrapper.appendChild(textTemplateGroup);

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
        wrapper.appendChild(injectionPromptGroup);

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
        const messageImagePromptResetBtn = document.createElement('button');
        messageImagePromptResetBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        messageImagePromptResetBtn.textContent = '↺ 기본값';
        messageImagePromptResetBtn.onclick = () => {
            settings.messageImagePrompt = DEFAULT_SETTINGS.messageImagePrompt;
            messageImagePromptInput.value = settings.messageImagePrompt;
            saveSettings();
        };
        messageImagePromptGroup.appendChild(messageImagePromptResetBtn);
        wrapper.appendChild(messageImagePromptGroup);

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

    function buildProbabilityTab() {
        const wrapper = document.createElement('div');
        wrapper.className = 'slm-settings-wrapper slm-form';

        wrapper.appendChild(renderFirstMsgSettingsUI(settings, saveSettings));
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

        return wrapper;
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

        const modePresetGroup = document.createElement('div');
        modePresetGroup.className = 'slm-form-group';
        modePresetGroup.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '🌓 주간/야간 모드 프리셋' }));
        const modePresetRow = document.createElement('div');
        modePresetRow.className = 'slm-input-row';
        const modePresetSaveBtn = document.createElement('button');
        modePresetSaveBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        modePresetSaveBtn.textContent = '💾 저장';
        const modePresetSelect = document.createElement('select');
        modePresetSelect.className = 'slm-select';
        modePresetSelect.style.flex = '1';
        const modePresetLoadBtn = document.createElement('button');
        modePresetLoadBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
        modePresetLoadBtn.textContent = '📂 불러오기';
        const modePresetDeleteBtn = document.createElement('button');
        modePresetDeleteBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
        modePresetDeleteBtn.textContent = '🗑️';
        modePresetDeleteBtn.title = '선택된 프리셋 삭제';
        const loadThemeModePresets = () => {
            const raw = localStorage.getItem(THEME_MODE_PRESETS_KEY) || '{}';
            try { return JSON.parse(raw); } catch (e) {
                console.warn('[ST-LifeSim] 테마 모드 프리셋 파싱 실패:', e, raw);
                return {};
            }
        };
        const refreshModePresetList = () => {
            modePresetSelect.innerHTML = '';
            modePresetSelect.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '-- 모드 프리셋 --' }));
            const presets = loadThemeModePresets();
            Object.keys(presets).forEach((name) => {
                modePresetSelect.appendChild(Object.assign(document.createElement('option'), { value: name, textContent: name }));
            });
        };
        modePresetSaveBtn.onclick = () => {
            const presetName = prompt('주간/야간 모드 프리셋 이름:');
            if (!presetName) return;
            const mode = getEffectiveTheme();
            const presets = loadThemeModePresets();
            presets[presetName] = mode;
            localStorage.setItem(THEME_MODE_PRESETS_KEY, JSON.stringify(presets));
            refreshModePresetList();
            modePresetSelect.value = presetName;
            showToast(`"${presetName}" 저장됨 (${mode === 'light' ? '주간' : '야간'})`, 'success', 1500);
        };
        modePresetLoadBtn.onclick = () => {
            const name = modePresetSelect.value;
            if (!name) { showToast('프리셋을 선택하세요.', 'warn'); return; }
            const mode = loadThemeModePresets()[name];
            if (mode !== 'light' && mode !== 'dark') { showToast('프리셋을 찾을 수 없습니다.', 'error'); return; }
            applyForcedTheme(mode);
            showToast(`프리셋 "${name}" 적용됨`, 'success', 1500);
        };
        modePresetDeleteBtn.onclick = () => {
            const name = modePresetSelect.value;
            if (!name) return;
            const presets = loadThemeModePresets();
            delete presets[name];
            localStorage.setItem(THEME_MODE_PRESETS_KEY, JSON.stringify(presets));
            refreshModePresetList();
            showToast(`프리셋 "${name}" 삭제됨`, 'success', 1200);
        };
        refreshModePresetList();
        modePresetRow.append(modePresetSaveBtn, modePresetSelect, modePresetLoadBtn, modePresetDeleteBtn);
        modePresetGroup.appendChild(modePresetRow);
        wrapper.appendChild(modePresetGroup);

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
        if (!settings.aiRoutes) settings.aiRoutes = { sns: { ...AI_ROUTE_DEFAULTS }, snsTranslation: { ...AI_ROUTE_DEFAULTS }, callSummary: { ...AI_ROUTE_DEFAULTS }, contactProfile: { ...AI_ROUTE_DEFAULTS } };
        if (!settings.aiRoutes.sns) settings.aiRoutes.sns = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.snsTranslation) settings.aiRoutes.snsTranslation = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.callSummary) settings.aiRoutes.callSummary = { ...AI_ROUTE_DEFAULTS };
        if (!settings.aiRoutes.contactProfile) settings.aiRoutes.contactProfile = { ...AI_ROUTE_DEFAULTS };

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
        endpointRow.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: 'SNS 외부 API URL (선택)' }));
        const endpointSelect = document.createElement('select');
        endpointSelect.className = 'slm-select';
        const endpointOptions = ['', '/api/backends/chat-completions/generate', '/api/openai/chat/completions'];
        if (settings.snsExternalApiUrl && !endpointOptions.includes(settings.snsExternalApiUrl)) endpointOptions.push(settings.snsExternalApiUrl);
        endpointOptions.forEach((value) => {
            endpointSelect.appendChild(Object.assign(document.createElement('option'), {
                value,
                textContent: value || '내부 생성 사용',
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
        translationPromptGroup.append(translationPromptLabel, translationPromptInput);
        snsSection.appendChild(translationPromptGroup);

        if (!settings.snsPrompts) settings.snsPrompts = { ...SNS_PROMPT_DEFAULTS };
        const promptDefs = [
            { key: 'postChar', label: '캐릭터 게시글 프롬프트' },
            { key: 'postContact', label: '연락처 게시글 프롬프트' },
            { key: 'imageDescription', label: '이미지 설명 프롬프트' },
            { key: 'reply', label: '답글 프롬프트' },
            { key: 'extraComment', label: '추가 댓글 프롬프트' },
        ];
        promptDefs.forEach(({ key, label }) => {
            const group = document.createElement('div');
            group.className = 'slm-form-group';
            const lbl = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: label });
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
            group.append(lbl, input, resetBtn);
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
        callSummaryGroup.append(callSummaryInput, callSummaryResetBtn);
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
            group.append(lbl, hintEl, input, preview, resetBtn);
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
        { key: 'media', label: '🖼️ 이미지', content: buildMediaTab() },
        { key: 'probability', label: '🎲 확률', content: buildProbabilityTab() },
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
        /사진.*(보내|줘|보여)|이미지.*(보내|줘|보여)|셀카.*(보내|줘)|찍은\s*사진/i,
        /photo|picture|pic|image|selfie|screenshot|send\s+(me\s+)?(a\s+)?(photo|picture|pic|image)|show\s+(me\s+)?(a\s+)?(photo|picture|pic|image)/i,
    ];
    const charSendIntentPatterns = [
        /사진.*(보낼게|보내줄게|찍어줄게|첨부|보여줄게)|이미지.*(보낼게|보내줄게|첨부|보여줄게)|셀카.*(보낼게|보내줄게)/i,
        /here['’]?s\s+(a\s+)?(photo|picture|pic|image)|i['’]ll\s+send\s+(you\s+)?(a\s+)?(photo|picture|pic|image)|let\s+me\s+show/i,
    ];
    return recentMessages.some((msg) => {
        const text = msg?.mes;
        if (!text) return false;
        const patterns = msg?.is_user ? userRequestPatterns : charSendIntentPatterns;
        return patterns.some((re) => re.test(text));
    });
}

function syncQuickSendButtons() {
    const quickBtn = document.getElementById('slm-quick-send-btn');
    const deletedBtn = document.getElementById('slm-deleted-msg-btn');
    if (!isEnabled()) {
        quickBtn?.remove();
        deletedBtn?.remove();
        return;
    }
    if (isModuleEnabled('quickTools')) {
        injectQuickSendButton();
    }
}

// ── 메신저 이미지 생성/텍스트 변환 로직 ──────────────────────────

// 메신저 이미지 프롬프트 주입 태그
const MSG_IMAGE_INJECT_TAG = 'st-lifesim-msg-image';

// <pic prompt="..."> 패턴 감지 정규식
const PIC_TAG_REGEX = /<pic\s[^>]*?prompt="([^"]*)"[^>]*?\/?>/gi;

/**
 * 메신저 이미지 모드에 따라 AI 프롬프트 주입을 업데이트한다
 * ON: AI에게 사진 상황에서 <pic prompt="..."> 태그를 출력하도록 지시
 * OFF: 주입을 제거하여 AI가 <pic> 태그를 출력하지 않도록 한다
 */
// OFF 모드 이미지 프롬프트 — AI가 사진 상황을 <pic> 태그로 표시하되, 실제 생성은 하지 않음
const MSG_IMAGE_OFF_PROMPT = '<image_generation_rule>\nWhen {{char}} would naturally send a photo or picture in the conversation (e.g., selfie, scenery, food, screenshot, etc.), insert a <pic prompt="image description in Korean for the photo situation"> tag at that point in your response.\nRules:\n1) Default subject is {{char}} only.\n2) Include {{user}} only when context explicitly indicates both are together or the photo is focused on {{user}}.\n3) Do not mix unrelated character appearance traits.\n4) Keep the situation brief and visual.\n</image_generation_rule>';

function updateMessageImageInjection() {
    const ctx = getContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
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
 * 메신저 이미지 생성 API를 사용하여 실제 이미지를 생성한다
 * SillyTavern의 /sd 슬래시 커맨드를 사용한다
 * @param {string} imagePrompt - 이미지 생성에 사용할 프롬프트
 * @returns {Promise<string>} 생성된 이미지의 URL 또는 빈 문자열
 */
async function generateMessageImageViaApi(imagePrompt) {
    if (!imagePrompt || !imagePrompt.trim()) return '';
    try {
        const ctx = getContext();
        if (!ctx) return '';
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            const result = await ctx.executeSlashCommandsWithOptions(`/sd quiet=true ${imagePrompt}`, { showOutput: false });
            const resultStr = String(result?.pipe || result || '').trim();
            if (resultStr && (resultStr.startsWith('http') || resultStr.startsWith('/') || resultStr.startsWith('data:'))) {
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
 * char 메시지 렌더링 후 이미지 태그를 처리한다
 * - ON: <pic prompt="..."> 태그를 감지하여 이미지 생성 API로 실제 이미지 생성
 * - OFF: <pic prompt="..."> 태그를 줄글 텍스트 형식으로 변환
 */
async function applyCharacterImageDisplayMode() {
    const settings = getSettings();
    const ctx = getContext();
    if (!ctx) return;
    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user) return;
    const mes = String(lastMsg.mes || '');

    // <pic prompt="..."> 태그가 있는지 확인
    const picMatches = [...mes.matchAll(PIC_TAG_REGEX)];
    if (picMatches.length === 0) return;

    const charName = String(lastMsg.name || ctx?.name2 || '{{char}}');
    const msgIdx = Number(ctx.chat.length - 1);

    // 각 매치에 대한 대체 문자열을 미리 계산한다 (역순 처리를 위해)
    /** @type {Array<{index: number, length: number, replacement: string}>} */
    const replacements = [];
    const allowAutoImageGeneration = settings.messageImageGenerationMode && hasExplicitImageIntentAroundLatestMessage();

    if (allowAutoImageGeneration) {
        // ── ON 모드: 이미지 생성 API로 실제 이미지 생성 ──
        showToast(`📷 ${picMatches.length}개 이미지 생성 중...`, 'info', 2000);
        const appearanceTags = getAppearanceTagsByName(charName) || settings.characterAppearanceTags?.[charName] || '';
        const userName = ctx?.name1 || '';
        const userAppearanceTags = getAppearanceTagsByName(userName) || settings.characterAppearanceTags?.['{{user}}'] || '';
        const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const userNameRegex = userName ? new RegExp(escapeRegex(userName.toLowerCase())) : null;
        const charNameRegex = charName ? new RegExp(escapeRegex(charName.toLowerCase())) : null;
        const userHintRegex = /\buser\b|{{user}}|유저|너|당신|with user|together|둘이|함께/;
        const charHintRegex = /\bchar\b|{{char}}|캐릭터/;
        for (const match of picMatches) {
            const fullTag = match[0];
            const rawPrompt = (match[1] || '').trim();
            const matchIndex = match.index;
            if (!rawPrompt) {
                replacements.push({ index: matchIndex, length: fullTag.length, replacement: '' });
                continue;
            }
            const promptLower = rawPrompt.toLowerCase();
            const mentionsUser = userHintRegex.test(promptLower)
                || (!!userNameRegex && userNameRegex.test(promptLower));
            const mentionsChar = charHintRegex.test(promptLower)
                || (!!charNameRegex && charNameRegex.test(promptLower));
            const tags = [];
            if (mentionsUser && !mentionsChar && userAppearanceTags) tags.push(userAppearanceTags);
            else {
                if (appearanceTags) tags.push(appearanceTags);
                if (mentionsUser && userAppearanceTags) tags.push(userAppearanceTags);
            }
            const tagsToUse = tags.join(', ');
            const prompt = tagsToUse ? `${rawPrompt}, ${tagsToUse}` : rawPrompt;
            let replacement;
            try {
                const imageUrl = await generateMessageImageViaApi(prompt);
                if (imageUrl) {
                    const safeUrl = escapeHtml(imageUrl);
                    const safePrompt = escapeHtml(rawPrompt);
                    replacement = `<img src="${safeUrl}" title="${safePrompt}" alt="${safePrompt}" class="slm-msg-generated-image" style="max-width:100%;border-radius:var(--slm-image-radius,10px);margin:4px 0">`;
                } else {
                    const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
                    replacement = template.replace(/\{description\}/g, rawPrompt);
                }
            } catch (err) {
                console.warn('[ST-LifeSim] 메신저 이미지 개별 생성 실패:', err);
                const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
                replacement = template.replace(/\{description\}/g, rawPrompt);
            }
            replacements.push({ index: matchIndex, length: fullTag.length, replacement });
        }
    } else {
        // ── OFF 모드: 줄글 텍스트로 변환 ──
        const template = settings.messageImageTextTemplate || DEFAULT_SETTINGS.messageImageTextTemplate;
        for (const match of picMatches) {
            const fullTag = match[0];
            const prompt = (match[1] || '').trim();
            const matchIndex = match.index;
            if (!prompt) {
                replacements.push({ index: matchIndex, length: fullTag.length, replacement: '' });
                continue;
            }
            const text = template.replace(/\{description\}/g, prompt);
            replacements.push({ index: matchIndex, length: fullTag.length, replacement: text });
        }
    }

    if (replacements.length === 0) return;

    // 역순으로 치환하여 인덱스 오프셋 문제를 방지한다
    let updatedMes = mes;
    for (let i = replacements.length - 1; i >= 0; i--) {
        const { index, length, replacement } = replacements[i];
        updatedMes = updatedMes.slice(0, index) + replacement + updatedMes.slice(index + length);
    }

    if (updatedMes !== mes) {
        lastMsg.mes = updatedMes;
        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }
        // UI 업데이트
        if (settings.messageImageGenerationMode && Number.isFinite(msgIdx) && msgIdx >= 0) {
            try {
                const msgEl = document.querySelector(`.mes[mesid="${msgIdx}"]`);
                if (msgEl) {
                    const mesTextEl = msgEl.querySelector('.mes_text');
                    if (mesTextEl) mesTextEl.innerHTML = updatedMes;
                }
            } catch (uiErr) {
                console.warn('[ST-LifeSim] 메시지 UI 업데이트 실패:', uiErr);
            }
        }
    }

    if (allowAutoImageGeneration && replacements.length > 0) {
        showToast(`📷 이미지 생성 완료`, 'success', 1500);
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
 * @param {'light'|'dark'|null} theme
 */
function applyForcedTheme(theme) {
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

    // 퀵 센드 버튼 삽입 (sendform 전송 버튼 옆)
    if (isEnabled() && isModuleEnabled('quickTools')) {
        try { injectQuickSendButton(); } catch (e) { console.error('[ST-LifeSim] 퀵 센드 버튼 오류:', e); }
    }

    // 메신저 이미지 생성 프롬프트 주입 설정
    try { updateMessageImageInjection(); } catch (e) { console.error('[ST-LifeSim] 이미지 프롬프트 주입 오류:', e); }

    // ST-LifeSim 메뉴 버튼 삽입 (sendform 옆)
    try { injectLifeSimMenuButton(); } catch (e) { console.error('[ST-LifeSim] 메뉴 버튼 오류:', e); }

    // 선톡 타이머 시작 (활성화된 경우)
    try { startFirstMsgTimer(settings.firstMsg); } catch (e) { console.error('[ST-LifeSim] 선톡 타이머 오류:', e); }

    // AI 응답 후 컨텍스트 주입
    const eventTypes = ctx.eventTypes || ctx.event_types;
    const evSrc = ctx.eventSource;

    if (evSrc && eventTypes?.CHARACTER_MESSAGE_RENDERED) {
        evSrc.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async () => {
            if (isEnabled()) {
                await injectContext().catch(e => console.error('[ST-LifeSim] 컨텍스트 주입 오류:', e));
            }
        });
    }

    // 채팅 로드 시 컨텍스트 주입
    if (evSrc && eventTypes?.CHAT_CHANGED) {
        evSrc.on(eventTypes.CHAT_CHANGED, async () => {
            if (isEnabled()) {
                await injectContext().catch(e => console.error('[ST-LifeSim] 컨텍스트 주입 오류:', e));
                try { updateMessageImageInjection(); } catch (e) { console.error('[ST-LifeSim] 이미지 프롬프트 재주입 오류:', e); }
            }
        });
    }

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
            if (!isModuleEnabled('call')) return;
            const callProb = getSettings().proactiveCallProbability ?? 0;
            const forceCall = hasForcedCallIntentFromLatestUserMessage();
            if (callProb > 0 || forceCall) {
                triggerProactiveIncomingCall(callProb, { deferUntilAiResponse: true, force: forceCall })
                    .catch(e => console.error('[ST-LifeSim] 선전화 트리거 오류:', e));
            }
        });
    }

    if (evSrc && eventTypes?.CHARACTER_MESSAGE_RENDERED) {
        evSrc.on(eventTypes.CHARACTER_MESSAGE_RENDERED, async () => {
            onCharacterMessageRenderedForProactiveCall();
            trackGifticonUsageFromCharacterMessage();
            await applyCharacterImageDisplayMode().catch((e) => console.error('[ST-LifeSim] 이미지 표시 모드 적용 오류:', e));
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
