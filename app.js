'use strict';
const $ = (id) => document.getElementById(id);
const selected = { start: null, end: null };
const versions = { start: 0, end: 0 };
const stops = [];
let nextStopId = 0;
let pointerDrag = null;
function addressIds() { return ['start', ...stops, 'end']; }
let map, planner, loadedConfig, busy = false, routeVersion = 0;
let appliedMapStyle = null, themeFrame = 0, themeMapTimer = 0, themePreferenceTimer = 0, pendingTheme = null;
let recommendedPoints = null, copiedItinerary = '';
function updateAddressState() {
  const ids = addressIds();
  $('address-count').textContent = ids.filter((id) => selected[id]).length + '/' + ids.length + ' 已确认';
  ids.forEach((id, index) => {
    const field = $(id).closest('.location-field');
    let hint = field.querySelector('.address-state');
    if (!hint) { hint = document.createElement('small'); hint.className = 'address-state'; field.append(hint); }
    hint.textContent = selected[id] ? '✓ 已确认 · ' + (typeof selected[id].address === 'string' && selected[id].address || selected[id].name) : $(id).value.trim() ? '请选择候选地点确认位置' : '等待输入地址';
    hint.classList.toggle('confirmed', Boolean(selected[id]));
    $(id).setAttribute('aria-invalid', String(Boolean($(id).value.trim() && !selected[id])));
    if (stops.includes(id)) {
      field.querySelector('label').textContent = '途经地址 ' + index;
      const handle = field.querySelector('.stop-drag');
      handle.disabled = stops.length < 2;
      handle.setAttribute('aria-label', '拖动途经地址 ' + index + ' 调整顺序，也可使用上下方向键');
    }
  });
}
function progress(label, value) {
  $('progress-label').textContent = label;
  if (value == null) $('progress-bar').removeAttribute('value');
  else $('progress-bar').value = value;
}
function mapStyle() { return document.documentElement.dataset.theme === 'dark' ? 'amap://styles/dark' : 'amap://styles/normal'; }
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-toggle').textContent = dark ? '☀ 日间模式' : '☾ 黑夜模式';
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
try { if (!config.managed) config = { ...config, ...JSON.parse(sessionStorage.getItem('xingtu-config') || '{}') }; } catch { /* Storage can be disabled. */ }
if (config.managed) { $('settings').hidden = true; $('connect').hidden = true; }
$('city').value = config.defaultCity || '北京';
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function mode() { return document.querySelector('input[name="mode"]:checked').value; }
function hideOptions() { addressIds().forEach((id) => { $(id + '-options').hidden = true; }); }
function clearRoute() {
  routeVersion++;
  recommendedPoints = null; copiedItinerary = '';
  if (planner) planner.clear();
  $('summary').hidden = true;
  $('visit-order').hidden = true;
  $('route-panel').replaceChildren();
}
function openSettings() {
  $('api-key').value = config.key || '';
  $('security-code').value = config.securityJsCode || '';
  $('service-host').value = config.serviceHost || '';
  $('config-error').textContent = '';
  $('config-dialog').showModal();
}
$('settings').onclick = openSettings;
$('connect').onclick = openSettings;
$('close-dialog').onclick = () => $('config-dialog').close();
$('config-form').onsubmit = (event) => {
  event.preventDefault();
  const next = { ...config, key: $('api-key').value.trim(), securityJsCode: $('security-code').value.trim(), serviceHost: $('service-host').value.trim() };
  if (!next.securityJsCode && !next.serviceHost) { $('config-error').textContent = '请填写安全密钥或安全代理地址。'; return; }
  try { sessionStorage.setItem('xingtu-config', JSON.stringify(next)); } catch { $('config-error').textContent = '浏览器禁止会话存储，请改为编辑 config.js 后刷新页面。'; return; }
  // Reload ensures the SDK uses the new security configuration, without mixing old map instances.
  location.reload();
};
async function loadMap() {
  if (!config.key) return;
  status('正在连接高德地图…');
  $('map-message').textContent = '正在加载地图…';
  $('connect').hidden = true;
  window._AMapSecurityConfig = config.serviceHost ? { serviceHost: config.serviceHost } : { securityJsCode: config.securityJsCode };
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('地图加载超时，请检查网络后刷新。')), 20000);
      script.src = 'https://webapi.amap.com/maps?' + new URLSearchParams({ v: '2.0', key: config.key, plugin: 'AMap.PlaceSearch,AMap.Driving,AMap.Transfer,AMap.Walking,AMap.Riding,AMap.Geolocation,AMap.ToolBar,AMap.Scale' });
      script.onload = () => { clearTimeout(timer); window.AMap ? resolve() : reject(new Error('地图加载失败，请核对 Key 和安全配置。')); };
      script.onerror = () => { clearTimeout(timer); reject(new Error('无法连接高德地图，请检查网络。')); };
      document.head.append(script);
    });
    map = new AMap.Map('map', { zoom: 12, center: config.center, viewMode: '2D', resizeEnable: true, mapStyle: mapStyle() });
    appliedMapStyle = mapStyle();
    map.addControl(new AMap.ToolBar({ position: 'RB' }));
    map.addControl(new AMap.Scale());
    loadedConfig = true;
    $('map-placeholder').hidden = true;
    status('地图已连接。输入地址后，请从候选地点中选择。');
  } catch (error) {
    $('map-message').textContent = error.message;
    $('connect').hidden = false;
    status(error.message, true);
  }
}
function showPlaces(id, places) {
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
      versions[id]++;
      selected[id] = place;
      $(id).value = place.name;
      box.hidden = true;
      clearRoute();
      updateAddressState();
      map.setZoomAndCenter(15, place.location);
      status('已选择地址：' + place.name);
    };
    box.append(button);
  });
  box.hidden = box.children.length === 0;
}
function searchPlaces(id) {
  if (!$(id)) return;
  const keyword = $(id).value.trim();
  const version = ++versions[id];
  if (!loadedConfig || !keyword) return;
  const search = new AMap.PlaceSearch({ city: $('city').value.trim() || '全国', citylimit: false, pageSize: 6 });
  search.search(keyword, (resultStatus, result) => {
    if (!$(id) || version !== versions[id] || keyword !== $(id).value.trim()) return;
    if (resultStatus === 'complete' && result.poiList?.pois?.length) showPlaces(id, result.poiList.pois);
    else { $(id + '-options').hidden = true; status(resultStatus === 'no_data' ? '没有找到该地点，请补充城市或更详细的地址。' : '地点查询失败，请检查 Key 权限、额度和网络。', true); }
  });
}
function bindAddress(id) {
  let timer;
  $(id).addEventListener('input', () => {
    clearTimeout(timer); versions[id]++; selected[id] = null;
    $(id + '-options').hidden = true; clearRoute();
    updateAddressState();
    timer = setTimeout(() => searchPlaces(id), 400);
  });
  $(id).addEventListener('focus', () => { if (!selected[id] && $(id).value.trim()) searchPlaces(id); });
}
['start', 'end'].forEach(bindAddress);
function updateMultiOptions() {
  $('optimization-options').hidden = !stops.length;
  $('policy-field').hidden = mode() !== 'driving' || stops.length > 0;
  $('add-stop').disabled = stops.length >= 6;
  document.querySelector('label[for="end"]').lastChild.textContent = stops.length && $('end-mode').value === 'free' ? '地址（参与自动排序）' : '终点';
  updateAddressState();
}
function moveStop(id, destination) {
  const from = stops.indexOf(id);
  if (from < 0 || destination < 0 || destination >= stops.length || destination === from) return false;
  stops.splice(from, 1); stops.splice(destination, 0, id);
  stops.forEach((stopId) => $('stops').append($(stopId + '-field')));
  clearRoute(); hideOptions(); updateMultiOptions();
  status('途经地址顺序已调整，请重新规划路线。');
  return true;
}
function clearStopDrag() {
  pointerDrag = null;
  stops.forEach((id) => $(id + '-field').classList.remove('dragging', 'drop-before', 'drop-after'));
}
function addStop(focus = true) {
  if (stops.length >= 6) return null;
  const id = 'stop-' + (++nextStopId);
  stops.push(id); selected[id] = null; versions[id] = 0;
  const field = document.createElement('div'); field.className = 'location-field stop-field'; field.id = id + '-field';
  const label = document.createElement('label'); label.htmlFor = id; label.textContent = '途经地址';
  const input = document.createElement('input'); input.id = id; input.placeholder = '输入需要到访的地址'; input.autocomplete = 'off'; input.required = true; input.setAttribute('aria-controls', id + '-options');
  const box = document.createElement('div'); box.id = id + '-options'; box.className = 'suggestions'; box.hidden = true;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-stop'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除此地址');
  remove.onclick = () => { versions[id]++; stops.splice(stops.indexOf(id), 1); delete selected[id]; field.remove(); clearRoute(); updateMultiOptions(); };
  const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'stop-drag'; handle.textContent = '⠿ 拖动';
  handle.title = '按住拖动调整顺序；键盘可使用上下方向键';
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
  $('batch-error').textContent = ''; $('batch-dialog').showModal();
};
$('close-batch').onclick = () => $('batch-dialog').close();
$('batch-form').onsubmit = (event) => {
  event.preventDefault();
  const names = $('batch-addresses').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (names.length < 2 || names.length > 8) { $('batch-error').textContent = '请输入 2–8 个地址，每行一个；空行会自动忽略。'; return; }
  stops.forEach((id) => { versions[id]++; delete selected[id]; $(id + '-field').remove(); }); stops.length = 0;
  for (let i = 0; i < names.length - 2; i++) addStop(false);
  addressIds().forEach((id, i) => { versions[id]++; selected[id] = null; $(id).value = names[i]; });
  clearRoute(); hideOptions(); updateMultiOptions(); $('batch-dialog').close(); $('start').focus();
  status('已导入 ' + names.length + ' 个地址。点击各地址并选择候选地点，确认后再规划。');
};
$('cancel-plan').onclick = () => {
  if (!busy) return;
  clearRoute(); $('cancel-plan').disabled = true;
  progress('正在取消计算…', null); status('已取消，将在当前查询结束后停止。');
};
$('apply-order').onclick = () => {
  if (!recommendedPoints) return;
  const points = recommendedPoints;
  addressIds().forEach((id, i) => { versions[id]++; selected[id] = points[i]; $(id).value = points[i].name; });
  clearRoute(); hideOptions(); updateAddressState(); status('推荐顺序已填回地址栏，可调整后重新规划。');
};
$('copy-order').onclick = async () => {
  if (!copiedItinerary) return;
  try { await navigator.clipboard.writeText(copiedItinerary); status('行程已复制，可以粘贴给同行的人。'); }
  catch { status('浏览器未允许复制，请选中推荐访问顺序后手动复制。', true); }
};
$('end-mode').onchange = () => { clearRoute(); updateMultiOptions(); };
$('objective').onchange = clearRoute;
document.addEventListener('click', (event) => { if (!event.target.closest('.location-field')) hideOptions(); });
$('city').addEventListener('input', () => { hideOptions(); addressIds().forEach((id) => versions[id]++); clearRoute(); });
$('swap').onclick = () => {
  versions.start++; versions.end++; hideOptions(); clearRoute();
  [selected.start, selected.end] = [selected.end, selected.start];
  [$('start').value, $('end').value] = [$('end').value, $('start').value];
  updateAddressState();
};
document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => { updateMultiOptions(); clearRoute(); }));
$('policy').onchange = clearRoute;
$('locate').onclick = () => {
  if (!loadedConfig) { openSettings(); return; }
  const version = ++versions.start;
  $('locate').disabled = true;
  status('正在获取你的位置，请允许浏览器定位…');
  new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10000 }).getCurrentPosition((resultStatus, result) => {
    $('locate').disabled = false;
    if (version !== versions.start) return;
    if (resultStatus !== 'complete' || !result.position) { status('定位失败，请允许定位权限，或手动输入起点地址。', true); return; }
    selected.start = { name: '我的位置', location: result.position };
    $('start').value = '我的位置';
    clearRoute(); hideOptions(); updateAddressState(); map.setZoomAndCenter(15, result.position); status('已将你的位置设为起点。');
  });
};
function duration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds) / 60));
  return minutes >= 60 ? Math.floor(minutes / 60) + '小时' + (minutes % 60 ? minutes % 60 + '分钟' : '') : minutes + '分钟';
}
function queryRoute(service, origin, destination, waypoints = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; service.clear(); reject(new Error('路线查询超时，请检查网络后重试。')); }, 15000);
    const callback = (resultStatus, result) => {
      if (settled) { service.clear(); return; }
      settled = true;
      clearTimeout(timer);
      if (resultStatus === 'complete') resolve(result);
      else if (resultStatus === 'no_data') resolve(null);
      else reject(new Error('路线查询失败，请检查高德服务权限、额度和网络。'));
    };
    try {
      if (waypoints) service.search(origin, destination, { waypoints }, callback);
      else service.search(origin, destination, callback);
    } catch (error) { settled = true; clearTimeout(timer); reject(error); }
  });
}
function ensureCurrent(request) { if (request !== routeVersion) throw new Error('地址或选项已改变，请重新规划。'); }
function sameLocation(a, b) { return String(a) === String(b); }
async function buildMatrix(points, policy, objective, request) {
  const n = points.length;
  const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : Infinity));
  const fixed = $('end-mode').value === 'fixed';
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = 1; j < n; j++) {
    if (i !== j && !(fixed && (i === n - 1 || (i === 0 && j === n - 1)))) pairs.push([i, j]);
  }
  // Sequential queries avoid flooding the service and respect asymmetric road costs.
  for (let k = 0; k < pairs.length; k++) {
    ensureCurrent(request);
    const [i, j] = pairs[k];
    status('正在比较地址间的道路路线 ' + (k + 1) + '/' + pairs.length + '…');
    progress('比较道路路线 ' + (k + 1) + '/' + pairs.length, k / pairs.length * 90);
    if (sameLocation(points[i].location, points[j].location)) { matrix[i][j] = 0; continue; }
    const data = await queryRoute(new AMap.Driving({ policy }), points[i].location, points[j].location);
    ensureCurrent(request);
    const values = (data?.routes || []).map((route) => Number(route[objective])).filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length) matrix[i][j] = Math.min(...values);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return matrix;
}
$('route-form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  if (!loadedConfig) { openSettings(); return; }
  if (stops.length && mode() !== 'driving') { status('多地址自动排序目前支持驾车，请切换到驾车；其他方式可规划两点路线。', true); return; }
  for (const id of addressIds()) {
    if (!selected[id]) { searchPlaces(id); $(id).focus(); status('请从候选地点中确认每一个地址的准确位置。', true); return; }
  }
  if (mode() === 'transfer' && !$('city').value.trim()) { $('city').focus(); status('公交规划需要填写所在城市。', true); return; }
  clearRoute(); hideOptions();
  const request = routeVersion;
  busy = true; $('plan').disabled = true; status('正在计算路线…');
  $('planning-progress').hidden = false; $('cancel-plan').disabled = false; progress('正在计算路线…', null);
  $('apply-order').disabled = true;
  const options = { map, panel: 'route-panel', autoFitView: true };
  const travelMode = mode();
  let activePlanner;
  try {
    let points = addressIds().map((id) => selected[id]);
    const multi = stops.length > 0;
    const objective = $('objective').value;
    const policy = multi ? (objective === 'distance' ? 2 : 0) : Number($('policy').value);
    let optimized, baseline;
    if (multi) {
      const matrix = await buildMatrix(points, policy, objective, request);
      ensureCurrent(request);
      optimized = window.RouteOptimizer.optimizeRoute(matrix, $('end-mode').value === 'fixed');
      if (!optimized) throw new Error('这些地址无法组成全部可达的驾车路线，请调整地址。');
      baseline = points.slice(1).reduce((sum, _, i) => sum + matrix[i][i + 1], 0);
      points = optimized.order.map((index) => points[index]);
      status('访问顺序已优化，正在生成完整路线…');
      progress('正在生成完整路线…', 95);
    }
    if (travelMode === 'driving') planner = new AMap.Driving({ ...options, policy });
    if (travelMode === 'transfer') planner = new AMap.Transfer({ ...options, city: $('city').value.trim(), cityd: selected.end.cityname || $('city').value.trim() });
    if (travelMode === 'walking') planner = new AMap.Walking(options);
    if (travelMode === 'riding') planner = new AMap.Riding(options);
    activePlanner = planner;
    const result = await queryRoute(activePlanner, points[0].location, points.at(-1).location, multi ? points.slice(1, -1).map((point) => point.location) : null);
    ensureCurrent(request);
    const routes = result?.routes || result?.plans;
    if (!routes?.length) throw new Error('未找到可用路线，请调整地点或出行方式。');
      const route = routes[0];
      $('duration').textContent = Number.isFinite(Number(route.time)) ? duration(route.time) : '查看路线详情';
      $('distance').textContent = Number.isFinite(Number(route.distance)) ? (Number(route.distance) / 1000).toFixed(1) + ' 公里' : '';
      $('route-caption').textContent = points.map((point) => point.name).join(' → ');
      $('summary').hidden = false;
    if (multi) {
      $('order-list').replaceChildren();
      points.forEach((point, index) => {
        const item = document.createElement('li');
        item.textContent = (index === 0 ? '起点 · ' : index === points.length - 1 ? '最后一站 · ' : '') + point.name;
        if (typeof point.address === 'string' && point.address) { const address = document.createElement('small'); address.className = 'address-state'; address.textContent = point.address; item.append(address); }
        $('order-list').append(item);
      });
      const saving = Number.isFinite(baseline) ? Math.max(0, baseline - optimized.cost) : null;
      const comparison = saving === null ? '原输入顺序存在不可达路段。' : saving < 1 ? '原输入顺序已达到同等结果。' : '相比输入顺序，分段估算减少 ' + (objective === 'time' ? (saving < 60 ? Math.round(saving) + ' 秒' : duration(saving)) : (saving < 1000 ? Math.round(saving) + ' 米' : (saving / 1000).toFixed(1) + ' 公里')) + '。';
      $('optimization-note').textContent = comparison + ' 按本次道路查询的分段' + (objective === 'time' ? '耗时' : '距离') + '选出最优顺序；完整路线以地图结果为准，实时路况可能变化。';
      $('visit-order').hidden = false;
      recommendedPoints = points.slice();
      copiedItinerary = '行途 · 推荐行程\n' + points.map((point, i) => (i + 1) + '. ' + point.name + (typeof point.address === 'string' && point.address ? '（' + point.address + '）' : '')).join('\n') + '\n预计 ' + $('duration').textContent + ' · ' + $('distance').textContent + '\n' + comparison + '\n预计耗时仅供参考，请以实际路况为准。';
    }
    status(multi ? '已生成经过全部地址的推荐路线。' : '找到 ' + routes.length + ' 个方案，可在下方查看路线详情。');
  } catch (error) {
    if (activePlanner) activePlanner.clear();
    if (request === routeVersion) status(error.message || '规划失败，请稍后重试。', true);
    else status($('cancel-plan').disabled ? '计算已取消，可以重新规划。' : '地址或选项已改变，请重新规划。');
  } finally { busy = false; $('plan').disabled = false; $('apply-order').disabled = false; $('planning-progress').hidden = true; }
};
updateMultiOptions();
loadMap();
