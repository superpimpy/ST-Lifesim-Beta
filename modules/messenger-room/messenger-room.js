import { getContext } from '../../utils/st-context.js';
import { getExtensionSettings, loadData, saveData } from '../../utils/storage.js';
import { createPopup, closePopup } from '../../utils/popup.js';
import { getAppearanceTagsByName, getContacts } from '../contacts/contacts.js';
import { buildAiEmoticonContext, replaceAiSelectedEmoticons, getStoredEmoticons, buildEmoticonMessageHtml } from '../emoticon/emoticon.js';
import { translateTextToKorean } from '../sns/sns.js';
import { buildDirectImagePrompt } from '../../utils/image-tag-generator.js';
import { applyProfileImageStyle } from '../../utils/profile-image.js';
import { escapeHtml, generateId, showConfirm, showToast } from '../../utils/ui.js';

const MODULE_KEY = 'messenger-rooms';
const MAIN_CHAR_MEMBER_KEY = '__main_char__';
const USER_MEMBER_KEY = '__user__';
const ROOM_MESSAGE_LIMIT = 18;
const ROOM_MESSAGE_STORAGE_LIMIT = 80;
const ROOM_AUTONOMY_DELAY_MIN_MS = 2500;
const ROOM_AUTONOMY_DELAY_MAX_MS = 6500;
const ROOM_IMAGE_TEXT_TEMPLATE_DEFAULT = '[사진: {description}]';
const ROOM_ICON_GROUP = '👥';
const ROOM_ICON_DIRECT = '💬';
const ROOM_IMAGE_OFF_PROMPT = '<image_generation_rule>\nWhen the responder would realistically take and send a photo in this room, insert a <pic prompt="short English image description"> tag.\nOnly use <pic> for photos the responder could actually take with their phone.\nNo narration, mood shots, or third-person views.\n</image_generation_rule>';
const ROOM_PIC_TAG_REGEX = /<?pic\s+[^>\n]*?\bprompt\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s*\/?\s*>)?/gi;
const ROOM_EMOTICON_ONLY_HTML_REGEX = /^<img\b[^>]*aria-label="[^"]*이모티콘[^"]*"[^>]*>$/i;
const ROOM_EMOTICON_TOKEN_ONLY_REGEX = /^\s*\[\[\s*emoticon\s*:\s*[^\]]+\s*\]\]\s*$/i;
const ROOM_DEFAULTS = {
    autoReplyEnabled: true,
    responseProbability: 100,
    extraResponseProbability: 35,
    maxResponses: 2,
};
const roomAutoReplyState = new Map();

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

function buildRoomMessageHtml(text, senderName) {
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
    return replaceAiSelectedEmoticons(html, senderName);
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
            avatarStyle: contact?.avatarStyle || null,
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

function getContactMemberKey(contact) {
    return String(contact?.displayName || contact?.name || '').trim();
}

function findDirectMessengerRoom(memberKey) {
    const normalizedKey = String(memberKey || '').trim().toLowerCase();
    if (!normalizedKey) return null;
    return loadMessengerRooms().find((room) => {
        const members = Array.isArray(room?.members) ? room.members : [];
        return members.length === 1 && String(members[0] || '').trim().toLowerCase() === normalizedKey;
    }) || null;
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
    const existingRoom = findDirectMessengerRoom(memberKey);
    const room = existingRoom || normalizeMessengerRooms([{
        id: generateId(),
        name: `${getMemberDisplayLabel(memberKey, candidateMap)} 개인톡`,
        categories: normalizeCategoryList(contact?.categories),
        members: [memberKey],
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

function buildRoomTranscript(room, candidateMap) {
    const messages = Array.isArray(room?.messages) ? room.messages.slice(-ROOM_MESSAGE_LIMIT) : [];
    return messages.map((message) => {
        const author = String(message?.authorName || getMemberDisplayLabel(message?.authorKey, candidateMap) || '{{user}}').trim();
        return `[room] ${author}: ${normalizeRoomPromptText(message?.text || '')}`;
    }).join('\n');
}

function getRoomImageSettings() {
    const ext = getExtensionSettings()?.['st-lifesim'] || {};
    return {
        messageImageGenerationMode: ext.messageImageGenerationMode === true,
        messageImageTextTemplate: String(ext.messageImageTextTemplate || ROOM_IMAGE_TEXT_TEMPLATE_DEFAULT),
        messageImageInjectionPrompt: String(ext.messageImageInjectionPrompt || '').trim(),
        snsExternalApiUrl: String(ext.snsExternalApiUrl || '').trim(),
        snsExternalApiTimeoutMs: Math.max(1000, Math.min(60000, Number(ext.snsExternalApiTimeoutMs) || 12000)),
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
    const settings = getRoomImageSettings();
    if (settings.snsExternalApiUrl && typeof fetch === 'function') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), settings.snsExternalApiTimeoutMs);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (typeof ctx.getRequestHeaders === 'function') Object.assign(headers, ctx.getRequestHeaders());
            const response = await fetch(settings.snsExternalApiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ prompt: imagePrompt, module: 'st-lifesim-room-image' }),
                signal: controller.signal,
            });
            if (response.ok) {
                const rawText = await response.text();
                let result = String(rawText || '').trim();
                try {
                    const parsed = JSON.parse(rawText || 'null');
                    if (typeof parsed === 'string') result = parsed.trim();
                    else if (typeof parsed?.url === 'string') result = parsed.url.trim();
                    else if (typeof parsed?.imageUrl === 'string') result = parsed.imageUrl.trim();
                    else if (typeof parsed?.text === 'string') result = parsed.text.trim();
                } catch { /* keep plain text response */ }
                if (result && (result.startsWith('http') || result.startsWith('/') || result.startsWith('data:'))) {
                    return result;
                }
            }
        } catch (error) {
            console.warn('[ST-LifeSim] 메신저 방 이미지 외부 API 호출 실패:', error);
        } finally {
            clearTimeout(timer);
        }
    }
    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
        const result = await ctx.executeSlashCommandsWithOptions(`/sd quiet=true ${imagePrompt}`, { showOutput: false });
        const resultStr = String(result?.pipe || result || '').trim();
        if (resultStr && (resultStr.startsWith('http') || resultStr.startsWith('/') || resultStr.startsWith('data:'))) {
            return resultStr;
        }
    }
    return '';
}

async function enrichRoomReplyContent(rawText, senderName, room, candidateMap) {
    const settings = getRoomImageSettings();
    const allContactsList = [...getContacts('character'), ...getContacts('chat')];
    const normalizedSource = normalizeQuotesForRoomPicTag(String(rawText || ''));
    let processedText = normalizedSource;
    const imagePlaceholders = new Map();
    let imageCounter = 0;
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
                        const placeholder = `__ROOM_IMG_${imageCounter++}__`;
                        imagePlaceholders.set(placeholder, `<img src="${safeUrl}" title="${safePrompt}" alt="${safePrompt}" class="slm-msg-generated-image" style="max-width:100%;border-radius:var(--slm-image-radius,10px);margin:4px 0">`);
                        replacement = placeholder;
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
    let html = buildRoomMessageHtml(processedText, senderName);
    imagePlaceholders.forEach((imageHtml, placeholder) => {
        html = html.replace(new RegExp(placeholder, 'g'), imageHtml);
    });
    const plainText = processedText
        .replace(/__ROOM_IMG_\d+__/g, ' [사진] ')
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
    const imageSettings = getRoomImageSettings();
    const responderName = getMemberDisplayLabel(responderKey, candidateMap);
    const memberLabels = room.members.map((memberKey) => getMemberDisplayLabel(memberKey, candidateMap));
    const transcript = buildRoomTranscript(room, candidateMap);
    const latestUserMessage = normalizeRoomPromptText(room.messages[room.messages.length - 1]?.text || '');
    const emoticonContext = buildAiEmoticonContext(responderName);
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
        emoticonContext,
        '',
        imageSettings.messageImageInjectionPrompt || ROOM_IMAGE_OFF_PROMPT,
        '',
        `Output only ${responderName}'s next room message.`,
    ].join('\n');

    let rawReply = '';
    if (typeof ctx.generateQuietPrompt === 'function') {
        rawReply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: responderName });
    } else if (typeof ctx.generateRaw === 'function') {
        rawReply = await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true });
    }
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

    let rawReply = '';
    if (typeof ctx.generateQuietPrompt === 'function') {
        rawReply = await ctx.generateQuietPrompt({ quietPrompt: prompt, quietName: charName });
    } else if (typeof ctx.generateRaw === 'function') {
        rawReply = await ctx.generateRaw({ prompt, quietToLoud: false, trimNames: true });
    }
    return sanitizeRoomReply(rawReply, charName, [charName]);
}

async function runRoomAutoReplies(roomId, onUpdate = null) {
    clearRoomAutoReplySchedule(roomId);
    const room = getMessengerRoomById(roomId);
    if (!room || room.settings?.autoReplyEnabled !== true) return;
    const scheduleToken = generateId();
    const maxResponses = Math.max(1, Math.min(3, Number(room.settings?.maxResponses) || ROOM_DEFAULTS.maxResponses));
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
                    ? (Number(freshRoom.settings?.responseProbability) || ROOM_DEFAULTS.responseProbability)
                    : (Number(freshRoom.settings?.extraResponseProbability) || ROOM_DEFAULTS.extraResponseProbability);
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
                        const roomTitle = getRoomTitle(freshRoom, candidateMap);
                        const senderLabel = getMemberDisplayLabel(responderKey, candidateMap);
                        const compactPreview = replyPreview.length > 42 ? `${replyPreview.slice(0, 42)}…` : replyPreview;
                        showToast(`${roomTitle} · ${senderLabel}: ${compactPreview}`, 'info', 2200);
                    }
                    latestState.onUpdate?.(freshRoom);
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
    const candidate = candidateMap.get(memberKey);
    const avatar = getAvatarForMember(memberKey, candidateMap);
    const label = getMemberDisplayLabel(memberKey, candidateMap);
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
    const emoticons = getStoredEmoticons();
    if (emoticons.length === 0) {
        showToast('보낼 수 있는 이모티콘이 없습니다.', 'warn');
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'slm-form';
    const search = document.createElement('input');
    search.className = 'slm-input';
    search.type = 'search';
    search.placeholder = '🔍 이모티콘 검색';
    const list = document.createElement('div');
    list.className = 'slm-room-emoticon-list';
    wrapper.append(search, list);

    const renderList = () => {
        const query = String(search.value || '').trim().toLowerCase();
        list.innerHTML = '';
        emoticons
            .filter((emoticon) => {
                if (!query) return true;
                return `${emoticon.name} ${emoticon.category}`.toLowerCase().includes(query);
            })
            .forEach((emoticon) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'slm-btn slm-btn-ghost slm-room-emoticon-btn';
                const html = buildEmoticonMessageHtml(emoticon, String(getContext()?.name1 || '{{user}}').trim() || '{{user}}');
                btn.innerHTML = html;
                btn.title = emoticon.name;
                btn.setAttribute('aria-label', emoticon.name);
                btn.onclick = () => {
                    close();
                    onSend?.(emoticon);
                };
                list.appendChild(btn);
            });
        if (!list.childElementCount) {
            const empty = document.createElement('div');
            empty.className = 'slm-empty';
            empty.textContent = '조건에 맞는 이모티콘이 없습니다.';
            list.appendChild(empty);
        }
    };

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
    search.oninput = renderList;
    renderList();
}

function openRoomCreatePopup(onBack, roomId = null) {
    const existingRoom = roomId ? getMessengerRoomById(roomId) : null;
    const candidateMap = getCandidateMap();
    const candidates = [...candidateMap.values()];
    const selectedKeys = new Set(existingRoom?.members || []);
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
            categories: parseCategoryInput(categoryInput.value),
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
        sendBtn.disabled = true;
        quickSendBtn.disabled = true;
        input.disabled = true;
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
        input.disabled = false;
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
        });
    });

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!sendBtn.disabled) sendBtn.click();
        }
    });
    input.addEventListener('input', updateComposerState);

    renderMessages();
    updateComposerState();
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
        const npcContacts = [...getContacts('chat'), ...getContacts('character')]
            .filter((contact) => !contact?.isUserAuto && !contact?.isCharAuto);
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
            option.textContent = getContactMemberKey(contact);
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
            // Tab filter: 1:1 (direct) vs group
            const memberCount = room.members?.length || 0;
            if (activeTab === 'direct' && memberCount > 2) return false;
            if (activeTab === 'group' && memberCount <= 2) return false;
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

            // 왼쪽 아이콘 (그룹 아바타)
            const icon = document.createElement('div');
            icon.className = 'slm-room-card-icon';
            const memberCount = room.members?.length || 0;
            icon.textContent = memberCount > 2 ? ROOM_ICON_GROUP : ROOM_ICON_DIRECT;

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
