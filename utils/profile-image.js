function clampDimension(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(16, Math.min(256, parsed));
}

function clampPercent(value, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, parsed));
}

function clampScale(value, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(100, Math.min(250, parsed));
}

export function normalizeProfileImageStyle(rawStyle, defaults = {}) {
    const fallbackWidth = clampDimension(defaults.width, 40);
    const fallbackHeight = clampDimension(defaults.height, fallbackWidth);
    return {
        width: fallbackWidth,
        height: fallbackHeight,
        positionX: clampPercent(rawStyle?.positionX, clampPercent(defaults.positionX, 50)),
        positionY: clampPercent(rawStyle?.positionY, clampPercent(defaults.positionY, 50)),
        scale: clampScale(rawStyle?.scale, clampScale(defaults.scale, 100)),
    };
}

export function applyProfileImageStyle(frameEl, imageEl, rawStyle, defaults = {}) {
    const style = normalizeProfileImageStyle(rawStyle, defaults);
    if (frameEl?.style) {
        frameEl.style.width = `${style.width}px`;
        frameEl.style.height = `${style.height}px`;
    }
    if (imageEl?.style) {
        imageEl.style.width = '100%';
        imageEl.style.height = '100%';
        imageEl.style.display = 'block';
        imageEl.style.objectFit = 'cover';
        imageEl.style.objectPosition = `${style.positionX}% ${style.positionY}%`;
        imageEl.style.transform = `scale(${style.scale / 100})`;
        imageEl.style.transformOrigin = `${style.positionX}% ${style.positionY}%`;
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
