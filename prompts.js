/* prompts.js: what the model is told, and how its replies are read. Browser (window.Prompts) and Node (require). */
(function (root) {
  'use strict';

  const SYSTEM = `You are a designer who works only in GLSL. You produce one finished design as a single fragment shader. You write no HTML, CSS, JavaScript or JSON.

The host already declares these (never redeclare them, never write #version):
  uniform vec2  iResolution;   // canvas size in pixels
  uniform float iTime;         // seconds since the design started
  uniform float iTimeDelta;
  uniform int   iFrame;
  uniform vec4  iMouse;        // xy = pointer in pixels, origin bottom-left; zw = where the button went down (positive while held, negative after release)
  uniform sampler2D iChannel0; // font atlas, use it only through glyph()
  float glyph(int code, vec2 p);
      // Coverage 0..1 of ASCII character \`code\` (32..127) at cell coordinate p. The cell is square, p in [0,1] x [0,1], y up.
      // Bold monospace. The baseline is at p.y = 0.28, capitals reach about 0.88, lowercase x-height is about 0.68.
      // Letters advance about 0.6 in x. Outside the cell it returns 0.

You write exactly one entry point, in GLSL ES 3.00:
  void mainImage(out vec4 fragColor, in vec2 fragCoord)
You may add helper functions, consts and arrays above it. Alpha is ignored, write 1.0.

Rules:
- The first line must be a comment declaring the artboard: "// design:size 1080x1350" for a fixed size (posters, logos, covers, phone screens), or "// design:size fluid" for something that should fill whatever space it gets. Choose the size that suits the work.
- Work in resolution-independent coordinates from iResolution, for example uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y. Never hardcode pixel sizes.
- Anti-alias every edge: use smoothstep over a pixel width such as 1.5 / iResolution.y.
- Loops need constant bounds and must stay small (under 64 iterations; ray-march under 48 steps). The shader runs on every pixel at 60 fps on an integrated GPU. Expensive shaders are rejected.
- Text: draw a string by looping over an int array, for example
    const int N = 5; int s[N] = int[](72, 69, 76, 76, 79);
    for (int i = 0; i < N; i++) a = max(a, glyph(s[i], (uv - origin) / size - vec2(float(i) * 0.6, 0.0)));
  Keep type large enough to read (at least 14 px tall at the artboard size) with strong contrast against what is behind it.
- Build shapes from signed distance functions, charts from the data written as constants, patterns from fract() and hashes, texture from noise and domain warping. Use iTime for motion only where it helps the design; a poster can be still.
- Everything is computed in the shader. There are no images, fonts or external files.

Reply with the shader in a single \`\`\`glsl fenced block and nothing else.`;

  // Random art direction: two identical requests should not give two near-identical results.
  const AXES = {
    palette: ['near-monochrome with one hot accent', 'deep saturated jewel tones', 'warm paper and ink, two inks only', 'neon on black', 'soft pastel gradient field', 'high-contrast primary colors', 'muted earth tones with a single bright spot', 'cold blues and one warm light', 'acid greens and violets', 'black, white and one metallic'],
    form: ['bold geometric shapes, flat and crisp', 'organic flowing fields from domain warping', 'grid of repeated cells with variation', 'a single dominant object with soft light', 'layered translucent planes', 'radial or polar composition', 'line art built from distance-field strokes', 'dense pattern that opens to one calm area'],
    composition: ['asymmetric, one dominant mass off-center', 'strict modular grid', 'centered and calm, lots of negative space', 'diagonal energy', 'edge-to-edge texture with a small, sharp focal point', 'stacked horizontal bands'],
    surface: ['flat vector, crisp edges', 'grain and noise over everything', 'soft glow and depth', 'print halftone dots', 'subtle gradient banding avoided with dithering', 'chromatic offset on edges'],
  };
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
  const pickDirection = (rnd = Math.random) => ({ palette: pick(AXES.palette, rnd), form: pick(AXES.form, rnd), composition: pick(AXES.composition, rnd), surface: pick(AXES.surface, rnd) });
  const directionText = d => `Art direction for this attempt (follow it unless the request says otherwise):
- palette: ${d.palette}
- form: ${d.form}
- composition: ${d.composition}
- surface: ${d.surface}`;

  const generatePrompt = (request, direction) => `${SYSTEM}

${direction ? directionText(direction) + '\n\n' : ''}Request:
${request}`;

  const numbered = src => src.split('\n').map((l, i) => String(i + 1).padStart(3) + '  ' + l).join('\n');

  function reportText(res) {
    const lines = [];
    if (res.errors && res.errors.length) {
      lines.push('Compile errors (line numbers refer to your source):');
      res.errors.slice(0, 10).forEach(e => lines.push(`- line ${e.line}: ${e.msg}${e.text ? '   <  ' + e.text : ''}`));
    }
    if (res.issues && res.issues.length) { lines.push('Problems found by measurement:'); res.issues.forEach(i => lines.push('- ' + i)); }
    if (res.metrics) lines.push(`Rendered ${res.metrics.width}x${res.metrics.height}, ${res.metrics.animated ? 'animated' : 'static'}, ${res.metrics.frameMs} ms per frame.`);
    if (!lines.length) lines.push('No problems found.');
    return lines.join('\n');
  }

  const fixPrompt = (request, src, res) => `${SYSTEM}

You wrote the shader below for this request and it failed to compile. Fix every error and return the complete corrected shader. Keep the design; do not simplify it.

Request:
${request}

${reportText(res)}

Your shader, with line numbers added (do not include them in your reply):
${numbered(src)}`;

  const critiquePrompt = (request, src, res, hasImage) => `${SYSTEM}

You are now the art director reviewing your own work. ${hasImage ? 'The attached image is a frame of the shader, rendered at its artboard size.' : 'No frame is available, so judge from the code and the report.'}

Request:
${request}

Run report:
${reportText(res)}

Check, in order: does it do what was asked; is any text readable and unclipped; is the hierarchy clear within two seconds; is it distinctive rather than generic; does anything look broken, empty, noisy or unfinished.

If it is already good, reply with the single word KEEP and nothing else.
Otherwise reply with the complete improved shader in one \`\`\`glsl fenced block, changing only what the review found. Do not shrink the ambition of the design to fix a problem.

Your shader:
\`\`\`glsl
${src}
\`\`\``;

  /** Pull a shader out of a model reply. Returns null if there is none. */
  function extractGlsl(text) {
    if (!text) return null;
    let body = null;
    const fence = /```(?:glsl|c|cpp|frag)?[ \t]*\n([\s\S]*?)```/i.exec(text);
    if (fence) body = fence[1];
    else {
      const open = /```(?:glsl|c|cpp|frag)?[ \t]*\n([\s\S]*)$/i.exec(text); // unterminated fence: reply was cut off
      if (open && /\}\s*$/.test(open[1].trim()) && /mainImage/.test(open[1])) body = open[1];
    }
    if (!body && /void\s+mainImage\s*\(/.test(text)) body = text;
    if (!body || !/void\s+mainImage\s*\(/.test(body)) return null;
    return body.trim();
  }

  const isKeep = text => /^\s*KEEP\b/i.test(text || '') && !/```/.test(text);

  const api = { SYSTEM, AXES, pickDirection, directionText, generatePrompt, fixPrompt, critiquePrompt, reportText, extractGlsl, isKeep, numbered };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Prompts = api;
})(typeof window !== 'undefined' ? window : globalThis);
