/**
 * emoticon.js
 * 이모티콘 모듈 - URL 기반 이모티콘 관리 및 전송
 * - 이모티콘 추가/편집/삭제
 * - 카테고리 탭 분류 + 검색 + 즐겨찾기
 * - 클릭 시 /send ![이름](URL) 전송
 * - 출력 크기: 설정에서 지정한 px (scale 방식)
 * - AI 공용 이모티콘은 컨텍스트에 주입
 */

import { slashSend } from '../../utils/slash.js';
import { loadData, saveData, getDefaultBinding, getExtensionSettings } from '../../utils/storage.js';
import { registerContextBuilder } from '../../utils/context-inject.js';
import { showToast, generateId, escapeHtml } from '../../utils/ui.js';
import { createPopup } from '../../utils/popup.js';
import { isCallActive } from '../call/call.js';
import { getContext } from '../../utils/st-context.js';

const GLOBAL_BINDING = 'global';

/**
 * 이모티콘 출력 크기를 가져온다 (extension_settings에서)
 * @returns {number}
 */
function getEmoticonSize() {
    const ext = getExtensionSettings();
    return ext?.['st-lifesim']?.emoticonSize || 80;
}

/**
 * 이모티콘 border-radius를 가져온다 (extension_settings에서)
 * @returns {number}
 */
function getEmoticonRadius() {
    const ext = getExtensionSettings();
    return ext?.['st-lifesim']?.emoticonRadius ?? 10;
}

const MODULE_KEY = 'emoticons';
const CATEGORY_AI_KEY = 'emoticon-category-ai';
const CHAR_CATEGORY_AI_KEY = 'emoticon-char-category-ai';
const CATEGORY_VISIBILITY_KEY = 'emoticon-category-visibility';

/**
 * @typedef {Object} Emoticon
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} category
 * @property {boolean} favorite
 * @property {boolean} aiUsable - AI도 사용 가능한지 여부
 */

/**
 * 저장된 이모티콘 목록을 불러온다
 * @returns {Emoticon[]}
 */
function loadEmoticons() {
    const globalEmoticons = loadData(MODULE_KEY, null, GLOBAL_BINDING);
    if (Array.isArray(globalEmoticons)) {
        return globalEmoticons;
    }
    const legacy = loadData(MODULE_KEY, [], getDefaultBinding());
    if (legacy.length > 0) {
        saveData(MODULE_KEY, legacy, GLOBAL_BINDING);
    }
    return legacy;
}

/**
 * 이모티콘 목록을 저장한다
 * @param {Emoticon[]} emoticons
 */
function saveEmoticons(emoticons) {
    saveData(MODULE_KEY, emoticons, GLOBAL_BINDING);
}

function loadCategoryAiMap() {
    const globalMap = loadData(CATEGORY_AI_KEY, null, GLOBAL_BINDING);
    if (globalMap && typeof globalMap === 'object') {
        return globalMap;
    }
    const legacy = loadData(CATEGORY_AI_KEY, {}, getDefaultBinding());
    if (Object.keys(legacy).length > 0) {
        saveData(CATEGORY_AI_KEY, legacy, GLOBAL_BINDING);
    }
    return legacy;
}

function saveCategoryAiMap(map) {
    saveData(CATEGORY_AI_KEY, map, GLOBAL_BINDING);
}

/**
 * 현재 캐릭터의 카테고리별 이모티콘 허용 맵을 불러온다 (character 바인딩 → 채팅을 새로 파도 유지)
 * 기본값: {} (모두 허용 안 함)
 * @returns {{ [category: string]: boolean }}
 */
function loadCharCategoryAiMap() {
    return loadData(CHAR_CATEGORY_AI_KEY, {}, 'character');
}

/**
 * 현재 캐릭터의 카테고리별 이모티콘 허용 맵을 저장한다
 * @param {{ [category: string]: boolean }} map
 */
function saveCharCategoryAiMap(map) {
    saveData(CHAR_CATEGORY_AI_KEY, map, 'character');
}

function getCurrentCharName() {
    const ctx = getContext();
    return ctx?.name2 || '';
}

function loadCategoryVisibilityMap() {
    return loadData(CATEGORY_VISIBILITY_KEY, {}, GLOBAL_BINDING);
}

function saveCategoryVisibilityMap(map) {
    saveData(CATEGORY_VISIBILITY_KEY, map, GLOBAL_BINDING);
}

function isAiUsableByPolicy(emoticon, categoryAiMap, charCategoryAiMap) {
    if (emoticon.aiOverrideAllow) return true;
    // Per-character category setting takes priority (default: not allowed)
    if (charCategoryAiMap && emoticon.category in charCategoryAiMap) {
        return charCategoryAiMap[emoticon.category] && emoticon.aiUsable !== false;
    }
    // If no per-character setting exists, default to not allowed
    if (charCategoryAiMap) return false;
    // Legacy global fallback
    if (categoryAiMap?.[emoticon.category] === false) return false;
    return emoticon.aiUsable !== false;
}

/**
 * 이모티콘 모듈을 초기화한다
 */
export function initEmoticon() {
    // 컨텍스트 빌더 등록: AI 사용 가능 이모티콘 목록 주입
    registerContextBuilder('emoticon', () => {
        // 통화 중에는 이모티콘 컨텍스트 주입 안 함
        if (isCallActive()) return null;

        const emoticons = loadEmoticons();
        const categoryAiMap = loadCategoryAiMap();
        const charCategoryAiMap = loadCharCategoryAiMap();
        const aiEmoticons = emoticons.filter(e => isAiUsableByPolicy(e, categoryAiMap, charCategoryAiMap));
        if (aiEmoticons.length === 0) return null;
        const size = getEmoticonSize();
        const radius = getEmoticonRadius();
        const ctx = getContext();
        const charName = (ctx?.name2 || '{{char}}').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const list = aiEmoticons.map(e => {
            // Escape values for safe HTML embedding
            const safeName = e.name.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeUrl = e.url.replace(/"/g, '&quot;');
            const label = `${charName}이(가) ${safeName} 이모티콘을 보냈습니다.`;
            return `• ${safeName}: <img src="${safeUrl}" alt="${safeName}" aria-label="${label}" style="width:${size}px;height:${size}px;object-fit:contain;display:inline-block;vertical-align:middle;border-radius:${radius}px">`;
        }).join('\n');
        return `=== Available Emoticons for AI ===\nWhen sending an emoticon, the aria-label should follow the format: "(이름)이(가) (이모티콘이름) 이모티콘을 보냈습니다."\nTo use an emoticon, copy the exact HTML tag shown below:\n${list}`;
    });
}

/**
 * 이모티콘 팝업을 연다
 */
export function openEmoticonPopup(onBack) {
    if (isCallActive()) {
        showToast('통화 중에는 이모티콘 기능을 사용할 수 없습니다.', 'warn');
        return;
    }
    const content = buildEmoticonContent();
    createPopup({
        id: 'emoticon',
        title: '😊 이모티콘',
        content,
        className: 'slm-emoticon-panel',
        onBack,
    });
}

/**
 * 이모티콘 팝업 내용을 빌드한다
 * @returns {HTMLElement}
 */
function buildEmoticonContent() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-emoticon-wrapper';

    // 상태: 현재 선택된 카테고리, 검색어
    let currentCategory = '전체';
    let searchQuery = '';

    // 검색창
    const searchInput = document.createElement('input');
    searchInput.className = 'slm-input slm-search';
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 이모티콘 검색...';
    searchInput.oninput = () => {
        searchQuery = searchInput.value.toLowerCase();
        renderGrid();
    };
    wrapper.appendChild(searchInput);

    // 카테고리 탭바
    const tabBar = document.createElement('div');
    tabBar.className = 'slm-emoticon-tabs';
    wrapper.appendChild(tabBar);

    const categoryAiRow = document.createElement('div');
    categoryAiRow.className = 'slm-input-row';
    categoryAiRow.style.alignItems = 'center';
    categoryAiRow.style.marginTop = '-2px';
    wrapper.appendChild(categoryAiRow);

    // 이모티콘 그리드
    const grid = document.createElement('div');
    grid.className = 'slm-emoticon-grid';
    wrapper.appendChild(grid);

    // 하단 버튼
    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const addBtn = document.createElement('button');
    addBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    addBtn.textContent = '+ 이모티콘 추가';
    addBtn.onclick = () => openAddEmoticonDialog(renderAll);

    const importBtn = document.createElement('button');
    importBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    importBtn.textContent = '📥 가져오기';
    importBtn.title = 'JSON 파일에서 이모티콘 프리셋 가져오기';
    importBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const imported = Array.isArray(data) ? data : (data.emoticons || []);
                if (!Array.isArray(imported) || imported.length === 0) {
                    showToast('유효한 이모티콘 데이터가 없습니다.', 'warn');
                    return;
                }
                const existing = loadEmoticons();
                const existingUrls = new Set(existing.map(e => e.url));
                let added = 0;
                imported.forEach(em => {
                    if (em.url && !existingUrls.has(em.url)) {
                        existing.push({
                            id: generateId(),
                            name: em.name || '이모티콘',
                            url: em.url,
                            category: em.category || '기본',
                            favorite: false,
                            aiUsable: em.aiUsable !== false,
                            aiOverrideAllow: em.aiOverrideAllow === true,
                        });
                        added++;
                    }
                });
                saveEmoticons(existing);
                renderAll();
                showToast(`이모티콘 ${added}개 가져오기 완료`, 'success');
            } catch (err) {
                showToast('가져오기 실패: ' + err.message, 'error');
            }
        };
        input.click();
    };

    const exportBtn = document.createElement('button');
    exportBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    exportBtn.textContent = '📤 내보내기';
    exportBtn.title = '이모티콘 프리셋을 JSON 파일로 저장 (카테고리 선택 가능)';
    exportBtn.onclick = () => {
        try {
            const emoticons = loadEmoticons();
            if (emoticons.length === 0) {
                showToast('내보낼 이모티콘이 없습니다.', 'warn');
                return;
            }
            // 카테고리 목록 생성
            const categories = ['전체', ...new Set(emoticons.map(e => e.category).filter(Boolean))];

            // 카테고리 선택 다이얼로그
            const dlgWrapper = document.createElement('div');
            dlgWrapper.className = 'slm-form';
            const dlgLabel = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '내보낼 카테고리 선택:' });
            const catSelect = document.createElement('select');
            catSelect.className = 'slm-select';
            categories.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.textContent = cat;
                catSelect.appendChild(opt);
            });
            dlgWrapper.appendChild(dlgLabel);
            dlgWrapper.appendChild(catSelect);

            const dlgFooter = document.createElement('div');
            dlgFooter.className = 'slm-panel-footer';
            const dlgCancelBtn = document.createElement('button');
            dlgCancelBtn.className = 'slm-btn slm-btn-secondary';
            dlgCancelBtn.textContent = '취소';
            const dlgExportBtn = document.createElement('button');
            dlgExportBtn.className = 'slm-btn slm-btn-primary';
            dlgExportBtn.textContent = '내보내기';
            dlgFooter.appendChild(dlgCancelBtn);
            dlgFooter.appendChild(dlgExportBtn);

            const { close: dlgClose } = createPopup({
                id: 'emoticon-export',
                title: '📤 카테고리별 내보내기',
                content: dlgWrapper,
                footer: dlgFooter,
                className: 'slm-sub-panel',
            });

            dlgCancelBtn.onclick = () => dlgClose();
            dlgExportBtn.onclick = () => {
                const selectedCat = catSelect.value;
                const filtered = selectedCat === '전체' ? emoticons : emoticons.filter(e => e.category === selectedCat);
                if (filtered.length === 0) {
                    showToast('해당 카테고리에 이모티콘이 없습니다.', 'warn');
                    return;
                }
                const data = { emoticons: filtered };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const catSlug = selectedCat === '전체' ? 'all' : selectedCat.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_');
                a.download = `emoticon-preset-${catSlug}-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                dlgClose();
                showToast(`이모티콘 ${filtered.length}개 내보내기 완료`, 'success');
            };
        } catch (err) {
            showToast('내보내기 실패: ' + err.message, 'error');
        }
    };

    footer.appendChild(addBtn);
    footer.appendChild(importBtn);
    footer.appendChild(exportBtn);

    const bulkBtn = document.createElement('button');
    bulkBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    bulkBtn.textContent = '📋 일괄 등록';
    bulkBtn.title = '여러 URL을 한 번에 등록합니다 (한 줄에 하나씩 또는 "이름|URL" 형식)';
    bulkBtn.onclick = () => openBulkAddDialog(renderAll);
    footer.appendChild(bulkBtn);

    wrapper.appendChild(footer);

    // 전체 렌더링
    function renderAll() {
        renderTabs();
        renderCategoryAiControl();
        renderGrid();
    }

    function renderCategoryAiControl() {
        categoryAiRow.innerHTML = '';
        categoryAiRow.style.fontSize = '12px';
        const categoryVisibilityMap = loadCategoryVisibilityMap();
        const hasCurrentCategory = currentCategory !== '전체' && currentCategory !== '즐겨찾기';
        if (hasCurrentCategory) {
            const visibleLbl = document.createElement('label');
            visibleLbl.className = 'slm-toggle-label';
            visibleLbl.style.fontSize = '12px';
            const visibleChk = document.createElement('input');
            visibleChk.type = 'checkbox';
            visibleChk.checked = categoryVisibilityMap[currentCategory] !== false;
            visibleChk.onchange = () => {
                const nextMap = loadCategoryVisibilityMap();
                nextMap[currentCategory] = visibleChk.checked;
                saveCategoryVisibilityMap(nextMap);
                renderAll();
            };
            visibleLbl.appendChild(visibleChk);
            visibleLbl.appendChild(document.createTextNode(` 카테고리 표시 (${currentCategory})`));
            categoryAiRow.appendChild(visibleLbl);
        }

        if (currentCategory === '전체' || currentCategory === '즐겨찾기') return;

        // 캐릭터별 카테고리 이모티콘 허용 설정 (character 바인딩 → 채팅을 새로 파도 유지)
        const charName = getCurrentCharName();
        const charCategoryAiMap = loadCharCategoryAiMap();
        const charLbl = document.createElement('label');
        charLbl.className = 'slm-toggle-label';
        charLbl.style.fontSize = '12px';
        const charChk = document.createElement('input');
        charChk.type = 'checkbox';
        charChk.checked = charCategoryAiMap[currentCategory] === true;
        charChk.onchange = () => {
            const nextMap = loadCharCategoryAiMap();
            nextMap[currentCategory] = charChk.checked;
            saveCharCategoryAiMap(nextMap);
            renderGrid();
        };
        charLbl.appendChild(charChk);
        // 한국어 조사: 이름 끝이 받침으로 끝나면 '이', 아니면 '가'
        const lastChar = charName ? charName[charName.length - 1] : '';
        const charCode = lastChar ? lastChar.charCodeAt(0) : 0;
        const hasJongseong = charCode >= 0xAC00 && charCode <= 0xD7A3
            && (charCode - 0xAC00) % 28 !== 0;
        const particle = hasJongseong ? '이' : '가';
        charLbl.appendChild(document.createTextNode(
            ` ${charName || '캐릭터'}${particle} 이 카테고리의 이모티콘을 사용하도록 허용`
        ));
        categoryAiRow.appendChild(charLbl);
    }

    // 카테고리 탭 렌더링
    function renderTabs() {
        tabBar.innerHTML = '';
        const emoticons = loadEmoticons();
        const categoryVisibilityMap = loadCategoryVisibilityMap();
        const categories = ['전체', '즐겨찾기', ...new Set(emoticons.map(e => e.category).filter(Boolean))];

        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'slm-tab-btn' + (cat === currentCategory ? ' active' : '');
            const isHiddenCategory = cat !== '전체' && cat !== '즐겨찾기' && categoryVisibilityMap[cat] === false;
            btn.textContent = isHiddenCategory ? `${cat} (숨김)` : cat;
            btn.onclick = () => {
                currentCategory = cat;
                renderAll();
            };
            tabBar.appendChild(btn);
        });
    }

    // 이모티콘 그리드 렌더링
    function renderGrid() {
        grid.innerHTML = '';
        const categoryVisibilityMap = loadCategoryVisibilityMap();
        const emoticons = loadEmoticons().filter(e => categoryVisibilityMap[e.category] !== false);

        let filtered = emoticons;
        if (currentCategory === '즐겨찾기') {
            filtered = filtered.filter(e => e.favorite);
        } else if (currentCategory !== '전체') {
            filtered = filtered.filter(e => e.category === currentCategory);
        }
        if (searchQuery) {
            filtered = filtered.filter(e => e.name.toLowerCase().includes(searchQuery));
        }

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'slm-empty';
            empty.textContent = '이모티콘이 없습니다.';
            grid.appendChild(empty);
            return;
        }

        const categoryAiMap = loadCategoryAiMap();
        const charCategoryAiMap = loadCharCategoryAiMap();
        filtered.forEach(e => {
            const aiUsable = isAiUsableByPolicy(e, categoryAiMap, charCategoryAiMap);
            const cell = document.createElement('div');
            cell.className = 'slm-emoticon-cell';
            cell.title = `${e.name}${aiUsable ? '' : ' 🔒'}`;
            cell.style.flexDirection = 'column';

            const img = document.createElement('img');
            img.src = e.url;
            img.alt = e.name;
            img.className = 'slm-emoticon-img';
            img.onerror = () => { img.style.display = 'none'; };

            const caption = document.createElement('span');
            caption.className = 'slm-emoticon-caption';
            caption.textContent = e.name;

            const lockIcon = document.createElement('span');
            lockIcon.className = 'slm-emoticon-lock';
            lockIcon.textContent = aiUsable ? '' : '🔒';

            // 클릭 시 전송 (설정된 크기로 scale)
            cell.onclick = async () => {
                try {
                    const size = getEmoticonSize();
                    const radius = getEmoticonRadius();
                    const ctx = getContext();
                    const userName = ctx?.name1 || '{{user}}';
                    // HTML img 태그로 크기/모서리 지정 (URL/이름 이스케이프)
                    const safeName = escapeHtml(e.name);
                    const safeUrl = e.url.replace(/"/g, '&quot;');
                    const safeUserName = escapeHtml(userName);
                    const label = `${safeUserName}이(가) ${safeName} 이모티콘을 보냈습니다.`;
                    const html = `<img src="${safeUrl}" alt="${safeName}" aria-label="${label}" style="width:${size}px;height:${size}px;object-fit:contain;display:inline-block;vertical-align:middle;border-radius:${radius}px">`;
                    await slashSend(html);
                    showToast(`이모티콘 전송: ${e.name}`, 'success', 1000);
                } catch (err) {
                    showToast('전송 실패', 'error');
                }
            };

            // 우클릭으로 즐겨찾기/삭제
            cell.oncontextmenu = (ev) => {
                ev.preventDefault();
                openEmoticonContextMenu(ev, e, renderAll);
            };

            cell.appendChild(img);
            cell.appendChild(caption);
            cell.appendChild(lockIcon);

            const editBtn = document.createElement('button');
            editBtn.className = 'slm-emoticon-edit-btn';
            editBtn.textContent = '✎';
            editBtn.title = '이모티콘 수정';
            editBtn.onclick = (ev) => {
                ev.stopPropagation();
                openAddEmoticonDialog(renderAll, e);
            };
            cell.appendChild(editBtn);

            // 삭제 버튼 오버레이 (hover 시 표시)
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'slm-emoticon-delete-btn';
            deleteBtn.textContent = '✕';
            deleteBtn.title = '이모티콘 삭제';
            deleteBtn.onclick = (ev) => {
                ev.stopPropagation();
                const list = loadEmoticons().filter(em => em.id !== e.id);
                saveEmoticons(list);
                renderAll();
                showToast(`이모티콘 삭제: ${e.name}`, 'success', 1200);
            };
            cell.appendChild(deleteBtn);

            grid.appendChild(cell);
        });
    }

    renderAll();
    return wrapper;
}

/**
 * 이모티콘 추가 서브창을 연다
 * @param {Function} onSave - 저장 후 콜백
 * @param {Emoticon|null} existing - 편집할 이모티콘 (없으면 새로 추가)
 */
function openAddEmoticonDialog(onSave, existing = null) {
    const isEdit = !!existing;
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    // 이름 입력
    const nameInput = createFormField(wrapper, '이름', 'text', existing?.name || '');

    // URL 입력
    const urlLabel = document.createElement('label');
    urlLabel.className = 'slm-label';
    urlLabel.textContent = 'URL';
    const urlInput = document.createElement('input');
    urlInput.className = 'slm-input';
    urlInput.type = 'url';
    urlInput.value = existing?.url || '';

    // 미리보기
    const preview = document.createElement('img');
    preview.className = 'slm-preview-img';
    preview.style.display = 'none';
    urlInput.oninput = () => {
        const val = urlInput.value.trim();
        if (val) {
            preview.src = val;
            preview.style.display = 'block';
            preview.style.borderRadius = getEmoticonRadius() + 'px';
        } else {
            preview.style.display = 'none';
        }
    };
    if (existing?.url) {
        preview.src = existing.url;
        preview.style.display = 'block';
        preview.style.borderRadius = getEmoticonRadius() + 'px';
    }

    wrapper.appendChild(urlLabel);
    wrapper.appendChild(urlInput);
    wrapper.appendChild(preview);

    // 카테고리 입력 (기존 카테고리 드롭다운 + 직접 입력)
    const catLabel = document.createElement('label');
    catLabel.className = 'slm-label';
    catLabel.textContent = '카테고리';
    const existingCategories = [...new Set(loadEmoticons().map(e => e.category).filter(Boolean))];
    const categoryOptions = [...new Set(['기본', ...existingCategories])];
    const initialCategory = existing?.category?.trim() || '기본';
    const directInputOptionValue = '__direct__';
    const isDirectInput = !categoryOptions.includes(initialCategory);

    const catSelect = document.createElement('select');
    catSelect.className = 'slm-select';
    categoryOptions.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
    });
    const directOpt = document.createElement('option');
    directOpt.value = directInputOptionValue;
    directOpt.textContent = '직접입력';
    catSelect.appendChild(directOpt);

    const catInput = document.createElement('input');
    catInput.className = 'slm-input';
    catInput.type = 'text';
    catInput.placeholder = '카테고리 직접 입력';
    catInput.value = isDirectInput ? initialCategory : '';
    catInput.style.display = isDirectInput ? '' : 'none';

    catSelect.value = isDirectInput ? directInputOptionValue : initialCategory;
    catSelect.onchange = () => {
        const showInput = catSelect.value === directInputOptionValue;
        catInput.style.display = showInput ? '' : 'none';
        if (!showInput) catInput.value = '';
    };

    wrapper.appendChild(catLabel);
    wrapper.appendChild(catSelect);
    wrapper.appendChild(catInput);

    // AI 사용 여부
    const aiRow = document.createElement('div');
    aiRow.className = 'slm-radio-row';
    const aiLabel = document.createElement('span');
    aiLabel.className = 'slm-label';
    aiLabel.textContent = 'AI 사용:';

    const radioYes = document.createElement('input');
    radioYes.type = 'radio';
    radioYes.name = 'slm-ai-usable';
    radioYes.value = 'yes';
    radioYes.checked = existing ? existing.aiUsable : true;

    const radioYesLabel = document.createElement('label');
    radioYesLabel.textContent = '가능';

    const radioNo = document.createElement('input');
    radioNo.type = 'radio';
    radioNo.name = 'slm-ai-usable';
    radioNo.value = 'no';
    radioNo.checked = existing ? !existing.aiUsable : false;

    const radioNoLabel = document.createElement('label');
    radioNoLabel.textContent = '불가';

    aiRow.appendChild(aiLabel);
    aiRow.appendChild(radioYes);
    aiRow.appendChild(radioYesLabel);
    aiRow.appendChild(radioNo);
    aiRow.appendChild(radioNoLabel);
    wrapper.appendChild(aiRow);

    const overrideLabel = document.createElement('label');
    overrideLabel.className = 'slm-toggle-label';
    const overrideCheck = document.createElement('input');
    overrideCheck.type = 'checkbox';
    overrideCheck.checked = !!existing?.aiOverrideAllow;
    overrideLabel.appendChild(overrideCheck);
    overrideLabel.appendChild(document.createTextNode(' 카테고리 설정과 무관하게 AI 사용 허용'));
    wrapper.appendChild(overrideLabel);

    // footer 버튼 생성 후 createPopup에 전달
    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = '저장';

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    const { close } = createPopup({
        id: 'emoticon-add',
        title: isEdit ? '이모티콘 편집' : '이모티콘 추가',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });

    cancelBtn.onclick = () => close();

    saveBtn.onclick = () => {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const category = (catSelect.value === directInputOptionValue
            ? catInput.value.trim()
            : catSelect.value.trim()) || '기본';
        const aiUsable = radioYes.checked;
        const aiOverrideAllow = overrideCheck.checked;

        if (!name || !url) {
            showToast('이름과 URL을 입력해주세요.', 'warn');
            return;
        }

        const emoticons = loadEmoticons();
        if (isEdit) {
            const idx = emoticons.findIndex(e => e.id === existing.id);
            if (idx !== -1) {
                emoticons[idx] = { ...existing, name, url, category, aiUsable, aiOverrideAllow };
            }
        } else {
            emoticons.push({
                id: generateId(),
                name, url, category,
                favorite: false,
                aiUsable,
                aiOverrideAllow,
            });
        }
        saveEmoticons(emoticons);
        close();
        onSave();
        showToast(isEdit ? '이모티콘 편집 완료' : '이모티콘 추가 완료', 'success');
    };
}

/**
 * 이모티콘 우클릭 컨텍스트 메뉴
 */
function openEmoticonContextMenu(ev, emoticon, onUpdate) {
    // 기존 메뉴 제거
    document.querySelectorAll('.slm-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'slm-context-menu';
    menu.style.left = `${Math.min(ev.clientX, window.innerWidth - 160)}px`;
    menu.style.top = `${Math.min(ev.clientY, window.innerHeight - 120)}px`;

    const favItem = document.createElement('button');
    favItem.className = 'slm-context-item';
    favItem.textContent = emoticon.favorite ? '⭐ 즐겨찾기 해제' : '⭐ 즐겨찾기 추가';
    favItem.onclick = () => {
        const list = loadEmoticons();
        const idx = list.findIndex(e => e.id === emoticon.id);
        if (idx !== -1) list[idx].favorite = !list[idx].favorite;
        saveEmoticons(list);
        menu.remove();
        onUpdate();
    };

    const editItem = document.createElement('button');
    editItem.className = 'slm-context-item';
    editItem.textContent = '✏️ 편집';
    editItem.onclick = () => { menu.remove(); openAddEmoticonDialog(onUpdate, emoticon); };

    const delItem = document.createElement('button');
    delItem.className = 'slm-context-item slm-context-danger';
    delItem.textContent = '🗑️ 삭제';
    delItem.onclick = () => {
        const list = loadEmoticons().filter(e => e.id !== emoticon.id);
        saveEmoticons(list);
        menu.remove();
        onUpdate();
    };

    menu.appendChild(favItem);
    menu.appendChild(editItem);
    menu.appendChild(delItem);
    document.body.appendChild(menu);

    // 외부 클릭으로 메뉴 닫기
    setTimeout(() => {
        document.addEventListener('click', () => menu.remove(), { once: true });
    }, 0);
}

/**
 * 이모티콘 일괄 등록 다이얼로그를 연다
 * 각 줄에 URL 또는 "이름|URL" 형식으로 입력한다
 * @param {Function} onSave - 저장 후 콜백
 */
function openBulkAddDialog(onSave) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const desc = document.createElement('p');
    desc.className = 'slm-desc';
    desc.textContent = '한 줄에 하나씩 입력하세요. 형식: URL 또는 이름|URL';
    wrapper.appendChild(desc);

    const textarea = document.createElement('textarea');
    textarea.className = 'slm-textarea';
    textarea.rows = 8;
    textarea.placeholder = 'https://example.com/sticker1.png\n스티커이름|https://example.com/sticker2.gif\n...';
    wrapper.appendChild(textarea);

    const catLabel = document.createElement('label');
    catLabel.className = 'slm-label';
    catLabel.textContent = '카테고리';
    const existingCategories = [...new Set(loadEmoticons().map(e => e.category).filter(Boolean))];
    const categoryOptions = [...new Set(['기본', ...existingCategories])];
    const catSelect = document.createElement('select');
    catSelect.className = 'slm-select';
    categoryOptions.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        catSelect.appendChild(opt);
    });
    const directCatOpt = document.createElement('option');
    directCatOpt.value = '__direct__';
    directCatOpt.textContent = '직접입력';
    catSelect.appendChild(directCatOpt);
    const catInput = document.createElement('input');
    catInput.className = 'slm-input';
    catInput.type = 'text';
    catInput.placeholder = '카테고리 직접 입력';
    catInput.style.display = 'none';
    catSelect.onchange = () => {
        catInput.style.display = catSelect.value === '__direct__' ? '' : 'none';
    };
    wrapper.appendChild(catLabel);
    wrapper.appendChild(catSelect);
    wrapper.appendChild(catInput);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = '일괄 등록';

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    const { close } = createPopup({
        id: 'emoticon-bulk-add',
        title: '📋 이모티콘 일괄 등록',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });

    cancelBtn.onclick = () => close();

    saveBtn.onclick = () => {
        const category = (catSelect.value === '__direct__'
            ? catInput.value.trim()
            : catSelect.value.trim()) || '기본';
        const lines = textarea.value.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
            showToast('등록할 항목이 없습니다.', 'warn');
            return;
        }
        const emoticons = loadEmoticons();
        const existingUrls = new Set(emoticons.map(e => e.url));
        let added = 0;
        for (const line of lines) {
            let name = '';
            let url = '';
            if (line.includes('|')) {
                const sepIdx = line.indexOf('|');
                name = line.slice(0, sepIdx).trim();
                url = line.slice(sepIdx + 1).trim();
            } else {
                url = line.trim();
                // URL에서 파일명을 이름으로 사용
                try {
                    const fileName = new URL(url).pathname.split('/').pop().replace(/\.[^.]+$/, '') || '이모티콘';
                    name = decodeURIComponent(fileName);
                } catch (urlErr) {
                    console.warn('[ST-LifeSim] 일괄 등록: URL 파싱 실패, 기본 이름 사용:', url, urlErr);
                    name = '이모티콘';
                }
            }
            if (!url || existingUrls.has(url)) continue;
            emoticons.push({
                id: generateId(),
                name: name || '이모티콘',
                url,
                category,
                favorite: false,
                aiUsable: true,
                aiOverrideAllow: false,
            });
            existingUrls.add(url);
            added++;
        }
        saveEmoticons(emoticons);
        close();
        onSave();
        showToast(`이모티콘 ${added}개 일괄 등록 완료`, 'success');
    };
}

/**
 * 폼 필드를 생성하고 컨테이너에 추가한다
 * @param {HTMLElement} container
 * @param {string} label
 * @param {string} type
 * @param {string} value
 * @returns {HTMLInputElement}
 */
function createFormField(container, label, type, value) {
    const lbl = document.createElement('label');
    lbl.className = 'slm-label';
    lbl.textContent = label;

    const input = document.createElement('input');
    input.className = 'slm-input';
    input.type = type;
    input.value = value;

    container.appendChild(lbl);
    container.appendChild(input);
    return input;
}
