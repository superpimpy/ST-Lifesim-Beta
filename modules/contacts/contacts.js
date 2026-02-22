/**
 * contacts.js
 * NPC 연락처 모듈
 * - 연락처 등록/편집/삭제
 * - {{char}} 연락처 자동 등록
 * - 연락처 클릭 시 상세 정보 팝업
 * - 컨텍스트에 인물 정보 주입
 * - 채팅별 또는 캐릭터별 바인딩
 */

import { getContext } from '../../utils/st-context.js';
import { loadData, saveData, getExtensionSettings } from '../../utils/storage.js';
import { registerContextBuilder } from '../../utils/context-inject.js';
import { showToast, escapeHtml, generateId } from '../../utils/ui.js';
import { createPopup } from '../../utils/popup.js';

const MODULE_KEY = 'contacts';
const MAX_AI_CONTACT_KEYWORD_LENGTH = 200;
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

/**
 * @typedef {Object} Contact
 * @property {string} id
 * @property {string} name
 * @property {string} [displayName]
 * @property {string} avatar
 * @property {string} description
 * @property {string} relationToUser
 * @property {string} relationToChar
 * @property {string} personality
 * @property {string} phone
 * @property {string[]} tags
 * @property {string} [appearanceTags] - 외관 태그 (이미지 생성 시 사용)
 * @property {'chat'|'character'} binding
 * @property {boolean} [isCharAuto] - {{char}} 자동 추가 여부
 * @property {boolean} [isUserAuto] - {{user}} 자동 추가 여부
 */

/**
 * 저장된 연락처 목록을 불러온다
 * @param {'chat'|'character'} binding
 * @returns {Contact[]}
 */
function loadContacts(binding = 'chat') {
    return loadData(MODULE_KEY, [], binding);
}

/**
 * 연락처 목록을 저장한다
 * @param {Contact[]} contacts
 * @param {'chat'|'character'} binding
 */
function saveContacts(contacts, binding = 'chat') {
    saveData(MODULE_KEY, contacts, binding);
}

function getContactDisplayName(contact) {
    return String(contact?.displayName || contact?.name || '').trim();
}

/**
 * {{char}} 연락처를 자동으로 추가한다 (아직 없는 경우에만)
 */
function ensureCharContact() {
    const ctx = getContext();
    if (!ctx) return;
    const charName = ctx.name2;
    if (!charName) return;

    const contacts = loadContacts('chat');
    const existing = contacts.find(c => c.isCharAuto || c.name === charName);
    const syncedAvatar = ctx.characters?.[ctx.characterId]?.avatar
        ? `/characters/${ctx.characters?.[ctx.characterId]?.avatar}`
        : '';
    const syncedDescription = ctx.characters?.[ctx.characterId]?.description || '';
    const syncedPersonality = ctx.characters?.[ctx.characterId]?.personality || '';
    if (existing) {
        existing.name = charName;
        existing.avatar = existing.avatar || syncedAvatar;
        existing.description = existing.description || syncedDescription;
        existing.personality = existing.personality || syncedPersonality;
        existing.isCharAuto = true;
        existing.binding = 'chat';
        saveContacts(contacts, 'chat');
        return;
    }

    contacts.push({
        id: generateId(),
        name: charName,
        displayName: '',
        avatar: syncedAvatar,
        description: syncedDescription,
        relationToUser: '주요 캐릭터',
        relationToChar: '',
        personality: syncedPersonality,
        phone: '',
        tags: [],
        binding: 'chat',
        isCharAuto: true,
    });
    saveContacts(contacts, 'chat');
}

/**
 * {{user}} 연락처를 자동으로 추가한다 (character 바인딩, 외모 태그 전용)
 * - 선통화/SNS 등 자동 트리거에서는 제외되어야 한다
 * - 삭제 버튼 없어야 하며 캐릭터 바인딩이어야 한다
 */
function ensureUserContact() {
    const ctx = getContext();
    if (!ctx) return;
    const userName = ctx.name1;
    if (!userName) return;

    const contacts = loadContacts('character');
    const existing = contacts.find(c => c.isUserAuto || c.name === userName);
    const userAvatar = document.querySelector('#user_avatar_block .avatar.selected img')?.getAttribute('src') || '';
    if (existing) {
        existing.name = userName;
        existing.avatar = existing.avatar || userAvatar;
        existing.isUserAuto = true;
        existing.binding = 'character';
        saveContacts(contacts, 'character');
        return;
    }

    contacts.push({
        id: generateId(),
        name: userName,
        displayName: '',
        avatar: userAvatar,
        description: '유저 (플레이어)',
        relationToUser: '본인',
        relationToChar: '',
        personality: '',
        phone: '',
        tags: [],
        appearanceTags: '',
        binding: 'character',
        isUserAuto: true,
    });
    saveContacts(contacts, 'character');
}

/**
 * 연락처 모듈을 초기화한다
 */
export function initContacts() {
    // 컨텍스트 빌더 등록
    registerContextBuilder('contacts', () => {
        const chatContacts = loadContacts('chat');
        const charContacts = loadContacts('character');
        const all = [...chatContacts, ...charContacts];

        if (all.length === 0) return null;

        const lines = all.map(c => {
            let line = `• ${getContactDisplayName(c)}`;
            if (c.relationToUser) line += ` | Relation to {{user}}: ${c.relationToUser}`;
            if (c.relationToChar) line += ` | Relation to {{char}}: ${c.relationToChar}`;
            if (c.personality) line += ` | Personality: ${c.personality}`;
            return line;
        });

        return `=== Contacts ===\n${lines.join('\n')}\n→ These characters may contact {{user}} or be mentioned in {{char}}'s conversation at any time.`;
    });

    // 채팅 로드 시 {{char}} 자동 추가
    const ctx = getContext();
    const resolvedEventTypes = ctx?.event_types || ctx?.eventTypes;
    if (ctx?.eventSource && resolvedEventTypes?.CHAT_CHANGED) {
        ctx.eventSource.on(resolvedEventTypes.CHAT_CHANGED, () => {
            ensureCharContact();
            ensureUserContact();
        });
    }
    // 즉시도 한번 실행
    ensureCharContact();
    ensureUserContact();
}

/**
 * 연락처 팝업을 연다
 */
export function openContactsPopup(onBack) {
    const content = buildContactsContent();
    createPopup({
        id: 'contacts',
        title: '📋 연락처',
        content,
        className: 'slm-contacts-panel',
        onBack,
    });
}

/**
 * 연락처 팝업 내용을 빌드한다
 * @returns {HTMLElement}
 */
function buildContactsContent() {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-contacts-wrapper';

    // 검색창
    const searchInput = document.createElement('input');
    searchInput.className = 'slm-input slm-search';
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 검색...';
    searchInput.oninput = () => renderList();
    wrapper.appendChild(searchInput);

    // 새 연락처 버튼
    const actionRow = document.createElement('div');
    actionRow.className = 'slm-btn-row';
    actionRow.style.marginBottom = '8px';
    const addBtn = document.createElement('button');
    addBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    addBtn.textContent = '+ 새 연락처';
    addBtn.onclick = () => openContactDialog(null, 'chat', renderList);
    const aiAddBtn = document.createElement('button');
    aiAddBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    aiAddBtn.textContent = '🤖 AI 생성';
    aiAddBtn.onclick = () => openAiContactDialog('chat', renderList);
    actionRow.appendChild(addBtn);
    actionRow.appendChild(aiAddBtn);
    wrapper.appendChild(actionRow);

    // 연락처 목록
    const list = document.createElement('div');
    list.className = 'slm-contacts-list';
    wrapper.appendChild(list);

    function renderList() {
        list.innerHTML = '';
        const contacts = [...loadContacts('chat'), ...loadContacts('character')];
        const query = searchInput.value.toLowerCase();
        const filtered = query
            ? contacts.filter(c => getContactDisplayName(c).toLowerCase().includes(query) || (c.description || '').toLowerCase().includes(query))
            : contacts;

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'slm-empty';
            empty.textContent = '연락처가 없습니다.';
            list.appendChild(empty);
            return;
        }

        filtered.forEach(contact => {
            const displayName = getContactDisplayName(contact);
            const row = document.createElement('div');
            row.className = 'slm-contact-row';
            row.style.cursor = 'pointer';

            // 아바타
            const avatar = document.createElement('div');
            avatar.className = 'slm-contact-avatar';
            if (contact.avatar) {
                const img = document.createElement('img');
                img.src = contact.avatar;
                img.alt = displayName;
                img.onerror = () => { avatar.textContent = displayName[0] || '?'; };
                avatar.appendChild(img);
            } else {
                avatar.textContent = displayName[0] || '?';
            }

            // 정보
            const info = document.createElement('div');
            info.className = 'slm-contact-info';

            const nameRow = document.createElement('div');
            nameRow.className = 'slm-contact-name-row';

            const name = document.createElement('span');
            name.className = 'slm-contact-name';
            name.textContent = displayName;

            nameRow.appendChild(name);

            // 캐릭터/유저 자동 추가가 아닌 경우에만 scope 태그 표시 (이름 오른쪽)
            if (!contact.isCharAuto && !contact.isUserAuto) {
                const scope = document.createElement('span');
                scope.className = 'slm-contact-scope';
                scope.textContent = contact.binding === 'character' ? '캐릭터' : '이 채팅';
                nameRow.appendChild(scope);
            }

            const rel = document.createElement('span');
            rel.className = 'slm-contact-rel';
            rel.textContent = contact.relationToUser || contact.description || '';

            info.appendChild(nameRow);
            info.appendChild(rel);

            const avatarWrap = document.createElement('div');
            avatarWrap.className = 'slm-contact-avatar-wrap';
            avatarWrap.appendChild(avatar);

            // 클릭 시 상세 팝업
            const clickArea = document.createElement('div');
            clickArea.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer';
            clickArea.appendChild(avatarWrap);
            clickArea.appendChild(info);
            clickArea.onclick = () => openContactDetailPopup(contact);

            // 편집 버튼
            const editBtn = document.createElement('button');
            editBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            editBtn.textContent = '편집';
            editBtn.onclick = (e) => { e.stopPropagation(); openContactDialog(contact, contact.binding || 'chat', renderList); };

            // 삭제 버튼
            const delBtn = document.createElement('button');
            delBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
            delBtn.textContent = '삭제';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                const targetBinding = contact.binding || 'chat';
                const updated = loadContacts(targetBinding).filter(c => c.id !== contact.id);
                saveContacts(updated, targetBinding);
                renderList();
                showToast('연락처 삭제', 'success', 1500);
            };

            row.appendChild(clickArea);
            row.appendChild(editBtn);
            if (!contact.isCharAuto && !contact.isUserAuto) {
                row.appendChild(delBtn);
            }
            list.appendChild(row);
        });
    }

    renderList();
    return wrapper;
}

/**
 * 연락처 상세 팝업을 연다
 * @param {Contact} contact
 */
function openContactDetailPopup(contact) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-contact-detail';

    // 아바타
    const avatar = document.createElement('div');
    avatar.className = 'slm-contact-detail-avatar';
    if (contact.avatar) {
        const img = document.createElement('img');
        img.src = contact.avatar;
        img.alt = contact.name;
        img.onerror = () => { avatar.textContent = contact.name[0] || '?'; };
        avatar.appendChild(img);
    } else {
        avatar.textContent = contact.name[0] || '?';
    }
    wrapper.appendChild(avatar);

    // 이름
    const nameEl = document.createElement('div');
    nameEl.className = 'slm-contact-detail-name';
    nameEl.textContent = getContactDisplayName(contact);
    wrapper.appendChild(nameEl);

    // 상세 필드들
    const fields = document.createElement('div');
    fields.className = 'slm-contact-detail-fields';

    const fieldDefs = [
        { label: '관계', value: contact.relationToUser },
        { label: '성격/말투', value: contact.personality },
        { label: '외관 태그', value: contact.appearanceTags },
    ];

    fieldDefs.forEach(({ label, value }) => {
        if (!value) return;
        const row = document.createElement('div');
        row.className = 'slm-contact-field-row';
        row.innerHTML = `
            <span class="slm-contact-field-label">${escapeHtml(label)}</span>
            <span class="slm-contact-field-value">${escapeHtml(value)}</span>
        `;
        fields.appendChild(row);
    });

    wrapper.appendChild(fields);

    createPopup({
        id: 'contact-detail',
        title: `👤 ${getContactDisplayName(contact)}`,
        content: wrapper,
        className: 'slm-sub-panel',
        onBack: () => openContactsPopup(),
    });
}

/**
 * 연락처 등록/편집 서브창을 연다
 * @param {Contact|null} existing
 * @param {'chat'|'character'} defaultBinding
 * @param {Function} onSave
 */
function openContactDialog(existing, defaultBinding, onSave) {
    const isEdit = !!existing;
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const fields = {
        name: createFormField(wrapper, existing?.isCharAuto ? '표시 이름 *' : (existing?.isUserAuto ? '표시 이름' : '이름 *'), 'text', existing?.displayName || existing?.name || ''),
        avatar: createFormField(wrapper, '프로필 이미지 URL', 'url', existing?.avatar || ''),
        description: createFormField(wrapper, '설명', 'text', existing?.description || ''),
        relationToUser: createFormField(wrapper, '{{user}}와의 관계 *', 'text', existing?.relationToUser || ''),
        relationToChar: createFormField(wrapper, '{{char}}와의 관계', 'text', existing?.relationToChar || ''),
        personality: createFormField(wrapper, '성격/말투', 'text', existing?.personality || ''),
        appearanceTags: createFormField(wrapper, '🏷️ 외관 태그 (이미지 생성용)', 'text', existing?.appearanceTags || ''),
    };
    fields.appearanceTags.placeholder = '예: long hair, school uniform, warm smile';
    if (existing?.isCharAuto) {
        fields.name.disabled = true;
        fields.description.disabled = true;
        const restoreAvatarBtn = document.createElement('button');
        restoreAvatarBtn.type = 'button';
        restoreAvatarBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
        restoreAvatarBtn.textContent = '🔄 기본값으로 복원';
        restoreAvatarBtn.style.marginTop = '2px';
        restoreAvatarBtn.onclick = () => {
            const ctx = getContext();
            fields.avatar.value = ctx?.characters?.[ctx?.characterId]?.avatar
                ? `/characters/${ctx?.characters?.[ctx?.characterId]?.avatar}`
                : '';
        };
        fields.avatar.insertAdjacentElement('afterend', restoreAvatarBtn);
    }
    if (existing?.isUserAuto) {
        fields.name.disabled = true;
        fields.description.disabled = true;
        fields.relationToUser.disabled = true;
    }
    let selectedBinding = existing?.binding || defaultBinding || 'chat';
    if (!existing?.isCharAuto && !existing?.isUserAuto) {
        const bindingLbl = document.createElement('label');
        bindingLbl.className = 'slm-label';
        bindingLbl.textContent = '저장 범위';
        const bindingSelect = document.createElement('select');
        bindingSelect.className = 'slm-select';
        bindingSelect.innerHTML = `
            <option value="chat"${selectedBinding === 'chat' ? ' selected' : ''}>이 채팅에만 저장</option>
            <option value="character"${selectedBinding === 'character' ? ' selected' : ''}>채팅을 새로 파도 유지</option>
        `;
        bindingSelect.onchange = () => { selectedBinding = bindingSelect.value; };
        wrapper.append(bindingLbl, bindingSelect);
    }

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
        id: 'contact-edit',
        title: isEdit ? '연락처 편집' : '연락처 등록',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack: () => openContactsPopup(),
    });

    cancelBtn.onclick = () => close();

    saveBtn.onclick = () => {
        const isCharAuto = existing?.isCharAuto === true;
        const isUserAuto = existing?.isUserAuto === true;
        const name = (isCharAuto || isUserAuto) ? (existing?.displayName || existing?.name || '').trim() : fields.name.value.trim();
        const relationToUser = fields.relationToUser.value.trim();
        if (!name || (!isUserAuto && !relationToUser)) {
            showToast('이름과 관계는 필수입니다.', 'warn');
            return;
        }

        const sourceBinding = existing?.binding || defaultBinding || 'chat';
        const targetBinding = selectedBinding;
        const sourceContacts = loadContacts(sourceBinding);
        const targetContacts = targetBinding === sourceBinding ? sourceContacts : loadContacts(targetBinding);
        const canonicalName = isCharAuto ? (existing?.name || getContext()?.name2 || name)
            : isUserAuto ? (existing?.name || getContext()?.name1 || name)
            : name;
        const displayName = (isCharAuto || isUserAuto) && name !== canonicalName ? name : '';
        const data = {
            id: existing?.id || generateId(),
            name: canonicalName,
            displayName,
            avatar: fields.avatar.value.trim(),
            description: (isCharAuto || isUserAuto) ? (existing?.description || '') : fields.description.value.trim(),
            relationToUser: isUserAuto ? (existing?.relationToUser || '본인') : relationToUser,
            relationToChar: fields.relationToChar.value.trim(),
            personality: fields.personality.value.trim(),
            phone: '',
            tags: existing?.tags || [],
            appearanceTags: fields.appearanceTags.value.trim(),
            binding: targetBinding,
            isCharAuto,
            isUserAuto,
        };

        if (isEdit) {
            const idx = sourceContacts.findIndex(c => c.id === existing.id);
            if (idx !== -1) sourceContacts.splice(idx, 1);
        }
        targetContacts.push(data);
        if (targetBinding !== sourceBinding) {
            saveContacts(sourceContacts, sourceBinding);
        }
        saveContacts(targetContacts, targetBinding);
        close();
        onSave();
        showToast(isEdit ? '연락처 수정 완료' : '연락처 추가 완료', 'success');
    };
}

/**
 * 키워드 기반 AI 연락처 생성 다이얼로그
 * @param {'chat'|'character'} binding
 * @param {Function} onSave
 */
function openAiContactDialog(binding, onSave) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';
    const keyword = createFormField(wrapper, '생성 키워드 *', 'text', '');
    keyword.placeholder = '예: 까칠하지만 속정 깊은 바리스타';

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';
    const createBtn = document.createElement('button');
    createBtn.className = 'slm-btn slm-btn-primary';
    createBtn.textContent = '생성';
    footer.append(cancelBtn, createBtn);

    const { close } = createPopup({
        id: 'contact-ai-create',
        title: '🤖 AI 연락처 생성',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });

    cancelBtn.onclick = () => close();
    createBtn.onclick = async () => {
        const q = keyword.value.trim();
        if (!q) { showToast('키워드를 입력해주세요.', 'warn'); return; }
        const safeKeyword = q.replace(/[{}\n\r]/g, ' ').slice(0, MAX_AI_CONTACT_KEYWORD_LENGTH);
        const ctx = getContext();
        if (!ctx || (typeof ctx.generateQuietPrompt !== 'function' && typeof ctx.generateRaw !== 'function')) {
            showToast('AI 생성 기능을 사용할 수 없습니다.', 'error');
            return;
        }
        createBtn.disabled = true;
        try {
            const prompt = `Create one realistic contact profile in JSON only (no markdown). Keyword: "${safeKeyword}". Write every text field in English only.\n{"name":"", "description":"", "relationToUser":"", "relationToChar":"", "personality":"", "avatar":""}`;
            const raw = await generateContactProfileText(ctx, prompt) || '';
            const match = raw.match(/\{[\s\S]*?\}/);
            if (!match) throw new Error('JSON 응답이 없습니다.');
            const parsed = JSON.parse(match[0]);
            const name = (parsed.name || '').trim();
            if (!name) throw new Error('이름이 비어 있습니다.');
            const relationToUser = (parsed.relationToUser || '지인').trim();

            const contacts = loadContacts(binding);
            contacts.push({
                id: generateId(),
                name,
                displayName: '',
                avatar: (parsed.avatar || '').trim(),
                description: (parsed.description || '').trim(),
                relationToUser,
                relationToChar: (parsed.relationToChar || '').trim(),
                personality: (parsed.personality || '').trim(),
                phone: '',
                tags: [],
                binding,
            });
            saveContacts(contacts, binding);
            close();
            onSave();
            showToast(`연락처 생성 완료: ${name}`, 'success');
        } catch (e) {
            showToast(`AI 생성 실패: ${e.message}`, 'error');
        } finally {
            createBtn.disabled = false;
        }
    };
}

function inferModelSettingKey(source) {
    return MODEL_KEY_BY_SOURCE[String(source || '').toLowerCase()] || '';
}

function getContactAiRouteSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'];
    const route = ext?.aiRoutes?.contactProfile || {};
    return {
        api: String(route.api || '').trim(),
        chatSource: String(route.chatSource || '').trim(),
        modelSettingKey: String(route.modelSettingKey || '').trim(),
        model: String(route.model || '').trim(),
    };
}

async function generateContactProfileText(ctx, prompt) {
    const ext = getExtensionSettings()?.['st-lifesim'];
    const externalApiUrl = String(ext?.snsExternalApiUrl || '').trim();
    const externalApiTimeoutMs = Math.max(1000, Math.min(60000, Number(ext?.snsExternalApiTimeoutMs) || 12000));
    if (externalApiUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), externalApiTimeoutMs);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (typeof ctx.getRequestHeaders === 'function') Object.assign(headers, ctx.getRequestHeaders());
            const response = await fetch(externalApiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ prompt, quietName: ctx?.name2 || '{{char}}', module: 'st-lifesim-contact-profile' }),
                signal: controller.signal,
            });
            if (response.ok) return (await response.text() || '').trim();
        } catch (error) {
            console.warn('[ST-LifeSim] 연락처 외부 API 호출 실패, 내부 생성으로 폴백:', error);
        } finally {
            clearTimeout(timer);
        }
    }
    if (typeof ctx.generateRaw === 'function') {
        const aiRoute = getContactAiRouteSettings();
        const chatSettings = ctx.chatCompletionSettings;
        const sourceBefore = chatSettings?.chat_completion_source;
        let modelKey = '';
        let modelBefore;
        if (chatSettings && aiRoute.chatSource) {
            chatSettings.chat_completion_source = aiRoute.chatSource;
        }
        if (chatSettings) {
            modelKey = aiRoute.modelSettingKey || inferModelSettingKey(aiRoute.chatSource || sourceBefore || '');
            if (modelKey && aiRoute.model) {
                modelBefore = chatSettings[modelKey];
                chatSettings[modelKey] = aiRoute.model;
            }
        }
        try {
            return (await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true, api: aiRoute.api || null }) || '').trim();
        } finally {
            if (chatSettings && aiRoute.chatSource) chatSettings.chat_completion_source = sourceBefore;
            if (chatSettings && modelKey && aiRoute.model) chatSettings[modelKey] = modelBefore;
        }
    }
    if (typeof ctx.generateQuietPrompt === 'function') {
        return (await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: ctx?.name2 || '{{char}}' }) || '').trim();
    }
    return '';
}

/**
 * 폼 필드를 생성한다
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

/**
 * 등록된 연락처 목록을 반환한다 (다른 모듈에서 참조용)
 * @param {'chat'|'character'} binding
 * @returns {Contact[]}
 */
export function getContacts(binding = 'chat') {
    return loadContacts(binding);
}

/**
 * 이름으로 연락처의 외관 태그를 가져온다.
 * chat 바인딩과 character 바인딩 모두 검색한다.
 * @param {string} name - 캐릭터/유저 이름
 * @returns {string} 외관 태그 문자열 (없으면 빈 문자열)
 */
export function getAppearanceTagsByName(name) {
    if (!name) return '';
    const allContacts = [...loadContacts('chat'), ...loadContacts('character')];
    const contact = allContacts.find(c => c.name === name || c.displayName === name);
    return String(contact?.appearanceTags || '').trim();
}
