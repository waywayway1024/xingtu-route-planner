'use strict';
(function (root) {
  const normalize = (angle) => (angle % 360 + 360) % 360;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  // Project the top of the displayed screen onto the ground, using the W3C Z-X-Y rotation.
  // A near-vertical screen has no reliable top-edge heading; show a posture hint instead.
  function headingFromEvent(event, screenAngle = 0) {
    if (!finite(screenAngle)) screenAngle = 0;
    const angle = screenAngle * Math.PI / 180;
    if (finite(event.webkitCompassHeading)) {
      if (finite(event.webkitCompassAccuracy) && (event.webkitCompassAccuracy < 0 || event.webkitCompassAccuracy > 50)) return null;
      return normalize(event.webkitCompassHeading + screenAngle);
    }
    if (!(event.absolute === true || event.type === 'deviceorientationabsolute') || !finite(event.alpha) || !finite(event.beta) || !finite(event.gamma)) return null;
    const a = event.alpha * Math.PI / 180, b = event.beta * Math.PI / 180, g = event.gamma * Math.PI / 180;
    const x = Math.sin(angle), y = Math.cos(angle);
    const east = (Math.cos(a) * Math.cos(g) - Math.sin(a) * Math.sin(b) * Math.sin(g)) * x - Math.cos(b) * Math.sin(a) * y;
    const north = (Math.sin(a) * Math.cos(g) + Math.cos(a) * Math.sin(b) * Math.sin(g)) * x + Math.cos(b) * Math.cos(a) * y;
    if (Math.hypot(east, north) < 0.15) return null;
    return normalize(Math.atan2(east, north) * 180 / Math.PI);
  }
  function create(options) {
    const env = options.environment || root;
    const geo = env.navigator?.geolocation;
    const doc = env.document;
    const now = options.now || (() => Date.now());
    let enabled = false, watching = false, watchId = null, generation = 0, sequence = 0;
    let position = null, positionState = 'idle', positionError = '', positionTime = 0, receivedTime = 0, convertedCoords = null;
    let directionWanted = false, directionState = 'off', directionTime = 0, heading = null;
    let permissionVersion = 0, directionStarted = 0, lastEvent = null, lastEventTime = 0;
    let tickTimer = null, conversionTimer = null, retryTimer = null;
    let converting = false, pendingPosition = null, latestSample = null, retryCount = 0;
    const screenAngle = () => env.screen?.orientation?.angle ?? env.orientation ?? 0;
    const emit = () => options.onState?.({ enabled, watching, positionState, positionError, directionState, directionEnabled: directionWanted, heading, position });
    function clearConversion() {
      env.clearTimeout(conversionTimer); env.clearTimeout(retryTimer);
      conversionTimer = null; retryTimer = null; converting = false;
      pendingPosition = null; latestSample = null; retryCount = 0; sequence++;
    }
    function removeDirectionListeners() {
      env.removeEventListener('deviceorientation', orient);
      env.removeEventListener('deviceorientationabsolute', orient);
      env.screen?.orientation?.removeEventListener?.('change', screenChanged);
      env.removeEventListener('orientationchange', screenChanged);
      heading = null; lastEvent = null; lastEventTime = 0; options.onHeading?.(null);
    }
    function haltWatch() {
      generation++; clearConversion();
      if (watchId !== null) geo?.clearWatch(watchId);
      watchId = null; watching = false;
      env.clearInterval(tickTimer); tickTimer = null;
    }
    function stopDirection() {
      permissionVersion++; directionWanted = false; directionState = 'off';
      removeDirectionListeners(); emit();
    }
    function stop() {
      enabled = false; haltWatch(); stopDirection();
      position = null; positionState = 'idle'; positionError = ''; positionTime = 0; receivedTime = 0; convertedCoords = null;
      options.onClear?.(); emit();
    }
    function fail(error) {
      positionError = error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : 'unavailable';
      positionState = 'error'; clearConversion();
      if (error.code === 1) {
        enabled = false; haltWatch(); stopDirection(); position = null; options.onClear?.();
      }
      emit();
    }
    function accept(raw, token) {
      if (!watching || token !== generation) return;
      const coords = raw.coords;
      if (!coords || !finite(coords.longitude) || !finite(coords.latitude) || Math.abs(coords.longitude) > 180 || Math.abs(coords.latitude) > 90 || !finite(coords.accuracy) || coords.accuracy < 0) {
        fail({ code: 2 }); return;
      }
      const timestamp = finite(raw.timestamp) ? raw.timestamp : now();
      if (now() - timestamp > 30000 || timestamp < receivedTime) return;
      receivedTime = timestamp;
      latestSample = { coords: [coords.longitude, coords.latitude], accuracy: coords.accuracy, timestamp };
      pendingPosition = latestSample;
      processPosition(token);
    }
    function processPosition(token) {
      if (!watching || token !== generation || converting || retryTimer !== null || !pendingPosition) return;
      const sample = pendingPosition; pendingPosition = null;
      if (now() - sample.timestamp > 30000) return;
      converting = true; const request = ++sequence;
      const done = (error, location) => {
        if (!watching || token !== generation || request !== sequence) return;
        env.clearTimeout(conversionTimer); conversionTimer = null; converting = false; sequence++;
        if (error || !location) {
          positionState = 'error'; positionError = 'conversion'; emit();
          // Retry a fresh sample twice, with backoff; new GPS updates share the same queue.
          if (watching && token === generation && retryCount < 2 && latestSample && now() - latestSample.timestamp <= 30000) {
            const delay = 1000 * 2 ** retryCount++;
            retryTimer = env.setTimeout(() => {
              retryTimer = null;
              if (!watching || token !== generation) return;
              pendingPosition = pendingPosition || latestSample;
              processPosition(token);
            }, delay);
          }
          return;
        }
        retryCount = 0;
        // Delayed coordinate conversions must never revive an expired position.
        if (now() - sample.timestamp > 30000) { positionState = 'stale'; emit(); }
        else if (sample.timestamp >= positionTime) {
          position = { location, accuracy: sample.accuracy, timestamp: sample.timestamp };
          convertedCoords = sample.coords;
          positionTime = sample.timestamp; positionState = 'active'; positionError = '';
          options.onPosition?.(position); emit();
        }
        // A newer queued sample must not invalidate a still-fresh completed conversion.
        processPosition(token);
      };
      conversionTimer = env.setTimeout(() => done(new Error('conversion')), 8000);
      try {
        // Stationary updates still refresh timestamp/accuracy, without another map service call.
        if (position && convertedCoords?.[0] === sample.coords[0] && convertedCoords?.[1] === sample.coords[1]) done(null, position.location);
        else options.convertPosition(sample.coords, done);
      }
      catch { done(new Error('conversion')); }
    }
    function tick() {
      if (positionState === 'active' && now() - positionTime > 30000) { positionState = 'stale'; emit(); }
      if (directionWanted && directionState === 'waiting' && now() - directionStarted > 5000) {
        directionState = 'unavailable'; emit();
      }
      if (directionWanted && directionState === 'active' && now() - directionTime > 5000) {
        directionState = 'stale'; heading = null; options.onHeading?.(null); emit();
      }
    }
    function beginWatch() {
      if (!enabled || watching || doc?.hidden) return;
      watching = true; positionState = 'waiting'; positionError = ''; const token = ++generation;
      emit(); tickTimer = env.setInterval(tick, 1000);
      try {
        const id = geo.watchPosition((raw) => accept(raw, token), (error) => {
          if (watching && token === generation) fail(error);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        // Some adapters synchronously report a permission denial during registration.
        if (watching && token === generation) watchId = id; else geo.clearWatch(id);
      } catch { fail({ code: 1 }); }
    }
    function start() {
      if (enabled) {
        if (!doc?.hidden && ['error', 'stale'].includes(positionState)) { haltWatch(); beginWatch(); }
        return;
      }
      if (env.isSecureContext === false || !geo?.watchPosition) {
        positionState = 'error'; positionError = env.isSecureContext === false ? 'insecure' : 'unsupported'; emit(); return;
      }
      enabled = true;
      if (doc?.hidden) { positionState = 'paused'; emit(); } else beginWatch();
    }
    function orient(event, timestamp = now()) {
      if (!directionWanted || !watching) return;
      // Prefer iOS compass data or absolute events; relative alpha is not north-referenced.
      if (!(finite(event.webkitCompassHeading) || event.absolute === true || event.type === 'deviceorientationabsolute')) return;
      lastEvent = event; lastEventTime = timestamp;
      const next = headingFromEvent(event, screenAngle());
      if (next === null) {
        if (finite(event.webkitCompassHeading) || event.absolute === true || event.type === 'deviceorientationabsolute') {
          if (directionState !== 'posture' || heading !== null) {
            directionState = 'posture'; heading = null; options.onHeading?.(null); emit();
          }
        }
        return;
      }
      directionTime = timestamp;
      const delta = heading === null ? 0 : (next - normalize(heading) + 540) % 360 - 180;
      // Keep an unwrapped angle so that 359 -> 0 never animates a full revolution.
      heading = heading === null ? next : heading + delta * 0.35;
      const changed = directionState !== 'active'; directionState = 'active';
      options.onHeading?.(heading);
      if (changed) emit();
    }
    function screenChanged() {
      if (!directionWanted || !watching || !lastEvent) return;
      if (now() - lastEventTime > 5000) {
        if (directionState !== 'stale' || heading !== null) { directionState = 'stale'; heading = null; options.onHeading?.(null); emit(); }
        return;
      }
      heading = null;
      orient(lastEvent, lastEventTime);
    }
    function addDirectionListeners() {
      directionState = 'waiting'; directionStarted = now();
      env.addEventListener('deviceorientation', orient);
      env.addEventListener('deviceorientationabsolute', orient);
      env.screen?.orientation?.addEventListener?.('change', screenChanged);
      env.addEventListener('orientationchange', screenChanged); emit();
    }
    async function enableDirection() {
      if (!enabled || !watching) return;
      if (directionWanted) { stopDirection(); return; }
      if (!env.DeviceOrientationEvent) { directionState = 'unavailable'; emit(); return; }
      directionWanted = true; directionState = 'requesting'; const request = ++permissionVersion; emit();
      try {
        // Called directly from the button gesture, before awaiting any GPS result.
        const permission = typeof env.DeviceOrientationEvent.requestPermission === 'function' ? await env.DeviceOrientationEvent.requestPermission(true) : 'granted';
        if (request !== permissionVersion || !enabled || !watching) return;
        if (permission !== 'granted') { directionWanted = false; directionState = 'denied'; emit(); return; }
        addDirectionListeners();
      } catch {
        if (request !== permissionVersion) return;
        directionWanted = false; directionState = 'denied'; emit();
      }
    }
    function suspend() {
      if (!enabled) return;
      const pending = directionState === 'requesting'; permissionVersion++; haltWatch(); removeDirectionListeners();
      if (pending) directionWanted = false;
      positionState = 'paused'; directionState = directionWanted ? 'paused' : 'off'; emit();
    }
    function resume() { if (enabled && !watching) { beginWatch(); if (directionWanted && watching) addDirectionListeners(); } }
    function visibilityChanged() { if (doc.hidden) suspend(); else resume(); }
    doc?.addEventListener?.('visibilitychange', visibilityChanged);
    env.addEventListener('pagehide', suspend);
    env.addEventListener('pageshow', resume);
    emit();
    return { start, stop, enableDirection, stopDirection, recenter() { if (positionState === 'active') options.onRecenter?.(position); }, dispose() {
      stop(); doc?.removeEventListener?.('visibilitychange', visibilityChanged);
      env.removeEventListener('pagehide', suspend); env.removeEventListener('pageshow', resume);
    } };
  }
  const api = { create, headingFromEvent };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveLocation = api;
})(typeof window === 'object' ? window : globalThis);
