// Afterglow as a Spotify Connect speaker, using Spotify's Web Playback SDK (Premium only).
// Once ready, "Afterglow (TV)" shows up in Spotify's device list on your phone.
(function () {
  'use strict';

  const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
  let player = null, deviceId = null, started = false;

  function start(opts) {
    if (started) return;
    started = true;

    window.onSpotifyWebPlaybackSDKReady = function () {
      player = new window.Spotify.Player({
        name: opts.name,
        volume: 0.8,
        getOAuthToken: cb => { opts.getToken().then(t => { if (t) cb(t); }); }
      });
      player.addListener('ready', e => { deviceId = e.device_id; opts.onReady && opts.onReady(deviceId); });
      player.addListener('not_ready', () => { deviceId = null; opts.onNotReady && opts.onNotReady(); });
      player.addListener('player_state_changed', () => { opts.onStateChange && opts.onStateChange(); });
      ['initialization_error', 'authentication_error', 'account_error', 'playback_error'].forEach(type =>
        player.addListener(type, e => { opts.onError && opts.onError(type, e.message); }));
      player.connect();
    };

    const s = document.createElement('script');
    s.src = SDK_URL;
    s.onerror = () => { started = false; opts.onError && opts.onError('load_error', 'Could not load Spotify player'); };
    document.head.appendChild(s);
  }

  function stop() {
    if (player) { player.disconnect(); player = null; }
    deviceId = null; started = false;
  }

  window.WebPlayer = {
    start, stop,
    deviceId: () => deviceId,
    // Browsers only allow audio after a user action; call this from a key/click handler.
    activate: () => { try { if (player && player.activateElement) player.activateElement(); } catch (e) {} }
  };
})();
