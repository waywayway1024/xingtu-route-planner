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
        if (error) { script.remove(); sdkPromise = null; reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('地铁图加载失败，请检查网络后重试。')), 20000);
      target.manmanhangMetroReady = () => finish(typeof target.subway === 'function' ? null : new Error('地铁图加载失败，请检查网络后重试。'));
      script.src = 'https://webapi.amap.com/subway?' + new URLSearchParams({ v: '1.0', key, callback: 'manmanhangMetroReady' });
      script.onerror = () => finish(new Error('地铁图加载失败，请检查网络后重试。'));
      target.document.head.append(script);
    });
    return sdkPromise;
  }
  function create(options) {
    const $ = id => document.getElementById(id), dialog = $('metro-dialog'), t = root.I18n.t;
    let cities, view, city = '', start = null, end = null, station = null;
    let ready = false, loading = false, manualCity = false, waitingPosition = false, locating = false;
    let opening = 0, geocodeVersion = 0, loadTimer, routeTimer, pendingRoute = null;
    let statusText = '定位城市后查看地铁线路。', statusError = false, result = null;
    try {
      const saved = JSON.parse(localStorage.getItem('xingtu-metro') || 'null');
      if (saved && typeof saved.city === 'string') { city = saved.city; start = saved.start; end = saved.end; manualCity = Boolean(saved.manualCity); }
    } catch { /* The window still works without saved selections. */ }
    function save() {
      try { localStorage.setItem('xingtu-metro', JSON.stringify({ city, start: start?.id || null, end: end?.id || null, manualCity })); } catch { /* Storage is optional. */ }
    }
    function status(text, error = false) { statusText = text; statusError = error; render(); }
    function render() {
      $('metro-status').textContent = t(statusText); $('metro-status').classList.toggle('error', statusError);
      $('metro-start').value = start?.name || ''; $('metro-end').value = end?.name || '';
      $('metro-start').placeholder = $('metro-end').placeholder = t('点击地铁站设置');
      $('metro-plan').disabled = !ready || !start || !end || Boolean(pendingRoute);
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
      clearTimeout(routeTimer); pendingRoute = null; result = null;
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
      const drawnCity = $('metro-frame').contentDocument?.getElementById('subway-svg')?.getAttribute('adcode');
      if (drawnCity && drawnCity !== city) return;
      clearTimeout(loadTimer); loading = false; ready = true;
      start = stationInfo(typeof start === 'string' ? start : start?.id);
      end = stationInfo(typeof end === 'string' ? end : end?.id);
      if (start?.id === end?.id) end = null;
      if (start) view.setStart(start.id); if (end) view.setEnd(end.id);
      $('metro-line').replaceChildren();
      const all = document.createElement('option'); all.value = ''; all.textContent = t('全部线路'); $('metro-line').append(all);
      view.getLineList(lines => {
        for (const line of lines) {
          const option = document.createElement('option'); option.value = line.id; option.textContent = line.name; $('metro-line').append(option);
        }
        status('已加载城市全部地铁线路，可双指缩放、拖动并点击站点。');
      });
      const position = options.getPosition();
      const near = !manualCity && position ? view.getNearStation({ lnglat: String(position.location) }) : null;
      if (start || near) view.setCenter(view.getStCenter(start?.id || near));
      save(); render();
    }
    function showCity(code) {
      if (!cities?.[code] || loading || pendingRoute) return;
      const same = city === code;
      city = code; $('metro-city').value = code;
      $('metro-map').hidden = false;
      if (same && ready) { save(); render(); return; }
      clearResult(); ready = false; loading = true; station = null;
      if (!same) { start = null; end = null; }
      $('metro-search').value = '';
      status('正在加载城市地铁线路…');
      loadTimer = setTimeout(() => { loading = false; status('地铁图加载失败，请检查网络后重试。', true); }, 20000);
      if (view) view.setAdcode(code);
      else {
        view = $('metro-frame').contentWindow.subway('metro-canvas', { adcode: Number(code), theme: 'colorful', doubleclick: { switch: true } });
        view.event.on('subway.complete', loaded);
        view.event.on('error.complete', () => { clearTimeout(loadTimer); loading = false; ready = false; status('地铁图加载失败，请检查网络后重试。', true); });
        for (const event of ['station.touch', 'stationName.touch']) view.event.on(event, (event, info) => selectStation(info?.id));
        view.event.on('subway.routeComplete', (event, info) => {
          const route = info?.data?.buslist?.[0];
          if (!pendingRoute || !route || route.spoi?.id !== pendingRoute.start || route.epoi?.id !== pendingRoute.end) { view.clearRoute(); return; }
          clearTimeout(routeTimer); pendingRoute = null;
          if (String(info.status) !== '1' || !Number.isFinite(Number(route.expensetime)) || !Array.isArray(route.segmentlist) || !route.segmentlist.length || route.segmentlist.some(segment => String(segment.bustype) !== '2')) { view.clearRoute(); status('未找到可用地铁路线，请调整站点后重试。', true); return; }
          result = route; station = null; status('地铁路线已规划，请查看线路和换乘站。');
        });
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
        else { clearResult(); ready = false; $('metro-city').value = ''; $('metro-map').hidden = true; status('定位城市暂无高德地铁数据，请选择其他城市。', true); }
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
        if (frame.contentDocument?.readyState !== 'complete') await new Promise((resolve, reject) => {
          const loaded = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { frame.removeEventListener('load', loaded); reject(new Error('frame timeout')); }, 20000);
          frame.addEventListener('load', loaded, { once: true });
        });
        await loadSDK(options.getConfig().key, frame.contentWindow);
        if (token !== opening || !dialog.open) return;
        if (manualCity && cities[city]) showCity(city); else { manualCity = false; await identify(); }
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
    $('metro-plan').onclick = () => {
      if (!ready || !start || !end || pendingRoute) return;
      clearResult(); pendingRoute = { start: start.poiid, end: end.poiid }; station = null;
      status('正在计算地铁路线…');
      routeTimer = setTimeout(() => { pendingRoute = null; status('未找到可用地铁路线，请调整站点后重试。', true); }, 15000);
      view.route(start.id, end.id, { closeBtn: false });
    };
    for (const [id, step] of [['metro-zoom-in', .15], ['metro-zoom-out', -.15]]) $(id).onclick = () => {
      if (!ready) return;
      const scale = $('metro-frame').contentDocument.querySelector('.svg-g').transform.baseVal.consolidate().matrix.a;
      view.scale(Math.max(.5, Math.min(1.3, scale + step)));
    };
    $('metro-reset').onclick = () => { if (!pendingRoute) reset(); };
    root.I18n.onChange(render);
    return { open, onPosition(position) { if (waitingPosition && cities && typeof $('metro-frame').contentWindow.subway === 'function') identify(position); }, onLocationState(state) { if (waitingPosition && state.positionState === 'error') status('定位不可用，请允许位置权限或手动选择城市。', true); }, clear() { reset(); try { localStorage.removeItem('xingtu-metro'); } catch {} } };
  }
  const api = { create, cityForAddress };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Metro = api;
})(typeof window === 'object' ? window : globalThis);
