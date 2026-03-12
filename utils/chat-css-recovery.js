import { getContext } from './st-context.js';

const pendingMessageIndexes = new Set();
let flushScheduled = false;

function forceCssReflowForMessage(messageIndex) {
    if (!Number.isFinite(messageIndex) || messageIndex < 0) return;
    const selectors = [
        `.mes[mesid="${messageIndex}"] .mes_text`,
        `div.mes[mesid="${messageIndex}"] .mes_text`,
        `#chat .mes[mesid="${messageIndex}"] .mes_text`,
    ];
    const mesTextEl = selectors
        .map(selector => document.querySelector(selector))
        .find(Boolean);
    if (!mesTextEl) return;
    mesTextEl.dataset.slmCssRecover = String(Date.now());
    void mesTextEl.offsetHeight;
    delete mesTextEl.dataset.slmCssRecover;
}

async function flushChatCssRecovery() {
    flushScheduled = false;
    const indexes = [...pendingMessageIndexes];
    pendingMessageIndexes.clear();

    indexes.forEach(forceCssReflowForMessage);

    const ctx = getContext();
    const evSrc = ctx?.eventSource;
    const eventTypes = ctx?.eventTypes || ctx?.event_types;
    if (!evSrc?.emit || !eventTypes?.CHARACTER_MESSAGE_RENDERED) return;
    for (const messageIndex of indexes) {
        if (!Number.isFinite(messageIndex) || messageIndex < 0) continue;
        try {
            await evSrc.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageIndex);
        } catch (err) {
            console.warn('[ST-LifeSim] CSS 복구 렌더 이벤트 재발행 실패:', err);
        }
    }
}

export function scheduleChatCssRecovery(messageIndex) {
    if (!Number.isFinite(messageIndex) || messageIndex < 0) return;
    pendingMessageIndexes.add(messageIndex);
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
        void flushChatCssRecovery();
    }, 0);
}
