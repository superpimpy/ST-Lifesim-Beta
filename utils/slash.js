/**
 * slash.js
 * /send, /sendas, /echo, /gen 슬래시 커맨드 래퍼 함수 모음
 * SillyTavern의 executeSlashCommandsWithOptions를 사용한다
 */

import { getContext } from './st-context.js';
import { getContacts } from '../modules/contacts/contacts.js';
import { applyProfileImageStyle } from './profile-image.js';

/**
 * 슬래시 커맨드를 실행하는 내부 함수
 * @param {string} command - 실행할 슬래시 커맨드 문자열
 */
async function run(command) {
    const ctx = getContext();
    if (!ctx) return;
    try {
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            // SillyTavern의 executeSlashCommandsWithOptions 함수를 사용한다
            return await ctx.executeSlashCommandsWithOptions(command, { showOutput: false });
        } else if (typeof ctx.executeSlashCommands === 'function') {
            // 구버전 폴백
            return await ctx.executeSlashCommands(command);
        }
    } catch (e) {
        console.error('[ST-LifeSim] 슬래시 커맨드 실행 오류:', command, e);
        throw e;
    }
}

function escapeSlashPromptText(text) {
    // SillyTavern slash parser treats `|` as a pipe separator, so escape it to keep prompt text intact.
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|');
}

async function generateQuietText(prompt) {
    const ctx = getContext();
    if (prompt == null) return '';
    const quietPrompt = String(prompt).trim();
    if (!ctx || !quietPrompt) return '';

    try {
        const result = await run(`/gen lock=off quiet=true ${escapeSlashPromptText(quietPrompt)}`);
        if (result?.isError) {
            console.warn('[ST-LifeSim] /gen lock=off quiet=true 실행 실패:', result.errorMessage || result);
            return '';
        }
        return String(result?.pipe ?? result ?? '').trim();
    } catch (error) {
        console.warn('[ST-LifeSim] /gen lock=off quiet=true 조용한 생성 실패:', error);
        return '';
    }
}

function findContactByNameVariant(name) {
    const requested = String(name || '').trim().toLowerCase();
    if (!requested) return null;
    const allContacts = [...getContacts('character'), ...getContacts('chat')];
    return allContacts.find((contact) => [contact?.name, contact?.displayName, contact?.subName]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .includes(requested)) || null;
}

async function applyLatestSendAsContactAvatar(name) {
    const contact = findContactByNameVariant(name);
    if (!contact?.avatar) return;
    const ctx = getContext();
    const msgIdx = Number((ctx?.chat?.length ?? 0) - 1);
    if (!Number.isFinite(msgIdx) || msgIdx < 0) return;
    const lastMsg = ctx?.chat?.[msgIdx];
    if (!lastMsg || lastMsg.is_user) return;
    lastMsg.force_avatar = contact.avatar;
    lastMsg.original_avatar = contact.avatar;

    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
        const msgEl = document.querySelector(`.mes[mesid="${msgIdx}"]`);
        const avatarFrame = msgEl?.querySelector('.mesAvatar, .avatar');
        const existingImg = avatarFrame?.querySelector('img');
        const avatarImg = existingImg || (avatarFrame ? document.createElement('img') : null);
        if (avatarFrame && avatarImg) {
            avatarImg.src = contact.avatar;
            avatarImg.alt = String(name || contact.displayName || contact.name || '');
            avatarImg.removeAttribute('srcset');
            applyProfileImageStyle(
                avatarFrame,
                avatarImg,
                contact.avatarStyle,
                { width: 40, height: 40, scale: 100, positionX: 50, positionY: 50 },
            );
            if (!existingImg) avatarFrame.appendChild(avatarImg);
        }
    } catch (error) {
        console.warn('[ST-LifeSim] /sendas 연락처 프로필 사진 적용 실패:', error);
    }

    if (typeof ctx?.saveChat === 'function') {
        await ctx.saveChat();
    }
}

/**
 * 유저 말풍선으로 텍스트를 전송한다 (AI 응답 없음)
 * @param {string} text - 전송할 텍스트
 */
export async function slashSend(text) {
    // 특수문자 처리: 파이프 문자는 이스케이프 필요
    await run(`/send ${text}`);
}

/**
 * 특정 캐릭터 이름으로 AI 응답 없이 말풍선을 삽입한다
 * @param {string} name - 캐릭터 이름
 * @param {string} text - 삽입할 텍스트
 */
export async function slashSendAs(name, text) {
    await run(`/sendas name="${name}" ${text}`);
    await applyLatestSendAsContactAvatar(name);
}

/**
 * 시스템 알림 메시지를 표시한다 (캐릭터 말풍선 아님)
 * @param {string} text - 표시할 텍스트
 */
export async function slashEcho(text) {
    await run(`/echo ${text}`);
}

/**
 * AI가 특정 지시로 텍스트를 생성한 뒤, 캐릭터 이름으로 전송한다
 * @param {string} prompt - 생성 지시 프롬프트
 * @param {string} name - 전송 대상 캐릭터 이름 (없으면 기본 {{char}})
 */
export async function slashGen(prompt, name = null) {
    if (name) {
        const generated = await generateQuietText(prompt, name);
        if (generated) {
            await slashSendAs(name, generated);
            return;
        }
        // 최종 폴백: /gen quiet=true ... | /sendas name="..." 형태로 실행
        await run(`/gen lock=off quiet=true ${prompt} | /sendas name="${name}"`);
    } else {
        // /gen quiet=true만 단독 사용 (기본 {{char}} 응답)
        await run(`/gen lock=off quiet=true ${prompt}`);
    }
}

/**
 * AI 텍스트를 채팅창 노출 없이 슬래시 커맨드 경로로 생성하고 결과 텍스트를 반환한다.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function slashGenQuiet(prompt) {
    return await generateQuietText(prompt);
}

/**
 * 여러 슬래시 커맨드를 순서대로 실행한다
 * @param {string[]} commands - 실행할 커맨드 목록
 */
export async function runSequential(commands) {
    for (const cmd of commands) {
        await run(cmd);
    }
}
