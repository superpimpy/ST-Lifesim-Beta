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
        // 아바타 프레임 크기는 사용 지점의 기본값을 고정으로 따르고,
        // 저장값은 크롭(확대/위치) 정보만 유지한다. 이전 width/height 값은 무시한다.
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
    if (!file) return Promise.resolve('');
    if (!String(file.type || '').startsWith('image/')) {
        return Promise.reject(new Error('이미지 파일만 업로드할 수 있습니다.'));
    }
    return compressImageFileToDataUrl(file).catch(() => readFileAsDataUrl(file));
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
        reader.readAsDataURL(file);
    });
}

/**
 * 로컬 업로드 이미지를 저장용 data URL로 압축/리사이즈한다.
 * 애니메이션 GIF/SVG는 원본을 유지하고, 일반 이미지 파일은 최대 512px 정사각 박스 안으로 축소한 뒤
 * WebP(quality 0.82)로 재인코딩하여 localStorage에 저장되는 문자열 길이를 줄인다.
 * @param {File} file
 * @returns {Promise<string>}
 */
function compressImageFileToDataUrl(file) {
    const mimeType = String(file.type || '').toLowerCase();
    const shouldKeepOriginal = mimeType === 'image/gif' || mimeType === 'image/svg+xml';
    if (shouldKeepOriginal) return readFileAsDataUrl(file);

    const outputType = 'image/webp';
    const maxDimension = 512;
    const quality = 0.82;

    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        const cleanup = () => URL.revokeObjectURL(objectUrl);

        image.onload = () => {
            try {
                const longestSide = Math.max(image.naturalWidth || image.width || 0, image.naturalHeight || image.height || 0);
                const scale = longestSide > maxDimension ? (maxDimension / longestSide) : 1;
                const width = Math.max(1, Math.round((image.naturalWidth || image.width || 1) * scale));
                const height = Math.max(1, Math.round((image.naturalHeight || image.height || 1) * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    cleanup();
                    reject(new Error('이미지 캔버스를 초기화하지 못했습니다.'));
                    return;
                }
                ctx.drawImage(image, 0, 0, width, height);
                const dataUrl = canvas.toDataURL(outputType, quality);
                cleanup();
                resolve(dataUrl);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        image.onerror = () => {
            cleanup();
            reject(new Error('이미지 파일을 읽지 못했습니다.'));
        };
        image.src = objectUrl;
    });
}
