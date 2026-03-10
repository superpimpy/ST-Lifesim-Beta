import { getContext } from '../../utils/st-context.js';
import { loadData, saveData } from '../../utils/storage.js';
import { createPopup, closePopup } from '../../utils/popup.js';
import { getContacts } from '../contacts/contacts.js';
import { generateId, showConfirm, showToast } from '../../utils/ui.js';

const MODULE_KEY = 'messenger-rooms';
const MAIN_CHAR_MEMBER_KEY = '__main_char__';
const USER_MEMBER_KEY = '__user__';
const ROOM_MESSAGE_LIMIT = 18;
const ROOM_MESSAGE_STORAGE_LIMIT = 80;
const ROOM_DEFAULTS = {
    autoReplyEnabled: true,
    responseProbability: 100,
    extraResponseProbability: 35,
    maxResponses: 2,
};

/**
 * Normalize messenger-room records loaded from storage.
 * @param {Array} rooms
 * @returns {Array}
 */
export function normalizeMessengerRooms(rooms = []) {
    if (!Array.isArray(rooms)) return [];
    return rooms
        .map((room) => {
            const members = Array.isArray(room?.members)
                ? room.members.map((member) => String(member || '').trim()).filter(Boolean)
                : [];
            const messages = Array.isArray(room?.messages)
                ? room.messages.map((message) => ({
                    id: String(message?.id || generateId()),
                    authorKey: String(message?.authorKey || '').trim(),
                    authorName: String(message?.authorName || '').trim(),
                    text: String(message?.text || '').trim(),
                    timestamp: Number(message?.timestamp) || Date.now(),
                    type: String(message?.type || 'message').trim() || 'message',
                })).filter((message) => message.text)
                : [];
            const name = String(room?.name || '').trim();
            const createdAt = Number(room?.createdAt) || Date.now();
            const updatedAt = Number(room?.updatedAt) || messages[messages.length - 1]?.timestamp || createdAt;
            return {
                id: String(room?.id || generateId()),
                name,
                members,
                createdAt,
                updatedAt,
                messages,
                settings: {
                    ...ROOM_DEFAULTS,
                    ...(room?.settings && typeof room.settings === 'object' ? room.settings : {}),
                },
            };
        })
        .filter((room) => room.members.length > 0)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/**
 * Builds a fallback room name from selected member labels.
 * @param {string[]} labels
 * @returns {string}
 */
export function buildMessengerRoomName(labels = []) {
    const safeLabels = Array.isArray(labels)
        ? labels.map((label) => String(label || '').trim()).filter(Boolean)
        : [];
    if (safeLabels.length === 0) {
        return `새 메신저 방 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    }
    if (safeLabels.length <= 3) return safeLabels.join(', ');
    return `${safeLabels.slice(0, 2).join(', ')} 외 ${safeLabels.length - 2}명`;
}

function loadMessengerRooms() {
    const stored = loadData(MODULE_KEY, { rooms: [] }, 'chat');
    return normalizeMessengerRooms(stored?.rooms || []);
}

function saveMessengerRooms(rooms) {
    saveData(MODULE_KEY, { rooms: normalizeMessengerRooms(rooms) }, 'chat');
}

function upsertMessengerRoom(nextRoom) {
    const rooms = loadMessengerRooms();
    const index = rooms.findIndex((room) => room.id === nextRoom.id);
    if (index >= 0) {
        rooms[index] = nextRoom;
    } else {
        rooms.push(nextRoom);
    }
    saveMessengerRooms(rooms);
    return nextRoom;
}

function deleteMessengerRoom(roomId) {
    const nextRooms = loadMessengerRooms().filter((room) => room.id !== roomId);
    saveMessengerRooms(nextRooms);
}

function getMessengerRoomById(roomId) {
    return loadMessengerRooms().find((room) => room.id === roomId) || null;
}

function normalizeRoomPromptText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[<>{}\[\]]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeRoomReply(text, responderName, memberLabels = []) {
    let cleaned = normalizeRoomPromptText(text);
    if (!cleaned) return '';
    cleaned = cleaned
        .replace(new RegExp(`^${escapeRegex(responderName)}\\s*[:：-]\\s*`, 'i'), '')
        .replace(/^\s*(?:reply|response)\s*[:：-]\s*/i, '')
        .trim();
    const allNames = [...new Set(memberLabels.map((label) => String(label || '').trim()).filter(Boolean))];
    let earliestForeignSpeakerIndex = -1;
    allNames
        .filter((name) => name.toLowerCase() !== String(responderName || '').trim().toLowerCase())
        .sort((a, b) => b.length - a.length)
        .forEach((name) => {
            const match = cleaned.match(new RegExp(`(^|\\n)\\s*${escapeRegex(name)}\\s*[:：-]\\s*`, 'i'));
            if (!match) return;
            const index = match.index !== undefined ? match.index : -1;
            if (earliestForeignSpeakerIndex === -1 || index < earliestForeignSpeakerIndex) {
                earliestForeignSpeakerIndex = index;
            }
        });
    if (earliestForeignSpeakerIndex === 0) return '';
    if (earliestForeignSpeakerIndex > 0) {
        cleaned = cleaned.slice(0, earliestForeignSpeakerIndex).trim();
    }
    return cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

function getMemberCandidates() {
    const ctx = getContext();
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const key = String(candidate?.key || '').trim();
        const label = String(candidate?.label || '').trim();
        if (!key || !label) return;
        const normalized = key.toLowerCase();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push({ ...candidate, key, label });
    };

    const mainCharName = String(ctx?.name2 || '').trim();
    if (mainCharName) {
        pushCandidate({
            key: MAIN_CHAR_MEMBER_KEY,
            label: mainCharName,
            subtitle: '현재 {{char}}',
            avatar: '',
            isMainChar: true,
            description: '',
            personality: '',
            relationToUser: '',
        });
    }

    [...getContacts('character'), ...getContacts('chat')].forEach((contact) => {
        if (contact?.isUserAuto) return;
        const label = String(contact?.displayName || contact?.name || '').trim();
        if (!label) return;
        pushCandidate({
            key: label,
            label,
            subtitle: String(contact?.relationToUser || contact?.description || '').trim(),
            avatar: String(contact?.avatar || '').trim(),
            isMainChar: false,
            description: String(contact?.description || '').trim(),
            personality: String(contact?.personality || '').trim(),
            relationToUser: String(contact?.relationToUser || '').trim(),
        });
    });

    return candidates;
}

function getCandidateMap() {
    return new Map(getMemberCandidates().map((candidate) => [candidate.key, candidate]));
}

function getMemberDisplayLabel(memberKey, candidateMap = getCandidateMap()) {
    if (memberKey === MAIN_CHAR_MEMBER_KEY) {
        return String(getContext()?.name2 || '{{char}}').trim() || '{{char}}';
    }
    return candidateMap.get(memberKey)?.label || String(memberKey || '').trim();
}

function getAvatarForMember(memberKey, candidateMap = getCandidateMap()) {
    return candidateMap.get(memberKey)?.avatar || '';
}

function isMainCharInRoom(room) {
    return Array.isArray(room?.members) && room.members.includes(MAIN_CHAR_MEMBER_KEY);
}

function getRoomTitle(room, candidateMap = getCandidateMap()) {
    const explicitName = String(room?.name || '').trim();
    if (explicitName) return explicitName;
    const labels = (Array.isArray(room?.members) ? room.members : []).map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
    return buildMessengerRoomName(labels);
}

function formatRelativeTime(timestamp) {
    const time = Number(timestamp) || Date.now();
    const diffMs = Math.max(0, Date.now() - time);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '방금';
    if (diffMin < 60) return `${diffMin}분`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}시간`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay}일`;
    return new Date(time).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}

function appendRoomMessage(room, message) {
    const nextRoom = {
        ...room,
        messages: [...room.messages, message].slice(-ROOM_MESSAGE_STORAGE_LIMIT),
        updatedAt: Number(message?.timestamp) || Date.now(),
    };
    return upsertMessengerRoom(nextRoom);
}

function buildRoomTranscript(room, candidateMap) {
    const messages = Array.isArray(room?.messages) ? room.messages.slice(-ROOM_MESSAGE_LIMIT) : [];
    return messages.map((message) => {
        const author = String(message?.authorName || getMemberDisplayLabel(message?.authorKey, candidateMap) || '{{user}}').trim();
        return `[room] ${author}: ${normalizeRoomPromptText(message?.text || '')}`;
    }).join('\n');
}

function pickRandomResponders(room) {
    const members = Array.isArray(room?.members) ? room.members.filter(Boolean) : [];
    if (members.length === 0) return [];
    const pool = [...members];
    const responders = [];
    const maxResponses = Math.max(1, Math.min(3, Number(room?.settings?.maxResponses) || ROOM_DEFAULTS.maxResponses));
    const extraProbability = Math.max(0, Math.min(100, Number(room?.settings?.extraResponseProbability) || ROOM_DEFAULTS.extraResponseProbability));

    const first = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    if (!first) return responders;
    responders.push(first);
    while (responders.length < maxResponses && pool.length > 0) {
        if (Math.random() * 100 >= extraProbability) break;
        const next = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        if (!next) break;
        responders.push(next);
    }
    return responders;
}

async function generateRoomReply(room, responderKey, candidateMap) {
    const ctx = getContext();
    if (!ctx) return '';
    const responderName = getMemberDisplayLabel(responderKey, candidateMap);
    const memberLabels = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
    const transcript = buildRoomTranscript(room, candidateMap);
    const latestUserMessage = normalizeRoomPromptText(room.messages[room.messages.length - 1]?.text || '');
    const rosterText = room.members.map((memberKey) => {
        const candidate = candidateMap.get(memberKey);
        const label = getMemberDisplayLabel(memberKey, candidateMap);
        const details = [];
        if (candidate?.relationToUser) details.push(`Relation to {{user}}: ${normalizeRoomPromptText(candidate.relationToUser)}`);
        if (candidate?.description) details.push(`Description: ${normalizeRoomPromptText(candidate.description)}`);
        if (candidate?.personality) details.push(`Speech/personality: ${normalizeRoomPromptText(candidate.personality)}`);
        return `- ${label}${details.length ? ` | ${details.join(' | ')}` : ''}`;
    }).join('\n');
    const otherMembers = memberLabels.filter((label) => label.toLowerCase() !== responderName.toLowerCase());
    const responderProfile = candidateMap.get(responderKey);
    const prompt = [
        `You are writing exactly one iPhone-style messenger room reply as ${responderName}.`,
        'This is a private mobile group room created by {{user}}.',
        '- Reply only as the selected responder. Do not narrate, explain, or write for {{user}}.',
        '- Stay strictly inside this room context. Do not turn it into the main 1:1 chat.',
        '- Keep it to 1-3 short natural chat lines with casual messenger rhythm.',
        '- Never imitate or merge with another member’s persona or tone.',
        '',
        '[Current responder]',
        responderName,
        responderProfile?.relationToUser ? `Relation to {{user}}: ${normalizeRoomPromptText(responderProfile.relationToUser)}` : '',
        responderProfile?.description ? `Description: ${normalizeRoomPromptText(responderProfile.description)}` : '',
        responderProfile?.personality ? `Speech/personality: ${normalizeRoomPromptText(responderProfile.personality)}` : '',
        '',
        '[Other room members]',
        otherMembers.length > 0 ? otherMembers.map((name) => `- ${name}`).join('\n') : '- {{user}} only',
        '',
        '[Room member roster]',
        rosterText || '- {{user}}',
        '',
        '[Recent room recap]',
        transcript || '(no prior room messages)',
        '',
        `[Latest user message]\n${latestUserMessage || '(empty)'}`,
        '',
        `Output only ${responderName}'s next room message.`,
    ].join('\n');

    let rawReply = '';
    if (typeof ctx.generateQuietPrompt === 'function') {
        rawReply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: responderName });
    } else if (typeof ctx.generateRaw === 'function') {
        rawReply = await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true });
    }
    return sanitizeRoomReply(rawReply, responderName, memberLabels);
}

async function generateOutsiderObservation(room, candidateMap) {
    const ctx = getContext();
    if (!ctx) return '';
    const charName = String(ctx?.name2 || '{{char}}').trim();
    const transcript = buildRoomTranscript(room, candidateMap);
    const roomTitle = getRoomTitle(room, candidateMap);
    const memberLabels = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
    const prompt = [
        `You are ${charName}, talking to {{user}} about a messenger room you are NOT a member of.`,
        'You do not know the exact private messages in that room.',
        'You may only speak indirectly, cautiously, and imperfectly based on vibes, public signs, or what {{user}} could have noticed.',
        'Never quote exact unseen messages. Never pretend you read the full room log.',
        'Write exactly one short messenger-style line in Korean.',
        '',
        `[Room title]\n${roomTitle}`,
        '',
        `[Known members]\n${memberLabels.join(', ') || '(unknown)'}`,
        '',
        `[Visible vibe recap for indirect inference only]\n${transcript || '(no visible room activity)'}`,
        '',
        'Output only the indirect observation line.',
    ].join('\n');

    let rawReply = '';
    if (typeof ctx.generateQuietPrompt === 'function') {
        rawReply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: charName });
    } else if (typeof ctx.generateRaw === 'function') {
        rawReply = await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true });
    }
    return sanitizeRoomReply(rawReply, charName, [charName]);
}

async function runRoomAutoReplies(roomId) {
    let room = getMessengerRoomById(roomId);
    if (!room || room.settings?.autoReplyEnabled !== true) return;
    const shouldReply = Math.random() * 100 < (Number(room.settings?.responseProbability) || ROOM_DEFAULTS.responseProbability);
    if (!shouldReply) return;
    const candidateMap = getCandidateMap();
    const responders = pickRandomResponders(room);
    for (const responderKey of responders) {
        const text = await generateRoomReply(room, responderKey, candidateMap);
        if (!text) continue;
        room = appendRoomMessage(room, {
            id: generateId(),
            authorKey: responderKey,
            authorName: getMemberDisplayLabel(responderKey, candidateMap),
            text,
            timestamp: Date.now(),
            type: 'message',
        });
    }
}

function buildAvatarElement(memberKey, candidateMap) {
    const avatar = getAvatarForMember(memberKey, candidateMap);
    const label = getMemberDisplayLabel(memberKey, candidateMap);
    if (avatar) {
        const img = document.createElement('img');
        img.className = 'slm-room-avatar-img';
        img.src = avatar;
        img.alt = label;
        return img;
    }
    const fallback = document.createElement('div');
    fallback.className = 'slm-room-avatar-fallback';
    fallback.textContent = label.slice(0, 1) || '?';
    return fallback;
}

function openRoomCreatePopup(onBack, roomId = null) {
    const existingRoom = roomId ? getMessengerRoomById(roomId) : null;
    const candidateMap = getCandidateMap();
    const candidates = [...candidateMap.values()];
    const selectedKeys = new Set(existingRoom?.members || []);
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form slm-room-create';

    const hint = document.createElement('div');
    hint.className = 'slm-desc';
    hint.textContent = '멤버를 고르면 그 방 안에서만 단톡이 활성화됩니다. {{char}}를 빼면, 바깥에서 본 분위기 정도만 간접적으로 말할 수 있습니다.';
    wrapper.appendChild(hint);

    const nameInput = document.createElement('input');
    nameInput.className = 'slm-input';
    nameInput.type = 'text';
    nameInput.placeholder = '방 이름 (비워두면 멤버 기준 자동 생성)';
    nameInput.value = existingRoom?.name || '';
    wrapper.appendChild(nameInput);

    const list = document.createElement('div');
    list.className = 'slm-room-member-list';
    wrapper.appendChild(list);

    const renderList = () => {
        list.innerHTML = '';
        candidates.forEach((candidate) => {
            const row = document.createElement('label');
            row.className = 'slm-room-member-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedKeys.has(candidate.key);
            checkbox.onchange = () => {
                if (checkbox.checked) selectedKeys.add(candidate.key);
                else selectedKeys.delete(candidate.key);
            };
            const avatarWrap = document.createElement('div');
            avatarWrap.className = 'slm-room-member-avatar';
            avatarWrap.appendChild(buildAvatarElement(candidate.key, candidateMap));
            const textWrap = document.createElement('div');
            textWrap.className = 'slm-room-member-meta';
            const name = document.createElement('div');
            name.className = 'slm-room-member-name';
            name.textContent = candidate.label;
            const subtitle = document.createElement('div');
            subtitle.className = 'slm-room-member-subtitle';
            subtitle.textContent = candidate.subtitle || (candidate.isMainChar ? '현재 {{char}}' : '연락처');
            textWrap.append(name, subtitle);
            row.append(checkbox, avatarWrap, textWrap);
            list.appendChild(row);
        });
    };
    renderList();

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = existingRoom ? '저장' : '방 만들기';
    footer.append(cancelBtn, saveBtn);

    const popupId = roomId ? `messenger-room-edit-${roomId}` : 'messenger-room-create';
    const { close } = createPopup({
        id: popupId,
        title: existingRoom ? '👥 방 편집' : '👥 새 메신저 방',
        content: wrapper,
        footer,
        className: 'slm-room-create-panel',
        onBack,
    });

    cancelBtn.onclick = () => close();
    saveBtn.onclick = () => {
        const members = [...selectedKeys];
        if (members.length === 0) {
            showToast('방 멤버를 1명 이상 골라주세요.', 'warn');
            return;
        }
        const labels = members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
        const room = normalizeMessengerRooms([{
            ...(existingRoom || {}),
            id: existingRoom?.id || generateId(),
            name: String(nameInput.value || '').trim() || buildMessengerRoomName(labels),
            members,
            createdAt: existingRoom?.createdAt || Date.now(),
            updatedAt: Date.now(),
            messages: existingRoom?.messages || [],
            settings: {
                ...ROOM_DEFAULTS,
                ...(existingRoom?.settings || {}),
                autoReplyEnabled: true,
            },
        }])[0];
        upsertMessengerRoom(room);
        close();
        if (existingRoom) {
            openMessengerRoomDetail(room.id, onBack);
        } else {
            openMessengerRoomsPopup(onBack, room.id);
        }
    };
}

function openMessengerRoomDetail(roomId, onBack) {
    const room = getMessengerRoomById(roomId);
    if (!room) {
        showToast('메신저 방을 찾을 수 없습니다.', 'error');
        return;
    }
    const candidateMap = getCandidateMap();
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-room-view';

    const headerMeta = document.createElement('div');
    headerMeta.className = 'slm-room-meta-card';
    const members = document.createElement('div');
    members.className = 'slm-room-member-chips';
    room.members.forEach((memberKey) => {
        const chip = document.createElement('span');
        chip.className = 'slm-room-chip';
        chip.textContent = getMemberDisplayLabel(memberKey, candidateMap);
        members.appendChild(chip);
    });
    const metaText = document.createElement('div');
    metaText.className = 'slm-desc';
    metaText.textContent = isMainCharInRoom(room)
        ? '이 방에는 {{char}}가 포함되어 있어 직접 참가자처럼 답할 수 있습니다.'
        : '{{char}}는 이 방 멤버가 아니므로, 정확한 대화 내용 대신 바깥에서 본 분위기만 간접적으로 말할 수 있습니다.';
    headerMeta.append(members, metaText);
    wrapper.appendChild(headerMeta);

    const actions = document.createElement('div');
    actions.className = 'slm-btn-row';
    if (!isMainCharInRoom(room)) {
        const insightBtn = document.createElement('button');
        insightBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
        insightBtn.textContent = '👀 {{char}}의 간접 의견';
        insightBtn.onclick = async () => {
            insightBtn.disabled = true;
            try {
                const freshRoom = getMessengerRoomById(roomId);
                const text = await generateOutsiderObservation(freshRoom, candidateMap);
                if (!text) {
                    showToast('간접 의견을 만들지 못했습니다.', 'warn');
                    return;
                }
                appendRoomMessage(freshRoom, {
                    id: generateId(),
                    authorKey: MAIN_CHAR_MEMBER_KEY,
                    authorName: String(getContext()?.name2 || '{{char}}').trim() || '{{char}}',
                    text,
                    timestamp: Date.now(),
                    type: 'outsider',
                });
                renderMessages();
            } catch (error) {
                console.error('[ST-LifeSim] 메신저 방 간접 의견 생성 오류:', error);
                showToast('간접 의견 생성 실패', 'error');
            } finally {
                insightBtn.disabled = false;
            }
        };
        actions.appendChild(insightBtn);
    }
    const editBtn = document.createElement('button');
    editBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
    editBtn.textContent = '✏️ 멤버 편집';
    editBtn.onclick = () => openRoomCreatePopup(() => openMessengerRoomDetail(roomId, onBack), roomId);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'slm-btn slm-btn-danger slm-btn-sm';
    deleteBtn.textContent = '🗑️ 방 삭제';
    deleteBtn.onclick = async () => {
        const confirmed = await showConfirm('이 메신저 방을 삭제할까요?', '삭제', '취소');
        if (!confirmed) return;
        deleteMessengerRoom(roomId);
        closePopup(`messenger-room-${roomId}`);
        openMessengerRoomsPopup(onBack);
    };
    actions.append(editBtn, deleteBtn);
    wrapper.appendChild(actions);

    const messageList = document.createElement('div');
    messageList.className = 'slm-room-message-list';
    wrapper.appendChild(messageList);

    const footer = document.createElement('div');
    footer.className = 'slm-room-composer';
    const input = document.createElement('textarea');
    input.className = 'slm-textarea slm-room-textarea';
    input.rows = 2;
    input.placeholder = '메시지를 입력하세요...';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'slm-btn slm-btn-primary';
    sendBtn.textContent = '전송';
    footer.append(input, sendBtn);

    function renderMessages() {
        const freshRoom = getMessengerRoomById(roomId);
        messageList.innerHTML = '';
        if (!freshRoom?.messages?.length) {
            const empty = document.createElement('div');
            empty.className = 'slm-empty';
            empty.textContent = '아직 이 방에 메시지가 없습니다. 첫 메시지를 보내 보세요.';
            messageList.appendChild(empty);
            return;
        }
        freshRoom.messages.forEach((message) => {
            const isUser = message.authorKey === USER_MEMBER_KEY;
            const row = document.createElement('div');
            row.className = `slm-room-message${isUser ? ' user' : ''}${message.type === 'outsider' ? ' outsider' : ''}`;
            const avatar = document.createElement('div');
            avatar.className = 'slm-room-message-avatar';
            const avatarKey = isUser ? USER_MEMBER_KEY : (message.authorKey || '');
            if (isUser) {
                const fallback = document.createElement('div');
                fallback.className = 'slm-room-avatar-fallback';
                fallback.textContent = String(getContext()?.name1 || '{{user}}').trim().slice(0, 1) || 'U';
                avatar.appendChild(fallback);
            } else {
                avatar.appendChild(buildAvatarElement(avatarKey, candidateMap));
            }
            const bubbleWrap = document.createElement('div');
            bubbleWrap.className = 'slm-room-bubble-wrap';
            const author = document.createElement('div');
            author.className = 'slm-room-message-author';
            author.textContent = isUser ? String(getContext()?.name1 || '{{user}}') : String(message.authorName || getMemberDisplayLabel(message.authorKey, candidateMap));
            const bubble = document.createElement('div');
            bubble.className = 'slm-room-message-bubble';
            bubble.textContent = message.text;
            const time = document.createElement('div');
            time.className = 'slm-room-message-time';
            time.textContent = formatRelativeTime(message.timestamp);
            bubbleWrap.append(author, bubble, time);
            if (isUser) row.append(bubbleWrap, avatar);
            else row.append(avatar, bubbleWrap);
            messageList.appendChild(row);
        });
        messageList.scrollTop = messageList.scrollHeight;
    }

    sendBtn.onclick = async () => {
        const text = normalizeRoomPromptText(input.value);
        if (!text) return;
        const freshRoom = getMessengerRoomById(roomId);
        input.value = '';
        sendBtn.disabled = true;
        input.disabled = true;
        appendRoomMessage(freshRoom, {
            id: generateId(),
            authorKey: USER_MEMBER_KEY,
            authorName: String(getContext()?.name1 || '{{user}}').trim() || '{{user}}',
            text,
            timestamp: Date.now(),
            type: 'message',
        });
        renderMessages();
        try {
            await runRoomAutoReplies(roomId);
        } catch (error) {
            console.error('[ST-LifeSim] 메신저 방 자동 응답 오류:', error);
            showToast('메신저 방 응답 생성 실패', 'error');
        } finally {
            sendBtn.disabled = false;
            input.disabled = false;
            input.focus();
            renderMessages();
        }
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!sendBtn.disabled) sendBtn.click();
        }
    });

    renderMessages();
    closePopup('messenger-rooms');
    createPopup({
        id: `messenger-room-${roomId}`,
        title: getRoomTitle(room, candidateMap),
        content: wrapper,
        footer,
        className: 'slm-room-detail-panel',
        onBack: () => openMessengerRoomsPopup(onBack, roomId),
    });
}

function buildRoomListContent(onBack, initialRoomId = null) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-room-list';

    const hero = document.createElement('div');
    hero.className = 'slm-room-hero';
    hero.textContent = '아이폰 메신저처럼 별도 방을 만들고, 그 방 멤버 안에서만 단톡이 흐르도록 분리했습니다.';
    wrapper.appendChild(hero);

    const search = document.createElement('input');
    search.className = 'slm-input';
    search.type = 'search';
    search.placeholder = '🔍 방 이름 / 멤버 검색';
    wrapper.appendChild(search);

    const list = document.createElement('div');
    list.className = 'slm-room-cards';
    wrapper.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer slm-room-list-footer';
    const createBtn = document.createElement('button');
    createBtn.className = 'slm-btn slm-btn-primary';
    createBtn.textContent = '+ 새 메신저 방';
    createBtn.onclick = () => openRoomCreatePopup(() => openMessengerRoomsPopup(onBack, initialRoomId));
    const latestBtn = document.createElement('button');
    latestBtn.className = 'slm-btn slm-btn-secondary';
    latestBtn.textContent = '🕘 최근 방 열기';
    latestBtn.onclick = async () => {
        const rooms = loadMessengerRooms();
        if (rooms.length === 0) {
            showToast('열 수 있는 방이 없습니다.', 'warn');
            return;
        }
        openMessengerRoomDetail(rooms[0].id, onBack);
    };
    footer.append(createBtn, latestBtn);
    wrapper.appendChild(footer);

    function renderRooms() {
        const query = String(search.value || '').trim().toLowerCase();
        const candidateMap = getCandidateMap();
        const rooms = loadMessengerRooms().filter((room) => {
            if (!query) return true;
            const haystack = [
                room.name,
                getRoomTitle(room, candidateMap),
                ...room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap)),
            ].join(' ').toLowerCase();
            return haystack.includes(query);
        });
        list.innerHTML = '';
        if (rooms.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'slm-empty slm-room-empty';
            empty.textContent = '아직 메신저 방이 없습니다. 새 방을 만들어 단톡을 분리해 보세요.';
            list.appendChild(empty);
            return;
        }
        rooms.forEach((room) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = `slm-room-card${initialRoomId && room.id === initialRoomId ? ' active' : ''}`;
            const title = document.createElement('div');
            title.className = 'slm-room-card-title';
            title.textContent = getRoomTitle(room, candidateMap);
            const subtitle = document.createElement('div');
            subtitle.className = 'slm-room-card-subtitle';
            subtitle.textContent = room.messages[room.messages.length - 1]?.text || '아직 메시지가 없습니다.';
            const meta = document.createElement('div');
            meta.className = 'slm-room-card-meta';
            const members = document.createElement('span');
            members.textContent = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap)).join(', ');
            const time = document.createElement('span');
            time.textContent = formatRelativeTime(room.updatedAt);
            meta.append(members, time);
            card.append(title, subtitle, meta);
            card.onclick = () => openMessengerRoomDetail(room.id, onBack);
            list.appendChild(card);
        });
    }

    search.oninput = renderRooms;
    renderRooms();
    return wrapper;
}

export function openMessengerRoomsPopup(onBack, initialRoomId = null) {
    const content = buildRoomListContent(onBack, initialRoomId);
    closePopup('messenger-rooms');
    createPopup({
        id: 'messenger-rooms',
        title: '💬 메신저 방',
        content,
        className: 'slm-room-list-panel',
        onBack,
    });
}
