'use strict';
const t = window.I18n.t;
const localizedText = new Map();
function writeText(id, render) { localizedText.set(id, render); const text = render(); if ($(id).textContent !== text) $(id).textContent = text; }
let renderOrder = null;
const $ = (id) => document.getElementById(id);
const selected = { start: null, end: null };
const versions = { start: 0, end: 0 };
const stops = [];
let nextStopId = 0;
let pointerDrag = null;
function addressIds() { return ['start', ...stops, 'end']; }
let map, planner, loadedConfig, busy = false, routeVersion = 0;
let appliedMapStyle = null, themeFrame = 0, themeMapTimer = 0, themePreferenceTimer = 0, pendingTheme = null;
let recommendedPoints = null, copiedItinerary = '', tourInputSnapshot = null;
let mapPlaceWindow, mapPlaceCandidate = null, mapPlaceRequest = 0, mapPlaceTimer = 0, mapPlaceLoading = false, mapPlaceError = false;
let liveLocation = null, livePosition = null, liveMarker = null, liveCircle = null, liveContent = null, liveState = null;
let pendingLocationStart = null, liveCentered = false;
let liveCircleActive = null;
let activeRoutePanel = 'current', panelVersion = 0, currentDestination = null, currentDestinationVersion = 0;
let currentDestinationSearch = null;
const addressSearches = new Map(), addressTimers = new Map();
let currentCityManual = false, currentCityCache = null, cancelRouteQuery = null;
let usageReady = false, usageDirty = false, usageTimer = 0, savedMapView = null, lastRoute = null;
const savedRouteOverlays = [];
const memoryFields = ['city', 'tour-places', 'tour-objective', 'end-mode', 'objective', 'policy', 'current-destination', 'current-policy', 'current-city'];
function freshCurrentPosition() {
  return liveState?.positionState === 'active' && livePosition && Date.now() - livePosition.timestamp <= 30000 ? livePosition : null;
}
function currentMode() { return document.querySelector('input[name="current-mode"]:checked').value; }
function syncCurrentForm() {
  $('current-plan').disabled = busy || !loadedConfig || !freshCurrentPosition();
  $('current-policy-field').hidden = currentMode() !== 'driving';
  $('current-city-field').hidden = currentMode() !== 'transfer';
  writeText('current-origin-status', () => liveState ? $('live-position-status').textContent : t('请先获取当前位置'));
  writeText('current-destination-state', () => currentDestination ? t('✓ 已确认 · ') + (typeof currentDestination.address === 'string' && currentDestination.address || pointName(currentDestination)) : $('current-destination').value.trim() ? t('请选择候选地点确认位置') : t('等待输入目的地'));
  $('current-destination').setAttribute('aria-invalid', String(Boolean($('current-destination').value.trim() && !currentDestination)));
}
function startCurrentLocation() {
  if (!loadedConfig) { openSettings(); return; }
  liveLocation.start();
  if (freshCurrentPosition()) liveLocation.recenter();
}
function switchRoutePanel(next, startLocation = true) {
  if (!['current', 'custom'].includes(next)) return;
  if (next !== activeRoutePanel) {
    activeRoutePanel = next; panelVersion++; clearRoute(); hideOptions(); clearStopDrag(); closeMapPlace();
    $('current-destination-options').hidden = true;
    if (pendingLocationStart !== null) { pendingLocationStart = null; versions.start++; $('locate').disabled = false; }
    status(() => t('已切换面板，输入已保留，请重新规划路线。'));
  }
  for (const name of ['current', 'custom']) {
    $(name + '-route-panel').hidden = name !== next;
    $(name + '-tab').setAttribute('aria-selected', String(name === next));
    $(name + '-tab').setAttribute('tabindex', name === next ? '0' : '-1');
  }
  syncCurrentForm();
  if (next === 'current' && startLocation) startCurrentLocation();
}
for (const name of ['current', 'custom']) {
  $(name + '-tab').onclick = () => switchRoutePanel(name);
  $(name + '-tab').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'current' : event.key === 'End' ? 'custom' : name === 'current' ? 'custom' : 'current';
    switchRoutePanel(next); $(next + '-tab').focus();
  });
}
$('current-locate').onclick = startCurrentLocation;
function searchCurrentDestination() {
  clearTimeout(currentDestinationTimer);
  if (!loadedConfig || activeRoutePanel !== 'current') return;
  const keyword = $('current-destination').value.trim();
  if (!keyword || currentDestination) return;
  const city = currentDestination?.cityname || '全国', previous = currentDestinationSearch;
  if (previous && previous.keyword === keyword && previous.city === city && previous.version === currentDestinationVersion && previous.panel === panelVersion && (previous.done ? !$('current-destination-options').hidden : Date.now() - previous.started < 8000)) return;
  const version = ++currentDestinationVersion, panel = panelVersion;
  const request = currentDestinationSearch = { keyword, city, version, panel, started: Date.now(), done: false };
  new AMap.PlaceSearch({ city, citylimit: false, pageSize: 6 }).search(keyword, (resultStatus, result) => {
    if (request.done) return;
    request.done = true;
    if (activeRoutePanel !== 'current' || panel !== panelVersion || version !== currentDestinationVersion || keyword !== $('current-destination').value.trim()) return;
    const box = $('current-destination-options'); box.replaceChildren();
    if (resultStatus !== 'complete' || !result.poiList?.pois?.length) {
      box.hidden = true; status(() => t(resultStatus === 'no_data' ? '没有找到该地点，请补充城市或更详细的地址。' : '地点查询失败，请检查 Key 权限、额度和网络。'), true); return;
    }
    for (const place of result.poiList.pois) {
      if (!place.location) continue;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = place.name;
      const detail = document.createElement('small'); detail.textContent = [place.pname, place.cityname, place.adname, typeof place.address === 'string' ? place.address : ''].filter(Boolean).join(' '); button.append(detail);
      button.onclick = () => {
        if (activeRoutePanel !== 'current' || panel !== panelVersion || version !== currentDestinationVersion) return;
        clearTimeout(currentDestinationTimer); currentDestinationSearch = null;
        currentDestinationVersion++; currentDestination = place; $('current-destination').value = place.name; box.hidden = true;
        clearRoute(); syncCurrentForm(); map.setZoomAndCenter(15, place.location); status(() => t('已选择目的地：') + place.name);
      };
      box.append(button);
    }
    box.hidden = box.children.length === 0;
  });
}
let currentDestinationTimer;
$('current-destination').addEventListener('input', () => {
  clearTimeout(currentDestinationTimer); currentDestinationVersion++; currentDestination = null;
  currentDestinationSearch = null;
  $('current-destination-options').hidden = true;
  if (activeRoutePanel === 'current') clearRoute();
  syncCurrentForm(); currentDestinationTimer = setTimeout(searchCurrentDestination, 400);
});
$('current-destination').addEventListener('focus', () => { if (!currentDestination && $('current-destination').value.trim()) searchCurrentDestination(); });
document.querySelectorAll('input[name="current-mode"]').forEach((input) => input.addEventListener('change', () => { clearRoute(); syncCurrentForm(); }));
$('current-policy').onchange = clearRoute;
$('current-city').addEventListener('input', () => { currentCityManual = true; clearRoute(); });
async function resolveCurrentCity(position, request) {
  const manual = $('current-city').value.trim();
  if (currentCityManual && manual) return manual;
  const key = String(position.location);
  if (currentCityCache?.key === key) { $('current-city').value = currentCityCache.city; return currentCityCache.city; }
  status(() => t('正在识别出发城市…'));
  const city = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { clearTimeout(timer); if (cancelRouteQuery === cancel) cancelRouteQuery = null; };
    const cancel = () => { if (settled) return; settled = true; finish(); reject(new Error('地址或选项已改变，请重新规划。')); };
    const fail = () => { if (settled) return; settled = true; finish(); reject(new Error('无法识别出发城市，请手动填写公交出发城市。')); };
    const timer = setTimeout(fail, 8000);
    cancelRouteQuery = cancel;
    try {
      new AMap.Geocoder().getAddress(position.location, (resultStatus, result) => {
        if (settled) return;
        const address = result?.regeocode?.addressComponent;
        const value = typeof address?.city === 'string' && address.city || (['北京市', '上海市', '天津市', '重庆市'].includes(address?.province) ? address.province : '');
        if (resultStatus === 'complete' && value) { settled = true; finish(); resolve(value); } else fail();
      });
    } catch { fail(); }
  });
  ensureCurrent(request); currentCityCache = { key, city }; $('current-city').value = city;
  return city;
}
function renderLiveState(state) {
  liveState = state;
  writeText('live-toggle', () => t(state.enabled ? '停止定位' : '◎ 定位我'));
  $('live-toggle').setAttribute('aria-pressed', String(state.enabled));
  const directionOn = state.directionEnabled;
  writeText('live-direction', () => t(directionOn ? '关闭方向' : '开启方向'));
  $('live-direction').setAttribute('aria-pressed', String(directionOn));
  $('live-direction').disabled = !state.watching || state.directionState === 'requesting';
  $('live-recenter').disabled = state.positionState !== 'active';
  const positionLabels = { idle: '定位尚未开启', waiting: '正在获取位置，请允许浏览器定位…', stale: '位置已过期，正在等待更新…', paused: '页面在后台，定位已暂停' };
  const errorLabels = { denied: '定位权限被拒绝，请在浏览器设置中允许位置访问。', timeout: '定位超时，正在等待下一次位置更新。', unavailable: '暂时无法获取位置，请检查系统定位设置。', insecure: '定位需要 HTTPS 或本机 localhost 环境。', unsupported: '当前浏览器不支持持续定位。', conversion: '地图坐标转换失败，正在等待重试。' };
  writeText('live-position-status', () => state.positionState === 'active' ? t('位置持续更新 · 精度约 ') + Math.round(state.position.accuracy) + t(' 米') + (state.position.accuracy > 100 ? t(' · 当前精度较低') : '') : t(state.positionState === 'error' ? errorLabels[state.positionError] : positionLabels[state.positionState]));
  const directionLabels = { off: '方向尚未开启', requesting: '正在请求方向权限…', waiting: '等待手机方向传感器…', active: '方向已开启 · 箭头随手机转动', denied: '方向权限被拒绝，位置定位仍可使用。', unavailable: '当前设备或浏览器未提供可靠方向。', posture: '请将手机平放；当前方向数据不可靠。', stale: '方向已过期，等待传感器更新…', paused: '页面在后台，方向已暂停' };
  writeText('live-direction-status', () => t(directionLabels[state.directionState]));
  liveContent?.classList.toggle('is-stale', state.positionState !== 'active');
  const arrow = liveContent?.querySelector('.live-arrow');
  if (arrow) { arrow.hidden = state.heading === null; if (state.heading !== null) arrow.style.transform = 'rotate(' + state.heading + 'deg)'; }
  const circleActive = state.positionState === 'active';
  if (liveCircle && liveCircleActive !== circleActive) {
    liveCircle.setOptions({ fillOpacity: circleActive ? 0.12 : 0.04, strokeOpacity: circleActive ? 0.35 : 0.12 });
    liveCircleActive = circleActive;
  }
  if (state.positionState === 'error' && pendingLocationStart !== null) { pendingLocationStart = null; $('locate').disabled = false; status(() => t(errorLabels[state.positionError]), true); }
  syncCurrentForm();
}
function useLiveStart(position, version) {
  $('locate').disabled = false;
  if (version !== versions.start) return;
  selected.start = { name: t('我的位置'), currentLocation: true, location: position.location };
  $('start').value = t('我的位置');
  clearRoute(); hideOptions(); updateAddressState(); map.setZoomAndCenter(15, position.location); status(() => t('已将你的位置设为起点。'));
}
function initializeLiveLocation() {
  $('live-controls').hidden = false;
  liveLocation = window.LiveLocation.create({
    environment: window.LOCATION_TEST_ENV || window,
    convertPosition(coords, done) {
      AMap.convertFrom(coords, 'gps', (resultStatus, result) => {
        done(resultStatus === 'complete' && result?.locations?.[0] ? null : new Error('conversion'), result?.locations?.[0]);
      });
    },
    onPosition(position) {
      livePosition = position;
      if (!liveMarker) {
        liveContent = document.createElement('div'); liveContent.className = 'live-marker';
        const arrow = document.createElement('span'); arrow.className = 'live-arrow'; arrow.hidden = true;
        const dot = document.createElement('span'); dot.className = 'live-dot'; liveContent.append(arrow, dot);
        liveMarker = new AMap.Marker({ map, position: position.location, content: liveContent, anchor: 'center', zIndex: 160, bubble: true });
        liveCircle = new AMap.Circle({ map, center: position.location, radius: position.accuracy, strokeColor: '#2478ed', strokeOpacity: 0.35, strokeWeight: 1, fillColor: '#2478ed', fillOpacity: 0.12, zIndex: 90, bubble: true });
        liveCircleActive = true;
      } else { liveMarker.setPosition(position.location); liveCircle.setCenter(position.location); liveCircle.setRadius(position.accuracy); }
      if (!liveCentered) { map.setZoomAndCenter(position.accuracy > 100 ? 13 : 16, position.location); liveCentered = true; }
      if (pendingLocationStart !== null) { const version = pendingLocationStart; pendingLocationStart = null; useLiveStart(position, version); }
    },
    onHeading(heading) {
      if (liveState) liveState.heading = heading;
      const arrow = liveContent?.querySelector('.live-arrow');
      if (arrow) { arrow.hidden = heading === null; if (heading !== null) arrow.style.transform = 'rotate(' + heading + 'deg)'; }
    },
    onState: renderLiveState,
    onRecenter(position) { map.setZoomAndCenter(position.accuracy > 100 ? 13 : 16, position.location); },
    onClear() {
      liveMarker?.setMap(null); liveCircle?.setMap(null); liveMarker = null; liveCircle = null; liveContent = null; livePosition = null; liveCentered = false;
      liveCircleActive = null;
      pendingLocationStart = null; $('locate').disabled = false;
    }
  });
}
function updateAddressState() {
  const ids = addressIds();
  writeText('address-count', () => ids.filter((id) => selected[id]).length + '/' + ids.length + t(' 已确认'));
  ids.forEach((id, index) => {
    const field = $(id).closest('.location-field');
    let hint = field.querySelector('.address-state');
    if (!hint) { hint = document.createElement('small'); hint.className = 'address-state'; hint.setAttribute('data-dynamic', ''); field.append(hint); }
    hint.textContent = selected[id] ? t('✓ 已确认 · ') + (typeof selected[id].address === 'string' && selected[id].address || pointName(selected[id])) : $(id).value.trim() ? t('请选择候选地点确认位置') : t('等待输入地址');
    hint.classList.toggle('confirmed', Boolean(selected[id]));
    $(id).setAttribute('aria-invalid', String(Boolean($(id).value.trim() && !selected[id])));
    if (stops.includes(id)) {
      field.querySelector('label').textContent = ($('end-mode').value === 'auto' ? t('地点 ') : t('途经地址 ')) + (index + ($('end-mode').value === 'auto' ? 1 : 0));
      const handle = field.querySelector('.stop-drag');
      $(id).placeholder = t('输入需要到访的地址');
      field.querySelector('.remove-stop').setAttribute('aria-label', t('删除此地址'));
      handle.textContent = t('⠿ 拖动');
      handle.title = t('按住拖动调整顺序；键盘可使用上下方向键');
      handle.disabled = stops.length < 2;
      handle.setAttribute('aria-label', t('拖动途经地址 ') + index + t(' 调整顺序，也可使用上下方向键'));
    }
  });
  rememberUsage();
}
function progress(label, value) {
  writeText('progress-label', () => typeof label === 'function' ? label() : t(label));
  if (value == null) $('progress-bar').removeAttribute('value');
  else $('progress-bar').value = value;
}
function mapStyle() { return document.documentElement.dataset.theme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal'; }
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  writeText('theme-toggle', () => dark ? t('☀ 日间模式') : t('☾ 黑夜模式'));
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#15231e' : '#176b53';
}
function saveThemePreference() {
  clearTimeout(themePreferenceTimer); themePreferenceTimer = 0;
  if (pendingTheme === null) return;
  try { localStorage.setItem('xingtu-theme', pendingTheme); } catch { /* Theme still works when storage is unavailable. */ }
  pendingTheme = null;
}
function scheduleMapTheme() {
  clearTimeout(themeMapTimer);
  cancelAnimationFrame(themeFrame);
  if (!map) return;
  // Let the page paint before the SDK rebuilds its map style; keep only the latest toggle.
  themeFrame = requestAnimationFrame(() => {
    themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      themeMapTimer = setTimeout(() => {
        themeMapTimer = 0;
        const style = mapStyle();
        if (map && style !== appliedMapStyle) {
          map.setMapStyle(style);
          appliedMapStyle = style;
        }
      }, 100);
    });
  });
}
window.addEventListener('pagehide', saveThemePreference);
$('theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  syncThemeButton();
  pendingTheme = theme;
  clearTimeout(themePreferenceTimer);
  themePreferenceTimer = setTimeout(saveThemePreference, 400);
  scheduleMapTheme();
};
syncThemeButton();
let config = { ...window.NAV_CONFIG };
try {
  const saved = JSON.parse(sessionStorage.getItem('xingtu-config') || 'null');
  if (typeof saved?.key === 'string' && saved.key.trim() && ((typeof saved.securityJsCode === 'string' && saved.securityJsCode.trim()) || (typeof saved.serviceHost === 'string' && saved.serviceHost.trim()))) {
    config = { ...config, ...saved, key: saved.key.trim(), securityJsCode: typeof saved.securityJsCode === 'string' ? saved.securityJsCode.trim() : '', serviceHost: typeof saved.serviceHost === 'string' ? saved.serviceHost.trim() : '', managed: false };
  }
} catch { /* Storage can be disabled. */ }
$('city').value = config.defaultCity || '北京';
const memoryDefaults = { city: config.defaultCity || '北京', 'tour-places': '', 'tour-objective': 'time', 'end-mode': 'fixed', objective: 'time', policy: '0', 'current-destination': '', 'current-policy': '0', 'current-city': '' };
function status(message, error = false) { writeText('status', () => typeof message === 'function' ? message() : t(message)); $('status').classList.toggle('error', error); }
function mode() { return document.querySelector('input[name="mode"]:checked').value; }
function hideOptions() {
  addressIds().forEach((id) => { $(id + '-options').hidden = true; versions[id]++; clearTimeout(addressTimers.get(id)); });
  addressTimers.clear(); addressSearches.clear();
  $('current-destination-options').hidden = true; currentDestinationVersion++; currentDestinationSearch = null; clearTimeout(currentDestinationTimer);
}
function clearRoute() {
  routeVersion++;
  if (cancelRouteQuery) cancelRouteQuery();
  recommendedPoints = null; copiedItinerary = ''; renderOrder = null;
  lastRoute = null;
  savedRouteOverlays.splice(0).forEach(overlay => overlay.setMap(null));
  $('saved-route-note').hidden = true;
  if (planner) planner.clear();
  $('summary').hidden = true;
  $('visit-order').hidden = true;
  $('route-panel').replaceChildren();
  rememberUsage();
}
function openSettings() {
  $('api-key').value = config.managed ? '' : config.key || '';
  $('security-code').value = config.managed ? '' : config.securityJsCode || '';
  $('service-host').value = config.managed ? '' : config.serviceHost || '';
  writeText('config-error', () => '');
  $('config-dialog').showModal();
}
$('settings').onclick = openSettings;
$('connect').onclick = openSettings;
$('close-dialog').onclick = () => $('config-dialog').close();
$('config-form').onsubmit = (event) => {
  event.preventDefault();
  const next = { ...config, managed: false, key: $('api-key').value.trim(), securityJsCode: $('security-code').value.trim(), serviceHost: $('service-host').value.trim() };
  if (!next.key) { writeText('config-error', () => t('请填写高德 JS API Key。')); return; }
  if (!next.securityJsCode && !next.serviceHost) { writeText('config-error', () => t('请填写安全密钥或安全代理地址。')); return; }
  try { sessionStorage.setItem('xingtu-config', JSON.stringify(next)); } catch { writeText('config-error', () => t('浏览器禁止会话存储，请改为编辑 config.js 后刷新页面。')); return; }
  // Reload ensures the SDK uses the new security configuration, without mixing old map instances.
  location.reload();
};
async function loadMap() {
  if (!config.key) return;
  status(() => t('正在连接高德地图…'));
  writeText('map-message', () => t('正在加载地图…'));
  $('connect').hidden = true;
  window._AMapSecurityConfig = config.serviceHost ? { serviceHost: config.serviceHost } : { securityJsCode: config.securityJsCode };
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('地图加载超时，请检查网络后刷新。')), 20000);
      script.src = 'https://webapi.amap.com/maps?' + new URLSearchParams({ v: '2.0', key: config.key, plugin: 'AMap.PlaceSearch,AMap.Driving,AMap.Transfer,AMap.Walking,AMap.Riding,AMap.Geolocation,AMap.Geocoder,AMap.ToolBar,AMap.Scale' });
      script.onload = () => { clearTimeout(timer); window.AMap ? resolve() : reject(new Error('地图加载失败，请核对 Key 和安全配置。')); };
      script.onerror = () => { clearTimeout(timer); reject(new Error('无法连接高德地图，请检查网络。')); };
      document.head.append(script);
    });
    map = new AMap.Map('map', { zoom: savedMapView?.zoom || 12, center: savedMapView?.center || config.center, viewMode: '2D', resizeEnable: true, rotateEnable: false, mapStyle: mapStyle(), isHotspot: true });
    bindMapPlaces();
    appliedMapStyle = mapStyle();
    map.addControl(new AMap.ToolBar({ position: 'RB' }));
    map.addControl(new AMap.Scale());
    loadedConfig = true;
    initializeLiveLocation();
    drawSavedRoute();
    map.on('moveend', rememberUsage); map.on('zoomend', rememberUsage);
    $('map-placeholder').hidden = true;
    status(() => t('地图已连接。输入地址确认位置，或点击地图地点图标添加途经点。'));
    liveCentered = Boolean(savedMapView || lastRoute);
    liveLocation.start();
  } catch (error) {
    writeText('map-message', () => t(error.message));
    $('connect').hidden = false;
    status(() => t(error.message), true);
  }
}
function closeMapPlace() {
  mapPlaceRequest++;
  clearTimeout(mapPlaceTimer);
  mapPlaceCandidate = null;
  mapPlaceWindow?.close();
}
function mapPlaceBlocked(place) {
  const auto = $('end-mode').value === 'auto';
  if ((auto ? addressIds() : stops).some((id) => selected[id] && ((place.id && selected[id].id === place.id) || sameLocation(selected[id].location, place.location)))) return auto ? '该地点已在地点列表中。' : '该地点已在途经点中。';
  if (stops.length >= 6) return '最多添加 6 个途经点，请先删除一个地址。';
  return '';
}
function renderMapPlace() {
  if (!mapPlaceCandidate) return;
  const place = mapPlaceCandidate;
  const request = mapPlaceRequest;
  const blocked = mapPlaceLoading || mapPlaceError ? '' : mapPlaceBlocked(place);
  const card = document.createElement('div'); card.className = 'map-place-card';
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', t('添加途经点'));
  // Keep place names and addresses as text, including any markup in provider data.
  const name = document.createElement('strong'); name.textContent = place.name || t('地图地点');
  const address = document.createElement('p'); address.className = 'map-place-address'; address.textContent = typeof place.address === 'string' ? place.address : ''; address.hidden = !address.textContent;
  const message = document.createElement('p'); message.className = 'map-place-message'; message.setAttribute('role', 'status');
  message.textContent = t(mapPlaceLoading ? '正在读取地点信息…' : mapPlaceError ? '地点信息读取失败，请重新点击图标重试。' : blocked || '将这个地点添加为途经点？');
  const actions = document.createElement('div'); actions.className = 'map-place-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button secondary'; cancel.textContent = t('取消'); cancel.onclick = closeMapPlace;
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button primary'; confirm.textContent = t('＋ 确认添加'); confirm.disabled = mapPlaceLoading || mapPlaceError || Boolean(blocked);
  confirm.onclick = () => {
    if (request !== mapPlaceRequest || place !== mapPlaceCandidate || mapPlaceLoading || mapPlaceError) return;
    const reason = mapPlaceBlocked(place);
    if (reason) { renderMapPlace(); return; }
    switchRoutePanel('custom', false);
    const syncTour = $('end-mode').value === 'auto' && $('tour-places').value === tourInputSnapshot;
    const id = addStop(false);
    if (!id) return;
    versions[id]++; selected[id] = place; $(id).value = place.name;
    if (syncTour) { $('tour-places').value = addressIds().map((addressId) => $(addressId).value.trim()).join('\n'); tourInputSnapshot = $('tour-places').value; }
    hideOptions(); updateAddressState(); closeMapPlace(); $('address-details').open = true;
    $(id).focus();
    status(() => t('已添加途经点：') + place.name + t('。请重新规划路线。'));
  };
  card.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMapPlace(); });
  actions.append(cancel, confirm); card.append(name, address, message, actions);
  mapPlaceWindow.setContent(card);
}
function bindMapPlaces() {
  mapPlaceWindow = new AMap.InfoWindow({ isCustom: true, offset: new AMap.Pixel(0, -12), closeWhenClickMap: false });
  map.on('hotspotclick', (hotspot) => {
    closeMapPlace();
    if (!hotspot.id || !hotspot.lnglat) return;
    const request = mapPlaceRequest;
    mapPlaceCandidate = { id: hotspot.id, name: hotspot.name, location: hotspot.lnglat };
    mapPlaceLoading = true; mapPlaceError = false;
    renderMapPlace(); mapPlaceWindow.open(map, hotspot.lnglat);
    const finish = (resultStatus, result) => {
      if (request !== mapPlaceRequest || !mapPlaceLoading) return;
      clearTimeout(mapPlaceTimer);
      const place = result?.poiList?.pois?.[0];
      mapPlaceLoading = false;
      mapPlaceError = resultStatus !== 'complete' || !place?.location || !place?.name;
      if (!mapPlaceError) mapPlaceCandidate = { ...place, id: place.id || hotspot.id };
      renderMapPlace();
    };
    mapPlaceTimer = setTimeout(() => finish('error'), 10000);
    try { new AMap.PlaceSearch().getDetails(hotspot.id, finish); }
    catch { finish('error'); }
  });
}
function showPlaces(id, places) {
  const panel = panelVersion, version = versions[id];
  const box = $(id + '-options');
  box.replaceChildren();
  places.forEach((place) => {
    if (!place.location) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = place.name;
    const detail = document.createElement('small');
    detail.textContent = [place.pname, place.cityname, place.adname, typeof place.address === 'string' ? place.address : ''].filter(Boolean).join(' ');
    button.append(detail);
    button.onclick = () => {
      if (activeRoutePanel !== 'custom' || panel !== panelVersion || version !== versions[id]) return;
      clearTimeout(addressTimers.get(id)); addressTimers.delete(id); addressSearches.delete(id);
      versions[id]++;
      selected[id] = place;
      $(id).value = place.name;
      box.hidden = true;
      clearRoute();
      updateAddressState();
      map.setZoomAndCenter(15, place.location);
      status(() => t('已选择地址：') + place.name);
    };
    box.append(button);
  });
  box.hidden = box.children.length === 0;
}
function searchPlaces(id) {
  clearTimeout(addressTimers.get(id)); addressTimers.delete(id);
  if (!$(id)) return;
  const keyword = $(id).value.trim();
  if (!loadedConfig || !keyword || selected[id] || activeRoutePanel !== 'custom') return;
  const city = $('city').value.trim() || '全国', previous = addressSearches.get(id);
  if (previous && previous.keyword === keyword && previous.city === city && previous.version === versions[id] && previous.panel === panelVersion && (previous.done ? !$(id + '-options').hidden : Date.now() - previous.started < 8000)) return;
  const version = ++versions[id], panel = panelVersion;
  const request = { keyword, city, version, panel, started: Date.now(), done: false }; addressSearches.set(id, request);
  const search = new AMap.PlaceSearch({ city, citylimit: false, pageSize: 6 });
  search.search(keyword, (resultStatus, result) => {
    if (request.done) return;
    request.done = true;
    if (!$(id) || activeRoutePanel !== 'custom' || panel !== panelVersion || version !== versions[id] || keyword !== $(id).value.trim()) return;
    if (resultStatus === 'complete' && result.poiList?.pois?.length) showPlaces(id, result.poiList.pois);
    else { $(id + '-options').hidden = true; status(() => resultStatus === 'no_data' ? t('没有找到该地点，请补充城市或更详细的地址。') : t('地点查询失败，请检查 Key 权限、额度和网络。'), true); }
  });
}
function bindAddress(id) {
  $(id).addEventListener('input', () => {
    tourInputSnapshot = null;
    clearTimeout(addressTimers.get(id)); addressSearches.delete(id); versions[id]++; selected[id] = null;
    $(id + '-options').hidden = true; clearRoute();
    updateAddressState();
    addressTimers.set(id, setTimeout(() => searchPlaces(id), 400));
  });
  $(id).addEventListener('focus', () => { if (!selected[id] && $(id).value.trim()) searchPlaces(id); });
}
['start', 'end'].forEach(bindAddress);
function updateMultiOptions() {
  const auto = $('end-mode').value === 'auto';
  $('optimization-options').hidden = !stops.length && !auto;
  $('policy-field').hidden = mode() !== 'driving' || stops.length > 0 || auto;
  $('add-stop').disabled = stops.length >= 6;
  document.querySelector('label[for="start"]').lastChild.textContent = auto ? t('地点 1（起点自动安排）') : t('起点');
  document.querySelector('label[for="end"]').lastChild.textContent = auto ? t('地点 ') + addressIds().length + t('（终点自动安排）') : stops.length && $('end-mode').value === 'free' ? t('地址（参与自动排序）') : t('终点');
  $('swap').hidden = auto; $('locate').hidden = auto;
  updateAddressState();
}
function moveStop(id, destination) {
  const from = stops.indexOf(id);
  if (from < 0 || destination < 0 || destination >= stops.length || destination === from) return false;
  stops.splice(from, 1); stops.splice(destination, 0, id);
  stops.forEach((stopId) => $('stops').append($(stopId + '-field')));
  clearRoute(); hideOptions(); updateMultiOptions();
  status(() => t('途经地址顺序已调整，请重新规划路线。'));
  return true;
}
function clearStopDrag() {
  pointerDrag = null;
  stops.forEach((id) => $(id + '-field').classList.remove('dragging', 'drop-before', 'drop-after'));
}
function addStop(focus = true) {
  if (stops.length >= 6) return null;
  tourInputSnapshot = null;
  const id = 'stop-' + (++nextStopId);
  stops.push(id); selected[id] = null; versions[id] = 0;
  const field = document.createElement('div'); field.className = 'location-field stop-field'; field.id = id + '-field';
  const label = document.createElement('label'); label.htmlFor = id; label.textContent = t('途经地址');
  const input = document.createElement('input'); input.id = id; input.placeholder = t('输入需要到访的地址'); input.autocomplete = 'off'; input.required = true; input.setAttribute('aria-controls', id + '-options');
  const box = document.createElement('div'); box.id = id + '-options'; box.className = 'suggestions'; box.hidden = true;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-stop'; remove.textContent = '×'; remove.setAttribute('aria-label', t('删除此地址'));
  remove.onclick = () => { tourInputSnapshot = null; clearTimeout(addressTimers.get(id)); addressTimers.delete(id); addressSearches.delete(id); versions[id]++; stops.splice(stops.indexOf(id), 1); delete selected[id]; field.remove(); clearRoute(); updateMultiOptions(); };
  const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'stop-drag'; handle.textContent = t('⠿ 拖动');
  handle.title = t('按住拖动调整顺序；键盘可使用上下方向键');
  handle.addEventListener('pointerdown', (event) => {
    if (stops.length < 2 || event.button !== 0 || pointerDrag) return;
    event.preventDefault(); handle.focus(); hideOptions();
    pointerDrag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId || pointerDrag.id !== id) return;
    if (!pointerDrag.moved && Math.hypot(event.clientX - pointerDrag.x, event.clientY - pointerDrag.y) < 6) return;
    pointerDrag.moved = true; field.classList.add('dragging'); pointerDrag.target = null;
    stops.forEach((stopId) => {
      const candidate = $(stopId + '-field'); candidate.classList.remove('drop-before', 'drop-after');
      if (stopId === id) return;
      const rect = candidate.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      const before = event.clientY < rect.top + rect.height / 2;
      candidate.classList.add(before ? 'drop-before' : 'drop-after');
      pointerDrag.target = { id: stopId, before };
    });
  });
  handle.addEventListener('pointerup', (event) => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId || pointerDrag.id !== id) return;
    const target = pointerDrag.moved && pointerDrag.target;
    clearStopDrag(); handle.releasePointerCapture(event.pointerId);
    if (!target) return;
    const from = stops.indexOf(id);
    let destination = stops.indexOf(target.id) + (target.before ? 0 : 1);
    if (from < destination) destination--;
    if (moveStop(id, destination)) handle.focus();
  });
  handle.addEventListener('pointercancel', clearStopDrag);
  handle.addEventListener('lostpointercapture', clearStopDrag);
  handle.addEventListener('dragstart', (event) => event.preventDefault());
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveStop(id, stops.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)); handle.focus();
  });
  field.append(label, handle, input, remove, box); $('stops').append(field); bindAddress(id); clearRoute(); updateMultiOptions(); if (focus) input.focus();
  return id;
}
$('add-stop').onclick = () => addStop();
$('open-batch').onclick = () => {
  $('batch-addresses').value = addressIds().map((id) => $(id).value.trim()).filter(Boolean).join('\n');
  writeText('batch-error', () => ''); $('batch-dialog').showModal();
};
$('close-batch').onclick = () => $('batch-dialog').close();
function importAddresses(names) {
  tourInputSnapshot = null;
  stops.forEach((id) => { versions[id]++; delete selected[id]; $(id + '-field').remove(); }); stops.length = 0;
  for (let i = 0; i < names.length - 2; i++) addStop(false);
  addressIds().forEach((id, i) => { versions[id]++; selected[id] = null; $(id).value = names[i]; });
  clearRoute(); hideOptions(); updateMultiOptions();
}
$('batch-form').onsubmit = (event) => {
  event.preventDefault();
  const names = $('batch-addresses').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length < 2 || names.length > 8) { writeText('batch-error', () => t('请输入 2–8 个地址，每行一个；空行会自动忽略。')); return; }
  importAddresses(names); $('address-details').open = true; $('batch-dialog').close(); $('start').focus();
  status(() => t('已导入 ') + names.length + t(' 个地址。点击各地址并选择候选地点，确认后再规划。'));
};
$('tour-places').addEventListener('input', () => { tourInputSnapshot = null; clearRoute(); });
$('tour-objective').onchange = () => { $('objective').value = $('tour-objective').value; clearRoute(); };
function queryTourPlaces(keyword) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { clearTimeout(timer); if (cancelRouteQuery === cancel) cancelRouteQuery = null; };
    const cancel = () => { if (settled) return; settled = true; finish(); reject(new Error('地址或选项已改变，请重新规划。')); };
    const timer = setTimeout(() => { settled = true; finish(); reject(new Error('地点查询失败，请检查 Key 权限、额度和网络。')); }, 15000);
    cancelRouteQuery = cancel;
    try {
      new AMap.PlaceSearch({ city: $('city').value.trim() || '全国', citylimit: Boolean($('city').value.trim()), pageSize: 6 }).search(keyword, (state, data) => {
        if (settled) return;
        settled = true; finish();
        if (state === 'complete' || state === 'no_data') resolve({ places: (data?.poiList?.pois || []).filter((place) => place.location), count: Number(data?.poiList?.count) });
        else reject(new Error('地点查询失败，请检查 Key 权限、额度和网络。'));
      });
    } catch (error) { settled = true; finish(); reject(error); }
  });
}
$('plan-tour').onclick = async () => {
  if (activeRoutePanel !== 'custom' || busy) return;
  const source = $('tour-places').value;
  const names = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length < 2 || names.length > 8) { status(() => t('请输入 2–8 个地址，每行一个；空行会自动忽略。'), true); return; }
  if (!loadedConfig) { openSettings(); return; }
  if (mode() !== 'driving') { status(() => t('多地址自动排序目前支持驾车，请切换到驾车；其他方式可规划两点路线。'), true); return; }
  if (source === tourInputSnapshot && $('end-mode').value === 'auto') return $('route-form').onsubmit({ preventDefault() {} });
  $('end-mode').value = 'auto'; $('objective').value = $('tour-objective').value;
  importAddresses(names); tourInputSnapshot = source;
  const request = routeVersion, requestPanel = panelVersion, ids = addressIds(), unresolved = [];
  busy = true; $('plan').disabled = true; $('plan-tour').disabled = true; $('apply-order').disabled = true; syncCurrentForm();
  $('planning-progress').hidden = false; $('cancel-plan').disabled = false;
  let ready = false;
  try {
    for (let i = 0; i < ids.length; i++) {
      ensureCurrent(request);
      status(() => t('正在识别游玩地点 ') + (i + 1) + '/' + ids.length + '…');
      progress(() => t('正在识别游玩地点 ') + (i + 1) + '/' + ids.length, i / ids.length * 100);
      const { places } = await queryTourPlaces(names[i]);
      ensureCurrent(request);
      // A named park and its gates are different matches. Equal names need a choice.
      const exact = places.filter((place) => place.name === names[i]);
      if (exact.length === 1) {
        selected[ids[i]] = exact[0]; $(ids[i]).value = exact[0].name; versions[ids[i]]++;
      } else unresolved.push({ id: ids[i], places });
      updateAddressState();
      if (i < ids.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    ensureCurrent(request);
    ready = !unresolved.length;
    $('address-details').open = !ready;
    if (!ready) {
      showPlaces(unresolved[0].id, unresolved[0].places);
      $('address-details').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      status(() => t('部分地点有多个匹配或未找到，请在下方确认位置，再点击规划路线。'), true);
    }
  } catch (error) {
    tourInputSnapshot = null;
    if (activeRoutePanel === 'custom' && requestPanel === panelVersion) {
      if (request === routeVersion) { $('address-details').open = true; status(() => t(error.message), true); }
      else status(() => $('cancel-plan').disabled ? t('计算已取消，可以重新规划。') : t('地址或选项已改变，请重新规划。'));
    }
  } finally {
    busy = false; $('plan').disabled = false; $('plan-tour').disabled = false; $('apply-order').disabled = false; $('planning-progress').hidden = true; syncCurrentForm();
  }
  if (ready && request === routeVersion && activeRoutePanel === 'custom' && requestPanel === panelVersion) await $('route-form').onsubmit({ preventDefault() {} });
};
$('cancel-plan').onclick = () => {
  if (!busy) return;
  clearRoute(); $('cancel-plan').disabled = true;
  progress(() => t('正在取消计算…'), null); status(() => t('计算已取消，可以重新规划。'));
};
$('apply-order').onclick = () => {
  if (!recommendedPoints) return;
  const points = recommendedPoints;
  addressIds().forEach((id, i) => { versions[id]++; selected[id] = points[i]; $(id).value = pointName(points[i]); });
  clearRoute(); hideOptions(); updateAddressState(); status(() => t('推荐顺序已填回地址栏，可调整后重新规划。'));
};
$('copy-order').onclick = async () => {
  if (!copiedItinerary) return;
  try { await navigator.clipboard.writeText(copiedItinerary); status(() => t('行程已复制，可以粘贴给同行的人。')); }
  catch { status(() => t('浏览器未允许复制，请选中推荐访问顺序后手动复制。'), true); }
};
$('end-mode').onchange = () => { clearRoute(); updateMultiOptions(); };
$('objective').onchange = () => { $('tour-objective').value = $('objective').value; clearRoute(); };
document.addEventListener('click', (event) => { if (!event.target.closest('.location-field')) hideOptions(); });
$('city').addEventListener('input', () => { tourInputSnapshot = null; hideOptions(); addressIds().forEach((id) => versions[id]++); clearRoute(); });
$('swap').onclick = () => {
  versions.start++; versions.end++; hideOptions(); clearRoute();
  [selected.start, selected.end] = [selected.end, selected.start];
  [$('start').value, $('end').value] = [$('end').value, $('start').value];
  updateAddressState();
};
document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => {
  if (mode() !== 'driving' && !stops.length && $('end-mode').value === 'auto') { $('end-mode').value = 'fixed'; tourInputSnapshot = null; }
  updateMultiOptions(); clearRoute();
}));
$('policy').onchange = clearRoute;
$('locate').onclick = () => {
  if (!loadedConfig) { openSettings(); return; }
  const version = ++versions.start;
  if (liveState?.positionState === 'active') { useLiveStart(livePosition, version); return; }
  pendingLocationStart = version; $('locate').disabled = true;
  status(() => t('正在获取你的位置，请允许浏览器定位…')); liveLocation.start();
};
$('live-toggle').onclick = () => { if (liveState?.enabled) liveLocation.stop(); else liveLocation.start(); };
$('live-recenter').onclick = () => liveLocation.recenter();
$('live-direction').onclick = () => liveLocation.enableDirection();
function pointName(point) { return point.currentLocation ? t(point.savedLocation ? '上次定位位置' : '我的位置') : point.name; }
function duration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds) / 60));
  return minutes >= 60 ? Math.floor(minutes / 60) + t('小时') + (minutes % 60 ? minutes % 60 + t('分钟') : '') : minutes + t('分钟');
}
function queryRoute(service, origin, destination, waypoints = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { clearTimeout(timer); if (cancelRouteQuery === cancel) cancelRouteQuery = null; };
    const cancel = () => { if (settled) return; settled = true; finish(); service.clear(); reject(new Error('地址或选项已改变，请重新规划。')); };
    const timer = setTimeout(() => { settled = true; finish(); service.clear(); reject(new Error('路线查询超时，请检查网络后重试。')); }, 15000);
    cancelRouteQuery = cancel;
    const callback = (resultStatus, result) => {
      if (settled) { service.clear(); return; }
      settled = true;
      finish();
      if (resultStatus === 'complete') resolve(result);
      else if (resultStatus === 'no_data') resolve(null);
      else reject(new Error('路线查询失败，请检查高德服务权限、额度和网络。'));
    };
    try {
      if (waypoints) service.search(origin, destination, { waypoints }, callback);
      else service.search(origin, destination, callback);
    } catch (error) { settled = true; finish(); reject(error); }
  });
}
function ensureCurrent(request) { if (request !== routeVersion) throw new Error('地址或选项已改变，请重新规划。'); }
function sameLocation(a, b) { return String(a) === String(b); }
async function buildMatrix(points, policy, objective, request) {
  const n = points.length;
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : Infinity));
  const fixed = $('end-mode').value === 'fixed';
  const auto = $('end-mode').value === 'auto';
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = auto ? 0 : 1; j < n; j++) {
    if (i !== j && !(fixed && (i === n - 1 || (i === 0 && j === n - 1)))) pairs.push([i, j]);
  }
  // Sequential queries avoid flooding the service and respect asymmetric road costs.
  for (let k = 0; k < pairs.length; k++) {
    ensureCurrent(request);
    const [i, j] = pairs[k];
    status(() => t('正在比较地址间的道路路线 ') + (k + 1) + '/' + pairs.length + '…');
    progress(() => t('比较道路路线 ') + (k + 1) + '/' + pairs.length, k / pairs.length * 90);
    if (sameLocation(points[i].location, points[j].location)) { matrix[i][j] = 0; continue; }
    const data = await queryRoute(new AMap.Driving({ policy }), points[i].location, points[j].location);
    ensureCurrent(request);
    const values = (data?.routes || []).map((route) => Number(route[objective])).filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length) matrix[i][j] = Math.min(...values);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return matrix;
}
async function planRoute(event, fromCurrent = false) {
  event.preventDefault();
  const ownerPanel = fromCurrent ? 'current' : 'custom';
  if (activeRoutePanel !== ownerPanel) return;
  if (busy) return;
  if (!loadedConfig) { openSettings(); return; }
  const position = fromCurrent ? freshCurrentPosition() : null;
  const travelMode = fromCurrent ? currentMode() : mode();
  if (fromCurrent && !position) { status(() => t('请先获取有效的当前位置，再规划路线。'), true); $('current-locate').focus(); return; }
  if (fromCurrent && !currentDestination) { searchCurrentDestination(); $('current-destination').focus(); status(() => t('请从候选地点中确认目的地的准确位置。'), true); return; }
  if (!fromCurrent && (stops.length || $('end-mode').value === 'auto') && travelMode !== 'driving') { status(() => t('多地址自动排序目前支持驾车，请切换到驾车；其他方式可规划两点路线。'), true); return; }
  for (const id of fromCurrent ? [] : addressIds()) {
    if (!selected[id]) { $('address-details').open = true; searchPlaces(id); $(id).focus(); status(() => t('请从候选地点中确认每一个地址的准确位置。'), true); return; }
  }
  if (!fromCurrent && addressIds().every((id) => sameLocation(selected[id].location, selected.start.location))) { status(() => t('请至少选择两个不同位置的地点。'), true); return; }
  if (!fromCurrent && travelMode === 'transfer' && !$('city').value.trim()) { $('city').focus(); status(() => t('公交规划需要填写所在城市。'), true); return; }
  clearRoute(); hideOptions();
  const request = routeVersion, requestPanel = panelVersion;
  busy = true; $('plan').disabled = true; $('plan-tour').disabled = true; syncCurrentForm(); status(() => t('正在计算路线…'));
  $('planning-progress').hidden = false; $('cancel-plan').disabled = false; progress(() => t('正在计算路线…'), null);
  $('apply-order').disabled = true;
  const options = { map, panel: 'route-panel', autoFitView: true };
  let activePlanner;
  try {
    let points = fromCurrent ? [{ name: t('我的位置'), currentLocation: true, location: position.location }, currentDestination] : addressIds().map((id) => selected[id]);
    const auto = !fromCurrent && $('end-mode').value === 'auto';
    const multi = !fromCurrent && (stops.length > 0 || auto);
    const objective = $('objective').value;
    const policy = multi ? (objective === 'distance' ? 2 : 0) : Number($(fromCurrent ? 'current-policy' : 'policy').value);
    let optimized, baseline;
    if (multi) {
      const matrix = await buildMatrix(points, policy, objective, request);
      ensureCurrent(request);
      optimized = auto ? window.RouteOptimizer.optimizeTourRoute(matrix) : window.RouteOptimizer.optimizeRoute(matrix, $('end-mode').value === 'fixed');
      if (!optimized) throw new Error('这些地址无法组成全部可达的驾车路线，请调整地址。');
      baseline = points.slice(1).reduce((sum, _, i) => sum + matrix[i][i + 1], 0);
      points = optimized.order.map((index) => points[index]);
      status(() => t('访问顺序已优化，正在生成完整路线…'));
      progress(() => t('正在生成完整路线…'), 95);
    }
    if (travelMode === 'driving') planner = new AMap.Driving({ ...options, policy });
    if (travelMode === 'transfer') {
      const city = fromCurrent ? await resolveCurrentCity(position, request) : $('city').value.trim();
      ensureCurrent(request); planner = new AMap.Transfer({ ...options, city, cityd: points.at(-1).cityname || city });
    }
    if (travelMode === 'walking') planner = new AMap.Walking(options);
    if (travelMode === 'riding') planner = new AMap.Riding(options);
    activePlanner = planner;
    const result = await queryRoute(activePlanner, points[0].location, points.at(-1).location, points.length > 2 ? points.slice(1, -1).map((point) => point.location) : null);
    ensureCurrent(request);
    const routes = result?.routes || result?.plans;
    if (!routes?.length) throw new Error('未找到可用路线，请调整地点或出行方式。');
    const route = routes[0];
    lastRoute = { route: { time: route.time, distance: route.distance }, points: points.map(memoryPoint), multi, baseline: Number.isFinite(baseline) ? baseline : null, optimized: optimized ? { cost: optimized.cost } : null, objective, ...routeGeometry(route) };
    renderOrder = () => renderRouteSummary({ route, points, multi, baseline, optimized, objective });
    renderOrder();
    rememberUsage();
    status(() => multi ? t('已生成经过全部地址的推荐路线。') : t('找到 ') + routes.length + t(' 个方案，可在下方查看路线详情。'));
  } catch (error) {
    if (activePlanner) activePlanner.clear();
    if (activeRoutePanel === ownerPanel && requestPanel === panelVersion) {
      if (request === routeVersion) status(() => t(error.message || '规划失败，请稍后重试。'), true);
      else status(() => $('cancel-plan').disabled ? t('计算已取消，可以重新规划。') : t('地址或选项已改变，请重新规划。'));
    }
  } finally { busy = false; $('plan').disabled = false; $('plan-tour').disabled = false; syncCurrentForm(); $('apply-order').disabled = false; $('planning-progress').hidden = true; }
}
function renderRouteSummary({ route, points, multi, baseline, optimized, objective }) {
      writeText('duration', () => Number.isFinite(Number(route.time)) ? duration(route.time) : t('查看路线详情'));
      writeText('distance', () => Number.isFinite(Number(route.distance)) ? (Number(route.distance) / 1000).toFixed(1) + t(' 公里') : '');
      writeText('route-caption', () => points.map((point) => pointName(point)).join(' → '));
      $('summary').hidden = false;
    if (multi) {
      $('order-list').replaceChildren();
      points.forEach((point, index) => {
        const item = document.createElement('li');
        item.textContent = (index === 0 ? t('起点 · ') : index === points.length - 1 ? t('最后一站 · ') : '') + pointName(point);
        if (typeof point.address === 'string' && point.address) { const address = document.createElement('small'); address.className = 'address-state'; address.textContent = point.address; item.append(address); }
        $('order-list').append(item);
      });
      const saving = Number.isFinite(baseline) ? Math.max(0, baseline - optimized.cost) : null;
      const comparison = saving === null ? t('原输入顺序存在不可达路段。') : saving < 1 ? t('原输入顺序已达到同等结果。') : t('相比输入顺序，分段估算减少 ') + (objective === 'time' ? (saving < 60 ? Math.round(saving) + t(' 秒') : duration(saving)) : (saving < 1000 ? Math.round(saving) + t(' 米') : (saving / 1000).toFixed(1) + t(' 公里'))) + t('。');
      writeText('optimization-note', () => comparison + t(' 按本次道路查询的分段') + (objective === 'time' ? t('耗时') : t('距离')) + t('选出最优顺序；完整路线以地图结果为准，实时路况可能变化。'));
      $('visit-order').hidden = false;
      recommendedPoints = points.slice();
      copiedItinerary = t('manmanhang · 推荐行程\n') + points.map((point, i) => (i + 1) + '. ' + pointName(point) + (typeof point.address === 'string' && point.address ? t('（') + point.address + t('）') : '')).join('\n') + t('\n预计 ') + $('duration').textContent + ' · ' + $('distance').textContent + '\n' + comparison + t('\n预计耗时仅供参考，请以实际路况为准。');
    }
}
$('route-form').onsubmit = (event) => planRoute(event);
$('current-route-form').onsubmit = (event) => planRoute(event, true);
window.I18n.onChange(() => {
  syncThemeButton();
  if (liveState) renderLiveState(liveState);
  addressIds().forEach(id => { if (selected[id]?.currentLocation) $(id).value = pointName(selected[id]); });
  updateMultiOptions();
  renderMapPlace();
  if (renderOrder) renderOrder();
  localizedText.forEach((render, id) => { $(id).textContent = render(); });
});
updateMultiOptions();
switchRoutePanel('current', false);
writeText('status', () => t('配置地图后，即可开始规划。'));
writeText('map-message', () => t('连接高德地图，查看你的路线。'));
restoreUsage();
usageReady = true;
loadMap();

function coordinates(location) {
  const values = Array.isArray(location) ? location : typeof location === 'string' ? location.split(',').map(Number) : [location?.getLng?.() ?? location?.lng, location?.getLat?.() ?? location?.lat];
  return values?.length === 2 && values.every(Number.isFinite) && Math.abs(values[0]) <= 180 && Math.abs(values[1]) <= 90 ? values.slice() : null;
}
function memoryPoint(point) {
  const location = coordinates(point?.location);
  if (!location || typeof point?.name !== 'string') return null;
  return { name: point.name, location, address: typeof point.address === 'string' ? point.address : '', cityname: typeof point.cityname === 'string' ? point.cityname : '', id: typeof point.id === 'string' ? point.id : '', currentLocation: Boolean(point.currentLocation) };
}
function routeGeometry(route) {
  const paths = [], instructions = [];
  function visit(part) {
    if (!part || typeof part !== 'object') return;
    if (typeof part.instruction === 'string') instructions.push(part.instruction);
    if (Array.isArray(part.path)) { const path = part.path.map(coordinates).filter(Boolean); if (path.length > 1) paths.push(path); }
    for (const [key, value] of Object.entries(part)) if (key !== 'path') { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value); }
  }
  visit(route);
  return { paths, instructions };
}
function rememberUsage() {
  if (!usageReady) return;
  usageDirty = true; clearTimeout(usageTimer); usageTimer = setTimeout(saveUsage, 250);
}
function saveUsage() {
  clearTimeout(usageTimer); usageTimer = 0;
  if (!usageDirty) return;
  try {
    if (map?.getCenter && map?.getZoom) savedMapView = { center: coordinates(map.getCenter()), zoom: map.getZoom() };
    const data = { version: 1, panel: activeRoutePanel, fields: Object.fromEntries(memoryFields.map(id => [id, $(id).value])), modes: { custom: mode(), current: currentMode() }, addresses: addressIds().map(id => ({ text: $(id).value, point: memoryPoint(selected[id]) })), currentDestination: memoryPoint(currentDestination), currentCityManual, tourInputSnapshot, addressDetailsOpen: Boolean($('address-details').open), mapView: savedMapView, route: lastRoute };
    localStorage.setItem('xingtu-usage', JSON.stringify(data));
    usageDirty = false;
    writeText('memory-status', () => t('使用数据已保存在此浏览器，关闭网页后仍会保留。'));
  } catch { writeText('memory-status', () => t('无法保存使用数据，请允许浏览器存储或释放存储空间。')); }
}
function validSavedRoute(route) {
  return route && Number.isFinite(route.route?.time) && route.route.time >= 0 && Number.isFinite(route.route?.distance) && route.route.distance >= 0 && Array.isArray(route.points) && route.points.length >= 2 && route.points.length <= 8 && route.points.every(memoryPoint) && typeof route.multi === 'boolean' && (!route.multi || Number.isFinite(route.optimized?.cost)) && ['time', 'distance'].includes(route.objective) && (route.baseline === null || Number.isFinite(route.baseline)) && Array.isArray(route.paths) && route.paths.every(path => Array.isArray(path) && path.every(coordinates)) && Array.isArray(route.instructions) && route.instructions.every(text => typeof text === 'string');
}
function restoreUsage() {
  // Restore before enabling saves, so startup cannot overwrite the previous session.
  try {
    const raw = localStorage.getItem('xingtu-usage');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.addresses) || data.addresses.length < 2 || data.addresses.length > 8 || !data.addresses.every(item => typeof item?.text === 'string' && (item.point === null || memoryPoint(item.point))) || !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields) || !Object.values(data.fields).every(value => typeof value === 'string') || !['current', 'custom'].includes(data.panel) || !['driving', 'transfer', 'walking', 'riding'].includes(data.modes?.custom) || !['driving', 'transfer', 'walking', 'riding'].includes(data.modes?.current)) throw new Error('Invalid usage data');
    importAddresses(data.addresses.map(item => item.text));
    addressIds().forEach((id, i) => { selected[id] = memoryPoint(data.addresses[i].point); if (selected[id]?.currentLocation) { selected[id].savedLocation = true; $(id).value = pointName(selected[id]); } });
    for (const id of Object.keys(memoryDefaults)) if (typeof data.fields[id] === 'string') $(id).value = data.fields[id];
    for (const [id, allowed] of Object.entries({ 'end-mode': ['fixed', 'free', 'auto'], objective: ['time', 'distance'], 'tour-objective': ['time', 'distance'], policy: ['0', '1', '2', '4'], 'current-policy': ['0', '1', '2', '4'] })) if (!allowed.includes($(id).value)) $(id).value = memoryDefaults[id];
    for (const [name, value] of [['mode', data.modes.custom], ['current-mode', data.modes.current]]) { const input = document.querySelector('input[name="' + name + '"][value="' + value + '"]'); if (input) input.checked = true; }
    currentDestination = memoryPoint(data.currentDestination); currentCityManual = Boolean(data.currentCityManual);
    tourInputSnapshot = typeof data.tourInputSnapshot === 'string' ? data.tourInputSnapshot : null;
    $('address-details').open = Boolean(data.addressDetailsOpen);
    if (coordinates(data.mapView?.center) && Number.isFinite(data.mapView.zoom) && data.mapView.zoom >= 2 && data.mapView.zoom <= 20) savedMapView = data.mapView;
    updateMultiOptions(); switchRoutePanel(data.panel, false);
    if (validSavedRoute(data.route)) {
      lastRoute = data.route;
      lastRoute.points.forEach(point => { if (point.currentLocation) point.savedLocation = true; });
      renderOrder = () => renderRouteSummary({ ...lastRoute, baseline: lastRoute.baseline === null ? Infinity : lastRoute.baseline });
      renderOrder(); $('saved-route-note').hidden = false;
      const details = document.createElement('ol');
      lastRoute.instructions.forEach(text => { const item = document.createElement('li'); item.textContent = text; details.append(item); });
      $('route-panel').append(details);
    }
    writeText('memory-status', () => t('已恢复上次使用数据。只有手动清除才会删除。'));
  } catch { writeText('memory-status', () => t('保存的使用数据无法恢复，请手动清除后重新开始。')); }
}
function drawSavedRoute() {
  if (!lastRoute || !map) return;
  for (const path of lastRoute.paths) savedRouteOverlays.push(new AMap.Polyline({ map, path, strokeColor: '#0091ff', strokeWeight: 5, strokeOpacity: 0.9 }));
  for (const point of lastRoute.points) savedRouteOverlays.push(new AMap.Marker({ map, position: point.location, title: pointName(point) }));
}
document.addEventListener('input', event => { if (memoryFields.includes(event.target.id)) rememberUsage(); });
document.addEventListener('change', event => { if (memoryFields.includes(event.target.id) || ['mode', 'current-mode'].includes(event.target.name)) rememberUsage(); });
window.addEventListener('pagehide', saveUsage);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveUsage(); });
$('clear-memory').onclick = () => {
  if (!window.confirm(t('清除已保存的地址、行程和出行选项？地图配置、语言和主题会保留。'))) return;
  try { localStorage.removeItem('xingtu-usage'); }
  catch { writeText('memory-status', () => t('无法清除使用数据，请允许浏览器存储后重试。')); return; }
  usageReady = false; clearTimeout(usageTimer); usageTimer = 0; usageDirty = false;
  clearRoute(); hideOptions(); closeMapPlace(); clearStopDrag();
  stops.forEach(id => { delete selected[id]; $(id + '-field').remove(); }); stops.length = 0;
  for (const id of ['start', 'end']) { selected[id] = null; $(id).value = ''; }
  for (const [id, value] of Object.entries(memoryDefaults)) $(id).value = value;
  for (const name of ['mode', 'current-mode']) document.querySelector('input[name="' + name + '"][value="driving"]').checked = true;
  currentDestination = null; currentCityManual = false; currentCityCache = null; tourInputSnapshot = null; savedMapView = null; pendingLocationStart = null;
  $('locate').disabled = false; $('batch-addresses').value = ''; $('address-details').open = false;
  updateMultiOptions(); syncCurrentForm();
  usageReady = true;
  writeText('memory-status', () => t('使用数据已清除。下次输入后会自动保存新的数据。'));
};
