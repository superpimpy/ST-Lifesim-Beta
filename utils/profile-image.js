const DEFAULT_OBJECT_FIT = 'cover';
const ALLOWED_OBJECT_FIT = new Set(['cover', 'contain', 'fill', 'scale-down']);

function clampDimension(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(16, Math.min(256, parsed));
}

export function normalizeProfileImageStyle(rawStyle, defaults = {}) {
    const fallbackWidth = clampDimension(defaults.width, 40);
    const fallbackHeight = clampDimension(defaults.height, fallbackWidth);
    const objectFit = String(rawStyle?.objectFit || defaults.objectFit || DEFAULT_OBJECT_FIT).trim().toLowerCase();
    return {
        width: clampDimension(rawStyle?.width, fallbackWidth),
        height: clampDimension(rawStyle?.height, fallbackHeight),
        objectFit: ALLOWED_OBJECT_FIT.has(objectFit) ? objectFit : DEFAULT_OBJECT_FIT,
    };
}

export function applyProfileImageStyle(frameEl, imageEl, rawStyle, defaults = {}) {
    const style = normalizeProfileImageStyle(rawStyle, defaults);
    if (frameEl?.style) {
        frameEl.style.width = `${style.width}px`;
        frameEl.style.height = `${style.height}px`;
    }
    if (imageEl?.style) {
        imageEl.style.objectFit = style.objectFit;
    }
    return style;
}

export function readImageFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) {
            resolve('');
            return;
        }
        if (!String(file.type || '').startsWith('image/')) {
            reject(new Error('이미지 파일만 업로드할 수 있습니다.'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
        reader.readAsDataURL(file);
    });
}
