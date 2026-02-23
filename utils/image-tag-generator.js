/**
 * image-tag-generator.js
 * Korean/raw image prompts를 영어 Danbooru 형식 태그로 변환하는 유틸리티
 * opinion3.txt 요구사항:
 *   - 한국어 원문은 절대 Image API에 직접 전달 금지
 *   - 태그 생성 단계가 반드시 선행
 *   - 태그는 영어 Danbooru 형식
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

const TAG_CONVERSION_PROMPT = [
    'Convert the following image description into Danbooru-style English tags.',
    'Output ONLY comma-separated tags. No sentences, no Korean, no explanation.',
    'Example output: 1girl, selfie, looking_at_viewer, phone_in_hand, casual_smile, indoor, upper_body',
    '',
    'Description:',
].join('\n');

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
 * @param {string} [options.customPrompt] - Additional context prompt (e.g. messageImagePrompt or snsImagePrompt) to guide tag generation
 * @returns {Promise<string>} English Danbooru tags, comma-separated
 */
export async function generateDanbooruTags(rawPrompt, options) {
    if (!rawPrompt || typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
        return '';
    }

    const trimmed = rawPrompt.trim();

    // Already looks like English-only tags — return as-is
    if (!containsKorean(trimmed)) {
        return trimmed;
    }

    const context = getContext();
    if (!context) {
        console.warn('[image-tag-generator] SillyTavern context unavailable; cannot convert tags.');
        return '';
    }

    const customPrompt = options?.customPrompt ? String(options.customPrompt).trim() : '';
    const contextSection = customPrompt
        ? `\n\nImage generation context:\n${customPrompt}\n`
        : '';

    const fullPrompt = `${TAG_CONVERSION_PROMPT}${contextSection}\n${trimmed}`;

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
                modelKey = aiRoute.modelSettingKey || MODEL_KEY_BY_SOURCE[aiRoute.chatSource || sourceBefore] || '';
                if (modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0) {
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
                if (chatSettings && modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0) {
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
 * @param {string} appearanceTags - Character appearance tags
 * @returns {string} Final prompt for Image API
 */
export function buildImageApiPrompt(danbooruTags, appearanceTags) {
    const parts = [];

    const cleanDanbooru = safeTags(danbooruTags);
    const cleanAppearance = safeTags(appearanceTags);

    if (cleanDanbooru) parts.push(cleanDanbooru);
    if (cleanAppearance) parts.push(cleanAppearance);

    return parts.join(', ');
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
        .map(t => t.trim())
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
