'use strict';
(function () {
  const touchScreen = window.matchMedia('(pointer: coarse)');
  if (touchScreen.matches) {
    document.querySelector('meta[name="viewport"]').content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  }
  function isMap(target) {
    return !!(target?.closest?.('#map') || target?.closest?.('#metro-map')) && !target.closest('.map-place-card');
  }
  function preventPageZoom(event) {
    if (!touchScreen.matches) return;
    const outsideMap = event.touches
      ? event.touches.length > 1 && !Array.from(event.touches).every(touch => isMap(touch.target))
      : !isMap(event.target);
    if (outsideMap) event.preventDefault();
  }
  // Safari may ignore viewport limits; leave the map SDK's own gestures intact.
  for (const type of ['touchstart', 'touchmove', 'gesturestart', 'gesturechange', 'dblclick']) {
    document.addEventListener(type, preventPageZoom, { passive: false });
  }
  const version = document.querySelector('meta[name="app-version"]')?.content;
  if (!version || version === '__APP_VERSION__') return;
  const banner = document.getElementById('app-update');
  const message = document.getElementById('app-update-message');
  const button = document.getElementById('app-update-button');
  const t = window.I18n.t;
  let available = false, checking = false, updating = false, failed = false;

  function render() {
    banner.hidden = !available;
    button.disabled = updating || navigator.onLine === false;
    button.textContent = t(updating ? '正在更新…' : '点击更新');
    message.textContent = t(navigator.onLine === false ? '有新版本，请联网后更新。' : failed ? '暂时无法更新，请稍后重试。' : '有新版本，更新后即可使用。');
  }
  async function fetchVersion() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/app-version.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Version check failed');
      const data = await response.json();
      if (typeof data.version !== 'string' || !/^[a-f0-9]{16}$/.test(data.version)) throw new Error('Invalid version');
      return data.version;
    } finally { clearTimeout(timer); }
  }
  async function checkUpdate() {
    if (checking || updating || document.hidden || navigator.onLine === false) return;
    checking = true;
    try { available = await fetchVersion() !== version; failed = false; render(); }
    catch { /* A failed background check must not interrupt route planning. */ }
    finally { checking = false; }
  }
  button.onclick = async () => {
    if (updating || navigator.onLine === false) return;
    updating = true; failed = false; render();
    try {
      await fetchVersion();
      // Existing pagehide handlers flush saved input and theme before navigation.
      window.location.reload();
    } catch { updating = false; failed = true; render(); }
  };
  window.I18n.onChange(render);
  window.addEventListener('online', () => { render(); checkUpdate(); });
  window.addEventListener('offline', render);
  window.addEventListener('focus', checkUpdate);
  window.addEventListener('pageshow', checkUpdate);
  document.addEventListener('visibilitychange', checkUpdate);
  setInterval(checkUpdate, 60000);
  checkUpdate();
})();
