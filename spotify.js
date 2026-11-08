// Spotify login (Authorization Code with PKCE, no client secret) and Web API helpers.
(function () {
  'use strict';

  const CLIENT_ID = '478213c3340f4b9ea54549487f50da39';
  const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
  // Local testing uses http://127.0.0.1:8888/callback; when hosted (e.g. GitHub Pages)
  // Spotify sends you back to the app's own page, e.g. https://you.github.io/afterglow/
  const IS_LOCAL = location.hostname === '127.0.0.1';
  const REDIRECT_URI = IS_LOCAL ? location.origin + '/callback'
                                : location.origin + location.pathname.replace(/[^/]*$/, '');
  const TOKEN_KEY = 'viz_spotify_tokens';

  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) {} }

  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }
  async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    const verifier = randomString(64);
    const state = randomString(16);
    store('viz_pkce', { verifier, state });
    const params = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, scope: SCOPES,
      redirect_uri: REDIRECT_URI, code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier), state
    });
    location.href = 'https://accounts.spotify.com/authorize?' + params;
  }

  async function tokenRequest(body) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Token request failed');
    const old = load(TOKEN_KEY) || {};
    const tokens = {
      access: data.access_token,
      refresh: data.refresh_token || old.refresh,
      expires: Date.now() + (data.expires_in - 60) * 1000
    };
    store(TOKEN_KEY, tokens);
    return tokens;
  }

  // Call on page load. Returns 'ok', 'error:<msg>' or null if this isn't a callback.
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return null;
    history.replaceState(null, '', IS_LOCAL ? '/' : location.pathname);
    if (q.has('error')) return 'error:' + q.get('error');
    const pkce = load('viz_pkce');
    drop('viz_pkce');
    if (!pkce || pkce.state !== q.get('state')) return 'error:Login state mismatch, please try again';
    try {
      await tokenRequest({
        grant_type: 'authorization_code', code: q.get('code'),
        redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: pkce.verifier
      });
      return 'ok';
    } catch (e) { return 'error:' + e.message; }
  }

  let refreshing = null;
  async function accessToken(force) {
    let t = load(TOKEN_KEY);
    if (!t || !t.refresh) return null;
    if (force || Date.now() > t.expires) {
      if (!refreshing) {
        refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: CLIENT_ID })
          .finally(() => { refreshing = null; });
      }
      try { t = await refreshing; } catch (e) { drop(TOKEN_KEY); return null; }
    }
    return t.access;
  }

  // Returns { status, data } ; data is null for empty responses.
  async function api(path, opts, retried) {
    const token = await accessToken(false);
    if (!token) return { status: 401, data: null };
    const res = await fetch('https://api.spotify.com/v1' + path, Object.assign({}, opts, {
      headers: { Authorization: 'Bearer ' + token }
    }));
    if (res.status === 401 && !retried) { await accessToken(true); return api(path, opts, true); }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) {} }
    return { status: res.status, data };
  }

  window.Spotify = {
    login, handleCallback,
    isLoggedIn: () => !!(load(TOKEN_KEY) || {}).refresh,
    logout: () => drop(TOKEN_KEY),
    playback: () => api('/me/player?additional_types=track,episode'),
    play: () => api('/me/player/play', { method: 'PUT' }),
    pause: () => api('/me/player/pause', { method: 'PUT' }),
    next: () => api('/me/player/next', { method: 'POST' }),
    previous: () => api('/me/player/previous', { method: 'POST' })
  };
})();
