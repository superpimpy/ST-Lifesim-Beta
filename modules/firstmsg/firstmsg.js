/**
 * firstmsg.js
 * 선톡 (First Message) 모듈
 * - N초마다 N% 확률로 {{char}}가 {{user}}에게 먼저 연락을 취한다
 * - 설정에서 활성화/비활성화, 간격(초), 확률(%) 조정 가능
 */

import { getContext } from '../../utils/st-context.js';
import { slashSendAs } from '../../utils/slash.js';
import { generateBackendText } from '../../utils/backend-generation.js';

// 최소 허용 간격 (초)
const MIN_INTERVAL_SEC = 5;

// 선톡 프롬프트 템플릿
const FIRST_MSG_PROMPT = (charName) =>
    `${charName} initiates contact with {{user}} out of the blue. Send exactly one short messenger-style line (no narration, no stage directions) that fits the current situation and ${charName}'s personality.`;

// 선톡 타이머 ID
let firstMsgTimer = null;
let firstMsgInFlight = false;

/**
 * 선톡 타이머를 시작한다
 * @param {Object} fmSettings - firstMsg 설정 (enabled, intervalSec, probability)
 */
export function startFirstMsgTimer(fmSettings) {
    stopFirstMsgTimer();
    if (!fmSettings?.enabled) return;

    const intervalMs = Math.max(MIN_INTERVAL_SEC, Number(fmSettings.intervalSec) || 10) * 1000;
    const probability = Math.min(1, Math.max(0, (Number(fmSettings.probability) || 8) / 100));
    const runTick = async () => {
        if (!fmSettings.enabled || firstMsgTimer === null) return;
        if (!firstMsgInFlight && Math.random() < probability) {
            const ctx = getContext();
            const charName = ctx?.name2;
            if (charName) {
                firstMsgInFlight = true;
                try {
                    const generated = await generateBackendText({
                        ctx,
                        prompt: FIRST_MSG_PROMPT(charName),
                        quietName: charName,
                    });
                    if (generated) {
                        await slashSendAs(charName, generated);
                    } else {
                        console.warn('[ST-LifeSim] 선톡 생성 결과가 비어 전송을 건너뜁니다:', charName);
                    }
                } catch (e) {
                    console.error('[ST-LifeSim] 선톡 오류:', e);
                } finally {
                    firstMsgInFlight = false;
                }
            }
        }
        if (firstMsgTimer !== null && fmSettings.enabled) {
            firstMsgTimer = setTimeout(runTick, intervalMs);
        }
    };

    firstMsgTimer = setTimeout(runTick, intervalMs);
}

/**
 * 선톡 타이머를 중지한다
 */
export function stopFirstMsgTimer() {
    if (firstMsgTimer !== null) {
        clearTimeout(firstMsgTimer);
        firstMsgTimer = null;
    }
    firstMsgInFlight = false;
}

/**
 * 선톡 설정 UI를 렌더링한다
 * @param {Object} settings - 전체 ST-LifeSim 설정 객체
 * @param {Function} onSave - 설정 저장 콜백
 * @returns {HTMLElement}
 */
export function renderFirstMsgSettingsUI(settings, onSave) {
    if (!settings.firstMsg) {
        settings.firstMsg = { enabled: false, intervalSec: 10, probability: 8 };
    }
    const fm = settings.firstMsg;

    const section = document.createElement('div');
    section.className = 'slm-firstmsg-section';

    // 제목 & 토글
    const titleRow = document.createElement('div');
    titleRow.className = 'slm-settings-row';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'slm-toggle-label';

    const toggleCheck = document.createElement('input');
    toggleCheck.type = 'checkbox';
    toggleCheck.checked = !!fm.enabled;
    toggleCheck.onchange = () => {
        fm.enabled = toggleCheck.checked;
        onSave();
        if (fm.enabled) {
            startFirstMsgTimer(fm);
        } else {
            stopFirstMsgTimer();
        }
    };

    toggleLabel.appendChild(toggleCheck);
    toggleLabel.appendChild(document.createTextNode(' 💌 선톡 (자동 먼저 연락) 활성화'));
    titleRow.appendChild(toggleLabel);
    section.appendChild(titleRow);

    const desc = document.createElement('p');
    desc.className = 'slm-desc';
    desc.textContent = '{{char}}가 N초마다 N% 확률로 {{user}}에게 먼저 연락을 취합니다.';
    section.appendChild(desc);

    // 간격 & 확률 설정
    const intervalRow = document.createElement('div');
    intervalRow.className = 'slm-input-row';

    const intervalLbl = document.createElement('label');
    intervalLbl.className = 'slm-label';
    intervalLbl.textContent = '간격(초):';

    const intervalInput = document.createElement('input');
    intervalInput.className = 'slm-input slm-input-sm';
    intervalInput.type = 'number';
    intervalInput.min = String(MIN_INTERVAL_SEC);
    intervalInput.max = '3600';
    intervalInput.value = String(fm.intervalSec || 10);
    intervalInput.style.width = '70px';

    const probLbl = document.createElement('label');
    probLbl.className = 'slm-label';
    probLbl.style.marginLeft = '8px';
    probLbl.textContent = '확률(%):';

    const probInput = document.createElement('input');
    probInput.className = 'slm-input slm-input-sm';
    probInput.type = 'number';
    probInput.min = '1';
    probInput.max = '100';
    probInput.value = String(fm.probability || 8);
    probInput.style.width = '60px';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'slm-btn slm-btn-primary slm-btn-sm';
    applyBtn.textContent = '적용';
    applyBtn.onclick = () => {
        fm.intervalSec = Math.max(MIN_INTERVAL_SEC, parseInt(intervalInput.value) || 10);
        fm.probability = Math.min(100, Math.max(1, parseInt(probInput.value) || 8));
        intervalInput.value = String(fm.intervalSec);
        probInput.value = String(fm.probability);
        onSave();
        if (fm.enabled) {
            startFirstMsgTimer(fm);
        }
    };

    intervalRow.appendChild(intervalLbl);
    intervalRow.appendChild(intervalInput);
    intervalRow.appendChild(probLbl);
    intervalRow.appendChild(probInput);
    intervalRow.appendChild(applyBtn);
    section.appendChild(intervalRow);

    return section;
}
