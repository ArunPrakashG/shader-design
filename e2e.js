// node e2e.js [outDir]
// Headless Chrome (software WebGL2) against the real page, with a stubbed `sample` so no API access is needed.
// Checks: compile errors with source line numbers, the font helper, uniforms, flat/blank and cost guards, screenshots
// with real pixels, and the generate -> fix -> review loop. Writes screenshots to outDir. No npm dependencies.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const out = path.resolve(process.argv[2] || './e2e-out');
fs.mkdirSync(out, { recursive: true });
const PORT = 9400 + (process.pid % 300), WEB = 8800 + (process.pid % 300), URL = `http://127.0.0.1:${WEB}/${process.env.PAGE || 'index.html'}`; // PAGE=dist/shader-design.html tests the bundled artifact
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const f = path.join(__dirname, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(__dirname) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': (MIME[path.extname(f)] || 'text/plain') + '; charset=utf-8' }).end(fs.readFileSync(f));
}).listen(WEB, '127.0.0.1');

let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); if (!ok) failures++; };

// Shaders under test. Embedded into the page as JSON so quoting stays simple.
const S = {
  split: '// design:size 400x300\nvoid mainImage(out vec4 o, in vec2 f) {\n  vec2 uv = f / iResolution.xy;\n  o = vec4(uv.x < 0.5 ? vec3(0.9, 0.1, 0.1) : vec3(0.1, 0.1, 0.9), 1.0);\n}',
  broken: '// design:size 400x300\nvoid mainImage(out vec4 o, in vec2 f) {\n  vec2 uv = f / iResolution.xy;\n  vec3 c = vec3(uv, undefinedThing);\n  o = vec4(c, 1.0);\n}',
  header: '#version 300 es\nuniform float iTime;\nuniform vec2 iResolution;\n// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(1.0, 0.5, 0.0, 1.0); }',
  text: '// design:size 600x300\nvoid mainImage(out vec4 o, in vec2 f) {\n  vec2 uv = f / iResolution.xy;\n  const int N = 2; int s[N] = int[](72, 73);\n  float a = 0.0;\n  for (int i = 0; i < N; i++) a = max(a, glyph(s[i], (uv - vec2(0.1, 0.15)) / 0.7 * vec2(1.0, 2.0) - vec2(float(i) * 0.6, 0.0)));\n  o = vec4(vec3(a), 1.0);\n}',
  black: '// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(0.0, 0.0, 0.0, 1.0); }',
  still: '// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(f.x / iResolution.x, 0.3, 0.2, 1.0); }',
  moving: '// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(0.5 + 0.5 * sin(iTime * 2.0 + f.x / iResolution.x * 6.0), 0.3, 0.2, 1.0); }',
  mouse: '// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) { o = vec4(iMouse.x / iResolution.x, 0.2, 0.2, 1.0); }',
  heavy: '// design:size 200x200\nvoid mainImage(out vec4 o, in vec2 f) {\n  float x = f.x;\n  for (int i = 0; i < 600000; i++) x = sin(x + float(i) * 0.001) * 3.0;\n  o = vec4(vec3(fract(x)), 1.0);\n}',
  nosize: 'void mainImage(out vec4 o, in vec2 f) { o = vec4(f / iResolution.xy, 0.5, 1.0); }',
  good: '// design:size 400x300\nvoid mainImage(out vec4 o, in vec2 f) { vec2 uv = f / iResolution.xy; o = vec4(0.1, uv.y, 0.4, 1.0); }',
  better: '// design:size 400x300\nvoid mainImage(out vec4 o, in vec2 f) { vec2 uv = f / iResolution.xy; o = vec4(0.9, uv.y, 0.4, 1.0); }',
  poster: '// design:size 1080x1350\nfloat sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }\nvoid mainImage(out vec4 o, in vec2 f) {\n  vec2 uv = (f - 0.5 * iResolution.xy) / iResolution.y;\n  vec2 u01 = f / iResolution.xy;\n  float px = 1.5 / iResolution.y;\n  vec3 col = mix(vec3(0.05, 0.03, 0.12), vec3(0.85, 0.25, 0.35), smoothstep(-0.6, 0.7, uv.y + 0.15 * sin(uv.x * 4.0 + iTime * 0.5)));\n  float moon = length(uv - vec2(0.12, 0.28)) - 0.2;\n  col = mix(col, vec3(1.0, 0.85, 0.5), smoothstep(px, -px, moon));\n  for (int i = 0; i < 5; i++) { float fi = float(i); float b = sdBox(uv - vec2(-0.32 + fi * 0.16, -0.18 - fi * 0.02), vec2(0.05, 0.14 + 0.05 * sin(fi * 2.0))); col = mix(col, vec3(0.04, 0.02, 0.08), smoothstep(px, -px, b)); }\n  const int N = 6; int s[N] = int[](75, 79, 67, 72, 73, 33);\n  float a = 0.0;\n  for (int i = 0; i < N; i++) a = max(a, glyph(s[i], (u01 - vec2(0.08, 0.1)) / 0.14 * vec2(1.0, 1.25) - vec2(float(i) * 0.6, 0.0)));\n  col = mix(col, vec3(1.0, 0.95, 0.85), a);\n  o = vec4(col, 1.0);\n}',
};

(async () => {
  const chrome = spawn(process.env.CHROME || 'google-chrome-stable', [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(out, 'profile')}`,
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch (_) { await sleep(200); } }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const pageErrors = [];
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
      return r.result.result.value;
    };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: URL }); await sleep(1500);
    await ev(`window.S = ${JSON.stringify(S)}; window.H = window.__app.host; true`);

    // ---------- 0. WebGL2 is really there ----------
    check('WebGL2 is available', await ev('window.H.supported === true'));

    // ---------- 1. compile, render, pixels, size ----------
    const a = await ev(`(() => {
      const r = H.compile(S.split); H.freeze(0);
      return { r: { ok: r.ok, errors: r.errors, issues: r.issues, size: r.size }, left: H.readPixel(0.25, 0.5), right: H.readPixel(0.75, 0.5), cw: H.canvas.width, ch: H.canvas.height };
    })()`);
    check('shader compiles and reports the declared size', a.r.ok && a.r.size.w === 400 && a.r.size.h === 300, a.r);
    check('left half is red, right half is blue', a.left[0] > 200 && a.left[2] < 60 && a.right[2] > 200 && a.right[0] < 60, a);
    check('canvas keeps the artboard aspect', Math.abs(a.cw / a.ch - 4 / 3) < 0.02, a);
    check('a clean shader raises no issues', a.r.issues.length === 0, a.r.issues);

    // ---------- 2. compile errors name the user's line ----------
    const b = await ev(`(() => { const r = H.compile(S.broken); return { ok: r.ok, errors: r.errors }; })()`);
    check('compile error is reported with the model\'s own line number', !b.ok && b.errors.some(e => e.line === 4 && /undefinedThing/.test(e.msg + e.text)), b);
    const keep = await ev(`(() => { H.compile(S.split); H.freeze(0); const before = H.readPixel(0.25, 0.5); H.compile(S.broken); H.freeze(0); return { before, after: H.readPixel(0.25, 0.5), src: H.source.includes('uv.x < 0.5') }; })()`);
    check('a failed compile leaves the previous design running', keep.before[0] > 200 && keep.after[0] > 200 && keep.src, keep);

    // ---------- 3. host wrapper tolerance ----------
    const c = await ev(`(() => { const r = H.compile(S.header); H.freeze(0); return { ok: r.ok, errors: r.errors, px: H.readPixel(0.5, 0.5), size: r.size }; })()`);
    check('#version and redeclared uniforms are stripped', c.ok && c.px[0] > 200 && c.size.w === 200, c);

    // ---------- 4. the font helper draws text ----------
    const t = await ev(`(() => {
      const r = H.compile(S.text); H.freeze(0);
      let lit = 0, total = 0;
      for (let y = 0.1; y < 0.9; y += 0.04) for (let x = 0.05; x < 0.8; x += 0.02) { total++; if (H.readPixel(x, y)[0] > 200) lit++; }
      return { ok: r.ok, errors: r.errors, lit, total };
    })()`);
    check('glyph() draws letters', t.ok && t.lit > 20 && t.lit < t.total * 0.6, t);

    // ---------- 5. blank, animation, size defaults ----------
    const d = await ev(`(() => ({ black: H.compile(S.black), still: H.compile(S.still), moving: H.compile(S.moving), nosize: H.compile(S.nosize) }))()`);
    check('solid black output is flagged', d.black.ok && d.black.issues.some(i => /solid black/.test(i)), d.black.issues);
    check('a gradient is not flagged as flat', d.still.ok && !d.still.issues.some(i => /flat|solid/.test(i)), d.still.issues);
    check('a time-dependent shader is detected as animated', d.moving.metrics.animated === true && d.still.metrics.animated === false, [d.moving.metrics, d.still.metrics]);
    check('missing design:size is flagged', d.nosize.ok && d.nosize.issues.some(i => /design:size/.test(i)), d.nosize.issues);

    // ---------- 6. cost guard ----------
    const h = await ev(`(() => { const t0 = performance.now(); const r = H.compile(S.heavy); return { ok: r.ok, msg: r.errors[0] && r.errors[0].msg, ms: Math.round(performance.now() - t0) }; })()`);
    check('a runaway shader is refused before it can freeze the page', !h.ok && /too expensive/.test(h.msg || ''), h);

    // ---------- 7. mouse uniform through real input ----------
    await ev(`H.compile(S.mouse); window.scrollTo(0, 0); true`); await sleep(300);
    const rect = await ev(`(() => { const r = H.canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const at = async fx => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * fx, y: rect.y + rect.h * 0.5 }); await sleep(200); return ev(`(() => { H.freeze(0.1); const p = H.readPixel(0.5, 0.5); H.freeze(null); return p; })()`); };
    const m1 = await at(0.2), m2 = await at(0.8);
    check('iMouse follows the pointer', m2[0] - m1[0] > 100, [m1, m2]);

    // ---------- 8. screenshots ----------
    const cap = await ev(`(async () => {
      H.compile(S.split); H.freeze(0);
      const s = await H.capture(400);
      const img = new Image(); img.src = s.dataUrl; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const px = (fx, fy) => Array.from(x.getImageData(Math.floor(img.width * fx), Math.floor(img.height * fy), 1, 1).data.slice(0, 3));
      return { type: s.blob.type, bytes: s.blob.size, w: img.width, h: img.height, left: px(0.25, 0.5), right: px(0.75, 0.5) };
    })()`);
    check('capture returns a PNG with the real pixels', cap.type === 'image/png' && cap.bytes > 300 && cap.left[0] > 200 && cap.right[2] > 200 && cap.w <= 400, cap);

    // ---------- 9. loop with a stubbed sampler ----------
    const loop = await ev(`(async () => {
      const calls = [];
      const mk = replies => async (input, opts) => { calls.push({ input: String(input), cache: opts.cache, hasImage: !!(opts.images && opts.images[0] instanceof Blob), tier: opts.modelTier }); const r = replies.shift(); if (r instanceof Error) throw r; return r; };
      const fence = g => '\\u0060\\u0060\\u0060glsl\\n' + g + '\\n\\u0060\\u0060\\u0060';
      const host = { compile: s => H.compile(s), capture: n => H.capture(n) };
      const steps = [];
      // a) broken draft -> fix -> review revises
      const a = await Loop.run({ request: 'logo', sample: mk([{ text: fence(S.broken) }, { text: fence(S.good) }, { text: fence(S.better) }]), host, onStep: s => steps.push(s.phase) });
      const aCalls = calls.splice(0);
      // b) good draft -> KEEP
      const b = await Loop.run({ request: 'logo', sample: mk([{ text: fence(S.good) }, { text: 'KEEP' }]), host }); const bCalls = calls.splice(0);
      // c) rate limit during review keeps the draft, no retry
      const c = await Loop.run({ request: 'logo', sample: mk([{ text: fence(S.good) }, Object.assign(new Error('slow down'), { code: 'rate_limited' })]), host }); const cCalls = calls.splice(0);
      // d) truncated first reply
      const d = await Loop.run({ request: 'logo', sample: mk([{ text: fence('void mainImage(out vec4 o, in vec2 f) {'), truncated: true }]), host });
      // e) consent refused
      const e = await Loop.run({ request: 'logo', sample: mk([Object.assign(new Error('no'), { code: 'not_granted' })]), host });
      // f) revision that does not compile keeps the working design on screen
      const f = await Loop.run({ request: 'logo', sample: mk([{ text: fence(S.good) }, { text: fence(S.broken) }]), host });
      // g) never compiles: 1 generation + 2 fixes, then stops and still hands back the last source
      calls.splice(0);
      const g = await Loop.run({ request: 'logo', sample: mk([{ text: fence(S.broken) }, { text: fence(S.broken) }, { text: fence(S.broken) }]), host }); const gCalls = calls.splice(0);
      return {
        a: { glsl: a.glsl === S.better, steps, calls: aCalls.length, image: aCalls[2] && aCalls[2].hasImage, noCache: aCalls.every(x => x.cache === false), fixMentionsLine: /line 4/.test(aCalls[1].input) && /undefinedThing/.test(aCalls[1].input) },
        b: { kept: b.glsl === S.good, calls: bCalls.length },
        c: { glsl: c.glsl === S.good, stoppedBy: c.stoppedBy, calls: cCalls.length },
        d: { glsl: d.glsl, stoppedBy: d.stoppedBy },
        e: { glsl: e.glsl, stoppedBy: e.stoppedBy },
        f: { glsl: f.glsl === S.good, shown: H.source.includes('0.1, uv.y'), last: f.lastSource === S.broken },
        g: { glsl: g.glsl, last: !!g.lastSource, calls: gCalls.length },
      };
    })()`);
    check('loop: broken draft is fixed (with line numbers in the prompt) then revised', loop.a.glsl && loop.a.calls === 3 && loop.a.steps.includes('fix') && loop.a.fixMentionsLine, loop.a);
    check('loop: review call carries the frame as an image', loop.a.image === true, loop.a);
    check('loop: every call uses cache:false', loop.a.noCache, loop.a);
    check('loop: KEEP ends the review', loop.b.kept && loop.b.calls === 2, loop.b);
    check('loop: rate limit keeps the draft, no retry', loop.c.glsl && loop.c.stoppedBy === 'rate_limited' && loop.c.calls === 2, loop.c);
    check('loop: truncated reply is not compiled', loop.d.glsl === null, loop.d);
    check('loop: refused consent stops cleanly', loop.e.glsl === null && loop.e.stoppedBy === 'not_granted', loop.e);
    check('loop: a revision that fails to compile keeps the working design', loop.f.glsl && loop.f.shown && loop.f.last, loop.f);
    check('loop: gives up after 2 fixes and returns the last source', loop.g.glsl === null && loop.g.last && loop.g.calls === 3, loop.g);

    // ---------- 10. full playground flow, then a screenshot ----------
    await send('Page.navigate', { url: URL }); await sleep(1500);
    await ev(`(() => {
      const fence = g => '\\u0060\\u0060\\u0060glsl\\n' + g + '\\n\\u0060\\u0060\\u0060';
      const poster = ${JSON.stringify(S.poster)};
      let n = 0; window.__app.sample = async () => ({ text: n++ === 0 ? fence(poster) : 'KEEP' });
      document.getElementById('req').value = 'A poster for a night market in Kochi, 1080x1350, with the title as text';
      document.getElementById('go').click();
    })()`);
    await sleep(2500);
    const ui = await ev(`({ log: [...document.querySelectorAll('#log div')].map(d => d.textContent), meta: document.getElementById('meta').textContent, code: document.getElementById('code').value.slice(0, 40) })`);
    check('playground ran generate, compile, review, keep', ui.log.some(l => /Compiling/.test(l)) && ui.log.some(l => /kept the design/.test(l)), ui.log);
    check('playground shows the declared size', /1080×1350/.test(ui.meta), ui.meta);
    check('playground puts the shader in the code box', /design:size 1080x1350/.test(ui.code), ui.code);
    await shot('playground-poster');

    check('no uncaught errors on the host page', pageErrors.length === 0, pageErrors);
  } finally {
    chrome.kill(); server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
