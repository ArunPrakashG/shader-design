/* app.js: the playground. Wires the shader host, the loop and the artifact `sample` capability to the page. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const EXAMPLES = [
    'A poster for a night market in Kochi, 1080x1350, with the title as text',
    'An animated logo for a coffee roaster called Ember',
    'A bar chart of monthly rainfall in Kerala, June to September highest',
    'A generative piece that feels like monsoon light on water',
    'An album cover for an ambient record named Low Tide',
    'A pricing screen for a meditation app, phone sized, three plans',
  ];

  const host = ShaderHost.create($('stage'));
  let sample = null, downloads = null, abort = null, busy = false, timer = null, started = 0;

  function logLine(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; $('log').appendChild(d); $('log').scrollTop = 1e9; }
  function setBusy(b) {
    busy = b; $('go').disabled = b || !sample; $('stopBtn').hidden = !b;
    clearInterval(timer);
    if (b) { started = Date.now(); timer = setInterval(() => { $('meta').textContent = `working… ${Math.round((Date.now() - started) / 1000)}s`; }, 1000); }
  }
  function showResult(res, src) {
    $('code').value = src; $('shot').disabled = false;
    const m = res.metrics;
    $('meta').textContent = `${res.size.w}×${res.size.h}` + (m ? `  ·  ${m.animated ? 'animated' : 'static'}  ·  ${m.frameMs} ms/frame` : '');
    $('issues').textContent = res.issues.join('  ·  '); $('issues').classList.toggle('on', res.issues.length > 0);
  }
  function compileAndShow(src) {
    const res = host.compile(src);
    if (res.ok) showResult(res, src);
    else { $('issues').textContent = res.errors.map(e => (e.line ? `line ${e.line}: ` : '') + e.msg).join('  ·  '); $('issues').classList.add('on'); }
    return res;
  }

  async function design() {
    const request = $('req').value.trim();
    if (!request || !sample || busy) return;
    $('log').textContent = ''; setBusy(true);
    abort = new AbortController();
    const wrapped = { compile: src => compileAndShow(src), capture: n => host.capture(n) };
    try {
      const out = await Loop.run({
        request, sample, host: wrapped, reviews: $('review').checked ? 1 : 0, images: !$('review').dataset.noimg, signal: abort.signal,
        onStep: s => {
          if (s.phase === 'stream') { const g = Prompts.extractGlsl(s.text) || s.text.replace(/```\w*\n?/, ''); $('code').value = g; return; }
          logLine(s.phase, s.message);
          if (s.errors) s.errors.slice(0, 4).forEach(e => logLine('err', `  line ${e.line}: ${e.msg}`));
        },
      });
      const d = out.direction;
      $('dir').innerHTML = `Direction: <b>${d.palette}</b> · ${d.form} · ${d.composition} · ${d.surface}`;
      if (!out.glsl && out.lastSource) $('code').value = out.lastSource;
    } catch (e) {
      logLine('err', e && e.code === 'cancelled' ? 'Stopped' : (e && e.message) || String(e));
    } finally { setBusy(false); abort = null; }
  }

  EXAMPLES.forEach(t => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = t.length > 38 ? t.slice(0, 36) + '…' : t; b.title = t; b.onclick = () => { $('req').value = t; $('req').focus(); }; $('chips').appendChild(b); });
  $('go').onclick = design;
  $('stopBtn').onclick = () => abort && abort.abort();
  $('renderCode').onclick = () => { const r = compileAndShow($('code').value); if (!r.ok) logLine('err', r.errors.map(e => `line ${e.line}: ${e.msg}`).join(' | ')); };
  $('copy').onclick = () => { try { navigator.clipboard.writeText($('code').value).then(() => logLine('done', 'Copied'), () => logLine('warn', 'Copy was blocked here')); } catch (e) { logLine('warn', 'Copy was blocked here'); } };
  // Saving goes through the artifact `downloads` capability; outside an artifact there is no save button.
  $('shot').onclick = async () => {
    if (!downloads) return;
    try { const s = await host.capture(2048); await downloads.save({ filename: 'design.png', data: s.blob }); logLine('done', 'Saved design.png'); }
    catch (e) { if (!e || e.code !== 'declined') logLine('warn', 'Save failed: ' + ((e && e.message) || e)); }
  };
  $('req').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') design(); });

  setBusy(false);
  if (!host.supported) { logLine('err', 'This browser has no WebGL2, so shaders cannot run.'); $('go').disabled = true; }
  else compileAndShow($('code').value);
  (async () => {
    try {
      if (window.claude && typeof claude.use === 'function') {
        sample = await claude.use('sample');
        if (sample && sample.limits) { try { const l = await sample.limits(); if (l && l.images === false) $('review').dataset.noimg = '1'; } catch (e) { /* keep default */ } }
        downloads = await claude.use('downloads');
      }
    } catch (e) { /* standalone */ }
    $('shot').hidden = !downloads; $('unavail').hidden = !!sample; $('go').disabled = busy || !sample || !host.supported;
  })();

  window.__app = { host, design, compileAndShow, get sample() { return sample; }, set sample(f) { sample = f; $('unavail').hidden = !!f; $('go').disabled = !f; } };
})();
