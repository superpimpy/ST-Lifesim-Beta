import { getContext } from './st-context.js';

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

function inferModelSettingKey(source) {
    return MODEL_KEY_BY_SOURCE[String(source || '').toLowerCase()] || '';
}

export async function generateBackendText({
    ctx = null,
    prompt = '',
    quietName = '',
    route = null,
}) {
    const context = ctx || getContext();
    const quietPrompt = String(prompt || '').trim();
    if (!context || !quietPrompt) return '';

    if (typeof context.generateRaw === 'function') {
        const aiRoute = route || {};
        const chatSettings = context.chatCompletionSettings;
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
            const generated = await context.generateRaw({
                prompt: quietPrompt,
                quietToLoud: false,
                trimNames: true,
                api: aiRoute.api || null,
            });
            if (generated) return String(generated).trim();
        } catch (error) {
            console.warn('[ST-LifeSim] generateRaw 백엔드 생성 실패, generateQuietPrompt로 폴백:', error);
        } finally {
            if (chatSettings && aiRoute.chatSource) {
                chatSettings.chat_completion_source = sourceBefore;
            }
            if (chatSettings && modelKey && typeof aiRoute.model === 'string' && aiRoute.model.length > 0) {
                chatSettings[modelKey] = modelBefore;
            }
        }
    }

    if (typeof context.generateQuietPrompt === 'function') {
        try {
            const generated = await context.generateQuietPrompt({
                quietPrompt,
                quietName: quietName || context.name2 || '{{char}}',
            });
            if (generated) return String(generated).trim();
        } catch (error) {
            console.warn('[ST-LifeSim] generateQuietPrompt 백엔드 생성 실패:', error);
        }
    }

    return '';
}
