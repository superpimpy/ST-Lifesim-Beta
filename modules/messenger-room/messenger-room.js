import { getContext } from '../../utils/st-context.js';
import { getDefaultBinding, getExtensionSettings, loadData, saveData } from '../../utils/storage.js';
import { injectContext, registerContextBuilder } from '../../utils/context-inject.js';
import { createPopup, closePopup } from '../../utils/popup.js';
import { getAllContacts, getAppearanceTagsByName, getContacts } from '../contacts/contacts.js';
import { generateBackendText } from '../../utils/backend-generation.js';
import { buildAiEmoticonContext, replaceAiSelectedEmoticons, buildEmoticonMessageHtml, buildEmoticonPickerContent } from '../emoticon/emoticon.js';
import { translateTextToKorean } from '../sns/sns.js';
import { buildDirectImagePrompt } from '../../utils/image-tag-generator.js';
import { runSdImageGeneration } from '../../utils/slash.js';
import { applyProfileImageStyle, normalizeProfileImageStyle, readImageFileAsDataUrl } from '../../utils/profile-image.js';
import { escapeHtml, generateId, showConfirm, showToast } from '../../utils/ui.js';

const MODULE_KEY = 'messenger-rooms';
const MAIN_CHAR_MEMBER_KEY = '__main_char__';
const USER_MEMBER_KEY = '__user__';
const CONTACT_MEMBER_KEY_PREFIX = 'contact:';
const ROOM_MESSAGE_LIMIT = 18;
const ROOM_MESSAGE_STORAGE_LIMIT = 80;
const ROOM_AUTONOMY_DELAY_MIN_MS = 2500;
const ROOM_AUTONOMY_DELAY_MAX_MS = 6500;
const ROOM_IMAGE_TEXT_TEMPLATE_DEFAULT = '[사진: {description}]';
const ROOM_ICON_GROUP = '👥';
const ROOM_ICON_DIRECT = '💬';
const ROOM_IMAGE_ON_PROMPT = '<image_generation_rule>\nWhen the responder would realistically take and send a photo in this room, insert a <pic prompt="concise English Danbooru-style tags"> tag.\nOnly use <pic> for photos the responder could actually take with their phone.\nNo narration, mood shots, or third-person views.\nRules:\n1) <pic prompt="..."> must already be final direct image tags.\n2) Format must be exactly "scene tags | Character 1: appearance tags | Character 2: appearance tags" with the double quotes included.\n3) Use "Character N:" labels, not actual names, for appearance blocks.\n4) Use explicit count tags such as 1girl, 1boy, 2girls, 2boys; never generic people-count tags.\n5) If three or more characters appear, include group shot.\n6) Preserve any weighted tags or special syntax such as 2::tag::, -2::tag::, or 3::tag:: exactly as written.\n7) Keep core appearance tags such as hair, eyes, and outfit when they are available for included characters.\n8) No Korean, explanations, markdown, or prose.\n</image_generation_rule>';
const ROOM_IMAGE_OFF_PROMPT = '<image_generation_rule>\nWhen the responder would realistically take and send a photo in this room, insert a <pic prompt="short Korean photo description"> tag.\nOnly use <pic> for photos the responder could actually take with their phone.\nNo narration, mood shots, or third-person views.\n</image_generation_rule>';
const ROOM_PIC_TAG_REGEX = /<?pic\s+[^>\n]*?\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s*\/?\s*>)?/gi;
const ROOM_EMOTICON_ONLY_HTML_REGEX = /^<img\b[^>]*aria-label="[^"]*이모티콘[^"]*"[^>]*>$/i;
const ROOM_EMOTICON_TOKEN_ONLY_REGEX = /^\s*\[\[\s*emoticon\s*:\s*[^\]]+\s*\]\]\s*$/i;
const ROOM_REPLY_TOAST_DURATION_MS = 2600;
const ROOM_DEFAULTS = {
    autoReplyEnabled: true,
    responseProbability: 100,
    extraResponseProbability: 35,
    maxResponses: 2,
    contextEnabled: false,
    autonomyEnabled: false,
    autonomyIntervalSec: 30,
    autonomyProbability: 15,
};
const ROOM_BINDINGS = ['chat', 'character'];
const ROOM_AVATAR_DEFAULTS = { width: 48, height: 48, scale: 100, positionX: 50, positionY: 50 };
const ROOM_AVATAR_PREVIEW_DEFAULTS = { width: 72, height: 72, scale: 100, positionX: 50, positionY: 50 };
const roomAutoReplyState = new Map();
const roomAutonomyState = new Map();
/** 방 목록 팝업이 열려 있을 때 실시간 갱신용 렌더러 참조 */
let _activeRoomListRenderer = null;

function normalizeRoomBinding(binding) {
    return binding === 'character' ? 'character' : 'chat';
}

function buildContactMemberKey(contact) {
    const id = String(contact?.id || '').trim();
    if (!id) return '';
    const binding = normalizeRoomBinding(contact?.binding || 'chat');
    return `${CONTACT_MEMBER_KEY_PREFIX}${binding}:${id}`;
}

function buildCandidateAliases(candidate = {}) {
    const aliases = [
        candidate.key,
        candidate.legacyKey,
        candidate.label,
        candidate.name,
        candidate.displayName,
        candidate.subName,
        candidate.isMainChar ? MAIN_CHAR_MEMBER_KEY : '',
    ];
    return [...new Set(aliases.map((value) => String(value || '').trim()).filter(Boolean))];
}

function getMemberCandidates() {
    const ctx = getContext();
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const key = String(candidate?.key || '').trim();
        const label = String(candidate?.label || '').trim();
        if (!key || !label || seen.has(key.toLowerCase())) return;
        seen.add(key.toLowerCase());
        candidates.push({
            ...candidate,
            key,
            label,
            aliases: buildCandidateAliases({ ...candidate, key, label }),
        });
    };

    const contacts = [...getContacts('character'), ...getContacts('chat')];
    const mainCharName = String(ctx?.name2 || '').trim();
    const mainCharContact = contacts.find((contact) => contact?.isCharAuto === true && String(contact?.name || '').trim() === mainCharName) || null;

    if (mainCharContact) {
        pushCandidate({
            key: buildContactMemberKey(mainCharContact),
            legacyKey: MAIN_CHAR_MEMBER_KEY,
            name: mainCharContact.name,
            displayName: mainCharContact.displayName,
            subName: mainCharContact.subName,
            label: String(mainCharContact.displayName || mainCharContact.name || mainCharName).trim(),
            subtitle: String(mainCharContact.relationToUser || '주요 캐릭터').trim(),
            avatar: String(mainCharContact.avatar || '').trim(),
            avatarStyle: mainCharContact.avatarStyle || null,
            isMainChar: true,
            description: String(mainCharContact.description || '').trim(),
            personality: String(mainCharContact.personality || '').trim(),
            relationToUser: String(mainCharContact.relationToUser || '').trim(),
        });
    } else if (mainCharName) {
        pushCandidate({
            key: MAIN_CHAR_MEMBER_KEY,
            label: mainCharName,
            subtitle: '현재 {{char}}',
            avatar: '',
            avatarStyle: null,
            isMainChar: true,
            description: '',
            personality: '',
            relationToUser: '',
        });
    }

    contacts.forEach((contact) => {
        if (contact?.isUserAuto) return;
        if (contact?.isCharAuto && buildContactMemberKey(contact) === buildContactMemberKey(mainCharContact)) return;
        const label = String(contact?.displayName || contact?.name || '').trim();
        const key = buildContactMemberKey(contact);
        if (!label || !key) return;
        pushCandidate({
            key,
            name: contact?.name,
            displayName: contact?.displayName,
            subName: contact?.subName,
            label,
            subtitle: String(contact?.relationToUser || contact?.description || '').trim(),
            avatar: String(contact?.avatar || '').trim(),
            avatarStyle: contact?.avatarStyle || null,
            isMainChar: contact?.isCharAuto === true,
            description: String(contact?.description || '').trim(),
            personality: String(contact?.personality || '').trim(),
            relationToUser: String(contact?.relationToUser || '').trim(),
        });
    });

    return candidates;
}

function getCandidateMap() {
    const map = new Map();
    getMemberCandidates().forEach((candidate) => {
        candidate.aliases.forEach((alias) => {
            map.set(alias, candidate);
            map.set(alias.toLowerCase(), candidate);
        });
    });
    return map;
}

function normalizeRoomMemberKey(memberKey, candidateMap = getCandidateMap()) {
    const normalized = String(memberKey || '').trim();
    if (!normalized) return '';
    return candidateMap.get(normalized)?.key || candidateMap.get(normalized.toLowerCase())?.key || normalized;
}

/**
 * Normalize messenger-room records loaded from storage.
 * @param {Array} rooms
 * @returns {Array}
 */
export function normalizeMessengerRooms(rooms = [], binding = 'chat') {
    if (!Array.isArray(rooms)) return [];
    const candidateMap = getCandidateMap();
    return rooms
        .map((room) => {
            const members = Array.isArray(room?.members)
                ? [...new Set(room.members
                    .map((member) => normalizeRoomMemberKey(member, candidateMap))
                    .filter(Boolean))]
                : [];
            const messages = Array.isArray(room?.messages)
                ? room.messages.map((message) => ({
                    id: String(message?.id || generateId()),
                    authorKey: String(message?.authorKey || '').trim(),
                    authorName: String(message?.authorName || '').trim(),
                    text: String(message?.text || '').trim(),
                    html: String(message?.html || '').trim(),
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
                categories: normalizeCategoryList(room?.categories),
                members,
                binding: normalizeRoomBinding(room?.binding || binding),
                avatar: String(room?.avatar || '').trim(),
                avatarStyle: normalizeProfileImageStyle(room?.avatarStyle, ROOM_AVATAR_DEFAULTS),
                createdAt,
                updatedAt,
                messages,
                settings: normalizeRoomSettings(room?.settings),
            };
        })
        .filter((room) => room.members.length > 0)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function normalizeRoomSettings(settings = {}) {
    const next = {
        ...ROOM_DEFAULTS,
        ...(settings && typeof settings === 'object' ? settings : {}),
    };
    next.autoReplyEnabled = next.autoReplyEnabled !== false;
    next.contextEnabled = next.contextEnabled === true;
    next.autonomyEnabled = next.autonomyEnabled === true;
    next.responseProbability = clampRoomPercentage(next.responseProbability, ROOM_DEFAULTS.responseProbability);
    next.extraResponseProbability = clampRoomPercentage(next.extraResponseProbability, ROOM_DEFAULTS.extraResponseProbability);
    next.maxResponses = clampRoomResponseCount(next.maxResponses, ROOM_DEFAULTS.maxResponses);
    next.autonomyIntervalSec = Math.max(5, Math.min(3600, Number.parseInt(next.autonomyIntervalSec, 10) || ROOM_DEFAULTS.autonomyIntervalSec));
    next.autonomyProbability = clampRoomPercentage(next.autonomyProbability, ROOM_DEFAULTS.autonomyProbability);
    return next;
}

function normalizeCategoryList(categories) {
    if (!Array.isArray(categories)) return [];
    return [...new Set(categories.map((category) => String(category || '').trim()).filter(Boolean))];
}

function parseCategoryInput(value) {
    return normalizeCategoryList(String(value || '').split(','));
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

function loadMessengerRooms(binding = null) {
    if (binding && ROOM_BINDINGS.includes(binding)) {
        const stored = loadData(MODULE_KEY, { rooms: [] }, binding);
        return normalizeMessengerRooms(stored?.rooms || [], binding);
    }
    const merged = new Map();
    ROOM_BINDINGS.forEach((scope) => {
        loadMessengerRooms(scope).forEach((room) => {
            const existing = merged.get(room.id);
            if (!existing || Number(room.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
                merged.set(room.id, room);
            }
        });
    });
    return normalizeMessengerRooms([...merged.values()]);
}

function saveMessengerRooms(rooms, binding = 'chat') {
    return saveData(MODULE_KEY, { rooms: normalizeMessengerRooms(rooms, binding) }, binding);
}

function refreshMessengerRoomContext() {
    void injectContext().catch((error) => console.error('[ST-LifeSim] 메신저 방 컨텍스트 주입 오류:', error));
}

function upsertMessengerRoom(nextRoom) {
    const room = normalizeMessengerRooms([nextRoom], nextRoom?.binding || 'chat')[0];
    if (!room) return null;
    ROOM_BINDINGS.forEach((binding) => {
        const rooms = loadMessengerRooms(binding).filter((entry) => entry.id !== room.id);
        if (binding === room.binding) rooms.push(room);
        saveMessengerRooms(rooms, binding);
    });
    ensureRoomAutonomySchedule(room.id);
    refreshMessengerRoomContext();
    return room;
}

function deleteMessengerRoom(roomId) {
    clearRoomAutoReplySchedule(roomId);
    clearRoomAutonomySchedule(roomId);
    ROOM_BINDINGS.forEach((binding) => {
        const nextRooms = loadMessengerRooms(binding).filter((room) => room.id !== roomId);
        saveMessengerRooms(nextRooms, binding);
    });
    refreshMessengerRoomContext();
}

function getMessengerRoomById(roomId) {
    return loadMessengerRooms().find((room) => room.id === roomId) || null;
}

function normalizeRoomPromptText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[<>{}\[\]]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .trim();
}

function normalizeRoomGeneratedReplyText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getRoomUiSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'] || {};
    return {
        hideHelperText: ext.hideHelperText === true,
    };
}

function clampRoomPercentage(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, parsed));
}

function clampRoomResponseCount(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(3, parsed));
}

function normalizeQuotesForRoomPicTag(text) {
    return String(text || '')
        .replace(/[\u201C\u201D\u201E\u201F\uFF02]/g, '"')
        .replace(/[\u2018\u2019\u201A\u201B\uFF07]/g, "'")
        .replace(/&lt;(\s*pic\s+[^\n]*?prompt\s*=\s*)&quot;([^\n]*?)&quot;(\s*\/?\s*)&gt;/gi, '<$1"$2"$3>')
        .replace(/&lt;(\s*pic\s+[^\n]*?prompt\s*=\s*)&quot;([^\n]*?)&quot;/gi, '<$1"$2"')
        .replace(/`(<?\s*pic\s+[^`\n]*?prompt\s*=\s*(?:"[^"]*"|'[^']*')(?:\s*\/?\s*>)?)`/gi, '$1');
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeRoomReply(text, responderName, memberLabels = []) {
    let cleaned = normalizeRoomGeneratedReplyText(text);
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

function buildRoomMessageHtml(text, senderName, tagReplacementMap = null) {
    const source = String(text || '');
    const escaped = escapeHtml(source);
    if (!escaped) return '';
    const paragraphs = escaped
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
    const renderParagraph = (paragraph) => paragraph
        .split('\n')
        .map((line) => line || '&nbsp;')
        .join('<br>');
    const html = paragraphs.length > 1
        ? `<div class="slm-room-message-segments">${paragraphs.map((paragraph) => `<span class="slm-room-message-segment">${renderParagraph(paragraph)}</span>`).join('')}</div>`
        : renderParagraph(escaped);
    return replaceAiSelectedEmoticons(html, senderName, tagReplacementMap);
}

function isSegmentedRoomMessageHtml(html) {
    return /slm-room-message-segments/.test(String(html || ''));
}

function isEmoticonOnlyRoomMessageHtml(html) {
    return ROOM_EMOTICON_ONLY_HTML_REGEX.test(String(html || '').trim());
}

function getTranslatableRoomMessageText(message) {
    const text = normalizeRoomGeneratedReplyText(message?.text || '');
    if (!text || ROOM_EMOTICON_TOKEN_ONLY_REGEX.test(text)) return '';
    return text;
}

function getMemberDisplayLabel(memberKey, candidateMap = getCandidateMap()) {
    const normalizedKey = normalizeRoomMemberKey(memberKey, candidateMap);
    if (normalizedKey === MAIN_CHAR_MEMBER_KEY) {
        return String(getContext()?.name2 || '{{char}}').trim() || '{{char}}';
    }
    return candidateMap.get(normalizedKey)?.label || String(memberKey || '').trim();
}

function getAvatarForMember(memberKey, candidateMap = getCandidateMap()) {
    return candidateMap.get(normalizeRoomMemberKey(memberKey, candidateMap))?.avatar || '';
}

function isMainCharInRoom(room) {
    const candidateMap = getCandidateMap();
    return Array.isArray(room?.members) && room.members.some((memberKey) => candidateMap.get(normalizeRoomMemberKey(memberKey, candidateMap))?.isMainChar === true);
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

function replaceRoomMessage(roomId, messageId, updater) {
    const room = getMessengerRoomById(roomId);
    if (!room) return null;
    const nextMessages = room.messages.map((message) => {
        if (message.id !== messageId) return message;
        const updated = typeof updater === 'function'
            ? updater(message)
            : (updater && typeof updater === 'object' ? updater : null);
        return {
            ...message,
            ...(updated && typeof updated === 'object' ? updated : {}),
        };
    });
    return upsertMessengerRoom({
        ...room,
        messages: nextMessages,
        updatedAt: Date.now(),
    });
}

function removeRoomMessage(roomId, messageId) {
    const room = getMessengerRoomById(roomId);
    if (!room) return null;
    return upsertMessengerRoom({
        ...room,
        messages: room.messages.filter((message) => message.id !== messageId),
        updatedAt: Date.now(),
    });
}

function getRoomAutoReplyDelay() {
    return ROOM_AUTONOMY_DELAY_MIN_MS + Math.floor(Math.random() * (ROOM_AUTONOMY_DELAY_MAX_MS - ROOM_AUTONOMY_DELAY_MIN_MS));
}

function clearRoomAutoReplySchedule(roomId) {
    const state = roomAutoReplyState.get(roomId);
    if (state?.timerId) clearTimeout(state.timerId);
    roomAutoReplyState.delete(roomId);
}

function clearRoomAutonomySchedule(roomId) {
    const state = roomAutonomyState.get(roomId);
    if (state?.timerId) clearTimeout(state.timerId);
    roomAutonomyState.delete(roomId);
}

function ensureRoomAutonomySchedule(roomId, onUpdate = null) {
    const room = getMessengerRoomById(roomId);
    if (!room) {
        clearRoomAutonomySchedule(roomId);
        return;
    }
    const settings = normalizeRoomSettings(room.settings);
    if (!settings.autonomyEnabled) {
        clearRoomAutonomySchedule(roomId);
        return;
    }
    const intervalMs = Math.max(5000, settings.autonomyIntervalSec * 1000);
    const existing = roomAutonomyState.get(roomId);
    if (existing?.timerId) clearTimeout(existing.timerId);
    const state = {
        onUpdate: typeof onUpdate === 'function' ? onUpdate : existing?.onUpdate || null,
        timerId: null,
    };
    roomAutonomyState.set(roomId, state);
    state.timerId = setTimeout(async function tick() {
        const latestRoom = getMessengerRoomById(roomId);
        if (!latestRoom) {
            clearRoomAutonomySchedule(roomId);
            return;
        }
        const latestSettings = normalizeRoomSettings(latestRoom.settings);
        if (!latestSettings.autonomyEnabled) {
            clearRoomAutonomySchedule(roomId);
            return;
        }
        if (!roomAutoReplyState.has(roomId) && Math.random() * 100 < latestSettings.autonomyProbability) {
            void runRoomAutoReplies(roomId, state.onUpdate, { forceFirstReply: true });
        }
        ensureRoomAutonomySchedule(roomId, state.onUpdate);
    }, intervalMs);
}

function getContactMemberKey(contact) {
    return buildContactMemberKey(contact);
}

function getRoomContactMemberKeys(room) {
    const candidateMap = getCandidateMap();
    return (Array.isArray(room?.members) ? room.members : [])
        .map((memberKey) => normalizeRoomMemberKey(memberKey, candidateMap))
        .filter((memberKey) => memberKey && memberKey !== USER_MEMBER_KEY);
}

function findDirectMessengerRoom(memberKey, binding = null) {
    const candidateMap = getCandidateMap();
    const normalizedKey = normalizeRoomMemberKey(memberKey, candidateMap).toLowerCase();
    if (!normalizedKey) return null;
    return loadMessengerRooms(binding).find((room) => {
        const contactMembers = getRoomContactMemberKeys(room)
            .map((entry) => normalizeRoomMemberKey(entry, candidateMap).toLowerCase())
            .filter(Boolean);
        return contactMembers.length === 1 && contactMembers[0] === normalizedKey;
    }) || null;
}

function getRoomRepresentativeCandidate(room, candidateMap = getCandidateMap()) {
    const contactMembers = getRoomContactMemberKeys(room)
        .map((memberKey) => candidateMap.get(normalizeRoomMemberKey(memberKey, candidateMap)))
        .filter(Boolean);
    if (contactMembers.length !== 1) return null;
    return contactMembers[0];
}

function isGroupMessengerRoom(room) {
    return getRoomContactMemberKeys(room).length > 1;
}

function getRoomAvatarSource(room, candidateMap = getCandidateMap()) {
    const directCandidate = getRoomRepresentativeCandidate(room, candidateMap);
    if (directCandidate?.avatar) {
        return {
            avatar: directCandidate.avatar,
            avatarStyle: directCandidate.avatarStyle || null,
            label: directCandidate.label,
        };
    }
    const roomAvatar = String(room?.avatar || '').trim();
    if (roomAvatar) {
        return {
            avatar: roomAvatar,
            avatarStyle: room?.avatarStyle || null,
            label: getRoomTitle(room, candidateMap),
        };
    }
    return null;
}

function buildRoomCardIcon(room, candidateMap = getCandidateMap()) {
    const icon = document.createElement('div');
    icon.className = 'slm-room-card-icon';
    const avatarSource = getRoomAvatarSource(room, candidateMap);
    if (avatarSource?.avatar) {
        const img = document.createElement('img');
        img.className = 'slm-room-card-icon-image';
        img.src = avatarSource.avatar;
        img.alt = avatarSource.label || getRoomTitle(room, candidateMap);
        applyProfileImageStyle(
            icon,
            img,
            avatarSource.avatarStyle,
            ROOM_AVATAR_DEFAULTS,
        );
        icon.appendChild(img);
        return icon;
    }
    icon.textContent = isGroupMessengerRoom(room) ? ROOM_ICON_GROUP : ROOM_ICON_DIRECT;
    return icon;
}

function buildRoomReplyToastContent(room, senderLabel, messageText, candidateMap = getCandidateMap()) {
    const container = document.createElement('div');
    container.className = 'slm-room-reply-toast';

    const avatar = document.createElement('div');
    avatar.className = 'slm-room-reply-toast-avatar';
    const avatarSource = getRoomAvatarSource(room, candidateMap);
    if (avatarSource?.avatar) {
        const img = document.createElement('img');
        img.className = 'slm-room-reply-toast-avatar-image';
        img.src = avatarSource.avatar;
        img.alt = avatarSource.label || getRoomTitle(room, candidateMap);
        applyProfileImageStyle(
            avatar,
            img,
            avatarSource.avatarStyle,
            ROOM_AVATAR_DEFAULTS,
        );
        avatar.appendChild(img);
    } else {
        avatar.textContent = isGroupMessengerRoom(room) ? ROOM_ICON_GROUP : ROOM_ICON_DIRECT;
    }

    const body = document.createElement('div');
    body.className = 'slm-room-reply-toast-body';

    const title = document.createElement('div');
    title.className = 'slm-room-reply-toast-title';
    title.textContent = getRoomTitle(room, candidateMap);

    const preview = document.createElement('div');
    preview.className = 'slm-room-reply-toast-preview';
    preview.textContent = `${senderLabel}: ${messageText}`;

    body.append(title, preview);
    container.append(avatar, body);
    return container;
}

export function openDirectMessengerWithContact(contact, onBack) {
    if (!contact || contact.isUserAuto || contact.isCharAuto) {
        showToast('NPC 연락처에서만 1:1 메신저를 시작할 수 있습니다.', 'warn');
        return null;
    }
    const memberKey = getContactMemberKey(contact);
    if (!memberKey) {
        showToast('대화를 시작할 연락처를 찾을 수 없습니다.', 'warn');
        return null;
    }
    const candidateMap = getCandidateMap();
    if (!candidateMap.has(memberKey)) {
        showToast('현재 메신저 멤버 후보에 없는 연락처입니다.', 'warn');
        return null;
    }
    const roomBinding = normalizeRoomBinding(contact?.binding || getDefaultBinding());
    const existingRoom = findDirectMessengerRoom(memberKey, roomBinding);
    const room = existingRoom || normalizeMessengerRooms([{
        id: generateId(),
        name: `${getMemberDisplayLabel(memberKey, candidateMap)} 개인톡`,
        categories: normalizeCategoryList(contact?.categories),
        members: [memberKey],
        binding: roomBinding,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        settings: {
            ...ROOM_DEFAULTS,
            autoReplyEnabled: true,
        },
    }])[0];
    if (!existingRoom) {
        upsertMessengerRoom(room);
    }
    closePopup('messenger-rooms');
    openMessengerRoomDetail(room.id, onBack);
    return room;
}

function openRoomSettingsPopup(roomId, options = {}) {
    const room = getMessengerRoomById(roomId);
    if (!room) {
        showToast('메신저 방을 찾을 수 없습니다.', 'warn');
        return;
    }
    const roomSettings = normalizeRoomSettings(room.settings);
    const isGroupRoom = isGroupMessengerRoom(room);
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';

    const intro = document.createElement('div');
    intro.className = 'slm-room-meta-card';
    intro.innerHTML = `
        <div class="slm-label">이 방 설정</div>
        <div class="slm-desc">이 방의 컨텍스트 반영과 자동대화 빈도를 한눈에 조정합니다.</div>
    `;
    wrapper.appendChild(intro);

    const contextCard = document.createElement('div');
    contextCard.className = 'slm-room-meta-card';
    const contextTitle = document.createElement('div');
    contextTitle.className = 'slm-label';
    contextTitle.textContent = '컨텍스트 반영';
    const contextToggle = document.createElement('label');
    contextToggle.className = 'slm-toggle-label';
    const contextCheck = document.createElement('input');
    contextCheck.type = 'checkbox';
    contextCheck.checked = roomSettings.contextEnabled === true;
    contextToggle.append(contextCheck, document.createTextNode(' 메인 대화 컨텍스트에 이 방 포함'));
    const contextDesc = document.createElement('div');
    contextDesc.className = 'slm-desc';
    contextDesc.textContent = isMainCharInRoom(room)
        ? '{{char}}가 이 방 멤버이므로, 켜 두면 메인 대화에서도 이 방 관련 내용을 자연스럽게 참조할 수 있습니다.'
        : '{{char}}가 이 방 멤버가 아니면, 켜 두더라도 정확한 로그 대신 분위기나 정황만 간접 반영합니다.';
    contextCard.append(contextTitle, contextToggle, contextDesc);
    wrapper.appendChild(contextCard);

    const replyCard = document.createElement('div');
    replyCard.className = 'slm-room-meta-card';
    const replyTitle = document.createElement('div');
    replyTitle.className = 'slm-label';
    replyTitle.textContent = '유저 입력 후 자동대화';
    const autoReplyToggle = document.createElement('label');
    autoReplyToggle.className = 'slm-toggle-label';
    const autoReplyCheck = document.createElement('input');
    autoReplyCheck.type = 'checkbox';
    autoReplyCheck.checked = roomSettings.autoReplyEnabled !== false;
    autoReplyToggle.append(autoReplyCheck, document.createTextNode(' 유저 메시지 뒤 AI 응답 자동 생성'));
    const replyDesc = document.createElement('div');
    replyDesc.className = 'slm-desc';
    replyDesc.textContent = '첫 응답 확률, 추가 응답 확률, 최대 연속 응답 수를 읽기 쉽게 한곳에 모았습니다.';
    const replyGrid = document.createElement('div');
    replyGrid.className = 'slm-input-row';
    replyGrid.style.alignItems = 'center';
    replyGrid.style.flexWrap = 'wrap';
    const responseProbabilityInput = Object.assign(document.createElement('input'), {
        className: 'slm-input slm-input-sm',
        type: 'number',
        min: '0',
        max: '100',
        value: String(roomSettings.responseProbability),
    });
    responseProbabilityInput.style.width = '74px';
    const extraResponseProbabilityInput = Object.assign(document.createElement('input'), {
        className: 'slm-input slm-input-sm',
        type: 'number',
        min: '0',
        max: '100',
        value: String(roomSettings.extraResponseProbability),
    });
    extraResponseProbabilityInput.style.width = '74px';
    const maxResponsesInput = Object.assign(document.createElement('input'), {
        className: 'slm-input slm-input-sm',
        type: 'number',
        min: '1',
        max: '3',
        value: String(roomSettings.maxResponses),
    });
    maxResponsesInput.style.width = '68px';
    replyGrid.append(
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '첫 응답(%)' }),
        responseProbabilityInput,
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '추가 응답(%)' }),
        extraResponseProbabilityInput,
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '최대 응답' }),
        maxResponsesInput,
    );
    replyCard.append(replyTitle, autoReplyToggle, replyDesc, replyGrid);
    wrapper.appendChild(replyCard);

    const autonomyCard = document.createElement('div');
    autonomyCard.className = 'slm-room-meta-card';
    const autonomyTitle = document.createElement('div');
    autonomyTitle.className = 'slm-label';
    autonomyTitle.textContent = '방 자체 자동대화';
    const autonomyToggle = document.createElement('label');
    autonomyToggle.className = 'slm-toggle-label';
    const autonomyCheck = document.createElement('input');
    autonomyCheck.type = 'checkbox';
    autonomyCheck.checked = roomSettings.autonomyEnabled === true;
    autonomyToggle.append(autonomyCheck, document.createTextNode(isGroupRoom ? ' 자유대화 자동 발생' : ' 선톡 자동 발생'));
    const autonomyDesc = document.createElement('div');
    autonomyDesc.className = 'slm-desc';
    autonomyDesc.textContent = isGroupRoom
        ? '유저가 가만히 있어도 이 그룹방이 일정 시간마다 스스로 굴러갑니다.'
        : '유저가 먼저 입력하지 않아도 이 1:1 방에서 먼저 말을 걸 수 있습니다.';
    const autonomyGrid = document.createElement('div');
    autonomyGrid.className = 'slm-input-row';
    autonomyGrid.style.alignItems = 'center';
    autonomyGrid.style.flexWrap = 'wrap';
    const autonomyIntervalInput = Object.assign(document.createElement('input'), {
        className: 'slm-input slm-input-sm',
        type: 'number',
        min: '5',
        max: '3600',
        value: String(roomSettings.autonomyIntervalSec),
    });
    autonomyIntervalInput.style.width = '88px';
    const autonomyProbabilityInput = Object.assign(document.createElement('input'), {
        className: 'slm-input slm-input-sm',
        type: 'number',
        min: '0',
        max: '100',
        value: String(roomSettings.autonomyProbability),
    });
    autonomyProbabilityInput.style.width = '74px';
    autonomyGrid.append(
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '간격(초)' }),
        autonomyIntervalInput,
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '발생 확률(%)' }),
        autonomyProbabilityInput,
    );
    autonomyCard.append(autonomyTitle, autonomyToggle, autonomyDesc, autonomyGrid);
    wrapper.appendChild(autonomyCard);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = '저장';
    footer.append(cancelBtn, saveBtn);

    const { close } = createPopup({
        id: `messenger-room-settings-${roomId}`,
        title: '⚙️ 방 설정',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
    });
    cancelBtn.onclick = () => close();
    saveBtn.onclick = () => {
        const freshRoom = getMessengerRoomById(roomId);
        if (!freshRoom) {
            showToast('메신저 방을 찾을 수 없습니다.', 'warn');
            return;
        }
        const nextRoom = upsertMessengerRoom({
            ...freshRoom,
            settings: {
                ...normalizeRoomSettings(freshRoom.settings),
                contextEnabled: contextCheck.checked,
                autoReplyEnabled: autoReplyCheck.checked,
                responseProbability: clampRoomPercentage(responseProbabilityInput.value, ROOM_DEFAULTS.responseProbability),
                extraResponseProbability: clampRoomPercentage(extraResponseProbabilityInput.value, ROOM_DEFAULTS.extraResponseProbability),
                maxResponses: clampRoomResponseCount(maxResponsesInput.value, ROOM_DEFAULTS.maxResponses),
                autonomyEnabled: autonomyCheck.checked,
                autonomyIntervalSec: Math.max(5, Math.min(3600, Number.parseInt(autonomyIntervalInput.value, 10) || ROOM_DEFAULTS.autonomyIntervalSec)),
                autonomyProbability: clampRoomPercentage(autonomyProbabilityInput.value, ROOM_DEFAULTS.autonomyProbability),
            },
        });
        if (!nextRoom) {
            showToast('방 설정 저장 실패', 'error');
            return;
        }
        ensureRoomAutonomySchedule(roomId, options.onUpdate);
        options.onSave?.(nextRoom);
        showToast('방 설정 저장', 'success', 1200);
        close();
    };
}

function buildRoomTranscript(room, candidateMap) {
    const messages = Array.isArray(room?.messages) ? room.messages.slice(-ROOM_MESSAGE_LIMIT) : [];
    return messages.map((message) => {
        const author = String(message?.authorName || getMemberDisplayLabel(message?.authorKey, candidateMap) || '{{user}}').trim();
        return `[room] ${author}: ${normalizeRoomPromptText(message?.text || '')}`;
    }).join('\n');
}

function buildMessengerRoomsContextSection() {
    const candidateMap = getCandidateMap();
    const rooms = loadMessengerRooms()
        .filter((room) => normalizeRoomSettings(room.settings).contextEnabled === true)
        .filter((room) => Array.isArray(room?.messages) && room.messages.length > 0);
    if (rooms.length === 0) return '';
    const sections = rooms.map((room) => {
        const transcript = buildRoomTranscript({
            ...room,
            messages: room.messages.slice(-6),
        }, candidateMap);
        const memberText = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap)).join(', ') || '(unknown)';
        const directMention = isMainCharInRoom(room);
        const contextRule = directMention
            ? '- {{char}} belongs to this room, so {{char}} may naturally mention related room events or topics to {{user}} when relevant, while still keeping the main 1:1 chat separate from the room itself.'
            : '- {{char}} is NOT a member of this room (including NPC private chats or outsider group chats), so {{char}} must never claim full access to unseen logs. {{char}} may only mention it indirectly, cautiously, or as an impression/vibe.';
        return [
            `[Messenger Room Context: ${getRoomTitle(room, candidateMap)}]`,
            `Members: ${memberText}`,
            contextRule,
            '[Recent room recap]',
            transcript || '(no recent room messages)',
        ].join('\n');
    });
    return sections.join('\n\n');
}

function getRoomImageSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'] || {};
    return {
        messageImageGenerationMode: ext.messageImageGenerationMode === true,
        messageImageTextTemplate: String(ext.messageImageTextTemplate || ROOM_IMAGE_TEXT_TEMPLATE_DEFAULT),
        messageImageInjectionPrompt: String(ext.messageImageInjectionPrompt || '').trim(),
        tagWeight: Number(ext.tagWeight) || 0,
    };
}

function isNameMentionedInRoomText(textLower, name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return false;
    if (/^[a-z0-9_]+$/i.test(normalized)) {
        const re = new RegExp(`(^|[^a-z0-9_])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`, 'i');
        return re.test(textLower);
    }
    return textLower.includes(normalized);
}

function collectMentionedRoomContactNames(text, contacts = []) {
    const textLower = String(text || '').toLowerCase();
    if (!textLower) return [];
    const names = [];
    const seen = new Set();
    contacts.forEach((contact) => {
        const aliases = [contact?.name, contact?.displayName, contact?.subName]
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        if (!aliases.length || !aliases.some((alias) => isNameMentionedInRoomText(textLower, alias))) return;
        const canonicalName = String(contact?.name || contact?.displayName || '').trim();
        const key = canonicalName.toLowerCase();
        if (!canonicalName || seen.has(key)) return;
        seen.add(key);
        names.push(canonicalName);
    });
    return names;
}

async function generateRoomMessageImageViaApi(imagePrompt) {
    if (!imagePrompt || !imagePrompt.trim()) return '';
    const ctx = getContext();
    if (!ctx) return '';
    return await runSdImageGeneration(imagePrompt, { ctx, retries: 2, retryDelayMs: 500, timeoutMs: 25000 });
}

async function enrichRoomReplyContent(rawText, senderName, room, candidateMap) {
    const settings = getRoomImageSettings();
    const allContactsList = getAllContacts();
    const normalizedSource = normalizeQuotesForRoomPicTag(String(rawText || ''));
    let processedText = normalizedSource;
    const imageTagReplacementEntries = [];
    const transcript = buildRoomTranscript(room, candidateMap);
    const userName = String(getContext()?.name1 || '').trim();
    ROOM_PIC_TAG_REGEX.lastIndex = 0;
    const picMatches = [...normalizedSource.matchAll(ROOM_PIC_TAG_REGEX)];
    if (picMatches.length > 0) {
        const replacements = [];
        for (const match of picMatches.slice(0, 3)) {
            const fullTag = match[0];
            const rawPrompt = String(match[1] || match[2] || '').trim();
            let replacement = '';
            if (rawPrompt) {
                if (settings.messageImageGenerationMode) {
                    const includeNames = [senderName];
                    collectMentionedRoomContactNames(`${transcript}\n${rawPrompt}`, allContactsList).forEach((name) => {
                        if (name && !includeNames.includes(name)) includeNames.push(name);
                    });
                    const userHintRegex = /\buser\b|{{user}}|유저|너|당신|with user|together|둘이|함께/;
                    if (userName && userHintRegex.test(rawPrompt.toLowerCase())) includeNames.push(userName);
                    const tagResult = buildDirectImagePrompt(rawPrompt, {
                        includeNames,
                        contacts: allContactsList,
                        getAppearanceTagsByName,
                        tagWeight: settings.tagWeight,
                    });
                    const imageUrl = tagResult.finalPrompt ? await generateRoomMessageImageViaApi(tagResult.finalPrompt) : '';
                    if (imageUrl) {
                        const safeUrl = escapeHtml(imageUrl);
                        const safePrompt = escapeHtml(rawPrompt);
                        imageTagReplacementEntries.push([fullTag, `<img src="${safeUrl}" title="${safePrompt}" alt="${safePrompt}" class="slm-msg-generated-image" style="max-width:100%;border-radius:var(--slm-image-radius,10px);margin:4px 0">`]);
                        replacement = fullTag;
                    }
                }
                if (!replacement) {
                    replacement = settings.messageImageTextTemplate.replace(/\{description\}/g, rawPrompt);
                }
            }
            replacements.push({ index: match.index, length: fullTag.length, replacement });
        }
        if (replacements.length > 0) {
            let offset = 0;
            replacements.forEach(({ index, length, replacement }) => {
                const adjusted = index + offset;
                processedText = processedText.slice(0, adjusted) + replacement + processedText.slice(adjusted + length);
                offset += replacement.length - length;
            });
        }
    }
    const html = buildRoomMessageHtml(processedText, senderName, imageTagReplacementEntries);
    const plainText = processedText
        .replace(/<?pic\s+[^>\n]*?\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s*\/?\s*>)?/gi, ' [사진] ')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .join('\n')
        .trim();
    return {
        text: plainText || normalizeRoomPromptText(rawText),
        html: html !== plainText ? html : '',
    };
}

function pickRandomResponders(room) {
    const members = Array.isArray(room?.members) ? room.members.filter(Boolean) : [];
    if (members.length === 0) return [];
    const pool = [...members];
    const responders = [];
    const maxResponses = clampRoomResponseCount(room?.settings?.maxResponses, ROOM_DEFAULTS.maxResponses);
    const extraProbability = clampRoomPercentage(room?.settings?.extraResponseProbability, ROOM_DEFAULTS.extraResponseProbability);

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
    const imageSettings = getRoomImageSettings();
    const responderName = getMemberDisplayLabel(responderKey, candidateMap);
    const memberLabels = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
    const transcript = buildRoomTranscript(room, candidateMap);
    const latestUserMessage = normalizeRoomPromptText(room.messages[room.messages.length - 1]?.text || '');
    const emoticonContext = buildAiEmoticonContext(responderName);
    const rosterText = room.members.map((memberKey) => {
        const candidate = candidateMap.get(normalizeRoomMemberKey(memberKey, candidateMap));
        const label = getMemberDisplayLabel(memberKey, candidateMap);
        const details = [];
        if (candidate?.relationToUser) details.push(`Relation to {{user}}: ${normalizeRoomPromptText(candidate.relationToUser)}`);
        if (candidate?.description) details.push(`Description: ${normalizeRoomPromptText(candidate.description)}`);
        if (candidate?.personality) details.push(`Speech/personality: ${normalizeRoomPromptText(candidate.personality)}`);
        return `- ${label}${details.length ? ` | ${details.join(' | ')}` : ''}`;
    }).join('\n');
    const otherMembers = memberLabels.filter((label) => label.toLowerCase() !== responderName.toLowerCase());
    const responderProfile = candidateMap.get(normalizeRoomMemberKey(responderKey, candidateMap));
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
        emoticonContext,
        '',
        imageSettings.messageImageGenerationMode
            ? (imageSettings.messageImageInjectionPrompt || ROOM_IMAGE_ON_PROMPT)
            : ROOM_IMAGE_OFF_PROMPT,
        '',
        `Output only ${responderName}'s next room message.`,
    ].join('\n');

    const rawReply = await generateBackendText({ ctx, prompt, quietName: responderName });
    const sanitizedReply = sanitizeRoomReply(rawReply, responderName, memberLabels);
    if (!sanitizedReply) return '';
    return enrichRoomReplyContent(sanitizedReply, responderName, room, candidateMap);
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

    const rawReply = await generateBackendText({ ctx, prompt, quietName: charName });
    return sanitizeRoomReply(rawReply, charName, [charName]);
}

async function runRoomAutoReplies(roomId, onUpdate = null, options = {}) {
    clearRoomAutoReplySchedule(roomId);
    const room = getMessengerRoomById(roomId);
    if (!room || room.settings?.autoReplyEnabled !== true) return;
    const scheduleToken = generateId();
    const maxResponses = clampRoomResponseCount(room.settings?.maxResponses, ROOM_DEFAULTS.maxResponses);
    const scheduleAttempt = (usedResponders = []) => {
        const state = roomAutoReplyState.get(roomId);
        if (!state || state.token !== scheduleToken) return;
        state.timerId = setTimeout(async () => {
            const latestState = roomAutoReplyState.get(roomId);
            if (!latestState || latestState.token !== scheduleToken) return;
            try {
                let freshRoom = getMessengerRoomById(roomId);
                if (!freshRoom || freshRoom.settings?.autoReplyEnabled !== true) {
                    clearRoomAutoReplySchedule(roomId);
                    return;
                }
                const probability = usedResponders.length === 0
                    ? (options.forceFirstReply
                        ? 100
                        : clampRoomPercentage(freshRoom.settings?.responseProbability, ROOM_DEFAULTS.responseProbability))
                    : clampRoomPercentage(freshRoom.settings?.extraResponseProbability, ROOM_DEFAULTS.extraResponseProbability);
                if (Math.random() * 100 >= probability) {
                    clearRoomAutoReplySchedule(roomId);
                    return;
                }
                const availableResponders = freshRoom.members.filter((memberKey) => !usedResponders.includes(memberKey));
                const responderKey = availableResponders[Math.floor(Math.random() * availableResponders.length)];
                if (!responderKey) {
                    clearRoomAutoReplySchedule(roomId);
                    return;
                }
                const candidateMap = getCandidateMap();
                const reply = await generateRoomReply(freshRoom, responderKey, candidateMap);
                if (reply?.text) {
                    freshRoom = appendRoomMessage(freshRoom, {
                        id: generateId(),
                        authorKey: responderKey,
                        authorName: getMemberDisplayLabel(responderKey, candidateMap),
                        text: reply.text,
                        html: reply.html || '',
                        timestamp: Date.now(),
                        type: 'message',
                    });
                    const replyPreview = String(reply.text || '').replace(/\s+/g, ' ').trim();
                    if (replyPreview) {
                        const senderLabel = getMemberDisplayLabel(responderKey, candidateMap);
                        showToast(buildRoomReplyToastContent(freshRoom, senderLabel, replyPreview, candidateMap), 'info', ROOM_REPLY_TOAST_DURATION_MS);
                    }
                    latestState.onUpdate?.(freshRoom);
                    _activeRoomListRenderer?.();
                    const nextResponders = [...usedResponders, responderKey];
                    if (nextResponders.length < maxResponses) {
                        scheduleAttempt(nextResponders);
                        return;
                    }
                }
            } catch (error) {
                console.error('[ST-LifeSim] 메신저 방 자동 응답 오류:', error);
                showToast('메신저 방 응답 생성 실패', 'error');
            }
            clearRoomAutoReplySchedule(roomId);
        }, getRoomAutoReplyDelay());
    };
    roomAutoReplyState.set(roomId, { token: scheduleToken, timerId: null, onUpdate });
    scheduleAttempt([]);
}

function buildAvatarElement(memberKey, candidateMap) {
    const normalizedKey = normalizeRoomMemberKey(memberKey, candidateMap);
    const candidate = candidateMap.get(normalizedKey);
    const avatar = getAvatarForMember(normalizedKey, candidateMap);
    const label = getMemberDisplayLabel(normalizedKey, candidateMap);
    if (avatar) {
        const img = document.createElement('img');
        img.className = 'slm-room-avatar-img';
        img.src = avatar;
        img.alt = label;
        applyProfileImageStyle(
            null,
            img,
            candidate?.avatarStyle,
            { width: 32, height: 32, scale: 100, positionX: 50, positionY: 50 },
        );
        return img;
    }
    const fallback = document.createElement('div');
    fallback.className = 'slm-room-avatar-fallback';
    fallback.textContent = label.slice(0, 1) || '?';
    return fallback;
}

function renderRoomMessageBubbleContent(message, bubble) {
    if (!bubble) return;
    if (message?.html) {
        bubble.innerHTML = message.html;
        bubble.classList.toggle('multiline', isSegmentedRoomMessageHtml(message.html));
        bubble.classList.toggle('emoticon-only', isEmoticonOnlyRoomMessageHtml(message.html));
        return;
    }
    const senderName = String(message?.authorName || getContext()?.name1 || '{{user}}').trim() || '{{user}}';
    const html = buildRoomMessageHtml(String(message?.text || ''), senderName);
    bubble.innerHTML = html;
    bubble.classList.toggle('multiline', isSegmentedRoomMessageHtml(html));
    bubble.classList.toggle('emoticon-only', isEmoticonOnlyRoomMessageHtml(html));
}

function openRoomMessageEditPopup(roomId, messageId, onBack, onSaved) {
    const room = getMessengerRoomById(roomId);
    const message = room?.messages?.find((entry) => entry.id === messageId);
    if (!room || !message) {
        showToast('편집할 메시지를 찾지 못했습니다.', 'warn');
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';
    const input = document.createElement('textarea');
    input.className = 'slm-textarea';
    input.rows = 5;
    input.value = message.text || '';
    wrapper.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'slm-btn slm-btn-secondary';
    cancelBtn.textContent = '취소';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'slm-btn slm-btn-primary';
    saveBtn.textContent = '저장';
    footer.append(cancelBtn, saveBtn);

    const popupId = `messenger-room-message-edit-${messageId}`;
    const { close } = createPopup({
        id: popupId,
        title: '메시지 편집',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack,
    });
    input.focus();
    cancelBtn.onclick = () => close();
    saveBtn.onclick = async () => {
        const nextText = normalizeRoomGeneratedReplyText(input.value);
        if (!nextText) {
            showToast('메시지를 비울 수 없습니다. 삭제 기능을 사용해주세요.', 'warn');
            return;
        }
        saveBtn.disabled = true;
        try {
            const freshRoom = getMessengerRoomById(roomId);
            const candidateMap = getCandidateMap();
            const enriched = await enrichRoomReplyContent(nextText, message.authorName || getMemberDisplayLabel(message.authorKey, candidateMap), freshRoom || room, candidateMap);
            replaceRoomMessage(roomId, messageId, {
                text: enriched?.text || nextText,
                html: enriched?.html || '',
            });
            close();
            onSaved?.();
        } catch (error) {
            console.error('[ST-LifeSim] 메신저 방 메시지 편집 오류:', error);
            showToast('메시지 편집 실패', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    };
}

function openRoomEmoticonPicker(roomId, onBack, onSend) {
    const userName = String(getContext()?.name1 || '{{user}}').trim() || '{{user}}';
    const wrapper = buildEmoticonPickerContent({
        readOnly: true,
        senderName: userName,
        showAiPolicy: false,
        showFooter: false,
        helperText: '기존 이모티콘 탭과 같은 방식으로 카테고리를 전환한 뒤, 보낼 이모티콘을 선택하세요.',
        emptyText: '조건에 맞는 이모티콘이 없습니다.',
        onSelect: (emoticon) => {
            close();
            onSend?.(emoticon);
        },
    });

    const footer = document.createElement('div');
    footer.className = 'slm-panel-footer';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'slm-btn slm-btn-secondary';
    closeBtn.textContent = '닫기';
    footer.appendChild(closeBtn);

    const { close } = createPopup({
        id: `messenger-room-emoticon-${roomId}`,
        title: '😊 이모티콘 보내기',
        content: wrapper,
        footer,
        className: 'slm-sub-panel',
        onBack,
    });
    closeBtn.onclick = () => close();
}

function openRoomCreatePopup(onBack, roomId = null) {
    const existingRoom = roomId ? getMessengerRoomById(roomId) : null;
    const candidates = getMemberCandidates();
    const candidateMap = getCandidateMap();
    const selectedKeys = new Set((existingRoom?.members || []).map((memberKey) => normalizeRoomMemberKey(memberKey, candidateMap)).filter(Boolean));
    let selectedBinding = normalizeRoomBinding(existingRoom?.binding || getDefaultBinding());
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form slm-room-create';

    if (!getRoomUiSettings().hideHelperText) {
        const hint = document.createElement('div');
        hint.className = 'slm-desc';
        hint.textContent = '멤버를 고르면 그 방 안에서만 단톡이 활성화됩니다. {{char}}를 빼면, 바깥에서 본 분위기 정도만 간접적으로 말할 수 있습니다.';
        wrapper.appendChild(hint);
    }

    const nameInput = document.createElement('input');
    nameInput.className = 'slm-input';
    nameInput.type = 'text';
    nameInput.placeholder = '방 이름 (비워두면 멤버 기준 자동 생성)';
    nameInput.value = existingRoom?.name || '';
    wrapper.appendChild(nameInput);
    const categoryInput = document.createElement('input');
    categoryInput.className = 'slm-input';
    categoryInput.type = 'text';
    categoryInput.placeholder = '카테고리 (쉼표로 구분)';
    categoryInput.value = normalizeCategoryList(existingRoom?.categories).join(', ');
    wrapper.appendChild(categoryInput);

    const bindingLabel = document.createElement('label');
    bindingLabel.className = 'slm-label';
    bindingLabel.textContent = '저장 범위';
    const bindingSelect = document.createElement('select');
    bindingSelect.className = 'slm-select';
    bindingSelect.innerHTML = `
        <option value="chat"${selectedBinding === 'chat' ? ' selected' : ''}>이 채팅에만 저장</option>
        <option value="character"${selectedBinding === 'character' ? ' selected' : ''}>채팅을 새로 파도 유지</option>
    `;
    bindingSelect.onchange = () => {
        selectedBinding = normalizeRoomBinding(bindingSelect.value);
    };
    wrapper.append(bindingLabel, bindingSelect);

    const avatarInput = document.createElement('input');
    avatarInput.className = 'slm-input';
    avatarInput.type = 'text';
    avatarInput.placeholder = '그룹 대표사진 데이터';
    avatarInput.value = String(existingRoom?.avatar || '').trim();
    avatarInput.style.display = 'none';
    wrapper.appendChild(avatarInput);

    const initialAvatarStyle = normalizeProfileImageStyle(existingRoom?.avatarStyle, ROOM_AVATAR_PREVIEW_DEFAULTS);
    const avatarActionLabel = Object.assign(document.createElement('label'), { className: 'slm-label', textContent: '그룹 대표사진 (선택)' });
    const avatarActionRow = document.createElement('div');
    avatarActionRow.className = 'slm-input-row';
    avatarActionRow.style.marginTop = '2px';
    const avatarUploadInput = document.createElement('input');
    avatarUploadInput.type = 'file';
    avatarUploadInput.accept = 'image/*';
    avatarUploadInput.style.display = 'none';
    const avatarUploadBtn = document.createElement('button');
    avatarUploadBtn.type = 'button';
    avatarUploadBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    avatarUploadBtn.textContent = '📁 로컬 이미지 업로드';
    const avatarClearBtn = document.createElement('button');
    avatarClearBtn.type = 'button';
    avatarClearBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
    avatarClearBtn.textContent = '🧹 대표사진 비우기';
    avatarActionRow.append(avatarUploadBtn, avatarClearBtn, avatarUploadInput);
    const avatarNote = document.createElement('div');
    avatarNote.className = 'slm-desc';
    const avatarPreview = document.createElement('div');
    avatarPreview.className = 'slm-contact-detail-avatar';
    avatarPreview.style.marginBottom = '8px';
    const avatarCropRow = document.createElement('div');
    avatarCropRow.className = 'slm-input-row';
    avatarCropRow.style.marginBottom = '8px';
    avatarCropRow.style.alignItems = 'center';
    avatarCropRow.style.flexWrap = 'wrap';
    const avatarScaleInput = Object.assign(document.createElement('input'), {
        className: 'slm-input',
        type: 'range',
        min: '100',
        max: '400',
        step: '1',
        value: String(initialAvatarStyle.scale),
    });
    avatarScaleInput.style.width = '140px';
    const avatarPositionXInput = Object.assign(document.createElement('input'), {
        className: 'slm-input',
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: String(initialAvatarStyle.positionX),
    });
    avatarPositionXInput.style.width = '140px';
    const avatarPositionYInput = Object.assign(document.createElement('input'), {
        className: 'slm-input',
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        value: String(initialAvatarStyle.positionY),
    });
    avatarPositionYInput.style.width = '140px';
    avatarCropRow.append(
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '확대' }),
        avatarScaleInput,
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '좌우 이동' }),
        avatarPositionXInput,
        Object.assign(document.createElement('span'), { className: 'slm-label', textContent: '상하 이동' }),
        avatarPositionYInput,
    );
    wrapper.append(avatarActionLabel, avatarActionRow, avatarNote, avatarPreview, avatarCropRow);

    const getDraftAvatarStyle = () => normalizeProfileImageStyle({
        scale: avatarScaleInput.value,
        positionX: avatarPositionXInput.value,
        positionY: avatarPositionYInput.value,
    }, ROOM_AVATAR_PREVIEW_DEFAULTS);

    const updateAvatarControls = () => {
        const contactMemberCount = getRoomContactMemberKeys({ members: [...selectedKeys] }).length;
        const isDirectRoom = contactMemberCount === 1;
        avatarUploadBtn.disabled = isDirectRoom;
        avatarClearBtn.disabled = isDirectRoom;
        avatarScaleInput.disabled = isDirectRoom;
        avatarPositionXInput.disabled = isDirectRoom;
        avatarPositionYInput.disabled = isDirectRoom;
        avatarNote.textContent = isDirectRoom
            ? 'NPC 1:1 방은 해당 연락처의 대표사진과 크롭 설정을 그대로 사용합니다.'
            : '그룹 메신저 방은 로컬 이미지를 대표사진으로 등록할 수 있습니다.';
    };

    const renderAvatarPreview = () => {
        avatarPreview.innerHTML = '';
        const previewRoom = { members: [...selectedKeys], avatar: avatarInput.value.trim(), avatarStyle: getDraftAvatarStyle() };
        const avatarSource = getRoomAvatarSource(previewRoom, candidateMap);
        if (avatarSource?.avatar) {
            const img = document.createElement('img');
            img.src = avatarSource.avatar;
            img.alt = avatarSource.label || 'room avatar preview';
            applyProfileImageStyle(avatarPreview, img, avatarSource.avatarStyle, ROOM_AVATAR_PREVIEW_DEFAULTS);
            avatarPreview.appendChild(img);
        } else {
            const fallback = isGroupMessengerRoom(previewRoom) ? ROOM_ICON_GROUP : ROOM_ICON_DIRECT;
            applyProfileImageStyle(avatarPreview, null, getDraftAvatarStyle(), ROOM_AVATAR_PREVIEW_DEFAULTS);
            avatarPreview.textContent = fallback;
        }
        updateAvatarControls();
    };

    avatarUploadBtn.onclick = () => avatarUploadInput.click();
    avatarClearBtn.onclick = () => {
        avatarInput.value = '';
        avatarUploadInput.value = '';
        renderAvatarPreview();
    };
    avatarUploadInput.onchange = async (event) => {
        const file = event.target?.files?.[0];
        if (!file) return;
        try {
            avatarInput.value = await readImageFileAsDataUrl(file);
            renderAvatarPreview();
        } catch (error) {
            showToast(error.message || '이미지 업로드 실패', 'error');
        } finally {
            avatarUploadInput.value = '';
        }
    };
    avatarScaleInput.addEventListener('input', renderAvatarPreview);
    avatarPositionXInput.addEventListener('input', renderAvatarPreview);
    avatarPositionYInput.addEventListener('input', renderAvatarPreview);

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
                renderAvatarPreview();
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
    renderAvatarPreview();

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
            categories: parseCategoryInput(categoryInput.value),
            members,
            binding: selectedBinding,
            avatar: avatarInput.value.trim(),
            avatarStyle: getDraftAvatarStyle(),
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

    if (!getRoomUiSettings().hideHelperText) {
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
        if (normalizeCategoryList(room.categories).length > 0) {
            const categoryChips = document.createElement('div');
            categoryChips.className = 'slm-room-member-chips';
            normalizeCategoryList(room.categories).forEach((category) => {
                const chip = document.createElement('span');
                chip.className = 'slm-room-chip';
                chip.textContent = `#${category}`;
                categoryChips.appendChild(chip);
            });
            headerMeta.appendChild(categoryChips);
        }
        wrapper.appendChild(headerMeta);
    }

    const actions = document.createElement('div');
    actions.className = 'slm-btn-row';
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
        clearRoomAutoReplySchedule(roomId);
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
    const emoticonBtn = document.createElement('button');
    emoticonBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm';
    emoticonBtn.textContent = '😊';
    emoticonBtn.title = '이모티콘 보내기';
    const input = document.createElement('textarea');
    input.className = 'slm-textarea slm-room-textarea';
    input.rows = 2;
    input.placeholder = '메시지를 입력하세요...';
    const quickSendBtn = document.createElement('button');
    quickSendBtn.className = 'slm-btn slm-btn-secondary slm-btn-sm slm-room-quick-send';
    quickSendBtn.textContent = '퀵';
    quickSendBtn.title = '응답 요청 없이 전송';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'slm-btn slm-btn-primary';
    sendBtn.textContent = '전송';
    footer.append(emoticonBtn, input, quickSendBtn, sendBtn);

    const updateComposerState = () => {
        // Send button is always enabled to allow triggering AI responses even with empty input
        sendBtn.disabled = false;
        quickSendBtn.disabled = false;
    };

    const submitRoomMessage = (options = {}) => {
        const text = normalizeRoomPromptText(input.value);
        input.value = '';
        if (text) {
            appendUserRoomMessage({ text }, options);
        } else {
            // Empty message: trigger AI auto-replies without appending a user message
            if (options.skipAutoReply !== true) {
                void runRoomAutoReplies(roomId, () => {
                    if (messageList.isConnected) renderMessages();
                });
            }
        }
        updateComposerState();
        input.focus();
        renderMessages();
    };

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
            renderRoomMessageBubbleContent(message, bubble);
            bubbleWrap.append(author, bubble);
            const actions = document.createElement('div');
            actions.className = 'slm-room-message-actions';
            let translationLine = null;
            const translatableText = getTranslatableRoomMessageText(message);
            if (translatableText) {
                const translateBtn = document.createElement('button');
                translateBtn.type = 'button';
                translateBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
                translateBtn.textContent = '번역';
                translateBtn.onclick = async () => {
                    if (translationLine) {
                        translationLine.remove();
                        translationLine = null;
                        translateBtn.textContent = '번역';
                        return;
                    }
                    translateBtn.disabled = true;
                    try {
                        const translated = await translateTextToKorean(translatableText);
                        if (!translated) {
                            showToast('AI 번역 결과가 비어 있습니다.', 'warn', 1200);
                            return;
                        }
                        translationLine = document.createElement('div');
                        translationLine.className = 'slm-room-message-translation';
                        translationLine.textContent = `🇰🇷 ${translated}`.trim();
                        bubbleWrap.insertBefore(translationLine, actions);
                        translateBtn.textContent = '원문';
                    } catch (error) {
                        console.warn('[ST-LifeSim] 메신저 방 번역 실패:', error);
                        showToast('번역 실패', 'warn', 1200);
                    } finally {
                        translateBtn.disabled = false;
                    }
                };
                actions.appendChild(translateBtn);
            }
            const messageEditBtn = document.createElement('button');
            messageEditBtn.type = 'button';
            messageEditBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            messageEditBtn.textContent = '편집';
            messageEditBtn.onclick = () => openRoomMessageEditPopup(roomId, message.id, () => openMessengerRoomDetail(roomId, onBack), renderMessages);
            const messageDeleteBtn = document.createElement('button');
            messageDeleteBtn.type = 'button';
            messageDeleteBtn.className = 'slm-btn slm-btn-ghost slm-btn-sm';
            messageDeleteBtn.textContent = '삭제';
            messageDeleteBtn.onclick = async () => {
                const confirmed = await showConfirm('이 메시지를 삭제할까요?', '삭제', '취소');
                if (!confirmed) return;
                removeRoomMessage(roomId, message.id);
                renderMessages();
            };
            actions.append(messageEditBtn, messageDeleteBtn);
            bubbleWrap.appendChild(actions);
            if (isUser) row.append(bubbleWrap, avatar);
            else row.append(avatar, bubbleWrap);
            messageList.appendChild(row);
        });
        messageList.scrollTop = messageList.scrollHeight;
    }

    const appendUserRoomMessage = (payload, options = {}) => {
        const freshRoom = getMessengerRoomById(roomId);
        if (!freshRoom) return null;
        const nextRoom = appendRoomMessage(freshRoom, {
            id: generateId(),
            authorKey: USER_MEMBER_KEY,
            authorName: String(getContext()?.name1 || '{{user}}').trim() || '{{user}}',
            text: String(payload?.text || '').trim(),
            html: String(payload?.html || '').trim(),
            timestamp: Date.now(),
            type: 'message',
        });
        renderMessages();
        if (options.skipAutoReply !== true) {
            void runRoomAutoReplies(roomId, () => {
                if (messageList.isConnected) renderMessages();
            });
        }
        return nextRoom;
    };

    sendBtn.onclick = () => submitRoomMessage();

    quickSendBtn.onclick = () => submitRoomMessage({ skipAutoReply: true });

    emoticonBtn.onclick = () => openRoomEmoticonPicker(roomId, () => openMessengerRoomDetail(roomId, onBack), (emoticon) => {
        const userName = String(getContext()?.name1 || '{{user}}').trim() || '{{user}}';
        appendUserRoomMessage({
            text: `[[emoticon:${emoticon.name}]]`,
            html: buildEmoticonMessageHtml(emoticon, userName),
        }, { skipAutoReply: true });
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!sendBtn.disabled) sendBtn.click();
        }
    });
    input.addEventListener('input', updateComposerState);

    renderMessages();
    ensureRoomAutonomySchedule(roomId, () => {
        if (messageList.isConnected) renderMessages();
    });
    updateComposerState();
    closePopup('messenger-rooms');
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'slm-panel-header-action';
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', '방 설정 열기');
    settingsBtn.onclick = () => openRoomSettingsPopup(roomId, {
        onUpdate: () => {
            if (messageList.isConnected) renderMessages();
        },
    });
    createPopup({
        id: `messenger-room-${roomId}`,
        title: getRoomTitle(room, candidateMap),
        content: wrapper,
        footer,
        className: 'slm-room-detail-panel',
        onBack: () => openMessengerRoomsPopup(onBack, roomId),
        headerActions: settingsBtn,
    });
}

function buildRoomListContent(onBack, initialRoomId = null) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-room-list';

    if (!getRoomUiSettings().hideHelperText) {
        const hero = document.createElement('div');
        hero.className = 'slm-room-hero';
        hero.textContent = '아이폰 메신저처럼 별도 방을 만들고, 그 방 멤버 안에서만 단톡이 흐르도록 분리했습니다.';
        wrapper.appendChild(hero);
    }

    // Sub-tabs for filtering 1:1 / Group / All
    let activeTab = 'all';
    const tabBar = document.createElement('div');
    tabBar.className = 'slm-room-tab-bar';
    const tabs = [
        { key: 'all', label: '전체' },
        { key: 'direct', label: '💬 1:1' },
        { key: 'group', label: '👥 그룹' },
    ];
    const tabButtons = {};
    tabs.forEach(({ key, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `slm-room-tab${key === activeTab ? ' active' : ''}`;
        btn.textContent = label;
        btn.onclick = () => {
            activeTab = key;
            Object.values(tabButtons).forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            renderRooms();
        };
        tabButtons[key] = btn;
        tabBar.appendChild(btn);
    });
    wrapper.appendChild(tabBar);

    const search = document.createElement('input');
    search.className = 'slm-input';
    search.type = 'search';
    search.placeholder = '🔍 방 이름 / 멤버 / 카테고리 검색';
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
    const quickDmBtn = document.createElement('button');
    quickDmBtn.className = 'slm-btn slm-btn-secondary';
    quickDmBtn.textContent = '👤 NPC 1:1 시작';
    quickDmBtn.onclick = () => {
        const npcContacts = [];
        const seen = new Set();
        getAllContacts()
            .filter((contact) => !contact?.isUserAuto && !contact?.isCharAuto)
            .forEach((contact) => {
                const key = getContactMemberKey(contact).toLowerCase();
                if (!key || seen.has(key)) return;
                seen.add(key);
                npcContacts.push(contact);
            });
        if (npcContacts.length === 0) {
            showToast('1:1 메신저를 시작할 NPC 연락처가 없습니다.', 'warn');
            return;
        }
        const dialog = document.createElement('div');
        dialog.className = 'slm-form';
        const select = document.createElement('select');
        select.className = 'slm-select';
        npcContacts.forEach((contact) => {
            const option = document.createElement('option');
            option.value = getContactMemberKey(contact);
            option.textContent = String(contact?.displayName || contact?.name || getContactMemberKey(contact)).trim();
            select.appendChild(option);
        });
        if (!getRoomUiSettings().hideHelperText) {
            const hint = document.createElement('div');
            hint.className = 'slm-desc';
            hint.textContent = '연락처에 등록된 NPC와 개인 메신저 방을 바로 엽니다.';
            dialog.append(hint);
        }
        dialog.append(select);
        const dialogFooter = document.createElement('div');
        dialogFooter.className = 'slm-panel-footer';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'slm-btn slm-btn-secondary';
        cancelBtn.textContent = '취소';
        const startBtn = document.createElement('button');
        startBtn.className = 'slm-btn slm-btn-primary';
        startBtn.textContent = '시작';
        dialogFooter.append(cancelBtn, startBtn);
        const { close } = createPopup({
            id: 'messenger-room-direct-start',
            title: '👤 NPC 1:1 메신저',
            content: dialog,
            footer: dialogFooter,
            className: 'slm-sub-panel',
        });
        cancelBtn.onclick = () => close();
        startBtn.onclick = () => {
            const contact = npcContacts.find((entry) => getContactMemberKey(entry) === select.value);
            if (!contact) {
                showToast('선택한 NPC 연락처를 찾지 못했습니다.', 'warn');
                return;
            }
            close();
            openDirectMessengerWithContact(contact, () => openMessengerRoomsPopup(onBack, initialRoomId));
        };
    };
    footer.append(createBtn, latestBtn, quickDmBtn);
    wrapper.appendChild(footer);

    function renderRooms() {
        const query = String(search.value || '').trim().toLowerCase();
        const candidateMap = getCandidateMap();
        const rooms = loadMessengerRooms().filter((room) => {
            if (activeTab === 'direct' && isGroupMessengerRoom(room)) return false;
            if (activeTab === 'group' && !isGroupMessengerRoom(room)) return false;
            if (!query) return true;
            const haystack = [
                room.name,
                getRoomTitle(room, candidateMap),
                ...normalizeCategoryList(room.categories),
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

            const icon = buildRoomCardIcon(room, candidateMap);

            // 오른쪽 본문 영역
            const body = document.createElement('div');
            body.className = 'slm-room-card-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'slm-room-card-title';
            const titleText = document.createElement('span');
            titleText.textContent = getRoomTitle(room, candidateMap);
            titleRow.append(titleText);

            const subtitle = document.createElement('div');
            subtitle.className = 'slm-room-card-subtitle';
            subtitle.textContent = room.messages[room.messages.length - 1]?.text || '아직 메시지가 없습니다.';

            body.append(titleRow, subtitle);
            card.append(icon, body);
            card.onclick = () => openMessengerRoomDetail(room.id, onBack);
            list.appendChild(card);
        });
    }

    search.oninput = renderRooms;
    renderRooms();
    _activeRoomListRenderer = () => { if (list.isConnected) renderRooms(); };
    return wrapper;
}

/**
 * 외부(index.js 등)에서 특정 방에 메시지를 추가한다.
 * 채팅창(/sendas)을 거치지 않고 방 데이터에만 저장하여 채팅창 노출을 방지한다.
 * @param {string} roomId
 * @param {{ authorName: string, text: string, html?: string }} payload
 * @returns {Object|null} 갱신된 방 객체
 */
export function appendExternalRoomMessage(roomId, { authorName, text, html = '' }) {
    const room = getMessengerRoomById(roomId);
    if (!room) return null;
    const candidateMap = getCandidateMap();
    const trimmedAuthor = String(authorName || '').trim();
    const lowerAuthor = trimmedAuthor.toLowerCase();
    const memberKey = room.members.find((key) => {
        const label = getMemberDisplayLabel(key, candidateMap);
        return label.toLowerCase() === lowerAuthor;
    }) || trimmedAuthor;
    const nextRoom = appendRoomMessage(room, {
        id: generateId(),
        authorKey: memberKey,
        authorName: trimmedAuthor,
        text: String(text || '').trim(),
        html: String(html || '').trim(),
        timestamp: Date.now(),
        type: 'message',
    });
    _activeRoomListRenderer?.();
    return nextRoom;
}

/**
 * 방의 최근 메시지를 '[group-room] Speaker: text' 형식 텍스트로 반환한다.
 * 단톡 자동 응답 프롬프트에서 사용한다.
 * @param {string} roomId
 * @param {number} [limit=8]
 * @returns {string}
 */
export function buildRoomTranscriptText(roomId, limit = 8) {
    const room = getMessengerRoomById(roomId);
    if (!room?.messages?.length) return '';
    const candidateMap = getCandidateMap();
    const userName = String(getContext()?.name1 || '{{user}}').trim();
    return room.messages.slice(-limit).map((msg) => {
        const speaker = msg.authorKey === USER_MEMBER_KEY
            ? (userName || '{{user}}')
            : (msg.authorName || getMemberDisplayLabel(msg.authorKey, candidateMap));
        // 마크업/템플릿 구문을 제거하여 프롬프트 오염을 방지한다
        const text = String(msg?.text || '').replace(/[<>{}\[\]]+/g, ' ').replace(/\n/g, ' ').trim();
        return `[group-room] ${speaker}: ${text}`;
    }).join('\n');
}

registerContextBuilder('messenger-room', buildMessengerRoomsContextSection);
queueMicrotask(() => {
    loadMessengerRooms().forEach((room) => ensureRoomAutonomySchedule(room.id));
});

export function openMessengerRoomsPopup(onBack, initialRoomId = null) {
    const content = buildRoomListContent(onBack, initialRoomId);
    closePopup('messenger-rooms');
    createPopup({
        id: 'messenger-rooms',
        title: '💬 메신저 방',
        content,
        className: 'slm-room-list-panel',
        onBack,
        onClose: () => { _activeRoomListRenderer = null; },
    });
}
