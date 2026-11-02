/* shaderhost.js: runs one model-written GLSL fragment shader full screen and reports what happened.
 *
 * The model writes only `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (Shadertoy style). The host wraps it
 * with the uniforms, a font atlas helper and a full-screen triangle. A shader has no network, storage or DOM access, so
 * no sandbox is needed; the only risk is GPU cost, which is checked before a shader is allowed to run.
 * Browser only (window.ShaderHost). */
(function (root) {
  'use strict';

  const HEADER = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'uniform vec2 iResolution;',
    'uniform float iTime;',
    'uniform float iTimeDelta;',
    'uniform int iFrame;',
    'uniform vec4 iMouse;',
    'uniform sampler2D iChannel0;',
    'out vec4 outColor;',
    '',
  ].join('\n');

  // Coverage of ASCII `code` (32..127) at cell coordinate p in [0,1]^2, y up. Atlas: 16 x 6 cells, bold monospace.
  const PRELUDE = [
    'float glyph(int code, vec2 p) {',
    '  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;',
    '  int i = clamp(code, 32, 127) - 32;',
    '  int cx = i % 16;',
    '  int cy = i / 16;',
    '  vec2 uv = (vec2(float(cx), 5.0 - float(cy)) + p) / vec2(16.0, 6.0);',
    '  return texture(iChannel0, uv).r;',
    '}',
    '',
  ].join('\n');

  const FOOTER = '\nvoid main() { vec4 c = vec4(0.0, 0.0, 0.0, 1.0); mainImage(c, gl_FragCoord.xy); outColor = vec4(c.rgb, 1.0); }\n';
  const VERT = '#version 300 es\nvoid main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';
  const BUILTINS = ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iMouse', 'iChannel0'];

  // The host declares these; a model that redeclares them or adds #version would fail to compile for no design reason.
  function sanitize(src) {
    let s = String(src).replace(/\r\n?/g, '\n');
    s = s.replace(/^[ \t]*#version[^\n]*$/gm, '');
    s = s.replace(new RegExp('^[ \\t]*uniform\\s+\\w+\\s+(?:' + BUILTINS.join('|') + ')\\s*;[^\\n]*$', 'gm'), '');
    return s;
  }

  // `// design:size 1080x1350` or `// design:size fluid`. Returns {w,h}, {fluid:true} or null.
  function parseSize(src) {
    const m = /^\s*\/\/\s*design:size\s+(fluid|(\d{2,5})\s*[x×]\s*(\d{2,5}))/im.exec(src);
    if (!m) return null;
    if (/fluid/i.test(m[1])) return { fluid: true };
    return { w: Math.min(4096, Math.max(120, +m[2])), h: Math.min(4096, Math.max(120, +m[3])) };
  }

  function parseLog(log, user) {
    const lines = user.split('\n'), out = [], re = /(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)/g;
    let m;
    while ((m = re.exec(log))) {
      if (m[1] !== 'ERROR') continue;
      const line = +m[2];
      out.push({ line, msg: m[3].trim(), text: line >= 1 && line <= lines.length ? lines[line - 1].trim() : '' });
    }
    return out.length ? out : [{ line: 0, msg: (log || 'the shader failed to compile').trim(), text: '' }];
  }

  function makeAtlas(gl) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 384;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    x.font = '700 52px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
    for (let i = 0; i < 96; i++) x.fillText(String.fromCharCode(32 + i), (i % 16) * 64 + 32, Math.floor(i / 16) * 64 + 46);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * @param {HTMLElement} stage element to fill (give it a fixed height)
   * @param {{onFrame?:Function}} [opts]
   */
  function create(stage, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);box-shadow:0 8px 40px rgba(0,0,0,.45);touch-action:none;cursor:crosshair';
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    let prog = null, uni = null, size = null, running = false, t0 = 0, frame = 0, lastT = 0, source = '', fixedT = null;
    const mouse = [0, 0, 0, 0];
    let down = false;
    stage.style.position = stage.style.position || 'relative';
    stage.replaceChildren(canvas);

    if (!gl) {
      return {
        supported: false,
        compile: () => ({ ok: false, errors: [{ line: 0, msg: 'WebGL2 is not available in this browser', text: '' }], issues: [], metrics: null }),
        capture: () => Promise.reject(new Error('no WebGL2')), destroy() {}, parseSize, sanitize,
      };
    }

    gl.bindVertexArray(gl.createVertexArray());
    const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VERT); gl.compileShader(vs);
    const atlas = makeAtlas(gl);

    // Canvas sizes for a design: CSS size on screen and the pixel size it is rendered at.
    function dims(sz) {
      const sw = Math.max(1, stage.clientWidth), sh = Math.max(1, stage.clientHeight), dpr = Math.min(2, root.devicePixelRatio || 1);
      if (!sz || sz.fluid) return { cssW: sw, cssH: sh, pw: Math.round(sw * dpr), ph: Math.round(sh * dpr) };
      const k = Math.min((sw - 24) / sz.w, (sh - 24) / sz.h);
      const cssW = Math.max(1, Math.floor(sz.w * k)), cssH = Math.max(1, Math.floor(sz.h * k));
      const pw = Math.min(sz.w, Math.round(cssW * dpr));
      return { cssW, cssH, pw, ph: Math.round(pw * sz.h / sz.w) };
    }
    function layout() {
      const d = dims(size);
      canvas.style.width = d.cssW + 'px'; canvas.style.height = d.cssH + 'px';
      if (canvas.width !== d.pw || canvas.height !== d.ph) { canvas.width = d.pw; canvas.height = d.ph; }
    }

    function setUniforms(p, u, t, dt) {
      gl.useProgram(p);
      gl.uniform2f(u.iResolution, canvas.width, canvas.height);
      gl.uniform1f(u.iTime, t);
      gl.uniform1f(u.iTimeDelta, dt);
      gl.uniform1i(u.iFrame, frame);
      gl.uniform4f(u.iMouse, mouse[0], mouse[1], mouse[2], mouse[3]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(u.iChannel0, 0);
    }
    const locations = p => { const u = {}; BUILTINS.forEach(n => { u[n] = gl.getUniformLocation(p, n); }); return u; };

    function draw(t, dt = 0) {
      if (!prog) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      setUniforms(prog, uni, t, dt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      lastT = t; frame++;
    }
    function tick(now) {
      if (!running) return;
      const t = fixedT != null ? fixedT : (now - t0) / 1000;
      draw(t, Math.max(0, t - lastT));
      if (opts.onFrame) opts.onFrame(t);
      requestAnimationFrame(tick);
    }
    function start() { if (running) return; running = true; requestAnimationFrame(tick); }

    const sync = () => { const b = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); };
    const probe = document.createElement('canvas'); probe.width = probe.height = 64;
    const px = probe.getContext('2d', { willReadFrequently: true });
    function snapshot() { px.drawImage(canvas, 0, 0, 64, 64); return px.getImageData(0, 0, 64, 64).data; }
    function stats(d) {
      let sum = 0, sq = 0; const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; }
      const mean = sum / n; return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
    }

    // Cost guard. A shader can spin a GPU for minutes, and JavaScript cannot interrupt a draw once it has started,
    // so cost is estimated on small viewports first and scaled up to the real pixel count. The same measurement on a
    // trivial shader is subtracted so the fixed cost of a draw and a sync does not count against the design.
    function steadyMs(p, u, vp, n) {
      gl.viewport(0, 0, vp, vp); setUniforms(p, u, 0.5, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3); sync();            // warm-up: the driver finishes compiling on first use
      const c0 = performance.now();
      for (let i = 0; i < n; i++) { gl.drawArrays(gl.TRIANGLES, 0, 3); sync(); }
      return (performance.now() - c0) / n;
    }
    const triv = gl.createProgram();
    { const f = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(f, HEADER + PRELUDE + '#line 1\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(f / iResolution.xy, 0.0, 1.0); }' + FOOTER);
      gl.compileShader(f); gl.attachShader(triv, vs); gl.attachShader(triv, f); gl.linkProgram(triv); }
    const trivU = locations(triv);
    const base32 = steadyMs(triv, trivU, 32, 3), base64 = steadyMs(triv, trivU, 64, 3);
    function costProblem(p, u, pixels) {
      const w0 = performance.now(); gl.viewport(0, 0, 32, 32); setUniforms(p, u, 0.5, 0); gl.drawArrays(gl.TRIANGLES, 0, 3); sync();
      const warm = performance.now() - w0;
      if (warm > 1500) return { ms: warm, est: warm };
      const s1 = steadyMs(p, u, 32, 1), e1 = Math.max(0, s1 - base32) * pixels / 1024;
      if (e1 > 8000) return { ms: s1, est: e1 };
      const s2 = steadyMs(p, u, 64, 5), e2 = Math.max(0, s2 - base64) * pixels / 4096;
      return e2 > 4000 ? { ms: s2, est: e2 } : { ms: s2, est: e2, ok: true };
    }

    /** Compile and, if it is safe and cheap enough, switch to it. A failed compile leaves the previous design running.
     *  Returns { ok, errors:[{line,msg,text}], issues:[string], metrics, size } */
    function compile(src) {
      const user = sanitize(src);
      const fsrc = HEADER + PRELUDE + '#line 1\n' + user + FOOTER;
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsrc); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        const errors = parseLog(gl.getShaderInfoLog(fs), user); gl.deleteShader(fs);
        return { ok: false, errors, issues: [], metrics: null };
      }
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const errors = parseLog(gl.getProgramInfoLog(p), user); gl.deleteProgram(p); gl.deleteShader(fs);
        return { ok: false, errors, issues: [], metrics: null };
      }
      const u = locations(p);

      const sz = parseSize(user), dm = dims(sz), cost = costProblem(p, u, dm.pw * dm.ph);
      if (!cost.ok) {
        gl.deleteProgram(p); gl.deleteShader(fs);
        return { ok: false, errors: [{ line: 0, msg: `the shader is too expensive: it would take about ${Math.round(cost.est)} ms per frame at ${dm.pw}x${dm.ph}, which would freeze the page. Cut loop counts and ray-march steps.`, text: '' }], issues: [], metrics: null };
      }
      const probeMs = cost.est;

      const old = prog;
      prog = p; uni = u; source = user; size = parseSize(user); frame = 0; t0 = performance.now(); lastT = 0;
      layout();
      draw(0); const a = stats(snapshot()); const snapA = snapshot().slice();
      draw(1.7); const snapB = snapshot();
      let diff = 0; for (let i = 0; i < snapA.length; i += 4) diff += Math.abs(snapA[i] - snapB[i]) + Math.abs(snapA[i + 1] - snapB[i + 1]) + Math.abs(snapA[i + 2] - snapB[i + 2]);
      const animated = diff / (snapA.length / 4) > 1.5;
      const m0 = performance.now(); for (let i = 0; i < 3; i++) { draw(0.5 + i); sync(); } const frameMs = (performance.now() - m0) / 3;
      if (old) gl.deleteProgram(old);

      const issues = [];
      if (a.std < 2) issues.push(a.mean < 8 ? 'the output is solid black: nothing visible is drawn' : a.mean > 247 ? 'the output is solid white: nothing visible is drawn' : 'the output is one flat color: nothing is drawn');
      if (frameMs > 80) issues.push(`a frame takes ${Math.round(frameMs)} ms at ${canvas.width}x${canvas.height}; it needs to be under 16 ms to animate smoothly`);
      if (!size) issues.push('the first line is not "// design:size WxH" or "// design:size fluid", so the frame defaulted to the available space');
      start();
      return { ok: true, errors: [], issues, metrics: { probeMs: Math.round(probeMs), width: canvas.width, height: canvas.height, mean: Math.round(a.mean), std: Math.round(a.std), animated, frameMs: Math.round(frameMs * 10) / 10 }, size: size && !size.fluid ? { w: size.w, h: size.h } : { w: canvas.width, h: canvas.height, fluid: true } };
    }

    /** PNG of the current frame: { dataUrl, blob }. maxSide caps the longer edge in pixels. */
    function capture(maxSide = 1024) {
      return new Promise((resolve, reject) => {
        if (!prog) return reject(new Error('nothing rendered'));
        draw(fixedT != null ? fixedT : (performance.now() - t0) / 1000);
        const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
        const c = document.createElement('canvas'); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve({ blob: b, dataUrl: c.toDataURL('image/png') }) : reject(new Error('screenshot failed')), 'image/png');
      });
    }

    function pointer(e) {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (r.bottom - e.clientY) * canvas.height / r.height];
    }
    canvas.addEventListener('pointerdown', e => { down = true; const p = pointer(e); mouse[0] = mouse[2] = p[0]; mouse[1] = mouse[3] = p[1]; try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    canvas.addEventListener('pointermove', e => { const p = pointer(e); mouse[0] = p[0]; mouse[1] = p[1]; });
    const up = () => { if (down) { down = false; mouse[2] = -Math.abs(mouse[2]); mouse[3] = -Math.abs(mouse[3]); } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { layout(); if (prog) draw(lastT); }) : null;
    if (ro) ro.observe(stage);

    return {
      supported: true, compile, capture, canvas,
      get source() { return source; },
      /** Freeze time at t (for tests and screenshots) or pass null to run again. */
      freeze(t) { fixedT = t; if (t != null) draw(t); },
      readPixel(fx, fy) { const b = new Uint8Array(4); gl.readPixels(Math.floor(fx * canvas.width), Math.floor((1 - fy) * canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b.slice(0, 3)); },
      destroy() { running = false; if (ro) ro.disconnect(); },
      parseSize, sanitize,
    };
  }

  root.ShaderHost = { create, parseSize, sanitize, HEADER, PRELUDE };
})(typeof window !== 'undefined' ? window : globalThis);
