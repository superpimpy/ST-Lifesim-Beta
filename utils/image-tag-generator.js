/**
 * image-tag-generator.js
 *
 * Korean/raw image prompts를 영어 Danbooru 형식 태그로 변환하는 유틸리티
 *
 * 요구사항:
 *  - 한국어 원문은 절대 Image API에 직접 전달 금지
 *  - 태그 생성 단계가 반드시 선행
 *  - 태그는 영어 Danbooru 형식
 *  - 모든 이미지 생성 경로(메신저/SNS/유저)가 동일한 파이프라인을 사용
 *  - 최종 프롬프트 형식: scene tags, [name1 - appearance1], [name2 - appearance2], ...
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
    'Do NOT fabricate or guess character appearance details (hair color, eye color, clothing, etc.).',
    'Always include at least one framing tag (upper body, full body, close-up, portrait) and one setting tag (indoor, outdoor, etc.).',
    'Example output: 1girl, selfie, looking at viewer, phone in hand, casual smile, indoor, upper body',
    '',
    'Description:',
].join('\n');

/**
 * Build the tag generation prompt that includes character context.
 * The AI is instructed to output ONLY scene/situation tags;
 * character appearance tags are appended programmatically by the caller.
 * Profile descriptions are NOT sent — only appearance tags are provided as reference.
 *
 * @param {Array<{name: string, appearanceTags?: string}>} characters
 * @param {{ [name: string]: string }} [appearanceVarMap] - (unused, kept for API compat)
 * @returns {string}
 */
function buildCharacterAwarePrompt(characters, appearanceVarMap) {
    const charList = characters.length > 0
        ? characters.map(c => `  - ${c.name}`).join('\n')
        : '  (none)';

    // Provide character appearance as READ-ONLY reference so the AI can compose
    // better scene/framing tags (e.g. close-up for selfie, full body for outfit post).
    // The AI MUST NOT reproduce these tags in its output.
    const charAppearanceRef = characters
        .filter(c => c.appearanceTags)
        .map(c => `  - ${c.name}: ${c.appearanceTags}`)
        .join('\n');
    const appearanceRefBlock = charAppearanceRef
        ? `\nCharacter appearance (READ-ONLY reference — do NOT output any of these tags, the system appends them automatically):\n${charAppearanceRef}\n`
        : '';

    return [
        'You are a Danbooru-style tag generator for image creation.',
        '',
        'Given an image description and a list of known characters, generate ONLY scene/situation/composition tags.',
        'Character appearance tags (hair, eyes, clothing, body features) are handled automatically by the system — do NOT include them in your output.',
        'The system will automatically append each character\'s full appearance description after your tags in the format: [CharName - appearance tags]',
        'Final prompt format (built by the system): <your scene tags>, [CharName - appearance], [CharName2 - appearance]',
        '',
        'RULES:',
        '1) Output ONLY comma-separated Danbooru-style tags. No sentences, no Korean, no explanation.',
        '2) Replace underscores with spaces in all tags.',
        '3) NEVER output character appearance, clothing, hair color, eye color, or body feature tags — the system appends them automatically. Do NOT fabricate or guess any character appearance details.',
        '4) DO NOT output any {{appearanceTag:...}} variables or references.',
        '5) DO NOT use the pipe character "|" or square brackets "[" "]" in your output. The system uses these as separators.',
        '6) DO include character count tags: 1girl, 1boy, 2girls, 3boys, multiple boys, multiple girls, solo, etc.',
        '7) Include scene/environment tags: cafe, outdoor, indoor, classroom, bedroom, park, street, etc.',
        '8) Include pose/action tags: selfie, standing, sitting, looking at viewer, v sign, peace sign, holding phone, etc.',
        '9) Include mood/lighting/framing tags: warm lighting, natural lighting, upper body, close-up, full body, photo (medium), portrait, etc.',
        '10) Count characters from the known list when they are mentioned or implied in the description.',
        '11) The entire output MUST be in English. No Korean or other languages.',
        '12) Even if the description is vague (e.g. just a social media post text), infer a plausible visual scene and generate appropriate scene/composition tags.',
        '13) Always include at least one framing tag (upper body, full body, close-up, portrait, etc.) and one setting tag (indoor, outdoor, etc.).',
        '',
        'EXAMPLE:',
        '* Input: "Alice and Bob go to cafe"',
        '* Known characters: Alice (girl), Bob (boy)',
        '* Output: 1girl, 1boy, cafe, sitting, table, indoor, warm lighting, upper body',
        '  (system then appends: , [Alice - <appearance>], [Bob - <appearance>])',
        '',
        'Known characters:',
        charList,
        appearanceRefBlock,
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
 *
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
    const looksLikeTagList = /,|\[/.test(trimmed);
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
 * Format: scene tags, weight::(name1 - appearance1)::, weight::(name2 - appearance2)::, ...
 *
 * @param {string} danbooruTags - Generated English Danbooru tags
 * @param {string|string[]} appearanceTags - Character appearance groups (already formatted as "name - tags")
 * @param {Object} [options]
 * @param {number} [options.tagWeight] - Weight multiplier for appearance tags (e.g. 5 → "5::(tags)::")
 * @returns {string} Final prompt for Image API
 */
export function buildImageApiPrompt(danbooruTags, appearanceTags, options) {
    const cleanDanbooru = safeTags(danbooruTags);
    const tagWeight = Number(options?.tagWeight) || 0;

    const appearanceGroups = Array.isArray(appearanceTags)
        ? appearanceTags.map(safeTags).filter(Boolean)
        : [safeTags(appearanceTags)].filter(Boolean);

    // Wrap each appearance group with weight syntax if tagWeight > 0
    const wrappedAppearance = appearanceGroups.map(a =>
        tagWeight > 0 ? `${tagWeight}::(${a})::` : `[${a}]`,
    );

    if (!cleanDanbooru && wrappedAppearance.length === 0) return '';
    if (!cleanDanbooru) return wrappedAppearance.join(', ');
    if (wrappedAppearance.length === 0) return cleanDanbooru;

    return `${cleanDanbooru}, ${wrappedAppearance.join(', ')}`;
}


/**
 * Unified image tag generation pipeline.
 * All image generation paths (message, SNS, user) MUST use this function.
 *
 * Pipeline:
 *  1. Load all contacts (names, descriptions, appearance tags)
 *  2. Match characters mentioned in the input prompt (name/displayName/subName)
 *  3. Generate scene/situation Danbooru tags via AI (with character context)
 *  4. Combine: scene tags, weight::(name1 - appearance1)::, weight::(name2 - appearance2)::
 *
 * Only characters whose names (including subName) are detected in the input/context
 * will have their appearance tags included. Characters not mentioned are excluded.
 *
 * Final output can be wrapped by optional user-defined template.
 *
 * @param {string} rawPrompt - Raw image description / prompt
 * @param {Object} options
 * @param {string[]} [options.includeNames] - Hint names to check for mention (still requires detection in prompt)
 * @param {Array<{name: string, displayName?: string, subName?: string, description?: string, appearanceTags?: string}>} [options.contacts] - All available contacts
 * @param {(name: string) => string} [options.getAppearanceTagsByName] - Lookup function for appearance tags
 * @param {{ [name: string]: string }} [options.appearanceVarMap] - Pre-built appearance tag variable map
 * @param {number} [options.tagWeight] - Weight multiplier for appearance tags (e.g. 5 → "5::(tags)::")
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
    const tagWeight = Number(options.tagWeight) || 0;

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
    // Only include characters whose name, displayName, or subName is detected in the input.
    // includeNames are also checked for mention — they are NOT blindly force-included.
    const textLower = resolvedRawPrompt.toLowerCase();
    const matched = [];
    const matchedNamesLower = new Set();

    /** Check if a name is mentioned in the prompt text */
    function isNameMentioned(name) {
        if (!name) return false;
        const norm = name.toLowerCase();
        if (/^[a-z0-9_]+$/i.test(norm)) {
            const re = new RegExp(`(^|[^a-z0-9_])${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
            return re.test(textLower);
        }
        return textLower.includes(norm);
    }

    // Check includeNames — only include if actually mentioned in prompt
    for (const name of includeNames) {
        if (!name) continue;
        const normalized = String(name).trim().toLowerCase();
        if (matchedNamesLower.has(normalized)) continue;
        const contact = allContacts.find(c =>
            String(c.name || '').trim().toLowerCase() === normalized
            || String(c.displayName || '').trim().toLowerCase() === normalized
            || String(c.subName || '').trim().toLowerCase() === normalized
        );
        // Check if any of the contact's names (name, displayName, subName) are mentioned
        const namesToCheck = contact
            ? [contact.name, contact.displayName, contact.subName, name].map(v => String(v || '').trim()).filter(Boolean)
            : [String(name).trim()];
        const mentioned = namesToCheck.some(n => isNameMentioned(n));
        if (!mentioned) continue;
        matchedNamesLower.add(normalized);
        const appearance = getAppearanceFn(name);
        matched.push({
            name: String(name).trim(),
            appearanceTags: String(appearance || '').trim(),
        });
    }

    // Scan all contacts for names mentioned in the prompt
    for (const contact of allContacts) {
        const names = [contact?.name, contact?.displayName, contact?.subName]
            .map(v => String(v || '').trim())
            .filter(Boolean);
        if (names.some(n => matchedNamesLower.has(n.toLowerCase()))) continue;
        const mentioned = names.some(n => isNameMentioned(n));
        if (mentioned) {
            const contactName = String(contact?.name || contact?.displayName || '').trim();
            matchedNamesLower.add(contactName.toLowerCase());
            matched.push({
                name: contactName,
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

    // ── Step 2b: If scene tag generation failed, collect appearance tags as fallback ──
    if (!sceneTags) {
        const fallbackAppearance = matched
            .map(c => {
                const name = String(c?.name || '').trim();
                const tags = String(c?.appearanceTags || '').trim();
                if (!name || !tags) return '';
                return `${name} - ${tags}`;
            })
            .filter(Boolean);
        if (fallbackAppearance.length > 0) {
            const fallbackPrompt = buildImageApiPrompt('', fallbackAppearance, { tagWeight });
            return { sceneTags: '', appearanceGroups: fallbackAppearance, finalPrompt: fallbackPrompt };
        }
        return emptyResult;
    }

    // AI가 실수로 파이프나 대괄호를 출력할 경우 대비: 파이프/대괄호를 제거하고 장면 태그만 추출
    const cleanedSceneTags = sceneTags
        .replace(/\|/g, ',')               // 파이프를 쉼표로 변환
        .replace(/\[.*?\]/g, '')           // 혹시 AI가 출력한 [] 블록 제거
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .join(', ');

    // ── Step 3: Collect appearance tag groups from ALL matched characters ──
    // Format: "name - tags"  (buildImageApiPrompt will wrap these in [])
    const appearanceGroups = matched
        .map(c => {
            const name = String(c?.name || '').trim();
            const tags = String(c?.appearanceTags || '').trim();
            if (!name || !tags) return '';
            return `${name} - ${tags}`;
        })
        .filter(Boolean);

    // ── Step 4: Build final prompt ──
    // Result: "scene tags, weight::(name1 - appearance1)::, weight::(name2 - appearance2)::"
    const finalPrompt = buildImageApiPrompt(cleanedSceneTags, appearanceGroups, { tagWeight });

    return { sceneTags: cleanedSceneTags, appearanceGroups, finalPrompt };
}


// ── internal helpers ──

/**
 * Sanitize AI output: strip non-tag noise, reject if Korean remains.
 * Strips pipe characters and bracket content that the AI should not have produced.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeTags(raw) {
    if (!raw || typeof raw !== 'string') return '';

    // Remove common AI preamble / markdown fences
    let cleaned = raw
        .replace(/```[^`]*```/gs, '')
        .replace(/\[.*?\]/g, '')           // AI가 실수로 [] 출력한 경우 제거
        .replace(/\|/g, ',')               // 파이프를 쉼표로 변환
        .replace(/^[^a-zA-Z0-9_(]*/, '')
        .trim();

    // Reject if Korean characters leaked through
    if (containsKorean(cleaned)) {
        console.warn('[image-tag-generator] AI output still contains Korean; discarding.');
        return '';
    }

    // 태그 정리: 쉼표로 분리 → 각 태그 언더스코어→공백, 공백 정규화
    return cleaned
        .split(',')
        .map(t => t.replace(/_/g, ' ').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join(', ');
}


/**
 * Return trimmed tag string only if it is non-empty and Korean-free.
 * Appearance tags are expected to be English (e.g. "long hair, school uniform").
 * If Korean is found, it's discarded to enforce the no-Korean-to-Image-API rule.
 *
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
    const appearanceTagRefRegex = /{{appearanceTag:\s*([^}]+?)\s*}}(?:\s*[''']?s\s+description)?/gi;
    return source.replace(appearanceTagRefRegex, (match, rawName) => {
        const key = (rawName || '').trim().toLowerCase();
        return lookup.get(key) || '';
    });
                                                                        }
