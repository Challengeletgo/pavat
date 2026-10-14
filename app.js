let mapInstance = null;
let naverMarkers = [];
let naverPolygons = [];
let cadastralLayerActive = false;
let myLocationMarker = null;
let watchId = null;

let listings = JSON.parse(localStorage.getItem('farm_listings')) || [];
let inquiries = JSON.parse(localStorage.getItem('farm_inquiries')) || [];

let isMeasuring = false;
let measurePoints = [];
let measureMarkers = [];
let currentPolygon = null;
let currentPolyline = null;
let calculatedPyeong = 0;
let lastRegisteredLat = 34.9921;
let lastRegisteredLng = 126.4783;
let activePolygonCoords = [];

function switchTab(targetTab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`tab-${targetTab}`).classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.getAttribute('data-target') === targetTab) {
            btn.classList.remove('text-gray-400', 'hover:text-gray-200');
            btn.classList.add('text-orange-500');
        } else {
            btn.classList.remove('text-orange-500');
            btn.classList.add('text-gray-400', 'hover:text-gray-200');
        }
    });

    if (targetTab === 'saved') renderSavedList();
    if (targetTab === 'activity') renderInquiries();
    
    if (targetTab === 'map' && mapInstance && window.naver && window.naver.maps && window.naver.maps.Event) {
        setTimeout(() => {
            window.naver.maps.Event.trigger(mapInstance, 'resize');
        }, 150);
    }
}

function initMap() {
    const mapCanvas = document.getElementById('map-canvas');
    
    if (window.naver && window.naver.maps && window.naver.maps.Map) {
        try {
            const mapOptions = {
                center: new naver.maps.LatLng(34.9921, 126.4783),
                zoom: 13,
                minZoom: 8,
                styleId: '6e0eb66f-c236-4b13-9b82-170d90c57a2c'
            };
            
            mapInstance = new naver.maps.Map('naver-map-inner', mapOptions);
            
            window.naver.maps.Event.addListener(mapInstance, 'click', function(e) {
                if (!isMeasuring) return;
                const coord = e.coord;

                measurePoints.push(coord);
                lastRegisteredLat = coord.lat();
                lastRegisteredLng = coord.lng();

                const isFirst = (measurePoints.length === 1);
                const markerColor = isFirst ? '#ef4444' : '#2563eb';
                const vertexMarker = new naver.maps.Marker({
                    position: coord,
                    map: mapInstance,
                    icon: {
                        content: `<div style="background:${markerColor}; width:14px; height:14px; border:2px solid #ffffff; border-radius:50%; box-shadow:0 2px 4px rgba(0,0,0,0.5);"></div>`,
                        anchor: new naver.maps.Point(7, 7)
                    }
                });

                measureMarkers.push(vertexMarker);
                updateMeasureShapes();

                const guideText = document.getElementById('measure-guide-text');
                const panel = document.getElementById('measure-panel');
                if (panel) panel.classList.remove('hidden');

                if (measurePoints.length >= 3) {
                    const areaInfo = calculateSphericalPolygonArea(measurePoints);
                    calculatedPyeong = areaInfo.pyeong;
                    if (guideText) guideText.innerText = `총 ${measurePoints.length}개 점 · ${calculatedPyeong} 평 (${areaInfo.sqm} ㎡)`;
                } else {
                    if (guideText) guideText.innerText = `모서리 ${measurePoints.length}개 찍힘 (최소 3개 필요)`;
                }
            });

            window.naver.maps.Event.once(mapInstance, 'init', function() {
                window.naver.maps.Event.trigger(mapInstance, 'resize');
                startRealtimeLocationTracking();
            });

            renderMapEntities(listings);
        } catch (err) {
            console.warn("네이버 지도 로드 실패", err);
        }
    }
}

function startRealtimeLocationTracking() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
        (position) => {
            updateUserLocationOnMap(position.coords.latitude, position.coords.longitude, true);
        },
        (error) => { console.log("위치 권한 대기중", error); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(
        (position) => {
            updateUserLocationOnMap(position.coords.latitude, position.coords.longitude, false);
        },
        (error) => { console.warn("위치 추적 오류", error); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 5000 }
    );
}

function updateUserLocationOnMap(lat, lng, shouldCenter) {
    if (!mapInstance || !window.naver || !window.naver.maps) return;

    const currentLatLng = new naver.maps.LatLng(lat, lng);
    lastRegisteredLat = lat;
    lastRegisteredLng = lng;

    if (shouldCenter) {
        mapInstance.setCenter(currentLatLng);
        mapInstance.setZoom(15);
    }

    if (myLocationMarker) {
        myLocationMarker.setPosition(currentLatLng);
    } else {
        myLocationMarker = new naver.maps.Marker({
            position: currentLatLng,
            map: mapInstance,
            icon: {
                content: '<div style="background:#f97316; width:20px; height:20px; border:3px solid #ffffff; border-radius:50%; box-shadow:0 0 12px rgba(249,115,22,0.9); animation: pulse-subtle 2s infinite;"></div>',
                anchor: new naver.maps.Point(10, 10)
            }
        });
    }
}

function panToCurrentLocation() {
    if (!navigator.geolocation) {
        alert("이 브라우저는 위치 정보를 지원하지 않습니다.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            updateUserLocationOnMap(position.coords.latitude, position.coords.longitude, true);
            alert("실시간 내 현장 위치로 이동했습니다.");
        },
        () => { alert("위치 정보를 가져올 수 없습니다. 브라우저 위치 허용을 확인해주세요."); },
        { enableHighAccuracy: true }
    );
}

function calculateSphericalPolygonArea(points) {
    if (points.length < 3) return { sqm: 0, pyeong: 0 };
    let area = 0;
    const earthRadius = 6378137;
    const rad = Math.PI / 180;
    
    for (let i = 0; i < points.length; i++) {
        let p1 = points[i];
        let p2 = points[(i + 1) % points.length];
        
        let lat1 = p1.lat() * rad;
        let lat2 = p2.lat() * rad;
        let lng1 = p1.lng() * rad;
        let lng2 = p2.lng() * rad;
        
        area += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    area = area * earthRadius * earthRadius / 2.0;
    let sqm = Math.abs(area);
    let pyeong = Math.round(sqm / 3.305785);
    return { sqm: Math.round(sqm), pyeong: pyeong };
}

function toggleMeasureMode() {
    isMeasuring = !isMeasuring;
    const btnText = document.getElementById('measure-btn-text');
    const btn = document.getElementById('measure-btn');
    const panel = document.getElementById('measure-panel');

    if (isMeasuring) {
        resetMeasurePoints();
        if (panel) panel.classList.remove('hidden');
        if (btn) {
            btn.classList.remove('bg-blue-600', 'hover:bg-blue-500');
            btn.classList.add('bg-red-600', 'hover:bg-red-500', 'ring-2', 'ring-red-300');
        }
        if (btnText) btnText.innerText = "면적재기 중지";
    } else {
        if (panel) panel.classList.add('hidden');
        if (btn) {
            btn.classList.remove('bg-red-600', 'hover:bg-red-500', 'ring-2', 'ring-red-300');
            btn.classList.add('bg-blue-600', 'hover:bg-blue-500');
        }
        if (btnText) btnText.innerText = "면적재기 시작";
    }
}

function updateMeasureShapes() {
    if (!window.naver || !window.naver.maps) return;
    if (currentPolyline) currentPolyline.setMap(null);
    if (currentPolygon) currentPolygon.setMap(null);

    if (measurePoints.length >= 2) {
        currentPolyline = new naver.maps.Polyline({
            map: mapInstance,
            path: measurePoints,
            strokeColor: '#2563eb',
            strokeWeight: 3,
            strokeOpacity: 0.8
        });
    }

    if (measurePoints.length >= 3) {
        currentPolygon = new naver.maps.Polygon({
            map: mapInstance,
            paths: [measurePoints],
            fillColor: '#3b82f6',
            fillOpacity: 0.35,
            strokeColor: '#2563eb',
            strokeWeight: 3,
            strokeOpacity: 0.9
        });
    }
}

function undoLastPoint() {
    if (measurePoints.length === 0) return;
    measurePoints.pop();
    const lastMarker = measureMarkers.pop();
    if (lastMarker) lastMarker.setMap(null);

    updateMeasureShapes();

    const guideText = document.getElementById('measure-guide-text');
    if (measurePoints.length >= 3) {
        const areaInfo = calculateSphericalPolygonArea(measurePoints);
        calculatedPyeong = areaInfo.pyeong;
        if (guideText) guideText.innerText = `총 ${measurePoints.length}개 점 · ${calculatedPyeong} 평`;
    } else {
        if (guideText) guideText.innerText = `모서리 ${measurePoints.length}개 찍힘 (최소 3개 필요)`;
    }
}

function resetMeasurePoints() {
    measurePoints = [];
    calculatedPyeong = 0;
    measureMarkers.forEach(m => m.setMap(null));
    measureMarkers = [];
    if (currentPolyline) currentPolyline.setMap(null);
    if (currentPolygon) currentPolygon.setMap(null);

    const panel = document.getElementById('measure-panel');
    if (panel) panel.classList.add('hidden');
}

// ✨ [내 땅 등록] 버튼 클릭 시 어두운 백드롭과 함께 모달 창 오픈
function openRegisterSheetFromMeasurement() {
    // 지도에서 잰 면적(3점 이상)이 있으면 그 값을 우선 사용
    const measuredInfo = measurePoints.length >= 3 ? calculateSphericalPolygonArea(measurePoints) : null;
    const finalPyeong = measuredInfo ? measuredInfo.pyeong : (calculatedPyeong || 500);
    const areaBanner = measuredInfo
        ? `<div class="mb-3 bg-blue-500/10 border border-blue-500/40 text-blue-300 text-[11px] rounded-xl px-3 py-2"><i class="fa-solid fa-ruler-combined mr-1"></i>지도에서 잰 면적이 자동 입력되었습니다: <b>${measuredInfo.pyeong}평</b> (${measuredInfo.sqm}㎡)</div>`
        : `<div class="mb-3 bg-gray-800 border border-gray-700 text-gray-400 text-[11px] rounded-xl px-3 py-2"><i class="fa-solid fa-circle-info mr-1"></i>면적을 재지 않아 임시 구역으로 등록됩니다. 면적은 직접 수정할 수 있어요.</div>`;
    
    if (measurePoints.length >= 3) {
        activePolygonCoords = measurePoints.map(pt => ({ lat: pt.lat(), lng: pt.lng() }));
    } else {
        if (mapInstance) {
            const center = mapInstance.getCenter();
            lastRegisteredLat = center.lat();
            lastRegisteredLng = center.lng();
        }
        activePolygonCoords = [
            { lat: lastRegisteredLat + 0.001, lng: lastRegisteredLng - 0.001 },
            { lat: lastRegisteredLat + 0.001, lng: lastRegisteredLng + 0.001 },
            { lat: lastRegisteredLat - 0.001, lng: lastRegisteredLng + 0.001 },
            { lat: lastRegisteredLat - 0.001, lng: lastRegisteredLng - 0.001 }
        ];
    }

    isMeasuring = false;
    const btnText = document.getElementById('measure-btn-text');
    const btn = document.getElementById('measure-btn');
    const panel = document.getElementById('measure-panel');
    if (panel) panel.classList.add('hidden');
    if (btn) {
        btn.classList.remove('bg-red-600', 'ring-2', 'ring-red-300');
        btn.classList.add('bg-blue-600');
    }
    if (btnText) btnText.innerText = "면적재기 시작";

    const backdrop = document.getElementById('modal-backdrop');
    const sheet = document.getElementById('field-detail-sheet');
    const content = document.getElementById('sheet-content');
    if (!content || !sheet || !backdrop) return;

    content.innerHTML = `
        <div class="flex justify-between items-start mb-4">
            <div>
                <span class="bg-emerald-500/20 text-emerald-400 text-xs px-2.5 py-1 rounded-md font-bold"><i class="fa-solid fa-tractor mr-1"></i> 내 땅(밭) 정보 등록</span>
                <h3 class="text-base font-bold mt-1 text-gray-100">대파 재배지 정보를 입력하세요</h3>
            </div>
            <button onclick="closeSheet()" class="text-gray-400 hover:text-white p-1 cursor-pointer"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>

        ${areaBanner}
        <form id="inline-farm-form" onsubmit="submitInlineFarm(event)" class="space-y-3.5">
            <div>
                <label class="block text-xs font-semibold text-gray-300 mb-1">밭 이름 / 매물 제목</label>
                <input type="text" id="reg-title" value="[내 밭] 임자면 대파 재배 하우스" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500" required>
            </div>
            <div class="grid grid-cols-2 gap-2.5">
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">대파 품종</label>
                    <select id="reg-variety" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-2.5 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500">
                        <option>월동대파</option>
                        <option>봄대파</option>
                        <option>중생종 대파</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">재배 면적 (평)</label>
                    <input type="number" id="reg-area" value="${finalPyeong}" class="w-full bg-gray-800 border border-blue-500 rounded-xl px-3 py-2.5 text-xs font-bold text-blue-300 focus:outline-none" required>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2.5">
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">수확 예정일</label>
                    <input type="date" id="reg-date" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-2.5 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500" required>
                </div>
                <div>
                    <label class="block text-xs font-semibold text-gray-300 mb-1">희망 총액 (만원)</label>
                    <input type="number" id="reg-price" placeholder="예: 850" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500" required>
                </div>
            </div>
            <div>
                <label class="block text-xs font-semibold text-gray-300 mb-1">현장 특이사항 메모</label>
                <textarea id="reg-notes" rows="2" placeholder="예: 5톤 화물차 진입 가능, 지하수 관정 완비" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500"></textarea>
            </div>
            <button type="submit" class="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3.5 rounded-xl transition shadow-lg flex items-center justify-center space-x-1.5 text-xs cursor-pointer">
                <i class="fa-solid fa-circle-check"></i><span>내 밭으로 최종 등록 완료하기</span>
            </button>
        </form>
    `;

    backdrop.classList.remove('hidden');
    setTimeout(() => {
        sheet.classList.remove('translate-y-full');
    }, 10);
}

function closeSheet(e) {
    const sheet = document.getElementById('field-detail-sheet');
    const backdrop = document.getElementById('modal-backdrop');
    if (sheet && backdrop) {
        sheet.classList.add('translate-y-full');
        setTimeout(() => {
            backdrop.classList.add('hidden');
        }, 300);
    }
}

function submitInlineFarm(e) {
    e.preventDefault();
    const title = document.getElementById('reg-title').value;
    const variety = document.getElementById('reg-variety').value;
    const area = Number(document.getElementById('reg-area').value);
    const harvestDate = document.getElementById('reg-date').value;
    const price = Number(document.getElementById('reg-price').value);
    const notes = document.getElementById('reg-notes').value;

    if (!activePolygonCoords || activePolygonCoords.length < 3) {
        if (mapInstance) {
            const center = mapInstance.getCenter();
            lastRegisteredLat = center.lat();
            lastRegisteredLng = center.lng();
        }
        activePolygonCoords = [
            { lat: lastRegisteredLat + 0.001, lng: lastRegisteredLng - 0.001 },
            { lat: lastRegisteredLat + 0.001, lng: lastRegisteredLng + 0.001 },
            { lat: lastRegisteredLat - 0.001, lng: lastRegisteredLng + 0.001 },
            { lat: lastRegisteredLat - 0.001, lng: lastRegisteredLng - 0.001 }
        ];
    }

    let sumLat = 0, sumLng = 0;
    activePolygonCoords.forEach(pt => {
        sumLat += pt.lat;
        sumLng += pt.lng;
    });
    const centerLat = sumLat / activePolygonCoords.length;
    const centerLng = sumLng / activePolygonCoords.length;

    const newListing = {
        id: Date.now(),
        title: title,
        variety: variety,
        area: area,
        harvestDate: harvestDate,
        price: price,
        unitPrice: `${(price / area).toFixed(2)}만/평`,
        expectedYield: `약 ${(area * 0.018).toFixed(1)}톤`,
        status: "판매중",
        farmer: "나 (소유주)",
        safePhone: "0505-7777-8888",
        notes: notes || "특이사항 없음",
        lat: centerLat,
        lng: centerLng,
        polygonCoords: [...activePolygonCoords],
        isSaved: false,
        isMyFarm: true,
        visitNote: ""
    };

    listings.push(newListing);
    localStorage.setItem('farm_listings', JSON.stringify(listings));

    alert("✨ 성공적으로 내 밭 정보가 등록되어 지도에 영구 저장되었습니다!");
    closeSheet();
    resetMeasurePoints();
    activePolygonCoords = [];
    renderMapEntities(listings);
}

function renderMapEntities(targetListings) {
    if (!mapInstance || !window.naver || !window.naver.maps) return;
    
    naverMarkers.forEach(m => m.setMap(null));
    naverMarkers = [];
    naverPolygons.forEach(p => p.setMap(null));
    naverPolygons = [];

    targetListings.forEach(item => {
        const position = new naver.maps.LatLng(item.lat, item.lng);
        
        let statusColor = item.isMyFarm 
            ? 'bg-emerald-600 border-emerald-400' 
            : (item.status === '판매중' ? 'bg-orange-600 border-orange-400' : 'bg-blue-600 border-blue-400');
        
        let badge = item.isMyFarm ? '<span class="bg-white text-emerald-700 text-[9px] px-1.5 py-0.2 rounded font-extrabold mr-1">내 밭</span>' : '<i class="fa-solid fa-seedling text-[10px]"></i>';

        const contentString = `
            <div class="marker-bubble cursor-pointer ${statusColor} text-white px-3 py-1.5 rounded-xl shadow-2xl border text-xs font-bold flex items-center space-x-1">
                ${badge}
                <span>${item.price}만원</span>
                <span class="text-[10px] opacity-80 font-normal">(${item.area}평)</span>
            </div>
        `;

        const marker = new naver.maps.Marker({
            position: position,
            map: mapInstance,
            icon: {
                content: contentString,
                size: new naver.maps.Size(130, 45),
                anchor: new naver.maps.Point(65, 22)
            }
        });

        window.naver.maps.Event.addListener(marker, 'click', () => {
            openFieldDetail(item.id);
        });
        naverMarkers.push(marker);

        if (item.polygonCoords && item.polygonCoords.length >= 3) {
            const paths = item.polygonCoords.map(coord => new naver.maps.LatLng(coord.lat, coord.lng));
            const polygon = new naver.maps.Polygon({
                map: mapInstance,
                paths: paths,
                fillColor: item.isMyFarm ? '#10b981' : (item.status === '판매중' ? '#f97316' : '#3b82f6'),
                fillOpacity: 0.38,
                strokeColor: item.isMyFarm ? '#059669' : (item.status === '판매중' ? '#ea580c' : '#2563eb'),
                strokeWeight: item.isMyFarm ? 3.5 : 3,
                strokeOpacity: 0.95
            });
            naverPolygons.push(polygon);
        }
    });
}

function applyFilters() {
    const status = document.getElementById('filter-status').value;

    const filtered = listings.filter(item => {
        const matchStatus = (status === '전체' || item.status === status);
        return matchStatus;
    });

    renderMapEntities(filtered);
}

function handleSearch(keyword) {
    const query = keyword.toLowerCase().trim();
    if (!query) {
        renderMapEntities(listings);
        return;
    }
    const searched = listings.filter(item => 
        item.title.toLowerCase().includes(query) || 
        item.variety.toLowerCase().includes(query) || 
        item.notes.toLowerCase().includes(query)
    );

    renderMapEntities(searched);
}

function toggleCadastralLayer() {
    cadastralLayerActive = !cadastralLayerActive;
    if (mapInstance && window.naver && window.naver.maps) {
        mapInstance.setMapTypeId(cadastralLayerActive ? naver.maps.MapTypeId.CADASTRAL : naver.maps.MapTypeId.NORMAL);
    }
    alert(cadastralLayerActive ? "지적편집도 레이어가 활성화되었습니다." : "일반 지도 레이어로 전환되었습니다.");
}

function openFieldDetail(id) {
    const item = listings.find(l => l.id === id);
    if (!item) return;

    const backdrop = document.getElementById('modal-backdrop');
    const sheet = document.getElementById('field-detail-sheet');
    const content = document.getElementById('sheet-content');

    if (!content || !backdrop || !sheet) return;

    let myFarmBadge = item.isMyFarm ? '<span class="bg-emerald-500/20 text-emerald-400 text-xs px-2 py-0.5 rounded-md font-bold mr-1">내 밭 관리중</span>' : '';

    content.innerHTML = `
        <div class="flex justify-between items-start mb-3">
            <div>
                <div class="flex items-center space-x-1 mb-1">
                    ${myFarmBadge}
                    <span class="bg-orange-500/20 text-orange-400 text-xs px-2 py-0.5 rounded-md font-semibold">${item.variety}</span>
                </div>
                <h3 class="text-lg font-bold text-gray-100">${item.title}</h3>
            </div>
            <button onclick="closeSheet()" class="text-gray-400 hover:text-white p-1 cursor-pointer"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>

        <div class="grid grid-cols-3 gap-2 bg-gray-800 p-3 rounded-xl mb-4 text-center">
            <div>
                <div class="text-[11px] text-gray-400">재배 면적</div>
                <div class="text-sm font-bold text-gray-200">${item.area}평</div>
            </div>
            <div>
                <div class="text-[11px] text-gray-400">예상 수확량</div>
                <div class="text-sm font-bold text-orange-400">${item.expectedYield}</div>
            </div>
            <div>
                <div class="text-[11px] text-gray-400">평당 단가</div>
                <div class="text-sm font-bold text-gray-200">${item.unitPrice}</div>
            </div>
        </div>

        <div class="space-y-2 text-xs text-gray-300 mb-4 bg-gray-800/50 p-3 rounded-xl border border-gray-700/50">
            <div class="flex justify-between"><span>수확 예정일:</span><strong class="text-white">${item.harvestDate}</strong></div>
            <div class="flex justify-between"><span>등록자/농가:</span><strong class="text-white">${item.farmer}</strong></div>
            <div class="flex justify-between"><span>특이사항:</span><span class="text-right text-gray-400">${item.notes}</span></div>
        </div>

        <div class="flex space-x-2">
            <button onclick="toggleSave(${item.id})" class="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-3 rounded-xl font-bold text-xs flex items-center justify-center space-x-2 transition cursor-pointer">
                <i class="fa-solid fa-heart ${item.isSaved ? 'text-red-500' : 'text-gray-400'}"></i>
                <span>${item.isSaved ? '찜 완료됨' : '관심 밭 찜'}</span>
            </button>
            <button onclick="callSafeNumber('${item.safePhone}', '${item.title}')" class="flex-[2] bg-orange-600 hover:bg-orange-700 text-white py-3 rounded-xl font-bold text-xs flex items-center justify-center space-x-2 shadow-lg transition cursor-pointer">
                <i class="fa-solid fa-phone"></i>
                <span>안심번호 연결 (${item.safePhone})</span>
            </button>
        </div>
    `;

    backdrop.classList.remove('hidden');
    setTimeout(() => {
        sheet.classList.remove('translate-y-full');
    }, 10);
}

function toggleSave(id) {
    const item = listings.find(l => l.id === id);
    if (item) {
        item.isSaved = !item.isSaved;
        localStorage.setItem('farm_listings', JSON.stringify(listings));
        openFieldDetail(id);
    }
}

function callSafeNumber(phone, title) {
    alert(`[안심번호 보안 연결]\n안전한 통화를 위해 안심번호(${phone})로 연결을 시도합니다.\n(대상 밭: ${title})`);
    inquiries.unshift({
        id: Date.now(),
        title: title,
        merchant: "본인 (산지 상인)",
        time: "방금 전",
        status: "안심번호 통화 연결됨"
    });
    localStorage.setItem('farm_inquiries', JSON.stringify(inquiries));
}

function renderSavedList() {
    const container = document.getElementById('saved-list-container');
    if (!container) return;
    const savedItems = listings.filter(l => l.isSaved);

    if (savedItems.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-gray-500">
                <i class="fa-solid fa-heart-crack text-3xl mb-2"></i>
                <p class="text-sm">찜한 대파 밭이 없습니다.<br>지도에서 마음에 드는 밭을 찜해보세요!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = savedItems.map(item => `
        <div class="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3 shadow">
            <div class="flex justify-between items-center">
                <div>
                    <span class="text-[10px] bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded">${item.variety}</span>
                    <h4 class="font-bold text-sm mt-1 text-gray-200">${item.title}</h4>
                    <p class="text-xs text-gray-400 mt-1">면적: ${item.area}평 | 가격: ${item.price}만원 (${item.unitPrice})</p>
                </div>
                <button onclick="openFieldDetail(${item.id})" class="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-xs font-bold text-gray-200 transition cursor-pointer">
                    지도보기
                </button>
            </div>
            <div class="border-t border-gray-700/60 pt-2">
                <label class="block text-[11px] font-semibold text-orange-400 mb-1"><i class="fa-solid fa-pen-to-square mr-1"></i> 현장 임장 메모</label>
                <div class="flex space-x-2">
                    <input type="text" id="note-input-${item.id}" value="${item.visitNote || ''}" placeholder="예: 5톤 진입 가능, 흙 상태 좋음" class="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500">
                    <button onclick="saveVisitNote(${item.id})" class="bg-orange-600 hover:bg-orange-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer">저장</button>
                </div>
            </div>
        </div>
    `).join('');
}

function saveVisitNote(id) {
    const inputEl = document.getElementById(`note-input-${id}`);
    const inputVal = inputEl ? inputEl.value : '';
    const item = listings.find(l => l.id === id);
    if (item) {
        item.visitNote = inputVal;
        localStorage.setItem('farm_listings', JSON.stringify(listings));
        alert("임장 메모가 성공적으로 저장되었습니다.");
    }
}

function renderInquiries() {
    const container = document.getElementById('inquiry-log-list');
    if (!container) return;
    container.innerHTML = inquiries.map(inq => `
        <div class="bg-gray-900 border border-gray-700/60 p-3 rounded-xl flex justify-between items-center">
            <div>
                <div class="font-bold text-xs text-gray-200">${inq.title}</div>
                <div class="text-[11px] text-gray-400 mt-0.5">상인: ${inq.merchant} · ${inq.time}</div>
            </div>
            <span class="text-[10px] bg-green-500/20 text-green-400 px-2 py-1 rounded-md font-medium">${inq.status}</span>
        </div>
    `).join('');
}

// 앱 초기화
window.addEventListener('load', function() {
    initMap();
});

// '내 땅 등록' 버튼 이벤트를 명시적으로 연결합니다.
(function bindRegisterFarmButton() {
    const registerButton = document.getElementById('register-farm-btn');

    if (!registerButton) {
        console.error("[파밭 직거래] '내 땅 등록' 버튼을 찾지 못했습니다. index.html의 id를 확인하세요.");
        return;
    }

    registerButton.addEventListener('click', function(event) {
        event.preventDefault();
        console.info("[파밭 직거래] '내 땅 등록' 버튼 클릭 감지");

        try {
            if (typeof openRegisterSheetFromMeasurement !== 'function') {
                throw new Error('등록 창을 여는 함수(openRegisterSheetFromMeasurement)를 찾을 수 없습니다.');
            }
            openRegisterSheetFromMeasurement();
        } catch (error) {
            console.error("[파밭 직거래] 등록 창을 여는 중 오류가 발생했습니다:", error);
            alert('등록 창을 여는 중 문제가 발생했습니다. F12 → Console에서 오류를 확인해주세요.');
        }
    });
})();
