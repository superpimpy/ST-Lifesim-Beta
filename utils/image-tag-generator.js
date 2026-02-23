/**
 * image-tag-generator.js
 * Korean/raw image prompts를 영어 Danbooru 형식 태그로 변환하는 유틸리티
 * 요구사항:
 *   - 한국어 원문은 절대 Image API에 직접 전달 금지
 *   - 태그 생성 단계가 반드시 선행
 *   - 태그는 영어 Danbooru 형식
 *   - 모든 이미지 생성 경로(메신저/SNS/유저)가 동일한 파이프라인을 사용
 *   - 최종 프롬프트 형식: scene tags | appearance1 | appearance2 | ...
 *   - 필요 시 설정값으로 태그 생성/API 전체 프롬프트를 커스터마이즈 가능
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
 * Build the tag generation prompt that includes character context.
 * The AI is instructed to output ONLY scene/situation tags;
 * character appearance tags are appended programmatically by the caller.
 *
 * @param {Array<{name: string, description?: string, appearanceTags?: string}>} characters
 * @param {{ [name: string]: string }} [appearanceVarMap] - (unused, kept for API compat)
 * @returns {string}
 */
function buildCharacterAwarePrompt(characters, appearanceVarMap) {
    const charList = characters.length > 0
        ? characters.map(c => {
            const desc = c.description ? ` (${c.description})` : ''; // ✅ fix: desc 선언
            return `  - ${c.name}${desc}`;
        }).join('\n')
        : '  (none)';

    return [
        'You are a Danbooru-style tag generator for image creation.',
        '',
        'Given an image description and a list of known characters, generate ONLY scene/situation tags.',
        'Character appearance tags are handled automatically by the system — do NOT include them in your output.',
        '',
        'RULES:',
        '1) Output ONLY comma-separated Danbooru-style tags. No sentences, no Korean, no explanation.',
        '2) Replace underscores with spaces in all tags.',
        '3) DO NOT output character appearance, clothing, hair, or eye tags — the system appends them automatically.',
        '4) DO NOT output any {{appearanceTag:...}} variables or references.',
        '5) DO include character count tags: 1girl, 1boy, 2girls, 3boys, multiple boys, multiple girls, solo, etc.',
        '6) Include scene/environment tags: cafe, outdoor, indoor, classroom, bedroom, park, street, etc.',
        '7) Include pose/action tags: selfie, standing, sitting, looking at viewer, v sign, peace sign, etc.',
        '8) Include mood/lighting/framing tags: warm lighting, natural lighting, upper body, close-up, full body, etc.',
        '9) Count characters from the known list when they are mentioned or implied in the description.',
        '10) The entire output MUST be in English. No Korean or other languages.',
        '',
        'EXAMPLE:',
        '* Input: "Alice and Bob go to cafe"',
        '* Known characters: Alice (girl), Bob (boy)',
        '* Output: 1girl, 1boy, cafe, sitting, table, indoor, warm lighting, upper body',
        '',
        'Known characters:',
        charList,
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

function getPromptTemplateSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'];
    return {
        imageApiFullPromptTemplate: String(ext?.imageApiFullPromptTemplate || '').trim(),
        tagGenerationFullPromptTemplate: String(ext?.tagGenerationFullPromptTemplate || '').trim(),
    };
}

function applyTagGenerationPromptTemplate(basePrompt, rawPrompt) {
    const prompt = `${basePrompt}\n${rawPrompt}`;
    const { tagGenerationFullPromptTemplate: template } = getPromptTemplateSettings();
    if (!template) return prompt;
    const hasPlaceholder = /\{(?:basePrompt|rawPrompt|prompt)\}/.test(template);
    const rendered = template
        .replace(/\{basePrompt\}/g, basePrompt)
        .replace(/\{rawPrompt\}/g, rawPrompt)
        .replace(/\{prompt\}/g, prompt)
        .trim();
    if (!rendered) return prompt;
    if (!hasPlaceholder) return `${rendered}\n${prompt}`.trim();
    return rendered;
}

function applyImageApiPromptTemplate(finalPrompt, sceneTags, appearancePart) {
    const { imageApiFullPromptTemplate: template } = getPromptTemplateSettings();
    if (!template) return finalPrompt;
    const hasPlaceholder = /\{(?:finalPrompt|sceneTags|appearanceTags)\}/.test(template);
    const rendered = template
        .replace(/\{finalPrompt\}/g, finalPrompt)
        .replace(/\{sceneTags\}/g, sceneTags)
        .replace(/\{appearanceTags\}/g, appearancePart)
        .trim();
    if (!rendered) return finalPrompt;
    if (!hasPlaceholder) return `${rendered}\n${finalPrompt}`.trim();
    return rendered;
}

/**
 * Uses AI to convert a raw prompt (possibly Korean) into English Danbooru-style tags.
 * Returns empty string on failure.
 * @param {string} rawPrompt - The raw image prompt (possibly Korean)
 * @param {Object} [options] - Optional parameters
 * @param {Array<{name: string, description?: string, appearanceTags?: string}>} [options.characters] - Known characters for context-aware generation
 * @param {{ [name: string]: string }} [options.appearanceVarMap] - Appearance tag variable map for reference
 * @returns {Promise<string>} English Danbooru tags, comma-separated
 */
export async function generateDanbooruTags(rawPrompt, options) {
    if (!rawPrompt || typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
        return '';
    }

    const trimmed = rawPrompt.trim();
    const characters = Array.isArray(options?.characters) ? options.characters : [];
    const appearanceVarMap = options?.appearanceVarMap || {};

    // Already looks like tag-style English input — keep as-is to avoid unnecessary AI rewriting
    const looksLikeTagList = /,|\|/.test(trimmed);
    if (!containsKorean(trimmed) && (looksLikeTagList || characters.length === 0)) {
        return sanitizeTags(trimmed);
    }

    const context = getContext();
    if (!context) {
        console.warn('[image-tag-generator] SillyTavern context unavailable; cannot convert tags.');
        return '';
    }

    // Use character-aware prompt when characters are provided
    const promptBase = characters.length > 0
        ? buildCharacterAwarePrompt(characters, appearanceVarMap)
        : TAG_CONVERSION_PROMPT;

    const fullPrompt = applyTagGenerationPromptTemplate(promptBase, trimmed);

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
    const appearancePart = appearanceGroups.join(' | ');
    const defaultPrompt = !cleanDanbooru
        ? appearancePart
        : (appearanceGroups.length === 0 ? cleanDanbooru : `${cleanDanbooru} | ${appearancePart}`);
    return applyImageApiPromptTemplate(defaultPrompt, cleanDanbooru, appearancePart);
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
 * Final output can be wrapped by optional user-defined template.
 *
 * @param {string} rawPrompt - Raw image description / prompt
 * @param {Object} options
 * @param {string[]} [options.includeNames] - Force-include these character names
 * @param {Array<{name: string, displayName?: string, description?: string, appearanceTags?: string}>} [options.contacts] - All available contacts
 * @param {(name: string) => string} [options.getAppearanceTagsByName] - Lookup function for appearance tags
 * @param {{ [name: string]: string }} [options.appearanceVarMap] - Pre-built appearance tag variable map
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

    // Build appearance variable map from all contacts for the prompt
    const appearanceVarMap = options.appearanceVarMap || {};
    if (Object.keys(appearanceVarMap).length === 0) {
        for (const contact of allContacts) {
            const name = String(contact?.name || '').trim();
            if (!name) continue;
            const tags = String(getAppearanceFn(name) || '').trim();
            if (tags) appearanceVarMap[name] = tags;
        }
        for (const name of includeNames) {
            const cleanName = String(name || '').trim();
            if (!cleanName || appearanceVarMap[cleanName]) continue;
            const tags = String(getAppearanceFn(cleanName) || '').trim();
            if (tags) appearanceVarMap[cleanName] = tags;
        }
    }

    const resolvedRawPrompt = resolveAppearanceTagRefs(rawPrompt, appearanceVarMap);

    // ── Step 1: Match mentioned characters ──
    const textLower = resolvedRawPrompt.toLowerCase();
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
        sceneTags = await generateDanbooruTags(resolvedRawPrompt, { characters: matched, appearanceVarMap });
    } catch (err) {
        console.warn('[image-tag-generator] Scene tag generation failed:', err);
    }

    if (!sceneTags) {
        return emptyResult;
    }

    // ── Step 3: Resolve appearance tag variables in the AI output ──
    // The AI may output {{appearanceTag:name}} references (possibly with trailing
    // suffixes like "'s description" or "s description") — resolve them to actual tags.
    const appearanceLookup = new Map(
        Object.entries(appearanceVarMap)
            .map(([name, tags]) => [(name || '').trim().toLowerCase(), (tags || '').trim()])
            .filter(([name, tags]) => name && tags),
    );
    const resolvedSceneTags = resolveAppearanceTagRefs(sceneTags, Object.fromEntries(appearanceLookup));

    // If AI output contains pipe-separated sections with resolved appearance tags,
    // split them out into appearance groups
    const pipeParts = resolvedSceneTags.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
    let finalSceneTags = pipeParts[0] || resolvedSceneTags;
    const aiAppearanceGroups = pipeParts.length > 1 ? pipeParts.slice(1) : [];

    // ── Step 4: Collect appearance tag groups ──
    // Merge AI-extracted groups with matched character tags (deduplicate)
    const seenAppearance = new Set(aiAppearanceGroups.map(g => g.toLowerCase()));
    const extraGroups = matched
        .map(c => c.appearanceTags)
        .filter(Boolean)
        .filter(g => !seenAppearance.has(g.toLowerCase()));
    const appearanceGroups = [...aiAppearanceGroups, ...extraGroups];

    // ── Step 5: Build final prompt ──
    const finalPrompt = buildImageApiPrompt(finalSceneTags, appearanceGroups);

    return { sceneTags: finalSceneTags, appearanceGroups, finalPrompt };
}

// ── internal helpers ──

/**
 * Sanitize AI output: strip non-tag noise, reject if Korean remains.
 * Preserves pipe-separated sections (scene | appearance1 | appearance2 format).
 * @param {string} raw
 * @returns {string}
 */
function sanitizeTags(raw) {
    if (!raw || typeof raw !== 'string') return '';

    // Remove common AI preamble / markdown fences
    let cleaned = raw
        .replace(/```[^`]*```/gs, '')
        .replace(/^[^a-zA-Z0-9_(|]*/, '') // ✅ fix: 파이프 문자를 허용 문자에 포함
        .trim();

    // Reject if Korean characters leaked through
    if (containsKorean(cleaned)) {
        console.warn('[image-tag-generator] AI output still contains Korean; discarding.');
        return '';
    }

    // ✅ fix: 파이프 섹션을 분리한 뒤 각 섹션 내부 태그만 정리 → 파이프 구조 보존
    const sections = cleaned.split(/\s*\|\s*/);
    const sanitizedSections = sections
        .map(section =>
            section
                .split(',')
                .map(t => t.replace(/_/g, ' ').trim().replace(/\s+/g, ' '))
                .filter(Boolean)
                .join(', ')
        )
        .filter(Boolean);

    return sanitizedSections.join(' | ');
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

function resolveAppearanceTagRefs(text, appearanceVarMap = {}) {
    const source = String(text || '');
    if (!source) return '';
    const lookup = new Map(
        Object.entries(appearanceVarMap || {})
            .map(([name, tags]) => [(name || '').trim().toLowerCase(), (tags || '').trim()])
            .filter(([name, tags]) => name && tags),
    );
    const appearanceTagRefRegex = /\{\{appearanceTag:\s*([^}]+?)\s*\}\}(?:\s*['‘’]?s\s+description)?/gi;
    return source.replace(appearanceTagRefRegex, (match, rawName) => {
        const key = (rawName || '').trim().toLowerCase();
        return lookup.get(key) || '';
    });
}
