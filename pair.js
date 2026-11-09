// "Sign in with your phone": the TV shows a QR code, the phone logs in to Spotify and sends
// the login back to the TV through ntfy.sh (a free public message relay).
// The login is encrypted with AES-GCM; the key lives only in the QR code's #fragment,
// which browsers never send to any server, so the relay can't read it.
(function () {
  'use strict';

  const RELAY = 'https://ntfy.sh/';
  const PENDING_KEY = 'viz_pair_pending';
  const PAIR_TTL_MS = 15 * 60 * 1000;

  function b64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  }
  function randomTopic() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return 'afterglow_' + Array.from(bytes, b => chars[b % chars.length]).join('');
  }
  async function importKey(raw, usage) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
  }

  // ---------- TV side ----------
  // Starts waiting for a phone. Returns { url, stop }. onToken(refreshToken) is called once.
  async function startTv(onToken, onError) {
    const topic = randomTopic();
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const key = await importKey(rawKey, 'decrypt');
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    const url = base + '#pair=' + topic + '.' + b64url(rawKey);
    const since = Math.floor(Date.now() / 1000) - 5;
    let done = false, es = null, pollTimer = null;

    async function handle(text) {
      if (done || !text) return;
      try {
        const bytes = fromB64url(text);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
        const data = JSON.parse(new TextDecoder().decode(plain));
        if (!data.refresh) return;
        done = true; stop();
        onToken(data.refresh);
      } catch (e) { /* not for us / tampered — ignore */ }
    }

    function stop() {
      done = true;
      if (es) { es.close(); es = null; }
      clearTimeout(pollTimer);
    }

    if (window.EventSource) {
      es = new EventSource(RELAY + topic + '/sse?since=' + since);
      es.onmessage = ev => {
        try { const m = JSON.parse(ev.data); if (m.event === 'message') handle(m.message); } catch (e) {}
      };
      es.onerror = () => { if (onError && !done) onError('Reconnecting to the sign-in service…'); };
    } else {
      // Fallback: slow polling (ntfy rate-limits frequent requests).
      const poll = async () => {
        if (done) return;
        try {
          const res = await fetch(RELAY + topic + '/json?poll=1&since=' + since);
          const lines = (await res.text()).split('\n').filter(Boolean);
          for (const l of lines) { const m = JSON.parse(l); if (m.event === 'message') await handle(m.message); }
        } catch (e) {}
        pollTimer = setTimeout(poll, 6000);
      };
      poll();
    }
    return { url, stop };
  }

  // ---------- Phone side ----------
  // If the page was opened from a QR code, remember the pairing details and clean the URL.
  function captureFromHash() {
    const m = /[#&]pair=([a-z0-9_]+)\.([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return false;
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ topic: m[1], key: m[2], at: Date.now() })); } catch (e) {}
    history.replaceState(null, '', location.pathname);
    return true;
  }
  function pending() {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING_KEY));
      if (p && Date.now() - p.at < PAIR_TTL_MS) return p;
    } catch (e) {}
    clear();
    return null;
  }
  function clear() { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} }

  async function send(refreshToken) {
    const p = pending();
    if (!p) throw new Error('This QR code has expired. Show a new one on the TV and scan it again.');
    const key = await importKey(fromB64url(p.key), 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ refresh: refreshToken }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const msg = new Uint8Array(iv.length + ct.length); msg.set(iv); msg.set(ct, iv.length);
    const res = await fetch(RELAY + p.topic, { method: 'POST', body: b64url(msg) });
    if (!res.ok) throw new Error('Could not reach the TV (relay error ' + res.status + '). Please try again.');
    clear();
  }

  window.Pair = { startTv, captureFromHash, pending, clear, send };
})();
