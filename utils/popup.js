/**
 * popup.js
 * 팝업창 공통 생성/열기/닫기 컴포넌트
 * - ESC 키 + 외부 클릭으로 닫기 지원
 * - 화면 밖으로 나가지 않도록 모바일 대응
 * - 돌아가기 버튼 지원 (onBack 옵션)
 */

// 현재 열려있는 팝업 목록
const openPopups = new Map();

/**
 * 팝업 오버레이를 생성하고 반환한다
 * @param {object} options
 * @param {string} options.id - 팝업 고유 ID
 * @param {string} options.title - 팝업 제목
 * @param {HTMLElement|string} options.content - 팝업 내용 (HTML 엘리먼트 또는 문자열)
 * @param {string} [options.className] - 추가 CSS 클래스
 * @param {HTMLElement} [options.footer] - 팝업 하단에 표시할 엘리먼트 (선택)
 * @param {Function} [options.onClose] - 닫힐 때 콜백
 * @param {Function} [options.onBack] - 돌아가기 버튼 콜백 (있으면 돌아가기 버튼 표시)
 * @returns {{ overlay: HTMLElement, panel: HTMLElement, body: HTMLElement, close: Function }}
 */
export function createPopup({ id, title, content, className = '', footer, onClose, onBack }) {
    // 이미 열린 팝업이 있으면 닫는다
    closePopup(id);

    // 오버레이 (반투명 배경)
    const overlay = document.createElement('div');
    overlay.className = 'slm-overlay';
    overlay.id = `slm-overlay-${id}`;

    // 팝업 패널
    const panel = document.createElement('div');
    panel.className = `slm-panel ${className}`;
    panel.id = `slm-panel-${id}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', title);

    // 제목바
    const titleBar = document.createElement('div');
    titleBar.className = 'slm-panel-title';

    // 왼쪽 영역 (돌아가기 버튼 + 제목)
    const titleLeft = document.createElement('div');
    titleLeft.className = 'slm-panel-title-left';

    // 돌아가기 버튼 (onBack이 있을 때만)
    if (typeof onBack === 'function') {
        const backBtn = document.createElement('button');
        backBtn.className = 'slm-panel-back';
        backBtn.textContent = '← 뒤로';
        backBtn.setAttribute('aria-label', '이전 패널로 돌아가기');
        backBtn.onclick = () => {
            close();
            onBack();
        };
        titleLeft.appendChild(backBtn);
    }

    const titleText = document.createElement('span');
    titleText.textContent = title;
    titleLeft.appendChild(titleText);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'slm-panel-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.onclick = () => close();

    titleBar.appendChild(titleLeft);
    titleBar.appendChild(closeBtn);

    // 내용 영역
    const body = document.createElement('div');
    body.className = 'slm-panel-body';
    if (typeof content === 'string') {
        body.innerHTML = content;
    } else if (content instanceof HTMLElement) {
        body.appendChild(content);
    }

    panel.appendChild(titleBar);
    panel.appendChild(body);
    // footer 옵션이 있으면 패널 하단에 추가한다
    if (footer instanceof HTMLElement) {
        panel.appendChild(footer);
    }
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ESC 키로 닫기
    const onKeyDown = (e) => {
        if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);

    // 외부 클릭으로 닫기 (패널 외부 영역 클릭)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    // 닫기 함수
    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown);
        openPopups.delete(id);
        if (typeof onClose === 'function') onClose();
    }

    // 팝업 등록
    openPopups.set(id, close);

    return { overlay, panel, body, close };
}

/**
 * 특정 ID의 팝업을 닫는다
 * @param {string} id - 팝업 ID
 */
export function closePopup(id) {
    const close = openPopups.get(id);
    if (typeof close === 'function') {
        close();
        return;
    }

    const existing = document.getElementById(`slm-overlay-${id}`);
    if (existing) existing.remove();
}

/**
 * 모든 팝업을 닫는다
 */
export function closeAllPopups() {
    for (const id of [...openPopups.keys()]) {
        closePopup(id);
    }
}

/**
 * 탭 UI를 생성한다
 * @param {Array<{label: string, key: string, content: HTMLElement}>} tabs - 탭 목록
 * @param {string} [defaultKey] - 기본 선택 탭
 * @returns {HTMLElement} 탭 컨테이너 엘리먼트
 */
export function createTabs(tabs, defaultKey = null) {
    const container = document.createElement('div');
    container.className = 'slm-tabs';

    const tabBar = document.createElement('div');
    tabBar.className = 'slm-tab-bar';

    const contentArea = document.createElement('div');
    contentArea.className = 'slm-tab-content';

    let activeKey = defaultKey || (tabs[0]?.key ?? '');

    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.className = 'slm-tab-btn' + (tab.key === activeKey ? ' active' : '');
        btn.textContent = tab.label;
        btn.dataset.key = tab.key;
        btn.onclick = () => {
            // 모든 탭 버튼 비활성화
            tabBar.querySelectorAll('.slm-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // 내용 교체
            contentArea.innerHTML = '';
            contentArea.appendChild(tab.content);
        };
        tabBar.appendChild(btn);
    });

    // 기본 탭 내용 표시
    const defaultTab = tabs.find(t => t.key === activeKey) || tabs[0];
    if (defaultTab) contentArea.appendChild(defaultTab.content);

    container.appendChild(tabBar);
    container.appendChild(contentArea);
    return container;
}
