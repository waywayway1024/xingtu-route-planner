'use strict';
(function (root) {
  function cityForAddress(cities, address) {
    const name = typeof address?.city === 'string' && address.city || address?.province;
    return Object.keys(cities).find(code => cities[code].name === name) || null;
  }
  let sdkPromise;
  function loadSDK(key, target) {
    if (typeof target.subway === 'function') return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = target.document.createElement('script');
      const finish = error => {
        clearTimeout(timer); delete target.manmanhangMetroReady;
        if (error) { script.remove(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('地铁图加载失败，请检查网络后重试。')), 20000);
      target.manmanhangMetroReady = () => finish(typeof target.subway === 'function' ? null : new Error('地铁图加载失败，请检查网络后重试。'));
      script.src = 'https://webapi.amap.com/subway?' + new URLSearchParams({ v: '1.0', key, callback: 'manmanhangMetroReady' });
      script.onerror = () => finish(new Error('地铁图加载失败，请检查网络后重试。'));
      target.document.head.append(script);
    }).finally(() => { sdkPromise = null; });
    return sdkPromise;
  }
  function create(options) {
    const $ = id => document.getElementById(id), dialog = $('metro-dialog'), t = root.I18n.t;
    let cities, view, city = '', start = null, end = null, station = null;
    let ready = false, loading = false, manualCity = false, waitingPosition = false, locating = false;
    let opening = 0, geocodeVersion = 0, loadTimer, routeTimer, pendingRoute = null;
    let statusText = '定位城市后查看地铁线路。', statusError = false, result = null, routeData = null, storageError = false;
    function stationId(value) { return typeof value === 'string' ? value : value?.id; }
    function savedStation(value) {
      if (typeof value === 'string') return value;
      return value && typeof value.id === 'string' && typeof value.name === 'string' ? { id: value.id, name: value.name, poiid: value.poiid } : null;
    }
    function routeInfo(data) {
      const route = data?.buslist?.[0];
      return route && Number.isFinite(Number(route.expensetime)) && Array.isArray(route.segmentlist) && route.segmentlist.length &&
        route.segmentlist.every(segment => segment && String(segment.bustype) === '2' && ['startname', 'endname', 'busname'].every(key => typeof segment[key] === 'string')) ? route : null;
    }
    try {
      const saved = JSON.parse(localStorage.getItem('xingtu-metro') || 'null');
      if (saved && /^\d{4}$/.test(saved.city)) {
        city = saved.city; start = savedStation(saved.start); end = savedStation(saved.end); manualCity = Boolean(saved.manualCity);
        const route = routeInfo(saved.route);
        if (route && String(saved.route.count) === '1' && start?.poiid && end?.poiid && stationId(start) !== stationId(end) && route.spoi?.id === start.poiid && route.epoi?.id === end.poiid) {
          routeData = saved.route; result = route; statusText = '已恢复上次地铁路线，可直接查看线路和换乘站。';
        }
      }
    } catch { /* The window still works without saved selections. */ }
    function save() {
      try { localStorage.setItem('xingtu-metro', JSON.stringify({ city, start: savedStation(start), end: savedStation(end), manualCity, route: routeData })); storageError = false; }
      catch { storageError = true; }
    }
    function status(text, error = false) { statusText = text; statusError = error; render(); }
    function render() {
      $('metro-status').textContent = t(storageError ? '无法保存地铁数据，请允许浏览器存储或释放存储空间。' : statusText); $('metro-status').classList.toggle('error', statusError || storageError);
      $('metro-start').value = start?.name || ''; $('metro-end').value = end?.name || '';
      $('metro-start').placeholder = $('metro-end').placeholder = t('点击地铁站设置');
      $('metro-plan').disabled = !ready || !stationInfo(stationId(start)) || !stationInfo(stationId(end)) || Boolean(pendingRoute);
      $('metro-plan').textContent = t(pendingRoute ? '正在计算路线…' : '规划地铁路线');
      $('metro-city').disabled = !cities || typeof $('metro-frame').contentWindow.subway !== 'function' || loading || Boolean(pendingRoute);
      $('metro-locate').disabled = $('metro-city').disabled;
      $('metro-line').disabled = $('metro-search').disabled = !ready || Boolean(pendingRoute);
      if ($('metro-line').children.length) $('metro-line').children[0].textContent = t('全部线路');
      for (const id of ['metro-set-start', 'metro-set-end', 'metro-swap', 'metro-zoom-in', 'metro-zoom-out']) $(id).disabled = !ready || Boolean(pendingRoute);
      $('metro-station').hidden = !station || !ready;
      if (station) {
        $('metro-station-name').textContent = station.name;
        $('metro-station-lines').textContent = (station.referlines || []).map(line => line.name).join(' · ');
        $('metro-set-start').textContent = t('设为起点'); $('metro-set-end').textContent = t('设为终点');
      }
      $('metro-result').hidden = !result;
      if (result) {
        $('metro-result').replaceChildren();
        const summary = document.createElement('strong');
        summary.textContent = Math.max(1, Math.round(Number(result.expensetime) / 60)) + t('分钟');
        if (result.expense !== '' && Number.isFinite(Number(result.expense))) summary.textContent += ' · ' + Number(result.expense) + (result.expense_currency ? ' ' + result.expense_currency : t(' 元'));
        $('metro-result').append(summary);
        for (const segment of result.segmentlist) {
          const item = document.createElement('p');
          item.textContent = segment.startname + ' → ' + segment.endname + ' · ' + segment.busname;
          $('metro-result').append(item);
        }
      }
    }
    function clearResult() {
      pendingRoute?.abort();
      clearTimeout(routeTimer); pendingRoute = null; result = null; routeData = null;
      view?.clearRoute(); $('metro-search-results').hidden = true;
    }
    function reset() {
      clearResult(); view?.clearOverlays(); start = null; end = null; station = null;
      save(); status('点击地铁站，选择起点或终点。');
    }
    function stationInfo(id) {
      const info = typeof id === 'string' ? view.getStationInfo(id) : null;
      return info?.id && info.name && info.status === '1' ? info : null;
    }
    function restoreRoute() {
      if (!routeData || !ready || !stationInfo(stationId(start)) || !stationInfo(stationId(end)) || typeof view.routeWithData !== 'function') return false;
      // Redraw the saved response; querying again could replace the user's itinerary.
      try { view.routeWithData({ start: stationId(start), end: stationId(end), routedata: routeData, closeBtn: false }); return true; }
      catch { return false; }
    }
    function routeFailed(request) {
      if (request !== pendingRoute) return;
      request.abort();
      clearTimeout(routeTimer); pendingRoute = null; restoreRoute();
      status('未找到可用地铁路线，请调整站点后重试。', true);
    }
    function selectStation(id) {
      if (!ready || pendingRoute) return;
      const info = stationInfo(id);
      if (!info) { status('该站暂不可用，请选择运营中的地铁站。', true); return; }
      station = info; $('metro-search-results').hidden = true;
      $('metro-search').blur();
      view.stopAnimation(); view.setCenter(view.getStCenter(info.id));
      status('请选择将这个地铁站设为起点或终点。');
    }
    function setEndpoint(which) {
      if (!station || !ready || pendingRoute) return;
      if ((which === 'start' ? end : start)?.id === station.id) { status('起点和终点不能是同一个地铁站。', true); return; }
      clearResult();
      const previous = which === 'start' ? start : end;
      if (previous) view.clearMarker(previous.id);
      if (which === 'start') { start = station; view.setStart(start.id); } else { end = station; view.setEnd(end.id); }
      station = null; save(); status(start && end ? '起终点已选择，可以规划地铁路线。' : '请继续选择另一个地铁站。');
    }
    function loaded() {
      if (!city) return;
      const drawnCity = $('metro-frame').contentDocument?.getElementById('subway-svg')?.getAttribute('adcode');
      if (drawnCity && drawnCity !== city) return;
      clearTimeout(loadTimer); loading = false; ready = true;
      const mapStart = stationInfo(stationId(start)), mapEnd = stationInfo(stationId(end));
      if (!result) { start = mapStart || start; end = mapEnd || end; }
      if (start && stationId(start) === stationId(end)) { end = null; result = null; routeData = null; }
      if (mapStart) view.setStart(mapStart.id); if (mapEnd) view.setEnd(mapEnd.id);
      status('已加载城市全部地铁线路，可双指缩放、拖动并点击站点。');
      $('metro-line').replaceChildren();
      const all = document.createElement('option'); all.value = ''; all.textContent = t('全部线路'); $('metro-line').append(all);
      view.getLineList(lines => {
        for (const line of lines) {
          const option = document.createElement('option'); option.value = line.id; option.textContent = line.name; $('metro-line').append(option);
        }
        render();
      });
      const position = options.getPosition();
      const near = !manualCity && position ? view.getNearStation({ lnglat: String(position.location) }) : null;
      if (mapStart || near) view.setCenter(view.getStCenter(mapStart?.id || near));
      if (result) status(restoreRoute() ? '已恢复上次地铁路线，可直接查看线路和换乘站。' : '已保留上次地铁路线，当前地铁图无法恢复高亮。');
      save(); render();
    }
    function showCity(code) {
      if (!cities?.[code] || loading || pendingRoute) return;
      const same = city === code;
      city = code; $('metro-city').value = code;
      $('metro-map').hidden = false;
      if (same && ready) { save(); render(); return; }
      ready = false; loading = true; station = null;
      if (!same) { clearResult(); start = null; end = null; save(); }
      $('metro-search').value = '';
      status('正在加载城市地铁线路…');
      loadTimer = setTimeout(() => { loading = false; status('地铁图加载失败，请检查网络后重试。', true); }, 20000);
      if (view) view.setAdcode(code);
      else {
        view = $('metro-frame').contentWindow.subway('metro-canvas', { adcode: Number(code), theme: 'colorful', doubleclick: { switch: true } });
        view.event.on('subway.complete', loaded);
        view.event.on('error.complete', () => { clearTimeout(loadTimer); loading = false; ready = false; status('地铁图加载失败，请检查网络后重试。', true); });
        for (const event of ['station.touch', 'stationName.touch']) view.event.on(event, (event, info) => selectStation(info?.id));
      }
    }
    async function identify(position = options.getPosition()) {
      if (!dialog.open || manualCity || locating) return;
      if (!position || Date.now() - position.timestamp > 30000) {
        waitingPosition = true; status('正在等待定位，也可以手动选择地铁城市。'); options.requestLocation(); return;
      }
      waitingPosition = false; locating = true; const version = ++geocodeVersion;
      status('正在识别定位城市…');
      try {
        const address = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('无法识别定位城市，请手动选择。')), 8000);
          try { new root.AMap.Geocoder().getAddress(position.location, (state, data) => {
            clearTimeout(timer);
            if (state === 'complete' && data?.regeocode?.addressComponent) resolve(data.regeocode.addressComponent);
            else reject(new Error('无法识别定位城市，请手动选择。'));
          }); } catch { clearTimeout(timer); reject(new Error('无法识别定位城市，请手动选择。')); }
        });
        if (version !== geocodeVersion || !dialog.open || manualCity) return;
        const code = cityForAddress(cities, address);
        if (code) showCity(code);
        else {
          clearResult(); clearTimeout(loadTimer); view?.clearOverlays();
          city = ''; start = null; end = null; station = null; ready = false; loading = false;
          $('metro-city').value = ''; $('metro-map').hidden = true; save();
          status('定位城市暂无高德地铁数据，请选择其他城市。', true);
        }
      } catch (error) { if (version === geocodeVersion && dialog.open) status(error.message, true); }
      finally { if (version === geocodeVersion) locating = false; }
    }
    async function open() {
      if (dialog.open) return;
      dialog.showModal(); document.documentElement.classList.add('metro-open');
      const token = ++opening; render();
      try {
        if (!cities) {
          status('正在加载地铁城市…');
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
          let data;
          try { const response = await fetch('https://webapi.amap.com/subway/data/citylist.json', { signal: controller.signal }); if (!response.ok) throw new Error(); data = await response.json(); }
          finally { clearTimeout(timer); }
          if (token !== opening || !dialog.open) return;
          const entries = (Array.isArray(data?.citylist) ? data.citylist : []).filter(value => /^\d{4}$/.test(value?.adcode) && typeof value.cityname === 'string').map(value => [value.adcode, { name: value.cityname }]);
          if (!entries.length) throw new Error('城市数据暂不可用，请重新打开地铁窗口。');
          cities = Object.fromEntries(entries);
          for (const [code, info] of entries) { const option = document.createElement('option'); option.value = code; option.textContent = info.name; $('metro-city').append(option); }
        }
        const frame = $('metro-frame');
        if (frame.contentDocument?.readyState !== 'complete' || !frame.contentDocument?.getElementById('metro-canvas')) await new Promise((resolve, reject) => {
          const loaded = () => {
            if (frame.contentDocument?.readyState !== 'complete' || !frame.contentDocument?.getElementById('metro-canvas')) return;
            clearTimeout(timer); frame.removeEventListener('load', loaded); resolve();
          };
          const timer = setTimeout(() => { frame.removeEventListener('load', loaded); reject(new Error('frame timeout')); }, 20000);
          frame.addEventListener('load', loaded);
        });
        if (token !== opening || !dialog.open) return;
        await loadSDK(options.getConfig().key, frame.contentWindow);
        if (token !== opening || !dialog.open) return;
        if (cities[city]) showCity(city); else if (!city) { manualCity = false; await identify(); }
        else status('已保存的地铁城市暂不可用，请手动选择城市。', true);
      } catch { if (token === opening && dialog.open) status('地铁图加载失败，请检查网络后重试。', true); }
      render();
    }
    dialog.addEventListener('close', () => { opening++; geocodeVersion++; locating = false; waitingPosition = false; document.documentElement.classList.remove('metro-open'); });
    $('metro-close').onclick = () => dialog.close();
    $('metro-city').onchange = () => { manualCity = true; waitingPosition = false; geocodeVersion++; locating = false; showCity($('metro-city').value); };
    $('metro-locate').onclick = () => { if (loading || pendingRoute) return; manualCity = false; identify(); };
    $('metro-line').onchange = () => { if (!ready) return; const line = $('metro-line').value; if (line) { view.showLine(line); view.setFitView($('metro-frame').contentDocument.querySelector('#g-select')); view.setCenter(view.getSelectedLineCenter()); } else view.clearLine(); };
    $('metro-search').addEventListener('input', () => {
      const keyword = $('metro-search').value.trim(), box = $('metro-search-results'); box.replaceChildren(); box.hidden = true;
      if (!ready || !keyword) return;
      const searchCity = city;
      view.stationSearch(keyword, data => {
        if (!ready || city !== searchCity || $('metro-search').value.trim() !== keyword) return;
        for (const info of (data.stationList || []).filter(info => info.status === '1').slice(0, 8)) { const button = document.createElement('button'); button.type = 'button'; button.textContent = info.name; button.onclick = () => selectStation(info.id); box.append(button); }
        box.hidden = !box.children.length;
      });
    });
    $('metro-set-start').onclick = () => setEndpoint('start'); $('metro-set-end').onclick = () => setEndpoint('end');
    $('metro-swap').onclick = () => { if (!ready || pendingRoute) return; clearResult(); view.clearOverlays(); [start, end] = [end, start]; if (start) view.setStart(start.id); if (end) view.setEnd(end.id); save(); render(); };
    $('metro-plan').onclick = async () => {
      if (!ready || pendingRoute) return;
      const mapStart = stationInfo(stationId(start)), mapEnd = stationInfo(stationId(end));
      if (!mapStart || !mapEnd) return;
      view.clearRoute(); const request = pendingRoute = new AbortController(); station = null;
      status('正在计算地铁路线…');
      routeTimer = setTimeout(() => routeFailed(request), 15000);
      try {
        const [x1, y1] = mapStart.lnglat.split(','), [x2, y2] = mapEnd.lnglat.split(',');
        const params = new URLSearchParams({ x1, y1, x2, y2, poiid1: mapStart.poiid, poiid2: mapEnd.poiid, uuid: root.crypto.randomUUID(), type: '6', Ver: '3' });
        // Use the SDK's route service with a per-request signal; its shared event has no request ID.
        const response = await fetch('https://webapi.amap.com/subway/service/navigation/busExt?' + params, { signal: request.signal });
        if (!response.ok) throw new Error('route request failed');
        const data = await response.json();
        if (pendingRoute !== request) return;
        const route = routeInfo(data);
        if (String(data?.count) !== '1' || route?.spoi?.id !== mapStart.poiid || route?.epoi?.id !== mapEnd.poiid) throw new Error('invalid route');
        clearTimeout(routeTimer); pendingRoute = null; start = mapStart; end = mapEnd;
        routeData = { ...data, count: '1' }; result = route; restoreRoute(); save(); status('地铁路线已规划，请查看线路和换乘站。');
      } catch { routeFailed(request); }
    };
    for (const [id, step] of [['metro-zoom-in', .15], ['metro-zoom-out', -.15]]) $(id).onclick = () => {
      if (!ready) return;
      const scale = $('metro-frame').contentDocument.querySelector('.svg-g').transform.baseVal.consolidate().matrix.a;
      view.scale(Math.max(.5, Math.min(1.3, scale + step)));
    };
    $('metro-reset').onclick = reset;
    root.I18n.onChange(render);
    render();
    return { open, onPosition(position) { if (waitingPosition && cities && typeof $('metro-frame').contentWindow.subway === 'function') identify(position); }, onLocationState(state) { if (waitingPosition && state.positionState === 'error') status('定位不可用，请允许位置权限或手动选择城市。', true); }, clear() { reset(); try { localStorage.removeItem('xingtu-metro'); } catch {} } };
  }
  const api = { create, cityForAddress };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Metro = api;
})(typeof window === 'object' ? window : globalThis);
