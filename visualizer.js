// WebGL visualizer: several full-screen shader scenes, colored by a 3-color palette,
// with crossfades between scenes, a rhythmic pulse and a burst on track changes.
(function () {
  'use strict';

  const SCENES = ['Nebula', 'Hyper Tunnel', 'Kaleidoscope', 'Lava Orbs', 'Synthwave', 'Aurora'];

  // TVs have weak mobile GPUs (e.g. Mali-G52): use fewer noise layers and a lower render size there.
  const LOW_POWER = /Tizen|SMART-TV|Web0S|webOS/i.test(navigator.userAgent);

  const VERT = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAG = `
#define OCTAVES ${LOW_POWER ? 3 : 5}
${LOW_POWER ? '#define LOW_POWER' : ''}
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_modeA, u_modeB, u_fade;
uniform vec3 u_c1, u_c2, u_c3;
uniform float u_pulse, u_burst, u_energy;

#define TAU 6.28318530718

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<OCTAVES;i++){ v += a*noise(p); p = p*2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
// Cheap 2-layer noise for effects evaluated many times per pixel.
float noise2(vec2 p){ return noise(p)*0.65 + noise(p*2.03 + vec2(1.7, 9.2))*0.35; }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
vec3 pal(float t){
  t = fract(t)*3.0;
  if(t < 1.0) return mix(u_c1, u_c2, smoothstep(0.0,1.0,t));
  if(t < 2.0) return mix(u_c2, u_c3, smoothstep(0.0,1.0,t-1.0));
  return mix(u_c3, u_c1, smoothstep(0.0,1.0,t-2.0));
}

vec3 nebula(vec2 p, float t){
  p *= 1.0 - u_pulse*0.04;
#ifdef LOW_POWER
  vec2 q = vec2(noise2(p*1.6 + t*0.08), noise2(p*1.6 + vec2(5.2,1.3) - t*0.07));
#else
  vec2 q = vec2(fbm(p*1.6 + t*0.08), fbm(p*1.6 + vec2(5.2,1.3) - t*0.07));
#endif
#ifdef LOW_POWER
  vec2 r = vec2(noise2(p*1.6 + 3.5*q + vec2(1.7,9.2) + t*0.12), noise2(p*1.6 + 3.5*q + vec2(8.3,2.8) - t*0.1));
#else
  vec2 r = vec2(fbm(p*1.6 + 3.5*q + vec2(1.7,9.2) + t*0.12), fbm(p*1.6 + 3.5*q + vec2(8.3,2.8) - t*0.1));
#endif
  float f = fbm(p*1.6 + 3.5*r);
  vec3 col = pal(f*1.3 + length(q)*0.4 + t*0.02);
  col *= 0.15 + f*f*2.2;
  col += pal(r.x + 0.33) * pow(r.y, 3.0) * 0.8;
  return col;
}

vec3 tunnel(vec2 p, float t){
  float a = atan(p.y, p.x), r = length(p);
  float z = 0.35/(r+0.001) + t*0.9;
  float tw = a + z*0.15 + sin(t*0.3)*0.5;
  float rings = pow(0.5+0.5*sin(z*6.0), 3.0);
  float spokes = 0.5+0.5*sin(tw*6.0);
  float n = fbm(vec2(cos(a), sin(a))*1.5 + vec2(z*0.5, 0.0));
  float v = rings*0.7 + spokes*n*0.9;
  vec3 col = pal(z*0.05 + n*0.5) * v * smoothstep(0.0, 0.5, r) * 1.6;
  col += pal(t*0.05) * 0.06/(r+0.05) * (0.6 + u_pulse);
  return col;
}

vec3 kaleido(vec2 p, float t){
  p *= rot(t*0.07);
  float a = atan(p.y, p.x), r = length(p);
  float seg = TAU/8.0;
  a = mod(a, seg); a = abs(a - seg*0.5);
  vec2 k = vec2(cos(a), sin(a))*r;
  float glow = 0.0;
  for(int i=0;i<4;i++){
    k = abs(k) - 0.25 - 0.05*sin(t*0.2 + float(i));
    k *= rot(t*0.05 + float(i)*0.7);
    k *= 1.25;
    glow += 0.012/abs(k.y + 0.02*sin(t + float(i)));
  }
  float v = fbm(k*1.2 + t*0.15);
  vec3 col = pal(v + r*0.6 - t*0.04) * smoothstep(0.25, 0.85, v) * 1.5;
  col += pal(r - t*0.05 + 0.5) * min(glow, 2.0) * 0.35 * (0.7 + u_pulse*0.6);
  return col * smoothstep(1.4, 0.2, r);
}

// Lava Orbs: glossy blobs that drift, merge and split (metaballs). Swell on each beat.
vec3 orbs(vec2 p, float t){
  vec3 col = mix(pal(0.66), pal(0.9), p.y*0.5 + 0.5) * 0.06;
  float field = 0.0;
  float grow = 1.0 + u_pulse*0.18;
  for(int i=0;i<6;i++){
    float fi = float(i);
    vec2 c = vec2(sin(t*(0.21 + fi*0.037) + fi*2.1)*0.75, sin(t*(0.17 + fi*0.029) + fi*1.3)*0.38);
    float r = (0.11 + 0.04*sin(t*0.5 + fi*1.7)) * grow;
    vec2 d = p - c;
    field += r*r / (dot(d, d) + 0.0001);
  }
  float body = smoothstep(0.95, 1.05, field);
  float core = smoothstep(1.0, 4.0, field);
  float rim = exp(-abs(field - 1.0)*6.0);
  vec3 a = pal(t*0.03 + p.x*0.15);
  vec3 b = pal(t*0.03 + 0.4 + p.y*0.2);
  col += mix(a, b, core) * body * (0.6 + core*0.8);
  col += pal(t*0.03 + 0.7) * rim * 0.9;                     // bright glowing edge
  col += a * min(field, 1.0) * 0.18;                        // soft halo around blobs
  col += vec3(1.0) * smoothstep(2.5, 6.0, field) * 0.25;    // glossy highlight in the middle
  return col;
}

// Synthwave: striped neon sun, mountain silhouettes and a glowing grid racing toward you.
vec3 synthwave(vec2 p, float t){
  float hz = -0.08;                                         // horizon height
  vec3 col;
  if(p.y > hz){
    float h = p.y - hz;
    col = mix(pal(0.0)*0.55, pal(0.66)*0.08, smoothstep(0.0, 0.55, h));   // sky, glowing near the horizon
    vec2 sc = vec2(0.0, 0.17);
    float sr = 0.27 * (1.0 + u_pulse*0.06);                // sun pulses on the beat
    float d = length(p - sc);
    float sun = smoothstep(sr, sr - 0.006, d);
    float yy = (p.y - sc.y) / sr;
    float stripe = step(0.0, -yy) * step(fract(yy*7.0 + t*0.35), (-yy)*0.55);  // sliding stripes, lower half
    sun *= 1.0 - stripe;
    vec3 sunCol = mix(pal(0.33), pal(0.0), clamp(0.5 - yy*0.5, 0.0, 1.0));
    col += sunCol * sun * 1.4;
    col += pal(0.0) * exp(-max(d - sr, 0.0)*7.0) * 0.35 * (1.0 + u_pulse*0.5);  // sun glow
    float m = hz + 0.02 + 0.08*noise(vec2(p.x*2.6 + 3.0, 1.0)) + 0.03*noise(vec2(p.x*7.0, 2.0));
    if(p.y < m){                                            // mountains
      col = mix(pal(0.66)*0.04, pal(0.66)*0.12, (p.y - hz)/max(m - hz, 0.001));
      col += pal(0.5) * exp(-(m - p.y)*60.0) * 0.6;         // glowing ridge line
    }
  } else {
    float depth = hz - p.y;
    float z = 0.3 / (depth + 0.003);                        // distance along the ground
    float gx = abs(fract(p.x*z*0.9) - 0.5);
    float gz = abs(fract(z*0.9 - t*1.2) - 0.5);             // grid scrolls toward you (faster for energetic songs)
    float w = 0.04 + z*0.004;                               // wider far lines = less shimmer
    float lines = smoothstep(w, 0.0, gx) + smoothstep(w*1.2, 0.0, gz);
    float fade = exp(-z*0.09);
    col = pal(0.66)*0.05 + pal(depth*0.6) * min(lines, 1.2) * fade * (1.1 + u_pulse*0.7);
    col += pal(0.0) * exp(-depth*14.0) * 0.5;               // horizon glow on the floor
  }
  return col;
}

vec3 aurora(vec2 p, float t){
  vec3 col = vec3(0.0);
  vec2 sgp = p*60.0; vec2 sg = floor(sgp); vec2 sf = fract(sgp) - 0.5;
  col += vec3(1.0) * step(0.985, hash(sg)) * smoothstep(0.18, 0.0, length(sf)) * 0.7 * (0.5+0.5*sin(t*2.0 + hash(sg+1.0)*20.0));
  for(int i=0;i<4;i++){
    float fi = float(i);
#ifdef LOW_POWER
    float n = noise2(vec2(p.x*1.2 + fi*3.0 + t*0.07, t*0.04 + fi));
#else
    float n = fbm(vec2(p.x*1.2 + fi*3.0 + t*0.07, t*0.04 + fi));
#endif
    float y = p.y - (n - 0.5)*0.9 - 0.05 + fi*0.09;
    float curtain = exp(-max(y, 0.0)*5.0) * smoothstep(-0.02, 0.0, y) ;
    curtain += exp(-abs(y)*30.0)*0.8;
    float streak = 0.55 + 0.45*noise(vec2(p.x*35.0 + fi*10.0, t*0.6));
    col += pal(fi*0.27 + p.x*0.15 + t*0.015) * curtain * streak * 0.45 * (0.85 + u_pulse*0.3);
  }
  return col;
}

vec3 scene(float m, vec2 p, float t){
  if(m < 0.5) return nebula(p, t);
  if(m < 1.5) return tunnel(p, t);
  if(m < 2.5) return kaleido(p, t);
  if(m < 3.5) return orbs(p, t);
  if(m < 4.5) return synthwave(p, t);
  return aurora(p, t);
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;
  float t = u_time;
  vec3 col = scene(u_modeA, p, t);
  if(u_fade > 0.001) col = mix(col, scene(u_modeB, p, t), u_fade);
  col *= 0.85 + u_energy*0.25 + u_pulse*0.18;
  col += pal(0.5 + t*0.1) * u_burst * 0.45 * smoothstep(1.2, 0.0, length(p));
  col = 1.0 - exp(-col*1.3);
  col *= smoothstep(1.35, 0.35, length(p*vec2(0.8,1.0)));
  gl_FragColor = vec4(col, 1.0);
}`;

  function Visualizer(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' })
            || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl; this.canvas = canvas;

    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    ['u_res', 'u_time', 'u_modeA', 'u_modeB', 'u_fade', 'u_c1', 'u_c2', 'u_c3', 'u_pulse', 'u_burst', 'u_energy']
      .forEach(n => { this.u[n] = gl.getUniformLocation(prog, n); });

    this.mode = 0; this.nextMode = 0; this.fade = 0;
    this.colors = [[0.9, 0.2, 0.6], [0.2, 0.4, 1.0], [0.1, 0.9, 0.8]];
    this.target = this.colors.map(c => c.slice());
    this.burst = 0; this.pulse = 0; this.energy = 0.6;
    this.bpm = 112; this.playing = true; this.beatPhase = 0;
    this.beatIndex = 0;   // 0..3 within a bar; beat 0 hits harder
    this.sharp = 6;       // how fast each pulse decays (higher = punchier)
    this.speed = 1;       // animation speed multiplier (driven by song energy)
    // Render size as a fraction of the screen (the image is smoothly scaled up to full screen).
    // Measured on a Samsung TV (Mali-G52): 0.3 (576x324) keeps every style at ~60 fps.
    this.minScale = LOW_POWER ? 0.25 : 0.3;
    this.maxScale = LOW_POWER ? 0.35 : 0.8;
    this.scale = LOW_POWER ? 0.3 : 0.6;
    this.frameTimes = []; this.goodWindows = 0;
    this.time = 0; this.last = performance.now();

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  Visualizer.SCENES = SCENES;

  Visualizer.prototype.resize = function () {
    const w = Math.max(1, Math.round(window.innerWidth * this.scale));
    const h = Math.max(1, Math.round(window.innerHeight * this.scale));
    this.canvas.width = w; this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  };

  Visualizer.prototype.setScene = function (i) {
    i = ((i % SCENES.length) + SCENES.length) % SCENES.length;
    if (i === this.mode && this.fade === 0) return;
    if (this.fade > 0) this.mode = this.nextMode; // finish the running crossfade instantly
    this.nextMode = i; this.fade = 0.0001;
  };
  Visualizer.prototype.currentScene = function () { return this.fade > 0 ? this.nextMode : this.mode; };

  // colors: array of 3 [r,g,b] in 0..1
  Visualizer.prototype.setPalette = function (colors) { this.target = colors.map(c => c.slice()); };
  Visualizer.prototype.triggerBurst = function () { this.burst = 1; };
  // bpm: pulses per minute; energy 0..1: pulse strength; sharp: decay rate; speed: animation speed.
  Visualizer.prototype.setRhythm = function (bpm, energy, sharp, speed) {
    this.bpm = bpm; this.energy = energy;
    if (sharp) this.sharp = sharp;
    if (speed) this.speed = speed;
  };
  // Lock the pulse to the song's playback position (seconds) so it never drifts.
  Visualizer.prototype.syncBeat = function (positionSec) {
    const beats = positionSec * this.bpm / 60;
    this.beatPhase = beats - Math.floor(beats);
    this.beatIndex = Math.floor(beats) % 4;
  };
  Visualizer.prototype.setPlaying = function (p) { this.playing = p; };

  Visualizer.prototype.frame = function (now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const gl = this.gl, u = this.u;

    // Slow down (not freeze) when paused so the screen still feels alive.
    this.time = (this.time + dt * (this.playing ? this.speed : 0.25)) % 3600;

    if (this.playing) {
      this.beatPhase += dt * this.bpm / 60;
      if (this.beatPhase >= 1) { this.beatPhase -= Math.floor(this.beatPhase); this.beatIndex = (this.beatIndex + 1) % 4; }
      const accent = this.beatIndex === 0 ? 1.35 : 1;
      this.pulse = Math.exp(-this.beatPhase * this.sharp) * this.energy * accent;
    } else {
      this.pulse *= 0.9;
    }
    this.burst *= Math.exp(-dt * 1.6);

    const k = 1 - Math.exp(-dt * 1.5);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      this.colors[i][j] += (this.target[i][j] - this.colors[i][j]) * k;

    if (this.fade > 0) {
      this.fade += dt / 1.8;
      if (this.fade >= 1) { this.mode = this.nextMode; this.fade = 0; }
    }

    gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_time, this.time);
    gl.uniform1f(u.u_modeA, this.mode);
    gl.uniform1f(u.u_modeB, this.nextMode);
    gl.uniform1f(u.u_fade, this.fade);
    gl.uniform3fv(u.u_c1, this.colors[0]);
    gl.uniform3fv(u.u_c2, this.colors[1]);
    gl.uniform3fv(u.u_c3, this.colors[2]);
    gl.uniform1f(u.u_pulse, this.pulse);
    gl.uniform1f(u.u_burst, this.burst);
    gl.uniform1f(u.u_energy, this.energy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Adaptive resolution. Resizing itself causes a hitch, so: ignore crossfades (they briefly cost
    // double), drop quickly when frames are slow, and only grow after several smooth windows in a row.
    if (this.fade > 0) { this.frameTimes = []; }
    else {
      this.frameTimes.push(dt);
      if (this.frameTimes.length >= 90) {
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        this.frameTimes = [];
        if (avg > 0.022 && this.scale > this.minScale) {
          this.scale = Math.max(this.minScale, this.scale - 0.05); this.goodWindows = 0; this.resize();
        } else if (avg < 0.0175) {
          if (++this.goodWindows >= 4 && this.scale < this.maxScale) {
            this.scale = Math.min(this.maxScale, this.scale + 0.05); this.goodWindows = 0; this.resize();
          }
        } else {
          this.goodWindows = 0;
        }
      }
    }
    requestAnimationFrame(this.frame);
  };

  window.Visualizer = Visualizer;
})();
