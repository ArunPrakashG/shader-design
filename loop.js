/* loop.js: generate, compile, fix, review. The model writes a shader, sees the compiler's complaints and a frame of
 * what it drew, and may revise it.
 *
 * `sample` is the artifact runtime's sampler (or any function with the same shape); `host` is ShaderHost.create().
 * Budget: 1 generation + up to `fixes` compile fixes + `reviews` review rounds. A sampler error stops the loop and
 * returns the best design so far; it is never retried (rate limits and consent refusals are not transient). */
(function (root) {
  'use strict';
  const P = root.Prompts || (typeof require === 'function' ? require('./prompts.js') : null);

  async function call(sample, input, { images, onText, signal } = {}) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      const opts = { cache: false, signal: ctl.signal, modelTier: 'complex' };
      if (images && images.length) opts.images = images;
      if (onText) opts.onText = onText;
      return await sample(input, opts);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @returns {Promise<{glsl:string|null, lastSource:string|null, direction:object, steps:object[], stoppedBy?:string, result?:object}>}
   *   glsl is the shader currently running on the host (null if none compiled); lastSource is the newest text the model wrote.
   */
  async function run({ request, sample, host, reviews = 1, fixes = 2, direction, onStep, signal, images = true }) {
    const dir = direction || P.pickDirection();
    const steps = [];
    const step = (phase, message, extra) => { const s = Object.assign({ phase, message }, extra); steps.push(s); if (onStep) onStep(s); };
    let glsl = null, lastSource = null, result = null;
    const stop = (why, err) => {
      step('stopped', why + (err && err.message ? ': ' + err.message : ''));
      return { glsl, lastSource, direction: dir, steps, stoppedBy: err && err.code ? err.code : why, result };
    };
    const stream = t => onStep && onStep({ phase: 'stream', message: 'writing', text: t.text });

    // 1. Generate
    step('generate', 'Asking for a first draft');
    let reply;
    try { reply = await call(sample, P.generatePrompt(request, dir), { signal, onText: stream }); }
    catch (e) { return stop('generation failed', e); }
    let src = P.extractGlsl(reply.text);
    if (!src) return stop(reply.truncated ? 'the reply was cut off before the shader ended' : 'the reply contained no shader');
    lastSource = src;
    if (reply.truncated) step('warn', 'The draft was truncated, so it may be incomplete');

    step('compile', 'Compiling', { source: src });
    let res = await host.compile(src);

    // 2. Compile fixes
    for (let i = 0; !res.ok && i < fixes; i++) {
      step('fix', `Fixing ${res.errors.length} compile error(s), attempt ${i + 1} of ${fixes}`, { errors: res.errors });
      try {
        const r = await call(sample, P.fixPrompt(request, src, res), { signal, onText: stream });
        const fixed = r.truncated ? null : P.extractGlsl(r.text);
        if (!fixed) { step('warn', 'The fix reply was unusable'); break; }
        src = fixed; lastSource = src;
        step('compile', 'Compiling the fix', { source: src });
        res = await host.compile(src);
      } catch (e) { return stop('fix failed', e); }
    }
    if (!res.ok) return stop('the shader still does not compile');
    glsl = src; result = res;

    // 3. Review with a frame
    for (let i = 0; i < reviews; i++) {
      step('review', `Review ${i + 1} of ${reviews}: capturing a frame`);
      let shot = null;
      if (images) { try { shot = await host.capture(1024); } catch (e) { step('warn', 'No frame (' + e.message + '), reviewing from the report'); } }
      let r;
      try { r = await call(sample, P.critiquePrompt(request, glsl, result, !!shot), { signal, images: shot ? [shot.blob] : undefined, onText: stream }); }
      catch (e) {
        if (e && e.code === 'images_unavailable') { step('warn', 'Images are not available here'); images = false; i--; continue; }
        return stop('review failed', e);
      }
      if (P.isKeep(r.text)) { step('keep', 'The review kept the design as it is'); break; }
      const revised = r.truncated ? null : P.extractGlsl(r.text);
      if (!revised) { step('warn', 'The review reply was unusable, keeping the current design'); break; }
      lastSource = revised;
      step('compile', 'Compiling the revision', { source: revised });
      const rr = await host.compile(revised);
      if (!rr.ok) { step('warn', `The revision does not compile (${rr.errors[0].msg}), keeping the current design`); break; }
      glsl = revised; result = rr;
    }

    step('done', 'Finished', { source: glsl });
    return { glsl, lastSource, direction: dir, steps, result };
  }

  const api = { run };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Loop = api;
})(typeof window !== 'undefined' ? window : globalThis);
