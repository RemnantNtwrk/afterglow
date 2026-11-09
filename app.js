// App glue: menu, now-playing UI, Spotify polling, demo mode, and remote/keyboard controls.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let viz;
  try { viz = new Visualizer($('gl')); }
  catch (e) {
    document.body.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;' +
      'text-align:center;font-size:24px;padding:40px">Sorry — this screen doesn\'t support the graphics (WebGL) ' +
      'the visualizer needs.<br><br><small style="opacity:.6">' + String(e.message).replace(/</g, '&lt;') + '</small></div>';
    return;
  }
  const SCENES = Visualizer.SCENES;

  // ---------- helpers ----------
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function prefs() { try { return JSON.parse(localStorage.getItem('viz_prefs')) || {}; } catch (e) { return {}; } }
  function savePrefs(p) { try { localStorage.setItem('viz_prefs', JSON.stringify(p)); } catch (e) {} }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = n => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
  }
  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  // Make a color vivid enough to glow on screen.
  function vivid(rgb) {
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    return hslToRgb(h, Math.max(s, 0.6), Math.min(0.62, Math.max(0.45, l)));
  }
  function hashPalette(key) {
    const h = hashStr(key) % 360;
    return [hslToRgb(h, 0.85, 0.55), hslToRgb(h + 45, 0.8, 0.5), hslToRgb(h + 190, 0.8, 0.55)];
  }

  // Pick 3 distinct, vivid colors from album art.
  function paletteFromImage(img) {
    const c = document.createElement('canvas'); c.width = c.height = 40;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 40, 40);
    const px = ctx.getImageData(0, 0, 40, 40).data; // throws if the image isn't CORS-enabled
    const buckets = {};
    for (let i = 0; i < px.length; i += 4) {
      const key = (px[i] >> 5) + ',' + (px[i + 1] >> 5) + ',' + (px[i + 2] >> 5);
      const b = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0 });
      b.r += px[i]; b.g += px[i + 1]; b.b += px[i + 2]; b.n++;
    }
    const list = Object.values(buckets).map(b => {
      const rgb = [b.r / b.n / 255, b.g / b.n / 255, b.b / b.n / 255];
      const [, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      const score = b.n * (0.15 + s * s * 2.5) * (l > 0.12 && l < 0.92 ? 1 : 0.08);
      return { rgb, score };
    }).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const item of list) {
      if (picked.every(p => Math.hypot(p[0] - item.rgb[0], p[1] - item.rgb[1], p[2] - item.rgb[2]) > 0.28)) picked.push(item.rgb);
      if (picked.length === 3) break;
    }
    while (picked.length < 3) {
      const base = rgbToHsl(...(picked[0] || [0.8, 0.2, 0.6]));
      picked.push(hslToRgb(base[0] + 60 * picked.length + 60, 0.7, 0.55));
    }
    return picked.map(vivid);
  }

  // ---------- UI state ----------
  let source = null;          // 'spotify' | 'demo' | null
  let track = null;           // { id, title, artist, art, duration, progress, playing, at }
  let autoCycle = prefs().autoCycle !== false;
  let showInfo = true;
  let lastInput = Date.now();
  let toastTimer, hintTimer;

  viz.setScene(prefs().scene || 0);

  function toast(html, ms) {
    const t = $('toast'); t.innerHTML = html; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2200);
  }
  function showHint() {
    $('hint').classList.remove('hidden');
    clearTimeout(hintTimer); hintTimer = setTimeout(() => $('hint').classList.add('hidden'), 6000);
  }
  function setStatus(text, demo) {
    $('statusText').textContent = text;
    $('status').classList.toggle('demo', !!demo);
    $('status').classList.toggle('hidden', !text);
  }

  function setScene(i, announce) {
    viz.setScene(i);
    const cur = viz.currentScene();
    const p = prefs(); p.scene = cur; savePrefs(p);
    if (announce) toast(SCENES[cur] + '<small>' + (cur + 1) + ' / ' + SCENES.length + '</small>');
  }

  function renderTrack() {
    const hasTrack = !!track;
    $('card').classList.toggle('hidden', !hasTrack || !showInfo);
    $('idle').classList.toggle('hidden', hasTrack || source !== 'spotify' || isMenuOpen());
    if (!hasTrack) return;
    $('title').innerHTML = '';
    $('title').textContent = track.title;
    if (!track.playing) {
      const s = document.createElement('span'); s.id = 'paused'; s.textContent = 'PAUSED'; $('title').appendChild(s);
    }
    $('artist').textContent = track.artist;
    $('tDur').textContent = fmt(track.duration);
  }

  function setTrack(t) {
    const changed = !track || !t || track.id !== t.id;
    const playChanged = track && t && track.playing !== t.playing;
    track = t;
    viz.setPlaying(!t || t.playing);
    if (changed && t) {
      const h = hashStr(t.id);
      // Until (or unless) real song data arrives, use an estimated per-song rhythm.
      viz.setRhythm(86 + (h % 42), 0.55 + ((h >> 8) % 40) / 100, 6, 1);
      features = null; showFeatures(null);
      basePalette = hashPalette(t.id); applyPalette();
      viz.triggerBurst();
      if (source === 'spotify') {
        const id = t.id;
        loadFeatures(id).then(f => {
          if (!track || track.id !== id) return; // song changed meanwhile
          if (f) applyFeatures(f);
          if (autoCycle) setScene(pickScene(f ? f.energy : null, h), true);
        });
      } else if (autoCycle && source) {
        setScene(viz.currentScene() + 1 + (h % (SCENES.length - 1)), true);
      }
      const img = $('art');
      img.crossOrigin = 'anonymous';
      img.onload = () => { try { basePalette = paletteFromImage(img); applyPalette(); } catch (e) { /* keep hash palette */ } };
      img.src = t.art || '';
    }
    if (changed || playChanged) renderTrack();
  }

  // ---------- Song data (tempo, energy, mood) from ReccoBeats ----------
  // Spotify's own audio-features API is closed to new apps, and Spotify's audio is copy-protected,
  // so it can't be analysed directly. ReccoBeats (free) has the same data for many songs.
  // Only the Spotify track ID is sent.
  let features = null, basePalette = null;

  async function loadFeatures(id) {
    const key = 'viz_feat_' + id;
    try { const c = JSON.parse(localStorage.getItem(key)); if (c && Date.now() - c.at < (c.f ? 30 : 3) * 86400000) return c.f; } catch (e) {} // re-check unknown songs sooner
    let f = null;
    try {
      const ctrl = window.AbortController ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), 4000);
      const res = await fetch('https://api.reccobeats.com/v1/audio-features?ids=' + encodeURIComponent(id),
        { headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
      clearTimeout(timer);
      if (res.ok) {
        const d = await res.json();
        const x = d && d.content && d.content[0];
        if (x && x.tempo) f = { tempo: x.tempo, energy: x.energy, danceability: x.danceability,
                                valence: x.valence, mode: x.mode, loudness: x.loudness };
      }
    } catch (e) { return null; } // network trouble: don't cache, try again next time
    try { localStorage.setItem(key, JSON.stringify({ f, at: Date.now() })); } catch (e) {}
    return f;
  }

  function applyFeatures(f) {
    features = f;
    // Keep pulses in a comfortable range (very fast songs pulse on every other beat).
    let bpm = f.tempo;
    while (bpm > 150) bpm /= 2;
    while (bpm < 70) bpm *= 2;
    viz.setRhythm(bpm,
      0.35 + f.energy * 0.65,          // pulse strength
      4 + (f.danceability || 0.5) * 8, // punchiness
      0.55 + f.energy * 0.9);          // animation speed
    if (track && track.playing) viz.syncBeat((track.progress + (Date.now() - track.at)) / 1000);
    applyPalette();
    showFeatures(f);
  }

  // Album-art colors, nudged warmer for happy songs and cooler for sad ones.
  function applyPalette() {
    if (!basePalette) return;
    if (!features || features.valence == null) { viz.setPalette(basePalette); return; }
    const v = features.valence, target = v >= 0.5 ? 35 : 220, amount = Math.abs(v - 0.5) * 0.6;
    viz.setPalette(basePalette.map(c => {
      let [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
      const diff = ((target - h + 540) % 360) - 180;
      h += diff * amount;
      s = Math.min(1, s * (0.85 + v * 0.3));
      if (features.mode === 0) l *= 0.92; // minor key: a touch darker
      return hslToRgb(h, s, l);
    }));
  }

  // Pick a visual style that suits the song's energy.
  function pickScene(energy, h) {
    let options;
    if (energy == null) options = [0, 1, 2, 3, 4, 5];
    else if (energy > 0.7) options = [1, 4, 2];  // Hyper Tunnel, Warp Stars, Kaleidoscope
    else if (energy > 0.4) options = [0, 2, 3];  // Nebula, Kaleidoscope, Liquid Waves
    else options = [5, 0, 3];                    // Aurora, Nebula, Liquid Waves
    const others = options.filter(i => i !== viz.currentScene());
    const list = others.length ? others : options;
    return list[h % list.length];
  }

  function showFeatures(f) {
    const el = $('feat');
    if (!f) { el.textContent = ''; el.style.display = 'none'; return; }
    const label = f.energy > 0.75 ? 'High energy' : f.energy > 0.45 ? 'Medium energy' : 'Chill';
    el.textContent = Math.round(f.tempo) + ' BPM · ' + label;
    el.style.display = '';
  }

  // Smooth progress between polls.
  setInterval(() => {
    if (!track) return;
    const p = track.playing ? Math.min(track.duration, track.progress + (Date.now() - track.at)) : track.progress;
    $('bar').style.width = (track.duration ? (p / track.duration) * 100 : 0) + '%';
    $('tCur').textContent = fmt(p);
    $('card').classList.toggle('dim', Date.now() - lastInput > 8000);
  }, 250);

  // ---------- Spotify ----------
  let pollTimer = null, backoffUntil = 0;

  function trackFromPlayback(d) {
    if (!d || !d.item) return null;
    const it = d.item;
    const images = (it.album && it.album.images) || it.images || [];
    return {
      id: it.id || it.uri || it.name,
      title: it.name,
      artist: it.artists ? it.artists.map(a => a.name).join(', ') : (it.show ? it.show.name : ''),
      art: images.length ? images[0].url : '',
      duration: it.duration_ms || 0,
      progress: d.progress_ms || 0,
      playing: !!d.is_playing,
      at: Date.now(),
      device: d.device ? d.device.name : ''
    };
  }

  async function poll() {
    if (source !== 'spotify') return;
    if (Date.now() < backoffUntil || document.hidden) return schedulePoll(3000);
    try {
      const r = await SpotifyApi.playback();
      if (source !== 'spotify') return;
      if (r.status === 401) { stopSpotify(); openMenu('Your Spotify login expired. Please connect again.'); return; }
      if (r.status === 429) { backoffUntil = Date.now() + 15000; }
      else if (r.status === 204 || (r.status === 200 && !r.data)) { setTrack(null); setStatus('Spotify connected'); renderTrack(); }
      else if (r.status === 200) {
        const t = trackFromPlayback(r.data);
        setTrack(t);
        if (track && t) { track.progress = t.progress; track.at = t.at; }
        if (features && t && t.playing) viz.syncBeat(t.progress / 1000); // keep pulse locked to the song
        setStatus(t && t.device ? 'Spotify · ' + t.device : 'Spotify connected');
        renderTrack();
      }
      if ((r.status === 200 || r.status === 204) && !playerChecked) { playerChecked = true; maybeStartPlayer(); }
    } catch (e) { setStatus('Spotify · connection problem, retrying…'); }
    schedulePoll(3000);
  }
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  function startSpotify() {
    stopDemo();
    source = 'spotify'; track = null;
    setStatus('Spotify connected');
    closeMenu(); showHint(); poll();
  }
  function stopSpotify() {
    source = null; clearTimeout(pollTimer); track = null; renderTrack(); setStatus('');
    playerChecked = false; WebPlayer.stop(); updateIdleText();
  }

  // ---------- Afterglow as a speaker (Web Playback SDK) ----------
  let playerChecked = false;
  const PLAYER_NAME = /Tizen|SMART-TV|Web0S|webOS/i.test(navigator.userAgent) ? 'Afterglow (TV)' : 'Afterglow (Browser)';

  function maybeStartPlayer() {
    // Logins from before this feature lack the "streaming" permission; the token's scope is
    // known after the first API call, which is why this runs after the first poll.
    if (!SpotifyApi.hasScope('streaming')) {
      toast('To play music on this screen: press Back → Enable "Play on this screen"', 6000);
      return;
    }
    WebPlayer.start({
      name: PLAYER_NAME,
      getToken: SpotifyApi.token,
      onReady: () => { updateIdleText(); if (!track) toast('"' + PLAYER_NAME + '" is now a Spotify speaker', 3500); },
      onNotReady: updateIdleText,
      onStateChange: () => schedulePoll(400),
      onError: (type, message) => {
        console.warn('Spotify player', type, message);
        if (type !== 'playback_error') toast('Playing on this screen isn\'t available: ' + message, 5000);
      }
    });
  }

  function updateIdleText() {
    $('idleText').textContent = WebPlayer.deviceId()
      ? 'Press OK to play here, or pick "' + PLAYER_NAME + '" as the device in Spotify on your phone.'
      : 'Start a song in Spotify on your phone, PC or TV and it will appear here.';
  }

  async function playHere() {
    const id = WebPlayer.deviceId();
    if (!id) return;
    WebPlayer.activate();
    toast('Starting music on this screen…', 2000);
    let r = await SpotifyApi.transfer(id);
    if (r.status >= 400) r = await SpotifyApi.playOn(id);
    if (r.status >= 400) toast('Couldn\'t start music here. Pick a song on your phone and choose "' + PLAYER_NAME + '".', 6000);
    schedulePoll(800);
  }

  async function spotifyControl(kind) {
    const fn = { play: SpotifyApi.play, pause: SpotifyApi.pause, next: SpotifyApi.next, previous: SpotifyApi.previous }[kind];
    const r = await fn();
    if (r.status === 403) toast('Playback controls need Spotify Premium', 3000);
    else if (r.status === 404) toast('No active Spotify device — start playback first', 3000);
    else if (r.status >= 400) toast('Spotify could not do that (' + r.status + ')', 3000);
    schedulePoll(600);
  }

  // ---------- Demo mode ----------
  const DEMO = [
    { title: 'Neon Horizon', artist: 'Demo Artist', hues: [320, 260, 190] },
    { title: 'Midnight Tide', artist: 'Demo Artist', hues: [210, 180, 280] },
    { title: 'Solar Bloom', artist: 'Demo Artist', hues: [30, 350, 55] },
    { title: 'Emerald Drift', artist: 'Demo Artist', hues: [150, 95, 200] },
    { title: 'Velvet Static', artist: 'Demo Artist', hues: [285, 330, 230] },
    { title: 'Glass Cathedral', artist: 'Demo Artist', hues: [190, 45, 300] }
  ];
  let demoIndex = 0, demoTimer = null;
  function demoArt(hues) {
    const c = document.createElement('canvas'); c.width = c.height = 300;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 300, 300);
    hues.forEach((h, i) => g.addColorStop(i / 2, 'hsl(' + h + ',85%,55%)'));
    ctx.fillStyle = g; ctx.fillRect(0, 0, 300, 300);
    ctx.globalCompositeOperation = 'overlay';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath(); ctx.arc(150, 150, 30 + i * 22, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.35 - i * 0.05) + ')'; ctx.lineWidth = 6; ctx.stroke();
    }
    return c.toDataURL();
  }
  function playDemo(i) {
    demoIndex = (i + DEMO.length) % DEMO.length;
    const d = DEMO[demoIndex];
    setTrack({ id: 'demo-' + demoIndex, title: d.title, artist: d.artist, art: demoArt(d.hues),
      duration: 30000, progress: 0, playing: true, at: Date.now() });
    clearTimeout(demoTimer);
    demoTimer = setTimeout(() => playDemo(demoIndex + 1), 30000);
  }
  function startDemo() {
    stopSpotify();
    source = 'demo'; track = null;
    setStatus('Demo mode', true);
    closeMenu(); showHint(); playDemo(demoIndex);
  }
  function stopDemo() { clearTimeout(demoTimer); if (source === 'demo') { source = null; track = null; renderTrack(); } }
  function demoToggle() {
    if (!track) return;
    if (track.playing) { track.progress += Date.now() - track.at; track.playing = false; clearTimeout(demoTimer); }
    else { track.playing = true; track.at = Date.now(); demoTimer = setTimeout(() => playDemo(demoIndex + 1), track.duration - track.progress); }
    viz.setPlaying(track.playing); renderTrack();
  }

  // ---------- Menu ----------
  let menuItems = [], menuFocus = 0;
  function isMenuOpen() { return !$('menu').classList.contains('hidden'); }
  const ON_TV = /Tizen|SMART-TV|Web0S|webOS/i.test(navigator.userAgent);

  function showPanel(opts) {
    $('sub').textContent = opts.sub || 'Music visuals for your big screen';
    $('pairBox').style.display = opts.pair ? '' : 'none';
    menuItems = opts.items || []; menuFocus = 0;
    const box = $('buttons'); box.innerHTML = '';
    menuItems.forEach((it, i) => {
      const b = document.createElement('button');
      b.textContent = it.label; if (it.primary) b.className = 'primary';
      b.onclick = () => it.run();
      b.onmouseenter = () => { menuFocus = i; paintFocus(); };
      box.appendChild(b);
    });
    $('msg').className = opts.ok ? 'ok' : ''; $('msg').textContent = opts.message || '';
    $('menu').classList.remove('hidden');
    $('idle').classList.add('hidden');
    paintFocus();
  }

  function loginHere() { $('msg').className = 'ok'; $('msg').textContent = 'Opening Spotify login…'; SpotifyApi.login(); }

  function openMenu(message, ok) {
    stopPairing();
    const items = [];
    if (source) items.push({ label: 'Resume', run: closeMenu });
    if (SpotifyApi.isLoggedIn()) {
      if (source !== 'spotify') items.push({ label: 'Use Spotify', primary: true, run: startSpotify });
      if (source === 'spotify' && WebPlayer.deviceId()) items.push({ label: 'Play on this screen', run: () => { closeMenu(); playHere(); } });
      if (playerChecked && !SpotifyApi.hasScope('streaming')) {
        items.push({ label: 'Enable "Play on this screen"', primary: true, run: () => {
          SpotifyApi.logout(); SpotifyApi.resetScopes(); stopSpotify();
          if (ON_TV) openPairScreen(); else loginHere();
        } });
      }
      items.push({ label: 'Disconnect Spotify', run: () => { SpotifyApi.logout(); if (source === 'spotify') stopSpotify(); openMenu('Spotify disconnected.', true); } });
    } else if (ON_TV) {
      items.push({ label: 'Sign in with your phone', primary: true, run: openPairScreen });
      items.push({ label: 'Sign in on this screen', run: loginHere });
    } else {
      items.push({ label: 'Connect Spotify', primary: true, run: loginHere });
      items.push({ label: 'Sign in with your phone', run: openPairScreen });
    }
    if (source !== 'demo') items.push({ label: 'Demo mode', run: startDemo });
    showPanel({ items, message, ok });
  }
  function closeMenu() { stopPairing(); $('menu').classList.add('hidden'); renderTrack(); }

  // ---------- Phone sign-in: TV side ----------
  let pairSession = null, pairTimer = null, pairGen = 0;
  function stopPairing() {
    pairGen++;
    if (pairSession) { pairSession.stop(); pairSession = null; }
    clearTimeout(pairTimer);
  }
  async function openPairScreen() {
    stopPairing();
    const gen = pairGen;
    showPanel({ sub: "Scan with your phone's camera", pair: true, items: [{ label: 'Back', run: () => openMenu() }] });
    $('qr').innerHTML = '';
    $('pairStatus').className = 'spin'; $('pairStatus').textContent = 'Creating code…';
    let session;
    try {
      session = await Pair.startTv(rt => {
        stopPairing();
        SpotifyApi.setRefreshToken(rt);
        $('pairStatus').className = ''; $('pairStatus').textContent = 'Connected!';
        startSpotify(); toast('Spotify connected', 2500);
      }, msg => { if (gen === pairGen) $('pairStatus').textContent = msg; });
    } catch (e) {
      $('pairStatus').className = ''; $('pairStatus').textContent = 'Could not start phone sign-in: ' + e.message;
      return;
    }
    if (gen !== pairGen) { session.stop(); return; } // user left the screen meanwhile
    pairSession = session;
    if (window.qrcode) {
      const q = qrcode(0, 'L'); q.addData(session.url); q.make();
      $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } else {
      $('qr').textContent = 'QR code unavailable';
    }
    $('pairStatus').className = 'spin'; $('pairStatus').textContent = 'Waiting for your phone…';
    pairTimer = setTimeout(() => { if (gen === pairGen) openPairScreen(); }, 14 * 60 * 1000); // fresh code before it expires
  }

  // ---------- Phone sign-in: phone side ----------
  function showPhoneScreen(message) {
    showPanel({
      sub: 'Connect your TV to Spotify',
      items: [
        { label: 'Log in with Spotify', primary: true, run: loginHere },
        { label: 'Cancel', run: () => { Pair.clear(); openMenu(); } }
      ],
      message: message || 'Log in on this phone and your TV will connect automatically.',
      ok: !message
    });
  }
  function paintFocus() { Array.from($('buttons').children).forEach((b, i) => b.classList.toggle('focus', i === menuFocus)); }

  // ---------- Controls (keyboard + Samsung remote) ----------
  const K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, SPACE: 32, ESC: 27, BACK: 10009,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, NEXT: 10233, PREV: 10232, FF: 417, RW: 412,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };

  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaTrackNext', 'MediaTrackPrevious',
       'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']
        .forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
    }
  } catch (e) {}

  function togglePlay() {
    if (source === 'demo') return demoToggle();
    if (source === 'spotify' && track) {
      const wantPlay = !track.playing;
      track.progress += track.playing ? Date.now() - track.at : 0; track.at = Date.now();
      track.playing = wantPlay; viz.setPlaying(wantPlay); renderTrack();
      spotifyControl(wantPlay ? 'play' : 'pause');
    }
  }
  function skip(dir) {
    if (source === 'demo') return playDemo(demoIndex + dir);
    if (source === 'spotify') { toast(dir > 0 ? 'Next track' : 'Previous track', 1200); spotifyControl(dir > 0 ? 'next' : 'previous'); }
  }

  document.addEventListener('keydown', e => {
    lastInput = Date.now();
    const k = e.keyCode;
    if (isMenuOpen()) {
      if (k === K.UP || k === K.LEFT) { menuFocus = (menuFocus - 1 + menuItems.length) % menuItems.length; paintFocus(); }
      else if (k === K.DOWN || k === K.RIGHT) { menuFocus = (menuFocus + 1) % menuItems.length; paintFocus(); }
      else if (k === K.ENTER) { if (menuItems[menuFocus]) menuItems[menuFocus].run(); }
      else if ((k === K.BACK || k === K.ESC) && source) { closeMenu(); }
      else if (k === K.BACK) { try { tizen.application.getCurrentApplication().exit(); } catch (err) {} }
      else return;
      e.preventDefault(); return;
    }
    switch (k) {
      case K.UP: setScene(viz.currentScene() - 1, true); break;
      case K.DOWN: setScene(viz.currentScene() + 1, true); break;
      case K.LEFT: case K.PREV: case K.RW: skip(-1); break;
      case K.RIGHT: case K.NEXT: case K.FF: skip(1); break;
      case K.ENTER: case K.SPACE: case K.PLAYPAUSE:
        if (source === 'spotify' && !track && WebPlayer.deviceId()) playHere(); else togglePlay();
        break;
      case K.PLAY: if (track && !track.playing) togglePlay(); break;
      case K.PAUSE: if (track && track.playing) togglePlay(); break;
      case K.GREEN: case 65: // A
        autoCycle = !autoCycle; { const p = prefs(); p.autoCycle = autoCycle; savePrefs(p); }
        toast('Auto-change style: ' + (autoCycle ? 'on' : 'off')); break;
      case K.RED: case 73: // I
        showInfo = !showInfo; renderTrack(); break;
      case K.BACK: case K.ESC: openMenu(); break;
      default: showHint(); return;
    }
    e.preventDefault();
  });
  document.addEventListener('mousemove', () => { lastInput = Date.now(); });

  // ---------- Startup ----------
  (async function init() {
    Pair.captureFromHash();
    const result = await SpotifyApi.handleCallback();

    // Spotify answers "server_error" when it refuses one of the requested permissions.
    // Step down to a smaller permission set and log in again (already approved, so it's quick).
    if (result === 'error:server_error' && SpotifyApi.stepDownScopes()) {
      showPanel({ sub: 'One moment…', items: [], message: 'Spotify refused a permission, trying again with fewer…', ok: true });
      setTimeout(() => SpotifyApi.login(), 1200);
      return;
    }

    // Opened from the TV's QR code: log in here, hand the login to the TV, keep nothing on this phone.
    if (Pair.pending()) {
      if (result === 'ok') {
        const rt = SpotifyApi.refreshToken();
        SpotifyApi.logout();
        showPanel({ sub: 'Connecting your TV…', items: [], message: 'Sending your login to the TV…', ok: true });
        try {
          await Pair.send(rt);
          showPanel({ sub: 'All set!', items: [], message: 'Your TV is now connected to Spotify. You can close this page.', ok: true });
        } catch (e) { showPhoneScreen(e.message); }
      } else {
        showPhoneScreen(result && result.startsWith('error:') ? 'Spotify login failed: ' + result.slice(6) : '');
      }
      return;
    }

    if (result === 'ok') { startSpotify(); toast('Spotify connected', 2500); return; }
    if (result && result.startsWith('error:')) { openMenu('Spotify login failed: ' + result.slice(6)); return; }
    if (SpotifyApi.isLoggedIn()) { startSpotify(); return; }
    openMenu();
  })();
})();
