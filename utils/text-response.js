export function isHtmlTextResponse(text, contentType = '') {
    const normalizedType = String(contentType || '').toLowerCase();
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return false;
    if (normalizedType.includes('text/html')) return true;
    return /^<(?:!doctype|html|head|body|h1|p|div|span|title)\b/i.test(normalizedText);
}
