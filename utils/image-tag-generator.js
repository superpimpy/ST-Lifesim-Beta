/**
 * image-tag-generator.js
 * Korean/raw image prompts를 영어 Danbooru 형식 태그로 변환하는 유틸리티
 * 요구사항:
 *   - 한국어 원문은 절대 Image API에 직접 전달 금지
 *   - 태그 생성 단계가 반드시 선행
 *   - 태그는 영어 Danbooru 형식
 *   - 모든 이미지 생성 경로(메신저/SNS/유저)가 동일한 파이프라인을 사용
 *   - 최종 프롬프트 형식: scene tags | appearance1 | appearance2 | ...
 *   - 커스텀 프롬프트는 최종 출력에 포함되지 않음
 */

import { getContext } from './st-context.js';
import { getExtensionSettings } from './storage.js';

// Korean character detection regex (Hangul syllables, Jamo, compatibility Jamo)
const KOREAN_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

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
};

/** Simple tag-only conversion prompt (legacy fallback) */
const TAG_CONVERSION_PROMPT = [
    'Convert the following image description into Danbooru-style English tags.',
    'Output ONLY comma-separated tags. No sentences, no Korean, no explanation.',
    'Replace underscores with spaces in all tags.',
    'Example output: 1girl, selfie, looking at viewer, phone in hand, casual smile, indoor, upper body',
    '',
    'Description:',
].join('\n');

/**
 * Build the enhanced tag generation prompt that includes character context.
 * The AI receives all known characters so it can:
 * - Correctly identify characters mentioned in the scene
 * - Generate accurate count tags (1girl, 3boys, multiple boys, etc.)
 * - Generate scene/situation/pose/action tags
 * - NOT output appearance tags (those are appended separately via pipe separator)
 *
 * @param {Array<{name: string, description?: string, appearanceTags?: string}>} characters
 * @returns {string}
 */
function buildCharacterAwarePrompt(characters) {
    const charList = characters.length > 0
        ? characters.map(c => {
            const desc = c.description ? ` (${c.description})` : '';
            const tags = c.appearanceTags ? ` [appearance: ${c.appearanceTags}]` : '';
            return `  - ${c.name}${desc}${tags}`;
        }).join('\n')
        : '  (none)';

    return [
        'You are a Danbooru-style tag generator for image creation.',
        '',
        'Given an image description and a list of known characters, generate ONLY scene/situation tags.',
        '',
        'RULES:',
        '1) Output ONLY comma-separated Danbooru-style English tags. No sentences, no Korean, no explanation.',
        '2) Replace underscores with spaces in all tags.',
        '3) DO NOT output character appearance/clothing tags — those are handled separately.',
        '4) DO include character count tags: 1girl, 1boy, 2girls, 3boys, multiple boys, multiple girls, solo, etc.',
        '5) Include scene/environment tags: cafe, outdoor, indoor, classroom, bedroom, park, street, etc.',
        '6) Include pose/action tags: selfie, standing, sitting, looking at viewer, v sign, peace sign, etc.',
        '7) Include mood/lighting/framing tags: warm lighting, natural lighting, upper body, close-up, full body, etc.',
        '8) If characters from the known list are mentioned or implied, count them for the character count tags.',
        '',
        'Known characters:',
        charList,
        '',
        'Example: If 3 male characters a, b, c take a selfie at a cafe →',
        '3boys, selfie, multiple boys, cafe, indoor, looking at viewer, upper body, warm lighting, casual',
        '',
        'Image description:',
    ].join('\n');
}

/**
 * Check if text contains Korean characters.
 * @param {string} text
 * @returns {boolean}
 */
export function containsKorean(text) {
    if (!text) return false;
    return KOREAN_REGEX.test(text);
}

/**
 * 태그 생성 AI 라우트 설정을 가져온다.
 * @returns {{ api: string, chatSource: string, modelSettingKey: string, model: string }}
 */
function getTagGenRouteSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'];
    const route = ext?.aiRoutes?.tagGeneration || {};
    return {
        api: String(route.api || '').trim(),
        chatSource: String(route.chatSource || '').trim(),
        modelSettingKey: String(route.modelSettingKey || '').trim(),
        model: String(route.model || '').trim(),
    };
}

/**
 * Uses AI to convert a raw prompt (possibly Korean) into English Danbooru-style tags.
 * Returns empty string on failure.
 * @param {string} rawPrompt - The raw image prompt (possibly Korean)
 * @param {Object} [options] - Optional parameters
 * @param {Array<{name: string, description?: string, appearanceTags?: string}>} [options.characters] - Known characters for context-aware generation
 * @returns {Promise<string>} English Danbooru tags, comma-separated
 */
export async function generateDanbooruTags(rawPrompt, options) {
    if (!rawPrompt || typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
        return '';
    }

    const trimmed = rawPrompt.trim();
    const characters = Array.isArray(options?.characters) ? options.characters : [];

    // Already looks like English-only tags and no character context — return as-is
    if (!containsKorean(trimmed) && characters.length === 0) {
        return sanitizeTags(trimmed);
    }

    const context = getContext();
    if (!context) {
        console.warn('[image-tag-generator] SillyTavern context unavailable; cannot convert tags.');
        return '';
    }

    // Use character-aware prompt when characters are provided
    const promptBase = characters.length > 0
        ? buildCharacterAwarePrompt(characters)
        : TAG_CONVERSION_PROMPT;

    const fullPrompt = `${promptBase}\n${trimmed}`;

    try {
        let result = '';
        const aiRoute = getTagGenRouteSettings();

        if (typeof context.generateRaw === 'function') {
            const chatSettings = context.chatCompletionSettings;
            const sourceBefore = chatSettings?.chat_completion_source;
            let modelKey = '';
            let modelBefore;

            // 태그 생성 AI 라우트가 지정되어 있으면 임시로 적용
            if (chatSettings && aiRoute.chatSource) {
                chatSettings.chat_completion_source = aiRoute.chatSource;
            }
            if (chatSettings) {
                const effectiveSource = aiRoute.chatSource || sourceBefore;
                modelKey = aiRoute.modelSettingKey || MODEL_KEY_BY_SOURCE[effectiveSource] || '';
                const hasModelOverride = modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0;
                if (hasModelOverride) {
                    modelBefore = chatSettings[modelKey];
                    chatSettings[modelKey] = aiRoute.model;
                }
            }

            try {
                result = (await context.generateRaw({
                    prompt: fullPrompt,
                    quietToLoud: false,
                    trimNames: true,
                    api: aiRoute.api || null,
                }) || '').trim();
            } finally {
                // 원래 설정 복원
                if (chatSettings && aiRoute.chatSource) {
                    chatSettings.chat_completion_source = sourceBefore;
                }
                const hasModelOverride = modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0;
                if (chatSettings && hasModelOverride) {
                    chatSettings[modelKey] = modelBefore;
                }
            }
        } else if (typeof context.generateQuietPrompt === 'function') {
            result = (await context.generateQuietPrompt({
                quietPrompt: fullPrompt,
                quietName: 'danbooru-tag-gen',
            }) || '').trim();
        } else {
            console.warn('[image-tag-generator] No generation API found on context.');
            return '';
        }

        return sanitizeTags(result);
    } catch (error) {
        console.error('[image-tag-generator] Tag generation failed:', error);
        return '';
    }
}

/**
 * Build the final Image API prompt by combining Danbooru tags with appearance tags.
 * Korean text is never included.
 * @param {string} danbooruTags - Generated English Danbooru tags
 * @param {string|string[]} appearanceTags - Character appearance tags
 * @returns {string} Final prompt for Image API
 */
export function buildImageApiPrompt(danbooruTags, appearanceTags) {
    const cleanDanbooru = safeTags(danbooruTags);
    const appearanceGroups = Array.isArray(appearanceTags)
        ? appearanceTags.map(safeTags).filter(Boolean)
        : [safeTags(appearanceTags)].filter(Boolean);
    if (!cleanDanbooru) return appearanceGroups.join(' | ');
    if (appearanceGroups.length === 0) return cleanDanbooru;
    return `${cleanDanbooru} | ${appearanceGroups.join(' | ')}`;
}

/**
 * Unified image tag generation pipeline.
 * All image generation paths (message, SNS, user) MUST use this function.
 *
 * Pipeline:
 *   1. Load all contacts (names, descriptions, appearance tags)
 *   2. Match characters mentioned in the input prompt
 *   3. Generate scene/situation Danbooru tags via AI (with character context)
 *   4. Combine: scene tags | appearance1 | appearance2 | ...
 *
 * No custom prompts are included in the final output.
 *
 * @param {string} rawPrompt - Raw image description / prompt
 * @param {Object} options
 * @param {string[]} [options.includeNames] - Force-include these character names
 * @param {Array<{name: string, displayName?: string, description?: string, appearanceTags?: string}>} [options.contacts] - All available contacts
 * @param {(name: string) => string} [options.getAppearanceTagsByName] - Lookup function for appearance tags
 * @returns {Promise<{sceneTags: string, appearanceGroups: string[], finalPrompt: string}>}
 */
export async function generateImageTags(rawPrompt, options = {}) {
    const emptyResult = { sceneTags: '', appearanceGroups: [], finalPrompt: '' };
    if (!rawPrompt || typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
        return emptyResult;
    }

    const allContacts = Array.isArray(options.contacts) ? options.contacts : [];
    const getAppearanceFn = typeof options.getAppearanceTagsByName === 'function'
        ? options.getAppearanceTagsByName
        : () => '';
    const includeNames = Array.isArray(options.includeNames) ? options.includeNames : [];

    // ── Step 1: Match mentioned characters ──
    const textLower = rawPrompt.toLowerCase();
    const matched = [];
    const matchedNamesLower = new Set();

    // Force-include specified names first
    for (const name of includeNames) {
        if (!name) continue;
        const normalized = String(name).trim().toLowerCase();
        if (matchedNamesLower.has(normalized)) continue;
        matchedNamesLower.add(normalized);
        const contact = allContacts.find(c =>
            String(c.name || '').trim().toLowerCase() === normalized
            || String(c.displayName || '').trim().toLowerCase() === normalized
        );
        const appearance = getAppearanceFn(name);
        matched.push({
            name: String(name).trim(),
            description: String(contact?.description || '').trim(),
            appearanceTags: String(appearance || '').trim(),
        });
    }

    // Scan all contacts for names mentioned in the prompt
    for (const contact of allContacts) {
        const names = [contact?.name, contact?.displayName]
            .map(v => String(v || '').trim())
            .filter(Boolean);
        if (names.some(n => matchedNamesLower.has(n.toLowerCase()))) continue;
        const mentioned = names.some(n => {
            const norm = n.toLowerCase();
            if (/^[a-z0-9_]+$/i.test(norm)) {
                const re = new RegExp(`(^|[^a-z0-9_])${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
                return re.test(textLower);
            }
            return textLower.includes(norm);
        });
        if (mentioned) {
            const contactName = String(contact?.name || contact?.displayName || '').trim();
            matchedNamesLower.add(contactName.toLowerCase());
            matched.push({
                name: contactName,
                description: String(contact?.description || '').trim(),
                appearanceTags: String(getAppearanceFn(contactName) || '').trim(),
            });
        }
    }

    // ── Step 2: Generate scene/situation tags via AI ──
    let sceneTags = '';
    try {
        sceneTags = await generateDanbooruTags(rawPrompt, { characters: matched });
    } catch (err) {
        console.warn('[image-tag-generator] Scene tag generation failed:', err);
    }

    if (!sceneTags) {
        return emptyResult;
    }

    // ── Step 3: Collect appearance tag groups ──
    const appearanceGroups = matched
        .map(c => c.appearanceTags)
        .filter(Boolean);

    // ── Step 4: Build final prompt ──
    const finalPrompt = buildImageApiPrompt(sceneTags, appearanceGroups);

    return { sceneTags, appearanceGroups, finalPrompt };
}

// ── internal helpers ──

/**
 * Sanitize AI output: strip non-tag noise, reject if Korean remains.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeTags(raw) {
    if (!raw || typeof raw !== 'string') return '';

    // Remove common AI preamble / markdown fences
    let cleaned = raw
        .replace(/```[^`]*```/gs, '')
        .replace(/^[^a-zA-Z0-9_(]*/, '')
        .trim();

    // Reject if Korean characters leaked through
    if (containsKorean(cleaned)) {
        console.warn('[image-tag-generator] AI output still contains Korean; discarding.');
        return '';
    }

    // Normalize whitespace around commas
    cleaned = cleaned
        .split(',')
        .map(t => t.replace(/_/g, ' ').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join(', ');

    return cleaned;
}

/**
 * Return trimmed tag string only if it is non-empty and Korean-free.
 * Appearance tags are expected to be English (e.g. "long hair, school uniform").
 * If Korean is found, it's discarded to enforce the no-Korean-to-Image-API rule.
 * @param {string} tags
 * @returns {string}
 */
function safeTags(tags) {
    if (!tags || typeof tags !== 'string') return '';
    const trimmed = tags.trim();
    if (containsKorean(trimmed)) return '';
    return trimmed;
}
