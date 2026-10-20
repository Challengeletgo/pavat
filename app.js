/* ==========================================================
   파밭 직거래 — app.js
   ========================================================== */

/* ---------- 유틸 ---------- */
const $ = (id) => document.getElementById(id);

// 사용자가 입력한 글을 innerHTML에 넣을 때 태그로 해석되지 않도록 변환
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
}
function persist(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('저장 실패', e); }
}

let toastTimer = null;
function showToast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 2200);
}

function formatPrice(man) {
    const n = Number(man);
    if (!n) return '협의';
    if (n >= 10000) {
        const eok = n / 10000;
        return `${parseFloat(eok.toFixed(2))}억`;
    }
    return `${n.toLocaleString()}만`;
}

function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '방금 전';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
}

/* ---------- 상태 ---------- */
let mapInstance = null;
let naverMarkers = [];
let naverPolygons = [];
let cadastralLayerActive = false;
let cadastralLayer = null;
let satelliteActive = false;
let myLocationMarker = null;
let watchId = null;

let listings = loadJSON('farm_listings');
let inquiries = loadJSON('farm_inquiries');

let isMeasuring = false;
let measurePoints = [];
let measureMarkers = [];
let currentPolygon = null;
let currentPolyline = null;
let calculatedPyeong = 0;
let lastRegisteredLat = 34.9921;
let lastRegisteredLng = 126.4783;
let activePolygonCoords = [];
let activePolygonIsTemp = false;   // 면적을 재지 않고 등록할 때 true
let tempCenter = null;

const KIND_COLORS = {
    mine:     { fill: '#1C5B3A', stroke: '#14452C' },
    sale:     { fill: '#E8590C', stroke: '#C2410C' },
    reserved: { fill: '#3B6FD4', stroke: '#2B57B0' }
};
const MEASURE_COLOR = '#6D4AE0';

function statusKind(item) { return item.status === '판매중' ? 'sale' : 'reserved'; }
function pinKind(item) { return item.isMyFarm ? 'mine' : statusKind(item); }
function statusTags(item) {
    const mine = item.isMyFarm ? '<span class="tag tag--mine">내 밭</span>' : '';
    return `${mine}<span class="tag tag--${statusKind(item)}">${esc(item.status)}</span>`;
}

/* ---------- 탭 ---------- */
function switchTab(targetTab) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    $(`tab-${targetTab}`).classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        const active = btn.getAttribute('data-target') === targetTab;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    });

    if (targetTab === 'saved') renderSavedList();
    if (targetTab === 'activity') renderInquiries();

    if (targetTab === 'map' && mapInstance && window.naver && window.naver.maps) {
        setTimeout(() => window.naver.maps.Event.trigger(mapInstance, 'resize'), 100);
    }
}

/* ---------- 지도 초기화 ---------- */
function showMapError() {
    const el = $('map-error');
    if (el) el.classList.remove('hidden');
    const o = $('map-error-origin');
    if (o) o.textContent = location.origin;
}

function initMap() {
    if (window.__mapAuthFailed || !(window.naver && window.naver.maps && window.naver.maps.Map)) {
        showMapError();
        return;
    }

    try {
        mapInstance = new naver.maps.Map('naver-map-inner', {
            center: new naver.maps.LatLng(34.9921, 126.4783),
            zoom: 13,
            minZoom: 8,
            styleId: '6e0eb66f-c236-4b13-9b82-170d90c57a2c'
        });

        naver.maps.Event.addListener(mapInstance, 'click', function (e) {
            if (!isMeasuring) return;
            const coord = e.coord;

            measurePoints.push(coord);
            lastRegisteredLat = coord.lat();
            lastRegisteredLng = coord.lng();

            const first = measurePoints.length === 1;
            measureMarkers.push(new naver.maps.Marker({
                position: coord,
                map: mapInstance,
                icon: {
                    content: `<div class="vtx${first ? ' vtx--first' : ''}"></div>`,
                    anchor: new naver.maps.Point(0, 0)
                }
            }));

            updateMeasureShapes();
            refreshMeasureGuide();
        });

        naver.maps.Event.once(mapInstance, 'init', function () {
            naver.maps.Event.trigger(mapInstance, 'resize');
            startRealtimeLocationTracking();
        });

        applyFilters();
    } catch (err) {
        console.warn('네이버 지도 로드 실패', err);
        showMapError();
    }
}

/* ---------- 내 위치 ---------- */
function startRealtimeLocationTracking() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
        (p) => updateUserLocationOnMap(p.coords.latitude, p.coords.longitude, true),
        (err) => console.log('위치 권한 대기중', err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
        (p) => updateUserLocationOnMap(p.coords.latitude, p.coords.longitude, false),
        (err) => console.warn('위치 추적 오류', err),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 5000 }
    );
}

function updateUserLocationOnMap(lat, lng, shouldCenter) {
    if (!mapInstance || !window.naver || !window.naver.maps) return;

    const here = new naver.maps.LatLng(lat, lng);
    lastRegisteredLat = lat;
    lastRegisteredLng = lng;

    if (shouldCenter) {
        mapInstance.setCenter(here);
        mapInstance.setZoom(15);
    }

    if (myLocationMarker) {
        myLocationMarker.setPosition(here);
    } else {
        myLocationMarker = new naver.maps.Marker({
            position: here,
            map: mapInstance,
            zIndex: 5,
            icon: { content: '<div class="me"></div>', anchor: new naver.maps.Point(0, 0) }
        });
    }
}

function panToCurrentLocation() {
    if (!navigator.geolocation) {
        showToast('이 브라우저는 위치 정보를 지원하지 않아요');
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (p) => {
            updateUserLocationOnMap(p.coords.latitude, p.coords.longitude, true);
            showToast('내 위치로 이동했어요');
        },
        () => showToast('위치를 가져오지 못했어요. 브라우저의 위치 허용을 확인해 주세요'),
        { enableHighAccuracy: true }
    );
}

function setFabState(id, on) {
    const btn = $(id);
    if (!btn) return;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
}

// 위성지도: 위성 사진 위에 도로·지명을 겹친 '겹쳐보기(HYBRID)'를 씁니다.
// 사진만 보고 싶으면 아래 HYBRID를 SATELLITE로 바꾸세요.
function toggleSatellite() {
    if (!mapInstance || !(window.naver && naver.maps)) {
        showToast('지도를 불러온 뒤 사용할 수 있어요');
        return;
    }
    satelliteActive = !satelliteActive;
    mapInstance.setMapTypeId(satelliteActive ? naver.maps.MapTypeId.HYBRID : naver.maps.MapTypeId.NORMAL);
    setFabState('satellite-btn', satelliteActive);
    showToast(satelliteActive ? '위성지도로 바꿨어요' : '일반 지도로 돌아왔어요');
}

// 지적편집도는 '지도 유형'이 아니라 별도 '레이어'라서 CadastralLayer로 켜고 끕니다.
// (위성지도 위에도 겹쳐 볼 수 있어요)
function toggleCadastralLayer() {
    if (!mapInstance || !(window.naver && naver.maps && naver.maps.CadastralLayer)) {
        showToast('지도를 불러온 뒤 사용할 수 있어요');
        return;
    }
    if (!cadastralLayer) cadastralLayer = new naver.maps.CadastralLayer();
    cadastralLayerActive = !cadastralLayerActive;
    cadastralLayer.setMap(cadastralLayerActive ? mapInstance : null);
    setFabState('cadastral-btn', cadastralLayerActive);
    showToast(cadastralLayerActive ? '지적편집도를 켰어요' : '지적편집도를 껐어요');
}

/* ---------- 면적 측정 ---------- */
function calculateSphericalPolygonArea(points) {
    if (points.length < 3) return { sqm: 0, pyeong: 0 };
    let area = 0;
    const earthRadius = 6378137;
    const rad = Math.PI / 180;

    for (let i = 0; i < points.length; i++) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        const lat1 = p1.lat() * rad, lat2 = p2.lat() * rad;
        const lng1 = p1.lng() * rad, lng2 = p2.lng() * rad;
        area += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    area = area * earthRadius * earthRadius / 2.0;
    const sqm = Math.abs(area);
    return { sqm: Math.round(sqm), pyeong: Math.round(sqm / 3.305785) };
}

// 지도에서 안 재고 등록할 때, 입력한 평수와 똑같은 크기의 정사각형 구역을 만들어 줍니다
function makeSquareAround(lat, lng, pyeong) {
    const sqm = Math.max(Number(pyeong) || 1, 1) * 3.305785;
    const half = Math.sqrt(sqm) / 2;
    const dLat = half / 111320;
    const dLng = half / (111320 * Math.cos(lat * Math.PI / 180));
    return [
        { lat: lat + dLat, lng: lng - dLng },
        { lat: lat + dLat, lng: lng + dLng },
        { lat: lat - dLat, lng: lng + dLng },
        { lat: lat - dLat, lng: lng - dLng }
    ];
}

function setMeasureMode(on) {
    isMeasuring = on;
    const tab = $('tab-map');
    if (tab) tab.classList.toggle('is-measuring', on);
    // 측정 중에는 가격 마커를 숨겨서 지도를 깔끔하게 (모서리 터치도 가로막지 않음)
    naverMarkers.forEach((m) => m.setMap(on ? null : mapInstance));
}

function startMeasure() {
    resetMeasurePoints();
    setMeasureMode(true);
    refreshMeasureGuide();
}

function cancelMeasure() {
    resetMeasurePoints();
    setMeasureMode(false);
}

function refreshMeasureGuide() {
    const main = $('measure-area-main');
    const sub = $('measure-guide-text');
    const cta = $('measure-register-btn');
    const n = measurePoints.length;

    if (n >= 3) {
        const info = calculateSphericalPolygonArea(measurePoints);
        calculatedPyeong = info.pyeong;
        if (main) main.textContent = `${info.pyeong.toLocaleString()}평`;
        if (sub) sub.textContent = `${info.sqm.toLocaleString()}㎡ · 모서리 ${n}개`;
        if (cta) cta.disabled = false;
    } else {
        calculatedPyeong = 0;
        if (main) main.textContent = '면적 재는 중';
        if (sub) sub.textContent = `모서리를 터치하세요 (${n}/3)`;
        if (cta) cta.disabled = true;
    }
}

function updateMeasureShapes() {
    if (!window.naver || !window.naver.maps) return;
    if (currentPolyline) currentPolyline.setMap(null);
    if (currentPolygon) currentPolygon.setMap(null);
    currentPolyline = null;
    currentPolygon = null;

    if (measurePoints.length >= 2) {
        currentPolyline = new naver.maps.Polyline({
            map: mapInstance, path: measurePoints,
            strokeColor: MEASURE_COLOR, strokeWeight: 3, strokeOpacity: 0.9
        });
    }
    if (measurePoints.length >= 3) {
        currentPolygon = new naver.maps.Polygon({
            map: mapInstance, paths: [measurePoints],
            fillColor: MEASURE_COLOR, fillOpacity: 0.28,
            strokeColor: MEASURE_COLOR, strokeWeight: 3, strokeOpacity: 0.95
        });
    }
}

function undoLastPoint() {
    if (measurePoints.length === 0) return;
    measurePoints.pop();
    const last = measureMarkers.pop();
    if (last) last.setMap(null);
    updateMeasureShapes();
    refreshMeasureGuide();
}

function resetMeasurePoints() {
    measurePoints = [];
    calculatedPyeong = 0;
    measureMarkers.forEach((m) => m.setMap(null));
    measureMarkers = [];
    if (currentPolyline) currentPolyline.setMap(null);
    if (currentPolygon) currentPolygon.setMap(null);
    currentPolyline = null;
    currentPolygon = null;
    refreshMeasureGuide();
}

/* ---------- 바텀시트 ---------- */
let sheetTimer = null;

function openSheet(html) {
    const backdrop = $('modal-backdrop');
    const sheet = $('field-detail-sheet');
    const content = $('sheet-content');
    if (!backdrop || !sheet || !content) return;

    clearTimeout(sheetTimer);
    content.innerHTML = html;
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('is-open')));
}

function closeSheet() {
    const backdrop = $('modal-backdrop');
    const sheet = $('field-detail-sheet');
    if (!backdrop || !sheet || backdrop.classList.contains('hidden')) return;

    sheet.classList.remove('is-open');
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => backdrop.classList.add('hidden'), 280);
}

/* ---------- 내 땅 등록 ---------- */
function openRegisterSheetFromMeasurement() {
    const measured = measurePoints.length >= 3 ? calculateSphericalPolygonArea(measurePoints) : null;

    if (measured) {
        activePolygonIsTemp = false;
        activePolygonCoords = measurePoints.map((pt) => ({ lat: pt.lat(), lng: pt.lng() }));
    } else {
        // 면적을 재지 않은 경우: 지도 중앙을 기준으로 등록 (구역은 입력한 평수 크기로 만들어짐)
        activePolygonIsTemp = true;
        if (mapInstance) {
            const c = mapInstance.getCenter();
            lastRegisteredLat = c.lat();
            lastRegisteredLng = c.lng();
        }
        tempCenter = { lat: lastRegisteredLat, lng: lastRegisteredLng };
        activePolygonCoords = makeSquareAround(tempCenter.lat, tempCenter.lng, 500);
    }

    const banner = measured
        ? `<div class="note note--measure"><i class="fa-solid fa-ruler-combined"></i><div>지도에서 잰 면적이 자동 입력됐어요: <b>${measured.pyeong.toLocaleString()}평</b> (${measured.sqm.toLocaleString()}㎡)</div></div>`
        : `<div class="note note--info"><i class="fa-solid fa-circle-info"></i><div>면적을 재지 않아 지도 가운데에 입력한 평수만큼의 구역으로 표시돼요. 정확한 모양은 <b>면적재기</b>로 직접 그려 보세요.</div></div>`;

    openSheet(`
        <div class="sheet__head">
            <div class="min0">
                <span class="tag tag--mine"><i class="fa-solid fa-tractor"></i>&nbsp; 내 땅 등록</span>
                <h3 class="sheet__title">대파 재배지 정보를 입력하세요</h3>
            </div>
            <button type="button" class="icon-btn" onclick="closeSheet()" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>

        ${banner}

        <form id="inline-farm-form" onsubmit="submitInlineFarm(event)">
            <label class="field">
                <span class="field__label">밭 이름 · 매물 제목</span>
                <input type="text" id="reg-title" class="input" placeholder="예: 임자면 월동대파 3번 밭" maxlength="40" required>
            </label>
            <div class="field-row">
                <label class="field">
                    <span class="field__label">대파 품종</span>
                    <select id="reg-variety" class="input">
                        <option>월동대파</option>
                        <option>봄대파</option>
                        <option>중생종 대파</option>
                    </select>
                </label>
                <label class="field">
                    <span class="field__label">재배 면적 (평)</span>
                    <input type="number" id="reg-area" class="input${measured ? ' input--measured' : ''}" inputmode="numeric" min="1"
                           value="${measured ? measured.pyeong : ''}" placeholder="예: 500" required>
                </label>
            </div>
            <div class="field-row">
                <label class="field">
                    <span class="field__label">수확 예정일</span>
                    <input type="date" id="reg-date" class="input" required>
                </label>
                <label class="field">
                    <span class="field__label">희망 총액 (만원)</span>
                    <input type="number" id="reg-price" class="input" inputmode="numeric" min="0" placeholder="예: 850" required>
                </label>
            </div>
            <label class="field">
                <span class="field__label">현장 특이사항</span>
                <textarea id="reg-notes" class="input" rows="2" maxlength="120" placeholder="예: 5톤 화물차 진입 가능, 지하수 관정 완비"></textarea>
            </label>
            <button type="submit" class="btn btn--primary btn--block"><i class="fa-solid fa-circle-check"></i><span>내 밭으로 등록하기</span></button>
        </form>
    `);
}

function submitInlineFarm(e) {
    e.preventDefault();
    const title = $('reg-title').value.trim();
    const variety = $('reg-variety').value;
    const area = Number($('reg-area').value);
    const harvestDate = $('reg-date').value;
    const price = Number($('reg-price').value);
    const notes = $('reg-notes').value.trim();

    if (!title || !(area > 0)) {
        showToast('밭 이름과 면적을 확인해 주세요');
        return;
    }

    // 면적을 안 재고 등록한 경우, 입력한 평수에 맞춰 구역 크기를 다시 만듭니다
    if (activePolygonIsTemp && tempCenter) {
        activePolygonCoords = makeSquareAround(tempCenter.lat, tempCenter.lng, area);
    }

    let sumLat = 0, sumLng = 0;
    activePolygonCoords.forEach((pt) => { sumLat += pt.lat; sumLng += pt.lng; });
    const centerLat = sumLat / activePolygonCoords.length;
    const centerLng = sumLng / activePolygonCoords.length;

    listings.push({
        id: Date.now(),
        title, variety, area, harvestDate, price,
        unitPrice: price > 0 ? `${(price / area).toFixed(2)}만/평` : '협의',
        expectedYield: `약 ${(area * 0.018).toFixed(1)}톤`,
        status: '판매중',
        farmer: '나 (소유주)',
        safePhone: '0505-7777-8888',
        notes: notes || '특이사항 없음',
        lat: centerLat,
        lng: centerLng,
        polygonCoords: [...activePolygonCoords],
        isSaved: false,
        isMyFarm: true,
        visitNote: ''
    });
    persist('farm_listings', listings);

    resetMeasurePoints();
    setMeasureMode(false);
    activePolygonCoords = [];
    closeSheet();

    // 필터/검색 때문에 새 밭이 안 보이는 일이 없도록 초기화
    const search = $('search-input');
    if (search) search.value = '';
    setStatusFilter('전체');

    if (mapInstance && window.naver && window.naver.maps) {
        mapInstance.panTo(new naver.maps.LatLng(centerLat, centerLng));
    }
    showToast('내 밭을 등록했어요');
}

/* ---------- 지도 위 밭 표시 ---------- */
function renderMapEntities(targetListings) {
    if (!mapInstance || !window.naver || !window.naver.maps) return;

    naverMarkers.forEach((m) => m.setMap(null));
    naverMarkers = [];
    naverPolygons.forEach((p) => p.setMap(null));
    naverPolygons = [];

    targetListings.forEach((item) => {
        const kind = pinKind(item);
        const colors = KIND_COLORS[kind];

        const content = `
            <div class="pin pin--${kind}">
                ${item.isMyFarm ? '<span class="pin__tag">내 밭</span>' : ''}
                <span>${formatPrice(item.price)}</span>
                <span class="pin__area">${Number(item.area).toLocaleString()}평</span>
            </div>`;

        const marker = new naver.maps.Marker({
            position: new naver.maps.LatLng(item.lat, item.lng),
            map: isMeasuring ? null : mapInstance,
            icon: { content, anchor: new naver.maps.Point(0, 0) }
        });
        naver.maps.Event.addListener(marker, 'click', () => {
            if (isMeasuring) return;
            openFieldDetail(item.id);
        });
        naverMarkers.push(marker);

        if (item.polygonCoords && item.polygonCoords.length >= 3) {
            naverPolygons.push(new naver.maps.Polygon({
                map: mapInstance,
                paths: item.polygonCoords.map((c) => new naver.maps.LatLng(c.lat, c.lng)),
                fillColor: colors.fill,
                fillOpacity: 0.3,
                strokeColor: colors.stroke,
                strokeWeight: 2.5,
                strokeOpacity: 0.95
            }));
        }
    });
}

/* ---------- 필터 · 검색 ---------- */
function setStatusFilter(value) {
    const input = $('filter-status');
    if (input) input.value = value;
    document.querySelectorAll('.chip').forEach((c) => {
        c.setAttribute('aria-pressed', String(c.dataset.value === value));
    });
    applyFilters();
}

function applyFilters() {
    const status = ($('filter-status') || {}).value || '전체';
    const searchEl = $('search-input');
    const q = searchEl ? searchEl.value.toLowerCase().trim() : '';

    const filtered = listings.filter((item) => {
        const okStatus = status === '전체'
            || (status === '내 밭' ? item.isMyFarm : item.status === status);
        const okSearch = !q
            || String(item.title).toLowerCase().includes(q)
            || String(item.variety).toLowerCase().includes(q)
            || String(item.notes).toLowerCase().includes(q);
        return okStatus && okSearch;
    });
    renderMapEntities(filtered);
}

/* ---------- 밭 상세 ---------- */
function openFieldDetail(id) {
    const item = listings.find((l) => l.id === id);
    if (!item) return;

    openSheet(`
        <div class="sheet__head">
            <div class="min0">
                <div class="tags">${statusTags(item)}<span class="tag">${esc(item.variety)}</span></div>
                <h3 class="sheet__title">${esc(item.title)}</h3>
            </div>
            <button type="button" class="icon-btn" onclick="closeSheet()" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>

        <div class="stats">
            <div class="stat"><div class="stat__label">재배 면적</div><div class="stat__value">${Number(item.area).toLocaleString()}평</div></div>
            <div class="stat"><div class="stat__label">예상 수확량</div><div class="stat__value stat__value--accent">${esc(item.expectedYield)}</div></div>
            <div class="stat"><div class="stat__label">평당 단가</div><div class="stat__value">${esc(item.unitPrice)}</div></div>
        </div>

        <div class="kv">
            <div class="kv__row"><span class="kv__k">희망 총액</span><span class="kv__v">${item.price ? Number(item.price).toLocaleString() + '만원' : '협의'}</span></div>
            <div class="kv__row"><span class="kv__k">수확 예정일</span><span class="kv__v">${esc(item.harvestDate)}</span></div>
            <div class="kv__row"><span class="kv__k">등록자</span><span class="kv__v">${esc(item.farmer)}</span></div>
            <div class="kv__row"><span class="kv__k">안심번호</span><span class="kv__v">${esc(item.safePhone)}</span></div>
            <div class="kv__row"><span class="kv__k">특이사항</span><span class="kv__v kv__v--soft">${esc(item.notes)}</span></div>
        </div>

        <div class="actions">
            <button type="button" class="btn btn--ghost btn--icon" onclick="toggleSave(${item.id})" aria-pressed="${!!item.isSaved}" aria-label="${item.isSaved ? '관심 밭 해제' : '관심 밭에 담기'}">
                <i class="fa-solid fa-heart ${item.isSaved ? 'heart-on' : ''}" style="${item.isSaved ? '' : 'color: var(--ink-3)'}"></i>
            </button>
            <button type="button" class="btn btn--primary" onclick="callSafeNumber(${item.id})">
                <i class="fa-solid fa-phone"></i><span>안심번호로 통화</span>
            </button>
        </div>
        ${item.isMyFarm ? `
        <div class="delete-row">
            <button type="button" class="btn btn--danger-soft btn--block" onclick="confirmDeleteFarm(${item.id})">
                <i class="fa-solid fa-trash-can"></i><span>내 밭 삭제</span>
            </button>
        </div>` : ''}
    `);
}

/* ---------- 내 밭 삭제 ---------- */
function confirmDeleteFarm(id) {
    const item = listings.find((l) => l.id === id);
    if (!item || !item.isMyFarm) return;   // 내가 등록한 밭만 삭제 가능

    openSheet(`
        <div class="confirm">
            <div class="confirm__icon"><i class="fa-solid fa-trash-can"></i></div>
            <h3 class="sheet__title">내 밭을 삭제할까요?</h3>
            <p class="confirm__desc"><b>${esc(item.title)}</b><br>지도의 구역과 입력한 정보가 모두 사라지고, 되돌릴 수 없어요.</p>
            <div class="actions">
                <button type="button" class="btn btn--ghost" onclick="openFieldDetail(${id})">취소</button>
                <button type="button" class="btn btn--danger" onclick="deleteFarm(${id})">삭제하기</button>
            </div>
        </div>
    `);
}

function deleteFarm(id) {
    const item = listings.find((l) => l.id === id);
    if (!item || !item.isMyFarm) return;

    listings = listings.filter((l) => l.id !== id);
    persist('farm_listings', listings);

    closeSheet();
    applyFilters();                       // 지도의 마커·구역 다시 그리기
    if (!$('tab-saved').classList.contains('hidden')) renderSavedList();
    showToast('내 밭을 삭제했어요');
}

function toggleSave(id) {
    const item = listings.find((l) => l.id === id);
    if (!item) return;
    item.isSaved = !item.isSaved;
    persist('farm_listings', listings);
    openFieldDetail(id);
    showToast(item.isSaved ? '관심 밭에 담았어요' : '관심 밭에서 뺐어요');
}

function callSafeNumber(id) {
    const item = listings.find((l) => l.id === id);
    if (!item) return;
    inquiries.unshift({
        id: Date.now(),
        at: Date.now(),
        title: item.title,
        merchant: '본인 (산지 상인)',
        status: '안심번호 통화 연결'
    });
    persist('farm_inquiries', inquiries);
    showToast(`안심번호 ${item.safePhone}로 연결해요`);
}

// 관심 밭 목록에서 '지도에서 보기'
function focusField(id) {
    const item = listings.find((l) => l.id === id);
    if (!item) return;
    switchTab('map');
    if (mapInstance && window.naver && window.naver.maps) {
        mapInstance.setCenter(new naver.maps.LatLng(item.lat, item.lng));
        mapInstance.setZoom(16);
    }
    openFieldDetail(id);
}

/* ---------- 관심 밭 · 활동 탭 ---------- */
function renderSavedList() {
    const container = $('saved-list-container');
    if (!container) return;
    const saved = listings.filter((l) => l.isSaved);

    if (saved.length === 0) {
        container.innerHTML = `
            <div class="empty">
                <i class="fa-regular fa-heart"></i>
                관심 밭이 아직 없어요.<br>지도에서 마음에 드는 밭을 눌러 담아 보세요.
            </div>`;
        return;
    }

    container.innerHTML = saved.map((item) => `
        <article class="card">
            <div class="card__top">
                <div class="min0">
                    <div class="tags">${statusTags(item)}<span class="tag">${esc(item.variety)}</span></div>
                    <h3 class="card__title">${esc(item.title)}</h3>
                    <p class="card__meta">${Number(item.area).toLocaleString()}평 · ${formatPrice(item.price)} (${esc(item.unitPrice)})</p>
                </div>
                <button type="button" class="btn btn--soft btn--sm" onclick="focusField(${item.id})">지도에서 보기</button>
            </div>
            <label class="field__label" for="note-input-${item.id}"><i class="fa-solid fa-pen-to-square"></i>&nbsp; 임장 메모</label>
            <div class="memo">
                <input type="text" id="note-input-${item.id}" class="input" value="${esc(item.visitNote)}" placeholder="예: 5톤 진입 가능, 흙 상태 좋음">
                <button type="button" class="btn btn--primary btn--sm" onclick="saveVisitNote(${item.id})">저장</button>
            </div>
        </article>
    `).join('');
}

function saveVisitNote(id) {
    const input = $(`note-input-${id}`);
    const item = listings.find((l) => l.id === id);
    if (!item) return;
    item.visitNote = input ? input.value : '';
    persist('farm_listings', listings);
    showToast('임장 메모를 저장했어요');
}

function renderInquiries() {
    const container = $('inquiry-log-list');
    if (!container) return;

    if (inquiries.length === 0) {
        container.innerHTML = `
            <div class="empty">
                <i class="fa-solid fa-phone-slash"></i>
                아직 통화 기록이 없어요.<br>밭 상세에서 안심번호로 통화하면 여기에 쌓여요.
            </div>`;
        return;
    }

    container.innerHTML = inquiries.map((inq) => `
        <div class="log">
            <div class="min0">
                <strong>${esc(inq.title)}</strong>
                <span>${esc(inq.merchant)} · ${inq.at ? timeAgo(inq.at) : esc(inq.time)}</span>
            </div>
            <span class="pill">${esc(inq.status)}</span>
        </div>
    `).join('');
}

/* ---------- 시작 ---------- */
window.addEventListener('load', initMap);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
});

(function bindRegisterFarmButton() {
    const btn = $('register-farm-btn');
    if (!btn) {
        console.error("[파밭 직거래] '내 땅 등록' 버튼을 찾지 못했습니다. index.html의 id를 확인하세요.");
        return;
    }
    btn.addEventListener('click', (event) => {
        event.preventDefault();
        openRegisterSheetFromMeasurement();
    });
})();
