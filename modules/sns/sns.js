/**
 * sns.js
 * SNS 피드 모듈 (인스타그램 스타일)
 * - 유저 직접 게시물 올리기 + 편집
 * - AI가 {{char}} 또는 NPC 이름으로 랜덤 포스팅 (유저 메시지 시 설정 확률 — index.js에서 트리거)
 * - 댓글/답글 기능
 * - SNS 활동은 채팅창에 노출되지 않음
 * - 컨텍스트에 최근 피드 주입
 */

import { getContext } from '../../utils/st-context.js';
import { loadData, saveData, getDefaultBinding, getExtensionSettings } from '../../utils/storage.js';
import { registerContextBuilder } from '../../utils/context-inject.js';
import { showToast, generateId } from '../../utils/ui.js';
import { createPopup } from '../../utils/popup.js';
import { getContacts, getAppearanceTagsByName } from '../contacts/contacts.js';
import { generateImageTags } from '../../utils/image-tag-generator.js';

const MODULE_KEY = 'sns-feed';
const AVATARS_KEY = 'sns-avatars';
const USER_IDS_KEY = 'sns-user-ids';      // { authorName: '@handle' }
const CONTACT_LINK_KEY = 'sns-contact-link'; // boolean: link avatars to contacts
const AUTHOR_DEFAULT_IMAGE_KEY = 'sns-author-default-images'; // { authorName: imageUrl }
const IMAGE_PRESETS_KEY = 'sns-image-presets'; // {id,name,url}[]
const POSTING_ENABLED_KEY = 'sns-posting-enabled'; // { authorName: boolean }
const AUTHOR_LANGUAGE_KEY = 'sns-author-languages'; // { authorName: ko|en|ja|zh }
const AUTHOR_MIN_LIKES_KEY = 'sns-author-min-likes'; // { authorName: number }
const SNS_REPLY_PROBABILITY = 0.7;
const SNS_EXTRA_COMMENT_PROBABILITY = 0.35;
const SNS_POST_TEXT_MAX = 280;
const SNS_IMAGE_DESC_MAX = 220;
const SNS_RANDOM_LIKES_BONUS_MAX = 30;
const DEFAULT_SNS_PROMPTS = {
    postChar: 'Write exactly one SNS post as {{charName}}.\n\n* Before writing, internalize these:\n- {{charName}}\'s personality, speech patterns, and worldview based on profile.\n- Extract the setting and genre from {{charName}}\'s profile itself — it could be modern, medieval fantasy, zombie apocalypse, sci-fi, or anything else. Let that world shape what feels natural to say and how to say it\n- What {{charName}} would actually care about or casually mention on a given day\n--------\n* {{charName}}\'s profile:\n{{personality}}\n--------\n* System Rules:\n- 1–4 sentences, casual and off-the-cuff, like a real personal post\n- Write in the voice and language style that fits {{charName}}\'s background and personality\n- If {{charName}}\'s personality strongly suggests they\'d use emojis, you may include them — otherwise, don\'t\n- No hashtags, no image tags, no quotation marks, no other characters\' reactions, no [caption: ...] blocks\n- Word choice, references, and tone must stay true to the detected world — never bleed in elements from the wrong setting\n- Don\'t be stiff or formal. This is a glimpse into {{charName}}\'s actual inner life, not a public announcement\n\n* System Note\n- Output only {{charName}}\'s post text. Nothing else.\n- Please comply with the output language.\n* This is a post aimed at an unspecified number of people. It is not a 1:1 session to communicate with {{user}}.',
    postContact: 'Write exactly one SNS post as {{authorName}}.\n\n* Before writing, internalize these:\n- {{authorName}}\'s personality, speech patterns, and worldview based on profile.\n- Extract the setting and genre from {{authorName}}\'s profile itself — it could be modern, medieval fantasy, zombie apocalypse, sci-fi, or anything else. Let that world shape what feels natural to say and how to say it\n- What {{authorName}} would actually care about or casually mention on a given day\n-------\n* {{authorName}}\'s profile:\n{{personality}}\n-------\n* System Rules:\n- 1–2 sentences, casual and off-the-cuff, like a real personal post\n- Write in the voice and language style that fits {{authorName}}\'s background and personality\n- If {{authorName}}\'s personality strongly suggests they\'d use emojis, you may include them — otherwise, don\'t\n- No hashtags, no image tags, no quotation marks, no other characters\' reactions, no [caption: ...] blocks\n- Word choice, references, and tone must stay true to the detected world — never bleed in elements from the wrong setting\n- Don\'t be stiff or formal. This is a glimpse into {{authorName}}\'s actual inner life, not a public announcement\n\n* System Note\n- Output only {{authorName}}\'s post text. Nothing else.\n- Please comply with the output language.',
    imageDescription: 'For {{authorName}}\'s SNS post "{{postContent}}", write exactly one short sentence describing the attached image. Mention only visible content. Do not use hashtags, quotes, parentheses, or any "caption:" prefix.',
    reply: 'Write exactly one SNS reply for this thread.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nTarget comment author: {{commentAuthorName}} ({{commentAuthorHandle}})\nTarget comment: "{{commentText}}"\nReply author: {{replyAuthorName}} ({{replyAuthorHandle}})\nRules: one sentence only from {{replyAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{replyAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{replyPersonality}}. It should be written vividly, fitting the characteristics of each character.',
    extraComment: 'Write exactly one additional SNS comment for this post.\nPost author: {{postAuthorName}} ({{postAuthorHandle}})\nPost: "{{postContent}}"\nComment author: {{extraAuthorName}} ({{extraAuthorHandle}})\nRules: one short sentence from {{extraAuthorName}}\'s perspective; use only fixed @handles if needed; use natural language fitting {{extraAuthorName}}\'s background; no explanations, quotes, or hashtags. Personality hint: {{extraPersonality}}. It should be written vividly, fitting the characteristics of each character.',
};
const SNS_PRESET_BINDING = 'character';
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
// 댓글 직후 즉시 생성하지 않고, 유저 메시지 이벤트에서 확률적으로 하나씩 처리하는 큐다.
const PENDING_COMMENT_REACTIONS = [];
let pendingReactionInFlight = false;

// SNS 포스트 카드 접힘 상태 (session 유지, localStorage 기반)
const SNS_CARDS_COLLAPSED_LS_KEY = 'slm:sns-cards-collapsed';
let _collapsedCardIds = null;

function loadCollapsedCardIds() {
    if (_collapsedCardIds) return _collapsedCardIds;
    try {
        const raw = localStorage.getItem(SNS_CARDS_COLLAPSED_LS_KEY);
        _collapsedCardIds = new Set(JSON.parse(raw || '[]'));
    } catch (e) {
        console.warn('[ST-LifeSim] SNS 카드 접힘 상태 로드 실패:', e);
        _collapsedCardIds = new Set();
    }
    return _collapsedCardIds;
}

function saveCollapsedCardIds() {
    try {
        localStorage.setItem(SNS_CARDS_COLLAPSED_LS_KEY, JSON.stringify([..._collapsedCardIds]));
    } catch { /* localStorage not available */ }
}

/**
 * 관리형 이미지 프리셋 목록을 불러온다
 * @returns {string[]}
 */
function loadImagePresets() {
    let raw = loadData(IMAGE_PRESETS_KEY, null, SNS_PRESET_BINDING);
    if (!Array.isArray(raw)) {
        const legacy = loadData(IMAGE_PRESETS_KEY, [], getDefaultBinding());
        raw = Array.isArray(legacy) ? legacy : [];
        if (raw.length > 0) {
            saveData(IMAGE_PRESETS_KEY, raw, SNS_PRESET_BINDING);
        }
    }
    if (!Array.isArray(raw)) return [];
    return raw
        .map((item, i) => {
            if (typeof item === 'string') {
                return { id: `legacy-${i}`, name: `프리셋 ${i + 1}`, url: item };
            }
            if (item && typeof item === 'object' && typeof item.url === 'string') {
                return {
                    id: item.id || `preset-${i}`,
                    name: item.name || `프리셋 ${i + 1}`,
                    url: item.url,
                };
            }
            return null;
        })
        .filter(Boolean);
}

/**
 * 관리형 이미지 프리셋 목록을 저장한다
 * @param {string[]} presets
 */
function saveImagePresets(presets) {
    saveData(IMAGE_PRESETS_KEY, presets, SNS_PRESET_BINDING);
}

function loadPostingEnabledMap() {
    return loadData(POSTING_ENABLED_KEY, {}, getDefaultBinding());
}

function savePostingEnabledMap(map) {
    saveData(POSTING_ENABLED_KEY, map, getDefaultBinding());
}

function loadAuthorMinLikesMap() {
    const current = loadData(AUTHOR_MIN_LIKES_KEY, null, SNS_PRESET_BINDING);
    if (current && typeof current === 'object') return current;
    const legacy = loadData(AUTHOR_MIN_LIKES_KEY, {}, getDefaultBinding());
    if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0 && getDefaultBinding() !== SNS_PRESET_BINDING) {
        saveData(AUTHOR_MIN_LIKES_KEY, legacy, SNS_PRESET_BINDING);
    }
    return legacy && typeof legacy === 'object' ? legacy : {};
}

function saveAuthorMinLikesMap(map) {
    saveData(AUTHOR_MIN_LIKES_KEY, map, SNS_PRESET_BINDING);
}

function getInitialLikes(authorName, fallback = 0) {
    const minLikes = Math.max(0, parseInt(loadAuthorMinLikesMap()?.[authorName], 10) || 0);
    if (minLikes <= 0) return Math.max(0, fallback);
    return minLikes + 1 + Math.floor(Math.random() * SNS_RANDOM_LIKES_BONUS_MAX);
}

/**
 * SNS 기본 이미지 URL을 가져온다 (하위 호환용)
 * @returns {string}
 */
function getDefaultImageUrl() {
    const ext = getExtensionSettings();
    return ext?.['st-lifesim']?.defaultSnsImageUrl || '';
}

function getSnsPromptSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'];
    const prompts = ext?.snsPrompts || {};
    const templates = { ...DEFAULT_SNS_PROMPTS };
    Object.keys(templates).forEach((key) => {
        const incoming = String(prompts?.[key] ?? '').trim();
        if (incoming) templates[key] = incoming;
    });
    return {
        templates,
        externalApiUrl: String(ext?.snsExternalApiUrl || '').trim(),
        externalApiTimeoutMs: Math.max(1000, Math.min(60000, Number(ext?.snsExternalApiTimeoutMs) || 12000)),
        language: ['ko', 'en', 'ja', 'zh'].includes(ext?.snsLanguage) ? ext.snsLanguage : 'en',
        koreanTranslationPrompt: String(ext?.snsKoreanTranslationPrompt || 'Translate the following SNS text into natural Korean. Output Korean text only.\n{{text}}').trim(),
        snsImageMode: ext?.snsImageMode === true,
        snsImagePrompt: String(ext?.snsImagePrompt || '').trim(),
        characterAppearanceTags: ext?.characterAppearanceTags && typeof ext.characterAppearanceTags === 'object' ? ext.characterAppearanceTags : {},
    };
}

function getSnsAiRouteSettings(routeKey = 'sns') {
    const ext = getExtensionSettings()?.['st-lifesim'];
    const route = ext?.aiRoutes?.[routeKey] || {};
    return {
        api: String(route.api || '').trim(),
        chatSource: String(route.chatSource || '').trim(),
        modelSettingKey: String(route.modelSettingKey || '').trim(),
        model: String(route.model || '').trim(),
    };
}

function inferModelSettingKey(source) {
    return MODEL_KEY_BY_SOURCE[String(source || '').toLowerCase()] || '';
}

function applyPromptTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)}}/g, (_, key) => String(vars?.[key] ?? ''));
}

function buildSnsImageInputPrompt(customTemplate, authorName, postContent) {
    if (!customTemplate) return `${authorName}'s social media photo post: "${postContent}"`;
    const authorAppearanceTags = String(getAppearanceTagsByName(authorName) || '').trim();
    return customTemplate
        .replace(/\{authorName\}/g, authorName)
        .replace(/\{appearanceTags\}/g, authorAppearanceTags)
        .replace(/\{postContent\}/g, postContent);
}

function enforceSnsLanguage(prompt, language) {
    const langLabel = {
        ko: 'Korean',
        en: 'English',
        ja: 'Japanese',
        zh: 'Chinese',
    }[String(language || '').toLowerCase()] || 'Korean';
    return `${prompt}\n\n[Output rule] Write the final output in ${langLabel} only.`;
}

/**
 * SNS 유저 아이디(핸들) 목록을 불러온다
 * @returns {Object}
 */
function loadUserIds() {
    return loadData(USER_IDS_KEY, {}, getDefaultBinding());
}

/**
 * SNS 유저 아이디 목록을 저장한다
 * @param {Object} ids
 */
function saveUserIds(ids) {
    saveData(USER_IDS_KEY, ids, getDefaultBinding());
}

function makeDefaultHandle(name) {
    const normalized = String(name || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^a-z0-9._]/g, '');
    return `@${normalized || 'user'}`;
}

function getAuthorHandle(authorName, userIds = loadUserIds()) {
    const key = String(authorName || '').trim();
    if (!key) return '@user';
    const existing = String(userIds[key] || '').trim();
    if (existing) return existing.startsWith('@') ? existing : `@${existing}`;
    return makeDefaultHandle(key) || '@user';
}

/**
 * 연락처 프로필 연동 토글 상태를 불러온다
 * @returns {boolean}
 */
function loadContactLink() {
    const val = loadData(CONTACT_LINK_KEY, true, getDefaultBinding());
    return val !== false;
}

/**
 * 연락처 프로필 연동 토글 상태를 저장한다
 * @param {boolean} val
 */
function saveContactLink(val) {
    saveData(CONTACT_LINK_KEY, val, getDefaultBinding());
}

function loadAuthorDefaultImages() {
    return loadData(AUTHOR_DEFAULT_IMAGE_KEY, {}, getDefaultBinding());
}

function saveAuthorDefaultImages(map) {
    saveData(AUTHOR_DEFAULT_IMAGE_KEY, map, getDefaultBinding());
}

function loadAuthorLanguages() {
    return loadData(AUTHOR_LANGUAGE_KEY, {}, getDefaultBinding());
}

function saveAuthorLanguages(map) {
    saveData(AUTHOR_LANGUAGE_KEY, map, getDefaultBinding());
}

function getAuthorLanguage(authorName, fallbackLanguage) {
    const lang = loadAuthorLanguages()?.[authorName];
    return ['ko', 'en', 'ja', 'zh'].includes(lang) ? lang : fallbackLanguage;
}

function getAuthorDefaultImageUrl(authorName, includeLegacy = true) {
    const map = loadAuthorDefaultImages();
    return map[authorName] || (includeLegacy ? getDefaultImageUrl() : '');
}

/**
 * C2: 최근 SNS 피드에 이미 존재하는 이미지 URL인지 확인한다.
 * 이전에 생성된 이미지 URL을 재사용하는 버그를 방지한다.
 * @param {string} url - 확인할 이미지 URL
 * @returns {boolean} 이미 존재하면 true
 */
function isUrlAlreadyInFeed(url) {
    if (!url) return false;
    const feed = loadFeed();
    return feed.some(post => post?.imageUrl === url);
}

/**
 * 이미지 생성 API를 사용하여 실제 이미지를 생성한다.
 * SillyTavern의 /sd 슬래시 커맨드를 사용한다.
 * @param {string} imagePrompt - 이미지 생성에 사용할 프롬프트
 * @returns {Promise<string>} 생성된 이미지의 URL 또는 빈 문자열
 */
async function generateImageViaApi(imagePrompt) {
    if (!imagePrompt || !imagePrompt.trim()) return '';
    try {
        const ctx = getContext();
        if (!ctx) {
            console.warn('[ST-LifeSim] 이미지 생성: 컨텍스트를 가져올 수 없습니다.');
            return '';
        }
        // SillyTavern SlashCommandParser를 통해 /sd 명령어 사용
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            const result = await ctx.executeSlashCommandsWithOptions(`/sd quiet=true ${imagePrompt}`, { showOutput: false });
            const resultStr = String(result?.pipe || result || '').trim();
            // 결과가 URL-like 문자열이면 반환
            if (resultStr && (resultStr.startsWith('http') || resultStr.startsWith('/') || resultStr.startsWith('data:'))) {
                // C2: Reject URLs that already exist in the SNS feed to prevent reuse
                if (isUrlAlreadyInFeed(resultStr)) {
                    console.warn('[ST-LifeSim] SNS 이미지 URL이 이미 피드에 존재합니다. 재사용 방지를 위해 거부합니다.');
                    return '';
                }
                return resultStr;
            }
        }
        return '';
    } catch (e) {
        console.warn('[ST-LifeSim] 이미지 생성 API 호출 실패:', e);
        return '';
    }
}

/**
 * 배열에서 임의의 원소를 반환한다.
 * @template T
 * @param {T[]} arr
 * @returns {T|null}
 */
function getRandomItem(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * SNS 텍스트를 한 줄로 정규화하고 길이를 제한한다.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function normalizeSnsText(text, maxLen = SNS_POST_TEXT_MAX) {
    return String(text || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
        .slice(0, maxLen);
}

/**
 * 본문에 섞여 나온 캡션 블록([캡션:...], (caption:...))을 제거한다.
 * @param {string} text
 * @returns {string}
 */
function stripInlineCaptionBlocks(text) {
    return String(text || '')
        .replace(/\[\s*(?:캡션|caption|사진설명|사진)\s*:[^\]]*]/gi, '')
        .replace(/\(\s*(?:캡션|caption|사진설명|사진)\s*:[^)]*\)/gi, '')
        .trim();
}

/**
 * 본문 내 캡션 블록에서 설명 텍스트를 추출한다.
 * @param {string} text
 * @returns {string}
 */
function extractInlineCaption(text) {
    const src = String(text || '');
    const match = src.match(/\[\s*(?:캡션|caption|사진설명|사진)\s*:\s*([^\]]+)]/i)
        || src.match(/\(\s*(?:캡션|caption|사진설명|사진)\s*:\s*([^)]+)\)/i);
    return normalizeSnsText(match?.[1] || '', SNS_IMAGE_DESC_MAX);
}

function getBuiltinUserAvatarUrl() {
    const fromPersona = document.querySelector('#user_avatar_block .avatar.selected img')?.getAttribute('src');
    if (fromPersona) return fromPersona;
    const fromProfile = document.querySelector('#user-profile .avatar img, .user_profile .avatar img')?.getAttribute('src');
    if (fromProfile) return fromProfile;
    return '/img/user-default.png';
}

function getBuiltinCharAvatarUrl() {
    const ctx = getContext();
    const char = (typeof ctx?.characterId === 'number' && Array.isArray(ctx?.characters))
        ? ctx.characters[ctx.characterId]
        : null;
    const fromData = String(char?.avatar || '').trim();
    if (fromData) {
        // avatar 필드가 파일이름만 있으면 /characters/ 경로를 붙인다
        if (!fromData.startsWith('http') && !fromData.startsWith('/') && !fromData.startsWith('data:')) {
            return `/characters/${fromData}`;
        }
        return fromData;
    }
    const fromDom = document.querySelector('#avatar_load_preview img, #avatar_div img, .mesAvatar img')?.getAttribute('src');
    return fromDom || '';
}

/**
 * 저자 이름에 대한 아바타 URL을 해결한다 (연락처 연동 고려)
 * user와 char는 자동연동 설정과 무관하게 항상 연동된다.
 * @param {string} authorName
 * @param {Object} avatars - 수동 아바타 맵
 * @returns {string}
 */
function resolveAvatar(authorName, avatars) {
    if (avatars[authorName]) return avatars[authorName];
    const ctx = getContext();
    const userName = ctx?.name1 || 'user';
    const charName = ctx?.name2 || '';
    const isUserOrChar = authorName === userName || (charName && authorName === charName);
    if (authorName === userName) {
        const builtinUrl = getBuiltinUserAvatarUrl();
        if (builtinUrl) return builtinUrl;
    }
    if (charName && authorName === charName) {
        const builtinUrl = getBuiltinCharAvatarUrl();
        if (builtinUrl) return builtinUrl;
    }
    // user/char는 contactLink 설정과 무관하게 연락처 아바타도 확인
    if (isUserOrChar || loadContactLink()) {
        const allContacts = [...getContacts('character'), ...getContacts('chat')];
        const contact = allContacts.find(c => c.name === authorName);
        if (contact?.avatar) return contact.avatar;
    }
    return '';
}

/**
 * SNS 피드 데이터 불러오기
 * @returns {Object[]}
 */
function loadFeed() {
    return loadData(MODULE_KEY, [], 'character');
}

/**
 * SNS 피드 저장
 * @param {Object[]} feed
 */
function saveFeed(feed) {
    saveData(MODULE_KEY, feed, 'character');
}

/**
 * SNS 작성자별 아바타(프로필 사진) 저장소 불러오기
 * @returns {Object} { [authorName]: avatarUrl }
 */
function loadAvatars() {
    return loadData(AVATARS_KEY, {}, getDefaultBinding());
}

/**
 * SNS 작성자별 아바타 저장
 * @param {Object} avatars
 */
function saveAvatars(avatars) {
    saveData(AVATARS_KEY, avatars, getDefaultBinding());
}

/**
 * SNS 모듈을 초기화한다
 */
export function initSns() {
    registerContextBuilder('sns', () => {
        const feed = loadFeed();
        const contextPosts = feed.filter(p => p.includeInContext).slice(-5);
        if (contextPosts.length === 0) return null;
        const lines = contextPosts.map(p => {
            const d = new Date(p.date);
            return `• ${p.authorName}: "${p.content}" (${d.toLocaleDateString('en-US')})`;
        });
        return `=== Recent SNS Posts ===\n${lines.join('\n')}`;
    });
    // 자동 포스팅 트리거는 index.js의 MESSAGE_SENT 이벤트에서 처리
}

/**
 * NPC 또는 {{char}} 랜덤 포스팅을 트리거한다
 * generateQuietPrompt를 사용하여 채팅창에 노출되지 않고 피드에만 저장한다
 */
export async function triggerNpcPosting() {
    const ctx = getContext();
    const charName = ctx?.name2 || '{{char}}';
    const userName = ctx?.name1 || 'user';
    const postingEnabled = loadPostingEnabledMap();

    const seenContactNames = new Set();
    const contacts = [...getContacts('chat'), ...getContacts('character'), ...getContacts(getDefaultBinding())]
        .filter((c) => {
            if (!c?.name || seenContactNames.has(c.name)) return false;
            seenContactNames.add(c.name);
            return true;
        });
    // charName의 연락처에서 description + personality를 결합하여 가져온다
    const charContact = [...getContacts('character'), ...getContacts('chat')].find(c => c?.name === charName);
    const charPersonality = [charContact?.description, charContact?.personality].filter(Boolean).join(' / ') || '';
    const candidates = [
        { name: charName, personality: charPersonality, isChar: true },
        ...contacts.map(c => ({ name: c.name, personality: [c.description, c.personality].filter(Boolean).join(' / '), isChar: false })),
    ].filter(c => c.name !== userName && postingEnabled[c.name] !== false);

    if (candidates.length === 0) return;

    const pick = getRandomItem(candidates);
    if (!pick) return;
    const promptSettings = getSnsPromptSettings();
    const promptTemplate = pick.isChar ? promptSettings.templates.postChar : promptSettings.templates.postContact;
    const prompt = applyPromptTemplate(promptTemplate, {
        charName,
        authorName: pick.name,
        personality: pick.personality || '평범함',
    });
    const recentPosts = loadFeed()
        .filter((item) => item?.authorName === pick.name && item?.content)
        .slice(-5)
        .map((item) => `- ${normalizeSnsText(item.content, 120)}`)
        .join('\n');
    const finalPrompt = recentPosts
        ? `${prompt}\n최근 ${pick.name} 게시글 요약:\n${recentPosts}\n위 내용과 주제/표현을 반복하지 말고 새 일상 주제로 작성하세요.`
        : prompt;
    const authorLanguage = getAuthorLanguage(pick.name, promptSettings.language);
    const localizedPrompt = enforceSnsLanguage(finalPrompt, authorLanguage);

    try {
        const freshCtx = getContext();
        if (!freshCtx) return;
        let postContent = '(게시물)';
        try {
            postContent = await generateSnsText(freshCtx, localizedPrompt, pick.name) || postContent;
        } catch (genErr) {
            console.error('[ST-LifeSim] NPC 포스팅 텍스트 생성 오류:', genErr);
            showToast('NPC 포스팅 생성 실패: ' + genErr.message, 'error');
            return;
        }
        const inlineCaption = extractInlineCaption(postContent);
        postContent = normalizeSnsText(stripInlineCaptionBlocks(postContent), SNS_POST_TEXT_MAX) || '(게시물)';

        const defaultImg = getAuthorDefaultImageUrl(pick.name, false);
        const presets = loadImagePresets().filter(p => p?.url);
        const presetPick = getRandomItem(presets);
        const presetImg = presetPick ? presetPick.url : '';
        // 캐릭터별 기본 이미지가 있으면 우선 사용하고, 없을 때만 프리셋으로 보완한다.
        let finalImageUrl = defaultImg || presetImg;
        let imageDescription = '';
        let resolvedImagePrompt = '';
        if (promptSettings.snsImageMode) {
            // 통합 파이프라인: generateImageTags() → Image API
            // 게시글 내용에서 시각적 장면을 유추할 수 있도록 작성자 정보 포함
            const allContactsList = [...getContacts('character'), ...getContacts('chat')];
            const imageInputPrompt = buildSnsImageInputPrompt(promptSettings.snsImagePrompt, pick.name, postContent);
            const additionalPrompt = String(getExtensionSettings()?.['st-lifesim']?.tagGenerationAdditionalPrompt || '').trim();
            const tagResult = await generateImageTags(imageInputPrompt, {
                includeNames: [pick.name],
                contacts: allContactsList,
                getAppearanceTagsByName,
                tagWeight: Number(getExtensionSettings()?.['st-lifesim']?.tagWeight) || 0,
                additionalPrompt,
            });
            resolvedImagePrompt = imageInputPrompt;

            if (tagResult.finalPrompt) {
                try {
                    const generatedUrl = await generateImageViaApi(tagResult.finalPrompt);
                    if (generatedUrl) {
                        finalImageUrl = generatedUrl;
                        imageDescription = '';
                    }
                } catch (imgErr) {
                    console.warn('[ST-LifeSim] SNS 이미지 생성 실패, 기본 이미지 사용:', imgErr);
                }
            } else {
                console.warn('[ST-LifeSim] SNS 태그 생성 결과 없음, 이미지 생성 건너뜀');
            }
        }
        if (!imageDescription && inlineCaption) imageDescription = inlineCaption;

        const feed = loadFeed();
        feed.push({
            id: generateId(),
            authorName: pick.name,
            authorIsUser: false,
            date: new Date().toISOString(),
            content: postContent,
            imageUrl: finalImageUrl,
            imageDescription,
            imagePrompt: resolvedImagePrompt,
            likes: getInitialLikes(pick.name, Math.floor(Math.random() * SNS_RANDOM_LIKES_BONUS_MAX)),
            likedByUser: false,
            comments: [],
            isStory: false,
            includeInContext: true,
        });
        saveFeed(feed);

        showToast(`📸 ${pick.name}님이 새 게시물을 올렸습니다.`, 'info', 2500);
    } catch (e) {
        console.error('[ST-LifeSim] NPC 포스팅 생성 오류:', e);
    }
}

/**
 * SNS 팝업을 연다
 */
export function openSnsPopup(onBack) {
    const content = buildSnsContent();
    createPopup({
        id: 'sns',
        title: '📸 SNS',
        content,
        className: 'slm-sns-panel',
        onBack,
    });
}

/**
 * SNS 팝업 내용을 빌드한다 (인스타그램 스타일)
 * @returns {HTMLElement}
 */
function buildSnsContent() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-sns-wrapper';

    // 작성자 필터
    let currentAuthor = '전체';
    const filterRow = document.createElement('div');
    filterRow.className = 'slm-sns-filter-row';

    const filterLabel = document.createElement('span');
    filterLabel.className = 'slm-sns-filter-label';
    filterLabel.textContent = '작성자:';

    const filterSelect = document.createElement('select');
    filterSelect.className = 'slm-select slm-sns-filter-select';

    function updateFilterOptions(feedData) {
        const prevVal = filterSelect.value;
        filterSelect.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '전체';
        allOpt.textContent = '전체';
        filterSelect.appendChild(allOpt);
        const feed = feedData || loadFeed();
        const authors = [...new Set(feed.map(p => p.authorName).filter(Boolean))];
        authors.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = `@${a}`;
            filterSelect.appendChild(opt);
        });
        filterSelect.value = authors.includes(prevVal) ? prevVal : '전체';
        currentAuthor = filterSelect.value;
    }
    updateFilterOptions();
    filterSelect.onchange = () => {
        currentAuthor = filterSelect.value;
        renderFeed();
    };

    filterRow.appendChild(filterLabel);
    filterRow.appendChild(filterSelect);
    wrapper.appendChild(filterRow);

    // 피드 목록
    const feedList = document.createElement('div');
    feedList.className = 'slm-feed-list';

    function renderFeed() {
        feedList.innerHTML = '';
        const feed = loadFeed();
        updateFilterOptions(feed);
        const filtered = currentAuthor === '전체' ? feed : feed.filter(p => p.authorName === currentAuthor);

        if (filtered.length === 0) {
            feedList.innerHTML = '<div class="slm-empty">게시물이 없습니다.</div>';
            return;
        }

        filtered.slice().reverse().forEach(post => {
            const card = buildPostCard(post, renderFeed);
            feedList.appendChild(card);
        });
    }

    // 하단 액션 바 (인스타그램 네비바 스타일)
    const actionBar = document.createElement('div');
    actionBar.className = 'slm-sns-action-bar';

    const writeBtn = document.createElement('button');
    writeBtn.className = 'slm-sns-action-btn';
    writeBtn.title = '게시물 작성';
    writeBtn.innerHTML = '<span class="slm-sns-action-icon">✏️</span><span class="slm-sns-action-label">작성</span>';
    writeBtn.onclick = () => openWritePostDialog(renderFeed);

    const npcPostBtn = document.createElement('button');
    npcPostBtn.className = 'slm-sns-action-btn';
    npcPostBtn.title = 'NPC 포스팅';
    npcPostBtn.innerHTML = '<span class="slm-sns-action-icon">🎲</span><span class="slm-sns-action-label">NPC</span>';
    npcPostBtn.onclick = async () => {
        npcPostBtn.disabled = true;
        try {
            await triggerNpcPosting();
            renderFeed();
        } finally {
            npcPostBtn.disabled = false;
        }
    };

    const avatarBtn = document.createElement('button');
    avatarBtn.className = 'slm-sns-action-btn';
    avatarBtn.title = '프로필 설정';
    avatarBtn.innerHTML = '<span class="slm-sns-action-icon">⚙️</span><span class="slm-sns-action-label">설정</span>';
    avatarBtn.onclick = () => openAvatarSettingsDialog(renderFeed);

    actionBar.appendChild(writeBtn);
    actionBar.appendChild(npcPostBtn);
    actionBar.appendChild(avatarBtn);
    wrapper.appendChild(actionBar);
    wrapper.appendChild(feedList);

    renderFeed();
    return wrapper;
}

/**
 * 인스타그램 스타일 게시물 카드를 빌드한다
 * @param {Object} post
 * @param {Function} onUpdate
 * @returns {HTMLElement}
 */
function buildPostCard(post, onUpdate) {
    const card = document.createElement('div');
    card.className = 'slm-post-card';

    const collapsedIds = loadCollapsedCardIds();
    const isCollapsed = collapsedIds.has(post.id);

    const avatars = loadAvatars();
    const avatarUrl = resolveAvatar(post.authorName, avatars);
    const userIds = loadUserIds();
    const displayId = getAuthorHandle(post.authorName, userIds);

    // 헤더 (아바타 + 이름 + 접기 버튼 + 메뉴) — 시간 제거
    const header = document.createElement('div');
    header.className = 'slm-post-header';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'slm-post-avatar';
    const avatarInner = document.createElement('div');
    avatarInner.className = 'slm-post-avatar-inner';
    if (avatarUrl) {
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarUrl;
        avatarImg.alt = post.authorName;
        avatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
        avatarImg.onerror = () => {
            avatarInner.removeChild(avatarImg);
            avatarInner.textContent = ((post.authorName || '?')[0] || '?').toUpperCase();
        };
        avatarInner.appendChild(avatarImg);
    } else {
        avatarInner.textContent = ((post.authorName || '?')[0] || '?').toUpperCase();
    }
    avatarWrap.appendChild(avatarInner);

    const authorEl = document.createElement('span');
    authorEl.className = 'slm-post-author';
    authorEl.textContent = displayId;

    // 접기/펼치기 버튼
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'slm-post-collapse-btn';
    collapseBtn.textContent = isCollapsed ? '▸' : '▾';
    collapseBtn.title = isCollapsed ? '펼치기' : '접기';

    const moreBtn = document.createElement('button');
    moreBtn.className = 'slm-post-more-btn';
    moreBtn.textContent = '···';
    moreBtn.onclick = (e) => showPostContextMenu(e, post, onUpdate);

    header.appendChild(avatarWrap);
    header.appendChild(authorEl);
    header.appendChild(collapseBtn);
    header.appendChild(moreBtn);
    card.appendChild(header);

    // 접을 수 있는 본문 영역
    const body = document.createElement('div');
    body.className = 'slm-post-body';
    if (isCollapsed) body.style.display = 'none';

    collapseBtn.onclick = () => {
        const nowCollapsed = body.style.display !== 'none';
        body.style.display = nowCollapsed ? 'none' : '';
        collapseBtn.textContent = nowCollapsed ? '▸' : '▾';
        collapseBtn.title = nowCollapsed ? '펼치기' : '접기';
        if (nowCollapsed) collapsedIds.add(post.id);
        else collapsedIds.delete(post.id);
        saveCollapsedCardIds();
    };

    // 이미지 (설명을 hover 툴팁으로)
    if (post.imageUrl) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'slm-post-img-wrap';

        const img = document.createElement('img');
        img.className = 'slm-post-img';
        img.src = post.imageUrl;
        img.alt = post.imageDescription || '게시물 이미지';
        img.onerror = () => imgWrap.style.display = 'none';
        imgWrap.appendChild(img);

        // 이미지 설명: hover 말풍선
        if (post.imageDescription) {
            const tooltip = document.createElement('div');
            tooltip.className = 'slm-img-tooltip';
            tooltip.textContent = post.imageDescription;
            imgWrap.appendChild(tooltip);
        }
        body.appendChild(imgWrap);
    }

    // 액션 버튼 행
    const actions = document.createElement('div');
    actions.className = 'slm-post-actions';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'slm-post-action-btn' + (post.likedByUser ? ' liked' : '');
    likeBtn.textContent = post.likedByUser ? '❤️' : '🤍';
    likeBtn.onclick = () => {
        const f = loadFeed();
        const p = f.find(p => p.id === post.id);
        if (p) {
            p.likedByUser = !p.likedByUser;
            p.likes += p.likedByUser ? 1 : -1;
            saveFeed(f);
            onUpdate();
        }
    };

    const commentBtn = document.createElement('button');
    commentBtn.className = 'slm-post-action-btn';
    commentBtn.textContent = '💬';
    commentBtn.onclick = () => {
        const isHidden = commentSection.style.display === 'none';
        commentSection.style.display = isHidden ? 'block' : 'none';
    };

    const contextLabel = document.createElement('label');
    contextLabel.className = 'slm-context-toggle';
    const ctxCheck = document.createElement('input');
    ctxCheck.type = 'checkbox';
    ctxCheck.checked = post.includeInContext;
    ctxCheck.onchange = () => {
        const f = loadFeed();
        const p = f.find(p => p.id === post.id);
        if (p) { p.includeInContext = ctxCheck.checked; saveFeed(f); }
    };
    contextLabel.appendChild(ctxCheck);
    contextLabel.appendChild(document.createTextNode(' 컨텍스트'));

    actions.appendChild(likeBtn);
    actions.appendChild(commentBtn);
    const translatePostBtn = createTranslateButton(
        post.content,
        body,
        () => body.querySelector('.slm-post-translation'),
        'slm-post-translation',
    );
    actions.appendChild(translatePostBtn);
    actions.appendChild(contextLabel);
    body.appendChild(actions);

    // 좋아요 수
    if (post.likes > 0) {
        const likesEl = document.createElement('div');
        likesEl.className = 'slm-post-likes';
        likesEl.textContent = `좋아요 ${post.likes}개`;
        body.appendChild(likesEl);
    }

    // 본문
    const contentEl = document.createElement('div');
    contentEl.className = 'slm-post-content';
    const authorSpan = document.createElement('span');
    authorSpan.className = 'slm-post-content-author';
    authorSpan.textContent = displayId;
    contentEl.appendChild(authorSpan);
    contentEl.appendChild(document.createTextNode(post.content));
    body.appendChild(contentEl);

    // 댓글 수 표시
    if (post.comments.length > 0) {
        const commentsLink = document.createElement('button');
        commentsLink.className = 'slm-post-comments-link';
        commentsLink.textContent = `댓글 ${post.comments.length}개 모두 보기`;
        commentsLink.onclick = () => {
            commentSection.style.display = commentSection.style.display === 'none' ? 'block' : 'none';
        };
        body.appendChild(commentsLink);
    }

    // 댓글 섹션 (기본 닫힘)
    const commentSection = document.createElement('div');
    commentSection.className = 'slm-comment-section';
    commentSection.style.display = 'none';
    renderComments(commentSection, post, onUpdate);
    body.appendChild(commentSection);

    card.appendChild(body);

    return card;
}

/**
 * 게시물 우클릭/더보기 메뉴
 */
function showPostContextMenu(e, post, onUpdate) {
    document.querySelectorAll('.slm-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'slm-context-menu';
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - 100)}px`;

    const editItem = document.createElement('button');
    editItem.className = 'slm-context-item';
    editItem.textContent = '✏️ 편집';
    editItem.onclick = () => { menu.remove(); openEditPostDialog(post, onUpdate); };

    const delItem = document.createElement('button');
    delItem.className = 'slm-context-item slm-context-danger';
    delItem.textContent = '🗑️ 삭제';
    delItem.onclick = () => {
        const f = loadFeed().filter(p => p.id !== post.id);
        saveFeed(f);
        menu.remove();
        onUpdate();
        showToast('게시물 삭제', 'success', 1500);
    };

    menu.appendChild(editItem);
    menu.appendChild(delItem);
    document.body.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', () => menu.remove(), { once: true });
    }, 0);
}

/**
 * 게시물 편집 다이얼로그를 연다
 */
function openEditPostDialog(post, onUpdate) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const contentLabel = document.createElement('label');
    contentLabel.className = 'slm-label';
    contentLabel.textContent = '글 내용';

    const contentInput = document.createElement('textarea');
    contentInput.className = 'slm-textarea';
    contentInput.rows = 4;
    contentInput.value = post.content;

    const imgLabel = document.createElement('label');
    imgLabel.className = 'slm-label';
    imgLabel.textContent = '이미지 URL (선택)';

    const defaultImg = getAuthorDefaultImageUrl(post.authorName);
    const useDefaultLabel = document.createElement('label');
    useDefaultLabel.className = 'slm-toggle-label';
    useDefaultLabel.style.marginBottom = '4px';
    const useDefaultCheck = document.createElement('input');
    useDefaultCheck.type = 'checkbox';
    useDefaultCheck.checked = !post.imageUrl && !!defaultImg;
    useDefaultLabel.appendChild(useDefaultCheck);
    useDefaultLabel.appendChild(document.createTextNode(' 기본 이미지 사용'));

    const imgInput = document.createElement('input');
    imgInput.className = 'slm-input';
    imgInput.type = 'url';
    imgInput.value = post.imageUrl || '';
    imgInput.style.display = useDefaultCheck.checked ? 'none' : '';

    useDefaultCheck.onchange = () => {
        imgInput.style.display = useDefaultCheck.checked ? 'none' : '';
    };

    const imgDescLabel = document.createElement('label');
    imgDescLabel.className = 'slm-label';
    imgDescLabel.textContent = '사진 설명 (선택, 이미지 위에 마우스 호버 시 표시)';

    const imgDescInput = document.createElement('input');
    imgDescInput.className = 'slm-input';
    imgDescInput.type = 'text';
    imgDescInput.value = post.imageDescription || '';
    imgDescInput.placeholder = '이미지 설명...';

    const likesLabel = document.createElement('label');
    likesLabel.className = 'slm-label';
    likesLabel.textContent = '기본 좋아요 수';
    const likesInput = document.createElement('input');
    likesInput.className = 'slm-input';
    likesInput.type = 'number';
    likesInput.min = '0';
    likesInput.max = '1000000';
    likesInput.value = String(Math.max(0, Number(post.likes) || 0));

    wrapper.appendChild(contentLabel);
    wrapper.appendChild(contentInput);
    wrapper.appendChild(imgLabel);
    if (defaultImg) wrapper.appendChild(useDefaultLabel);
    wrapper.appendChild(imgInput);
    wrapper.appendChild(imgDescLabel);
    wrapper.appendChild(imgDescInput);
    wrapper.appendChild(likesLabel);
    wrapper.appendChild(likesInput);

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
        id: 'edit-post',
        title: '✏️ 게시물 편집',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack: () => openSnsPopup(),
    });

    cancelBtn.onclick = () => close();

    saveBtn.onclick = () => {
        const text = contentInput.value.trim();
        if (!text) { showToast('내용을 입력해주세요.', 'warn'); return; }

        const f = loadFeed();
        const p = f.find(p => p.id === post.id);
        if (p) {
            p.content = text;
            p.imageUrl = useDefaultCheck.checked ? (getAuthorDefaultImageUrl(post.authorName) || '') : imgInput.value.trim();
            p.imageDescription = imgDescInput.value.trim();
            p.likes = Math.max(0, parseInt(likesInput.value) || 0);
            saveFeed(f);
        }
        close();
        onUpdate();
        showToast('게시물 편집 완료', 'success');
    };
}

/**
 * 댓글 영역을 렌더링한다
 */
function renderComments(container, post, onUpdate) {
    container.innerHTML = '';
    const userIds = loadUserIds();

    const renderCommentNode = (parent, node, isReply = false) => {
        const commentDiv = document.createElement('div');
        commentDiv.className = isReply ? 'slm-reply' : 'slm-comment';
        const authorSpan = document.createElement('span');
        authorSpan.className = 'slm-comment-author';
        const displayId = getAuthorHandle(node.author, userIds);
        authorSpan.textContent = isReply ? `└ ${displayId}` : displayId;
        const textSpan = document.createElement('span');
        textSpan.className = 'slm-comment-text';
        textSpan.textContent = isReply ? ` ${node.text}` : node.text;
        commentDiv.appendChild(authorSpan);
        commentDiv.appendChild(textSpan);
        const translateCommentBtn = createTranslateButton(
            node.text,
            commentDiv,
            () => commentDiv.querySelector('.slm-comment-translation'),
            'slm-comment-translation',
            true,
        );
        commentDiv.appendChild(translateCommentBtn);
        parent.appendChild(commentDiv);

        if (Array.isArray(node.replies) && node.replies.length > 0) {
            node.replies.forEach(reply => renderCommentNode(commentDiv, reply, true));
        }
    };

    post.comments.forEach(c => {
        renderCommentNode(container, c, false);
    });

    const inputRow = document.createElement('div');
    inputRow.className = 'slm-input-row';

    const input = document.createElement('input');
    input.className = 'slm-input';
    input.type = 'text';
    input.placeholder = '댓글 달기...';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    submitBtn.textContent = '달기';
    submitBtn.onclick = async () => {
        const text = input.value.trim();
        if (!text) return;

        submitBtn.disabled = true;
        try {
            await postComment(post, text, onUpdate);
            input.value = '';
        } finally {
            submitBtn.disabled = false;
        }
    };

    inputRow.appendChild(input);
    inputRow.appendChild(submitBtn);
    container.appendChild(inputRow);
}

function createTranslateButton(text, parent, findExisting, translationClass, compact = false) {
    const btn = document.createElement('button');
    btn.className = `slm-btn slm-btn-ghost ${compact ? 'slm-btn-xs' : 'slm-btn-sm'}`;
    btn.textContent = '한글 번역';
    btn.onclick = async () => {
        const existing = findExisting?.();
        if (existing) {
            existing.remove();
            return;
        }
        btn.disabled = true;
        try {
            const ctx = getContext();
            const promptSettings = getSnsPromptSettings();
            const customPrompt = applyPromptTemplate(
                promptSettings.koreanTranslationPrompt || 'Translate the following SNS text into natural Korean. Output Korean text only.\n{{text}}',
                { text: String(text || '') },
            );
            let translated = '';
            if (ctx && (typeof ctx.generateRaw === 'function' || typeof ctx.generateQuietPrompt === 'function')) {
                translated = await generateSnsText(ctx, customPrompt, 'sns-translation', 'snsTranslation');
            }
            if (!translated) {
                showToast('AI 번역 결과가 비어 있습니다.', 'warn', 1200);
                return;
            }
            const line = document.createElement('div');
            line.className = translationClass;
            line.textContent = `🇰🇷 ${translated || ''}`.trim();
            parent.appendChild(line);
        } catch (error) {
            showToast('번역 실패', 'warn', 1200);
        } finally {
            btn.disabled = false;
        }
    };
    return btn;
}

/**
 * 댓글을 달고 NPC가 답글을 생성한다 (채팅창에 노출 안 됨)
 */
async function postComment(post, text, onUpdate) {
    const ctx = getContext();
    const userProfileName = loadFeed().slice().reverse().find(item => item?.authorIsUser && item?.authorName)?.authorName;
    const userName = ctx?.name1 || userProfileName || 'user';
    const userIds = loadUserIds();
    if (!userIds[userName]) {
        userIds[userName] = makeDefaultHandle(userName);
        saveUserIds(userIds);
    }
    const feed = loadFeed();
    const p = feed.find(p => p.id === post.id);
    if (!p) return;
    const commentId = generateId();
    p.comments.push({
        id: commentId,
        author: userName,
        text,
        date: new Date().toISOString(),
        replies: [],
    });
    saveFeed(feed);
    onUpdate();

    PENDING_COMMENT_REACTIONS.push({
        postId: post.id,
        commentId,
        text,
        userName,
        onUpdate,
    });
}

export async function triggerPendingCommentReaction() {
    if (pendingReactionInFlight) return;
    pendingReactionInFlight = true;
    const pending = PENDING_COMMENT_REACTIONS.shift();
    if (!pending) {
        pendingReactionInFlight = false;
        return;
    }
    try {
        await runDeferredCommentGeneration(pending);
    } finally {
        pendingReactionInFlight = false;
    }
}

export function hasPendingCommentReaction() {
    return PENDING_COMMENT_REACTIONS.length > 0;
}

function findCommentNodeById(nodes, id) {
    for (const node of (Array.isArray(nodes) ? nodes : [])) {
        if (node?.id === id) return node;
        const found = findCommentNodeById(node?.replies, id);
        if (found) return found;
    }
    return null;
}

async function generateSnsText(ctx, quietPrompt, quietName, routeKey = 'sns') {
    if (!ctx) return '';
    const promptSettings = getSnsPromptSettings();
    if (promptSettings.externalApiUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), promptSettings.externalApiTimeoutMs);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (typeof ctx.getRequestHeaders === 'function') {
                Object.assign(headers, ctx.getRequestHeaders());
            }
            const response = await fetch(promptSettings.externalApiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ prompt: quietPrompt, quietName, module: 'st-lifesim-sns' }),
                signal: controller.signal,
            });
            if (response.ok) {
                const rawText = await response.text();
                try {
                    const json = JSON.parse(rawText || 'null');
                    if (typeof json === 'string') return json.trim();
                    if (typeof json?.text === 'string') return json.text.trim();
                } catch { /* non-JSON 응답은 그대로 사용 */ }
                if (rawText) return rawText.trim();
            } else {
                console.warn('[ST-LifeSim] SNS 외부 API 응답 오류:', response.status);
            }
        } catch (error) {
            console.warn('[ST-LifeSim] SNS 외부 API 호출 실패, 내부 생성으로 폴백:', error);
        } finally {
            clearTimeout(timer);
        }
    }
    if (typeof ctx.generateRaw === 'function') {
        const aiRoute = getSnsAiRouteSettings(routeKey);
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

async function runDeferredCommentGeneration({ postId, commentId, text, userName, onUpdate }) {
    try {
        const ctx = getContext();
        if (!ctx || (typeof ctx.generateQuietPrompt !== 'function' && typeof ctx.generateRaw !== 'function')) return;
        const feed = loadFeed();
        const p = feed.find(item => item.id === postId);
        const comment = findCommentNodeById(p?.comments, commentId);
        if (!p || !comment) return;

        const safePostContent = String(p.content || '').replace(/[{}\n\r]/g, ' ').slice(0, 300);
        const safeComment = String(text || '').replace(/[{}\n\r]/g, ' ').slice(0, 200);
        const promptSettings = getSnsPromptSettings();
        const userIds = loadUserIds();
        const postAuthorHandle = getAuthorHandle(p.authorName, userIds);
        const userHandle = getAuthorHandle(userName, userIds);
        const charName = ctx?.name2 || '';
        const contacts = getContacts('chat');
        const allContactsForPersonality = [...getContacts('character'), ...contacts];
        const postAuthorContact = allContactsForPersonality.find(c => c?.name === p.authorName);
        const replyAuthorCandidates = [];
        if (p.authorName && p.authorName !== userName) {
            replyAuthorCandidates.push({ name: p.authorName, personality: [postAuthorContact?.description, postAuthorContact?.personality].filter(Boolean).join(' / ') || '' });
        }
        if (charName && charName !== userName && charName !== p.authorName) {
            const charContact = allContactsForPersonality.find(c => c?.name === charName);
            replyAuthorCandidates.push({ name: charName, personality: [charContact?.description, charContact?.personality].filter(Boolean).join(' / ') || '' });
        }
        contacts.forEach(c => {
            if (!c?.name || c.name === userName || c.name === p.authorName) return;
            if (!replyAuthorCandidates.find(existing => existing.name === c.name)) {
                replyAuthorCandidates.push({ name: c.name, personality: [c.description, c.personality].filter(Boolean).join(' / ') || '' });
            }
        });

        const shouldReply = Math.random() < SNS_REPLY_PROBABILITY;
        let replyText = '';
        let extraContactComment = null;

        if (shouldReply && replyAuthorCandidates.length > 0) {
            const replyAuthor = replyAuthorCandidates[Math.floor(Math.random() * replyAuthorCandidates.length)];
            const replyAuthorHandle = getAuthorHandle(replyAuthor.name, userIds);
            const replyLanguage = getAuthorLanguage(replyAuthor.name, promptSettings.language);
            const replyPrompt = enforceSnsLanguage(applyPromptTemplate(promptSettings.templates.reply, {
                postAuthorName: p.authorName,
                postAuthorHandle,
                postContent: safePostContent,
                commentAuthorName: userName,
                commentAuthorHandle: userHandle,
                commentText: safeComment,
                replyAuthorName: replyAuthor.name,
                replyAuthorHandle,
                replyPersonality: replyAuthor.personality || '평범하고 자연스러운 말투',
            }), replyLanguage);
            replyText = await generateSnsText(ctx, replyPrompt, replyAuthor.name);
            if (replyText) {
                const replyId = generateId();
                comment.replies.push({
                    id: replyId,
                    author: replyAuthor.name,
                    text: replyText,
                    date: new Date().toISOString(),
                    replies: [],
                });
                if (Math.random() < SNS_REPLY_PROBABILITY) {
                    PENDING_COMMENT_REACTIONS.push({
                        postId: p.id,
                        commentId: replyId,
                        text: replyText,
                        userName: replyAuthor.name,
                        onUpdate,
                    });
                }
            }
        }

        if (Math.random() < SNS_EXTRA_COMMENT_PROBABILITY && contacts.length > 0) {
            const candidates = contacts.filter(c => c?.name && c.name !== userName && c.name !== p.authorName);
            if (candidates.length > 0) {
                const picker = candidates[Math.floor(Math.random() * candidates.length)];
                const pickerHandle = getAuthorHandle(picker.name, userIds);
                const pickerLanguage = getAuthorLanguage(picker.name, promptSettings.language);
                const contactPrompt = enforceSnsLanguage(applyPromptTemplate(promptSettings.templates.extraComment, {
                    postAuthorName: p.authorName,
                    postAuthorHandle,
                    postContent: safePostContent,
                    extraAuthorName: picker.name,
                    extraAuthorHandle: pickerHandle,
                    extraPersonality: [picker.description, picker.personality].filter(Boolean).join(' / ') || '평범하고 자연스러운 말투',
                }), pickerLanguage);
                const generated = await generateSnsText(ctx, contactPrompt, picker.name);
                if (generated) {
                    extraContactComment = {
                        id: generateId(),
                        author: picker.name,
                        text: generated,
                        date: new Date().toISOString(),
                        replies: [],
                    };
                }
            }
        }

        if (extraContactComment) p.comments.push(extraContactComment);
        saveFeed(feed);
        onUpdate();
    } catch (genErr) {
        console.error('[ST-LifeSim] 댓글 답글 생성 오류:', genErr);
        showToast('답글 생성 실패 (댓글은 저장됨)', 'warn', 2000);
    }
}


/**
 * 직접 게시물 작성 다이얼로그를 연다
 */
function openWritePostDialog(onSave) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const contentLabel = document.createElement('label');
    contentLabel.className = 'slm-label';
    contentLabel.textContent = '글 내용';

    const contentInput = document.createElement('textarea');
    contentInput.className = 'slm-textarea';
    contentInput.rows = 4;
    contentInput.placeholder = '내용을 입력하세요...';

    const imgLabel = document.createElement('label');
    imgLabel.className = 'slm-label';
    imgLabel.textContent = '이미지';

    // ── 이미지 소스 선택: 기본이미지 / URL 직접입력 / AI 생성 ──
    const imgSourceRow = document.createElement('div');
    imgSourceRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px';

    const useDefaultLabel = document.createElement('label');
    useDefaultLabel.className = 'slm-toggle-label';
    const useDefaultRadio = document.createElement('input');
    useDefaultRadio.type = 'radio';
    useDefaultRadio.name = 'slm-img-source';
    useDefaultRadio.value = 'default';
    useDefaultRadio.checked = true;
    useDefaultLabel.appendChild(useDefaultRadio);
    useDefaultLabel.appendChild(document.createTextNode(' 기본 이미지'));

    const useUrlLabel = document.createElement('label');
    useUrlLabel.className = 'slm-toggle-label';
    const useUrlRadio = document.createElement('input');
    useUrlRadio.type = 'radio';
    useUrlRadio.name = 'slm-img-source';
    useUrlRadio.value = 'url';
    useUrlLabel.appendChild(useUrlRadio);
    useUrlLabel.appendChild(document.createTextNode(' URL 직접입력'));

    const useAiLabel = document.createElement('label');
    useAiLabel.className = 'slm-toggle-label';
    const useAiRadio = document.createElement('input');
    useAiRadio.type = 'radio';
    useAiRadio.name = 'slm-img-source';
    useAiRadio.value = 'ai';
    useAiLabel.appendChild(useAiRadio);
    useAiLabel.appendChild(document.createTextNode(' 🎨 AI 이미지 생성'));

    imgSourceRow.appendChild(useDefaultLabel);
    imgSourceRow.appendChild(useUrlLabel);
    imgSourceRow.appendChild(useAiLabel);

    const imgInput = document.createElement('input');
    imgInput.className = 'slm-input';
    imgInput.type = 'url';
    imgInput.placeholder = 'https://...';
    imgInput.style.display = 'none';

    const aiImgDescInput = document.createElement('textarea');
    aiImgDescInput.className = 'slm-textarea';
    aiImgDescInput.rows = 2;
    aiImgDescInput.placeholder = '생성할 이미지 설명 (예: 카페에서 셀카를 찍는 모습)';
    aiImgDescInput.style.display = 'none';

    function updateImgSourceVisibility() {
        imgInput.style.display = useUrlRadio.checked ? '' : 'none';
        aiImgDescInput.style.display = useAiRadio.checked ? '' : 'none';
    }
    useDefaultRadio.onchange = updateImgSourceVisibility;
    useUrlRadio.onchange = updateImgSourceVisibility;
    useAiRadio.onchange = updateImgSourceVisibility;

    const imgDescLabel = document.createElement('label');
    imgDescLabel.className = 'slm-label';
    imgDescLabel.textContent = '사진 설명 (선택, 이미지 위에 마우스 호버 시 표시)';

    const imgDescInput = document.createElement('input');
    imgDescInput.className = 'slm-input';
    imgDescInput.type = 'text';
    imgDescInput.placeholder = '이미지 설명...';

    wrapper.appendChild(contentLabel);
    wrapper.appendChild(contentInput);
    wrapper.appendChild(imgLabel);
    wrapper.appendChild(imgSourceRow);
    wrapper.appendChild(imgInput);
    wrapper.appendChild(aiImgDescInput);
    wrapper.appendChild(imgDescLabel);
    wrapper.appendChild(imgDescInput);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const postBtn = document.createElement('button');
    postBtn.className = 'slm-btn slm-btn-primary';
    postBtn.textContent = '올리기';

    footer.appendChild(cancelBtn);
    footer.appendChild(postBtn);

    const { close } = createPopup({
        id: 'write-post',
        title: '✏️ 게시물 작성',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack: () => openSnsPopup(),
    });

    cancelBtn.onclick = () => close();

    postBtn.onclick = async () => {
        const text = contentInput.value.trim();
        if (!text) { showToast('내용을 입력해주세요.', 'warn'); return; }

        const freshCtx = getContext();
        const authorName = freshCtx?.name1 || 'user';
        const promptSettings = getSnsPromptSettings();
        let finalImageUrl = '';
        let imageDescription = imgDescInput.value.trim();
        let resolvedImagePrompt = '';

        if (useDefaultRadio.checked) {
            finalImageUrl = getAuthorDefaultImageUrl(authorName) || '';
        } else if (useUrlRadio.checked) {
            finalImageUrl = imgInput.value.trim();
        } else if (useAiRadio.checked) {
            // AI 이미지 생성 (NPC 게시글과 동일한 파이프라인)
            const userImageDesc = aiImgDescInput.value.trim() || text;
            const fallbackImageUrl = getAuthorDefaultImageUrl(authorName) || '';

            // 통합 파이프라인: generateImageTags() → Image API
            // 유저 SNS 게시글용 이미지: 작성자 컨텍스트 포함
            showToast('🎨 이미지 생성 중...', 'info', 3000);
            postBtn.disabled = true;

            try {
                const allContactsList = [...getContacts('character'), ...getContacts('chat')];
                const userPromptSettings = getSnsPromptSettings();
                const imageInputPrompt = buildSnsImageInputPrompt(userPromptSettings.snsImagePrompt, authorName, userImageDesc);
                const additionalPrompt = String(getExtensionSettings()?.['st-lifesim']?.tagGenerationAdditionalPrompt || '').trim();
                const tagResult = await generateImageTags(imageInputPrompt, {
                    includeNames: [authorName].filter(Boolean),
                    contacts: allContactsList,
                    getAppearanceTagsByName,
                    tagWeight: Number(getExtensionSettings()?.['st-lifesim']?.tagWeight) || 0,
                    additionalPrompt,
                });
                resolvedImagePrompt = userImageDesc;

                if (tagResult.finalPrompt) {
                    const generatedUrl = await generateImageViaApi(tagResult.finalPrompt);
                    finalImageUrl = generatedUrl || fallbackImageUrl;
                    if (generatedUrl) imageDescription = '';
                    if (!generatedUrl) showToast('이미지 생성 결과가 없습니다. 기본 이미지를 사용합니다.', 'warn', 2500);
                } else {
                    showToast('태그 변환 실패. 기본 이미지를 사용합니다.', 'warn', 2500);
                    finalImageUrl = fallbackImageUrl;
                }
            } catch (imgErr) {
                console.warn('[ST-LifeSim] 유저 SNS 이미지 생성 실패:', imgErr);
                showToast('이미지 생성 실패. 기본 이미지를 사용합니다.', 'warn', 2500);
                finalImageUrl = fallbackImageUrl;
            } finally {
                postBtn.disabled = false;
            }
        }

        const feed = loadFeed();
        feed.push({
            id: generateId(),
            authorName,
            authorIsUser: true,
            date: new Date().toISOString(),
            content: text,
            imageUrl: finalImageUrl,
            imageDescription,
            imagePrompt: resolvedImagePrompt,
            likes: getInitialLikes(authorName, 0),
            likedByUser: false,
            comments: [],
            isStory: false,
            includeInContext: true,
        });
        saveFeed(feed);

        close();
        onSave();
        showToast('게시물 올리기 완료', 'success');
    };
}

function openImagePresetManager(onChanged) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';
    const list = document.createElement('div');
    list.className = 'slm-sns-preset-grid';
    wrapper.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    addBtn.textContent = '+ 프리셋 추가';
    addBtn.onclick = () => openPresetEditor(null, render);
    wrapper.appendChild(addBtn);

    function render() {
        list.innerHTML = '';
        const presets = loadImagePresets();
        if (presets.length === 0) {
            list.appendChild(Object.assign(document.createElement('div'), { className: 'slm-empty', textContent: '등록된 프리셋이 없습니다.' }));
            return;
        }
        presets.forEach((preset, i) => {
            const row = document.createElement('div');
            row.className = 'slm-sns-preset-card';
            const thumb = document.createElement('img');
            thumb.src = preset.url;
            thumb.alt = preset.name;
            thumb.className = 'slm-preview-img';
            const name = document.createElement('span');
            name.className = 'slm-sns-preset-name';
            name.textContent = preset.name;
            const editBtn = document.createElement('button');
            editBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            editBtn.textContent = '수정';
            editBtn.onclick = () => openPresetEditor({ ...preset, index: i }, render);
            const delBtn = document.createElement('button');
            delBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
            delBtn.textContent = '삭제';
            delBtn.onclick = () => {
                const all = loadImagePresets();
                all.splice(i, 1);
                saveImagePresets(all);
                render();
                onChanged?.();
            };
            const btnRow = document.createElement('div');
            btnRow.className = 'slm-btn-row';
            btnRow.append(editBtn, delBtn);
            row.append(thumb, name, btnRow);
            list.appendChild(row);
        });
    }

    function openPresetEditor(preset, onDone) {
        const form = document.createElement('div');
        form.className = 'slm-form';
        const nameInput = document.createElement('input');
        nameInput.className = 'slm-input';
        nameInput.placeholder = '이름';
        nameInput.value = preset?.name || '';
        const urlInput = document.createElement('input');
        urlInput.className = 'slm-input';
        urlInput.type = 'url';
        urlInput.placeholder = '이미지 URL';
        urlInput.value = preset?.url || '';
        form.append(nameInput, urlInput);

        const footer = document.createElement('div');
        footer.className = 'slm-panel-footer';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'slm-btn slm-btn-primary';
        saveBtn.textContent = '저장';
        footer.appendChild(saveBtn);

        const { close } = createPopup({
            id: 'sns-preset-edit',
            title: preset ? '🛠️ 프리셋 수정' : '➕ 프리셋 추가',
            content: form,
            footer,
            className: 'slm-sub-panel',
        });
        saveBtn.onclick = () => {
            const name = nameInput.value.trim();
            const url = urlInput.value.trim();
            if (!name || !url) return;
            const all = loadImagePresets();
            const next = { id: preset?.id || generateId(), name, url };
            if (typeof preset?.index === 'number') all[preset.index] = next;
            else all.push(next);
            saveImagePresets(all);
            close();
            onDone();
            onChanged?.();
        };
    }

    render();
    createPopup({
        id: 'sns-preset-manager',
        title: '🖼️ SNS 이미지 프리셋',
        content: wrapper,
        className: 'slm-sub-panel',
    });
}

/**
 * SNS 프로필 설정 다이얼로그를 연다 (아바타 + 아이디 + 연락처 연동)
 * @param {Function} onUpdate
 */
function openAvatarSettingsDialog(onUpdate) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';
    const defaultAuthorLanguage = getSnsPromptSettings().language;

    // ─ 연락처 프로필 연동 토글 ─
    const linkRow = document.createElement('div');
    linkRow.className = 'slm-settings-row';
    const linkLabel = document.createElement('label');
    linkLabel.className = 'slm-toggle-label';
    const linkCheck = document.createElement('input');
    linkCheck.type = 'checkbox';
    linkCheck.checked = loadContactLink();
    linkCheck.onchange = () => {
        saveContactLink(linkCheck.checked);
        onUpdate();
    };
    linkLabel.appendChild(linkCheck);
    linkLabel.appendChild(document.createTextNode(' 연락처 프로필과 자동 연동'));
    linkRow.appendChild(linkLabel);
    wrapper.appendChild(linkRow);

    wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));

    // ─ 이미지 URL 프리셋 관리 ─
    const presetTitle = Object.assign(document.createElement('div'), {
        className: 'slm-label',
        textContent: '📎 기본 이미지 URL 프리셋',
    });
    presetTitle.style.fontWeight = '700';
    wrapper.appendChild(presetTitle);

    const presetDesc = Object.assign(document.createElement('div'), {
        className: 'slm-label',
        textContent: '등록된 URL을 각 캐릭터의 게시글 기본 이미지로 바인딩할 수 있습니다.',
    });
    presetDesc.style.fontSize = '12px';
    presetDesc.style.marginBottom = '6px';
    wrapper.appendChild(presetDesc);

    const presetManageBtn = document.createElement('button');
    presetManageBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    presetManageBtn.textContent = '🖼️ 프리셋 관리 열기';
    presetManageBtn.onclick = () => openImagePresetManager(() => renderContactList());
    wrapper.appendChild(presetManageBtn);

    wrapper.appendChild(Object.assign(document.createElement('hr'), { className: 'slm-hr' }));
    const descRow = document.createElement('div');
    descRow.style.display = 'flex';
    descRow.style.alignItems = 'center';
    descRow.style.gap = '8px';
    descRow.style.marginBottom = '6px';
    const desc = document.createElement('div');
    desc.className = 'slm-label';
    desc.textContent = '연락처에 등록된 인물을 SNS 프로필로 자동 동기화합니다. 이름을 눌러 세부 옵션을 설정하세요.';
    descRow.appendChild(desc);
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    refreshBtn.textContent = '🔄 갱신';
    refreshBtn.title = '현재 연락처/페르소나에서 프로필을 다시 동기화합니다';
    refreshBtn.onclick = () => {
        const freshContacts = [...getContacts('character'), ...getContacts('chat')];
        const freshUserName = getContext()?.name1 || 'user';
        const freshCharName = getContext()?.name2 || '';
        const freshCharProfile = freshCharName
            ? [{ name: freshCharName, avatar: avatars[freshCharName] || getBuiltinCharAvatarUrl(), personality: 'char' }]
            : [];
        const freshProfiles = [{ name: freshUserName, avatar: avatars[freshUserName] || getBuiltinUserAvatarUrl(), personality: 'user' }, ...freshCharProfile, ...freshContacts]
            .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i);
        // 새 프로필에 없는 이전 항목 제거
        const freshNames = new Set(freshProfiles.map(c => c.name));
        Object.keys(userIds).forEach(k => { if (!freshNames.has(k)) delete userIds[k]; });
        Object.keys(avatars).forEach(k => { if (!freshNames.has(k)) delete avatars[k]; });
        Object.keys(defaultImages).forEach(k => { if (!freshNames.has(k)) delete defaultImages[k]; });
        Object.keys(postingEnabled).forEach(k => { if (!freshNames.has(k)) delete postingEnabled[k]; });
        Object.keys(authorLanguages).forEach(k => { if (!freshNames.has(k)) delete authorLanguages[k]; });
        Object.keys(authorMinLikes).forEach(k => { if (!freshNames.has(k)) delete authorMinLikes[k]; });
        // 새 프로필 동기화
        freshProfiles.forEach(c => {
            if (!userIds[c.name]) userIds[c.name] = makeDefaultHandle(c.name);
            if (c.avatar && !avatars[c.name]) avatars[c.name] = c.avatar;
            if (c.name !== freshUserName && postingEnabled[c.name] == null) postingEnabled[c.name] = true;
            if (!['ko', 'en', 'ja', 'zh'].includes(authorLanguages[c.name])) authorLanguages[c.name] = defaultAuthorLanguage;
            if (authorMinLikes[c.name] == null || Number.isNaN(Number(authorMinLikes[c.name]))) authorMinLikes[c.name] = 0;
        });
        saveUserIds(userIds);
        saveAvatars(avatars);
        saveAuthorDefaultImages(defaultImages);
        savePostingEnabledMap(postingEnabled);
        saveAuthorLanguages(authorLanguages);
        saveAuthorMinLikesMap(authorMinLikes);
        // allProfiles 갱신 후 렌더링
        allProfiles.length = 0;
        freshProfiles.forEach(p => allProfiles.push(p));
        renderContactList();
        showToast('SNS 프로필 갱신 완료', 'success', 1500);
    };
    descRow.appendChild(refreshBtn);
    wrapper.appendChild(descRow);

    const userIds = loadUserIds();
    const avatars = loadAvatars();
    const defaultImages = loadAuthorDefaultImages();
    const postingEnabled = loadPostingEnabledMap();
    const authorLanguages = loadAuthorLanguages();
    const authorMinLikes = loadAuthorMinLikesMap();
    const contacts = [...getContacts('character'), ...getContacts('chat')];
    const userName = getContext()?.name1 || 'user';
    const charName = getContext()?.name2 || '';
    const charProfile = charName
        ? [{ name: charName, avatar: avatars[charName] || getBuiltinCharAvatarUrl(), personality: 'char' }]
        : [];
    const allProfiles = [{ name: userName, avatar: avatars[userName] || getBuiltinUserAvatarUrl(), personality: 'user' }, ...charProfile, ...contacts]
        .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i);

    allProfiles.forEach(c => {
        if (!userIds[c.name]) userIds[c.name] = makeDefaultHandle(c.name);
        if (c.avatar && !avatars[c.name]) avatars[c.name] = c.avatar;
        if (c.name !== userName && postingEnabled[c.name] == null) postingEnabled[c.name] = true;
        if (!['ko', 'en', 'ja', 'zh'].includes(authorLanguages[c.name])) authorLanguages[c.name] = defaultAuthorLanguage;
        if (authorMinLikes[c.name] == null || Number.isNaN(Number(authorMinLikes[c.name]))) authorMinLikes[c.name] = 0;
    });
    saveUserIds(userIds);
    saveAvatars(avatars);
    savePostingEnabledMap(postingEnabled);
    saveAuthorLanguages(authorLanguages);
    saveAuthorMinLikesMap(authorMinLikes);

    const contactList = document.createElement('div');
    contactList.className = 'slm-form';
    wrapper.appendChild(contactList);

    function renderContactList() {
        contactList.innerHTML = '';
        const presets = loadImagePresets();

        allProfiles.forEach(c => {
            const item = document.createElement('details');
            item.className = 'slm-sns-profile-item';
            const summary = document.createElement('summary');
            summary.className = 'slm-sns-profile-summary';
            const avatarSpan = document.createElement('span');
            avatarSpan.className = 'slm-sns-profile-avatar';
            if (avatars[c.name]) {
                const img = document.createElement('img');
                img.src = avatars[c.name];
                img.alt = c.name;
                avatarSpan.appendChild(img);
            } else {
                avatarSpan.textContent = ((c.name || '?')[0] || '?').toUpperCase();
            }
            const nameSpan = document.createElement('span');
            nameSpan.textContent = c.name;
            summary.append(avatarSpan, nameSpan);
            item.appendChild(summary);

            const handleInput = document.createElement('input');
            handleInput.className = 'slm-input';
            handleInput.type = 'text';
            handleInput.placeholder = '@핸들';
            handleInput.value = userIds[c.name] || '';
            handleInput.onchange = () => {
                let val = handleInput.value.trim();
                if (val && !val.startsWith('@')) val = '@' + val;
                userIds[c.name] = val;
                saveUserIds(userIds);
                onUpdate();
            };

            const avatarInput = document.createElement('input');
            avatarInput.className = 'slm-input';
            avatarInput.type = 'url';
            avatarInput.placeholder = '프로필 이미지 URL';
            avatarInput.value = avatars[c.name] || '';
            avatarInput.onchange = () => {
                avatars[c.name] = avatarInput.value.trim();
                saveAvatars(avatars);
                onUpdate();
            };

            const presetSelect = document.createElement('select');
            presetSelect.className = 'slm-select';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '기본 이미지 미사용';
            presetSelect.appendChild(noneOpt);
            presets.forEach(preset => {
                const opt = document.createElement('option');
                opt.value = preset.url;
                opt.textContent = preset.name;
                presetSelect.appendChild(opt);
            });
            presetSelect.value = defaultImages[c.name] || '';
            presetSelect.onchange = () => {
                defaultImages[c.name] = presetSelect.value;
                saveAuthorDefaultImages(defaultImages);
            };

            const postToggle = document.createElement('label');
            postToggle.className = 'slm-toggle-label';
            const postCheck = document.createElement('input');
            postCheck.type = 'checkbox';
            postCheck.checked = postingEnabled[c.name] !== false;
            postCheck.onchange = () => {
                postingEnabled[c.name] = postCheck.checked;
                savePostingEnabledMap(postingEnabled);
            };
            postToggle.appendChild(postCheck);
            postToggle.appendChild(document.createTextNode(' 게시물 활성화'));

            const languageSelect = document.createElement('select');
            languageSelect.className = 'slm-select';
            [
                { value: 'ko', label: '한국어' },
                { value: 'zh', label: '中文' },
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
            ].forEach(({ value, label }) => {
                languageSelect.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
            });
            languageSelect.value = authorLanguages[c.name] || defaultAuthorLanguage;
            languageSelect.onchange = () => {
                authorLanguages[c.name] = languageSelect.value;
                saveAuthorLanguages(authorLanguages);
            };

            const minLikesInput = document.createElement('input');
            minLikesInput.className = 'slm-input';
            minLikesInput.type = 'number';
            minLikesInput.min = '0';
            minLikesInput.max = '1000000';
            minLikesInput.value = String(Math.max(0, parseInt(authorMinLikes[c.name], 10) || 0));
            minLikesInput.onchange = () => {
                authorMinLikes[c.name] = Math.max(0, parseInt(minLikesInput.value, 10) || 0);
                minLikesInput.value = String(authorMinLikes[c.name]);
                saveAuthorMinLikesMap(authorMinLikes);
            };

            item.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '아이디(@핸들)' }));
            item.appendChild(handleInput);
            item.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '프로필 이미지 URL' }));
            item.appendChild(avatarInput);
            item.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '게시글/댓글 출력 언어' }));
            item.appendChild(languageSelect);
            item.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '최소 좋아요 수' }));
            item.appendChild(minLikesInput);
            item.appendChild(Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '게시글 기본 이미지 프리셋' }));
            item.appendChild(presetSelect);
            if (c.name !== userName) item.appendChild(postToggle);
            contactList.appendChild(item);
        });
    }

    renderContactList();

    createPopup({
        id: 'sns-avatars',
        title: '⚙️ SNS 프로필 설정',
        content: wrapper,
        className: 'slm-sub-panel',
        onBack: () => openSnsPopup(),
    });
}
