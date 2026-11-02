# shader-design

An AI agent designs by writing a GLSL fragment shader and nothing else. No HTML, no CSS, no markup, no JSON, no component catalog. The host runs the shader full screen, tells the agent what the compiler and a rendered frame say, and lets it revise.

This is the third attempt. [genui-dsl](https://github.com/ArunPrakashG/genui-dsl) gave the model a small catalog drawn on a canvas, which re-implemented what a browser already does. An HTML version followed, but the model mostly produced a web page with a 2D canvas inside it. This one removes the document layer: the whole design is one shader.

## What the agent writes

```glsl
// design:size 1080x1350
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  ...
}
```

The host supplies `iResolution`, `iTime`, `iTimeDelta`, `iFrame`, `iMouse` and a font helper, `float glyph(int code, vec2 p)`, which returns the coverage of an ASCII character. Text is the one thing a pure shader cannot do on its own, so the host bakes a bold monospace atlas and exposes only that function. Everything else (shapes, gradients, charts, patterns, motion) is computed in the shader.

The first line declares the artboard (`// design:size 1080x1350` or `fluid`).

## The loop

```
request -> generate -> compile -> fix compile errors (up to 2) -> frame review -> keep or revise
```

- Compile errors come back with the model's own line numbers and the offending source line.
- The review step attaches a rendered frame as an image, plus measurements: flat or blank output, animated or static, milliseconds per frame.
- A revision that does not compile never replaces a working design.
- Each run gets a random art direction (palette, form, composition, surface) so identical requests diverge.
- Calls are never retried. A rate limit or refused consent ends the loop and keeps the best design so far.

## Safety

A shader has no network, storage or DOM access, so no sandbox is needed. The remaining risk is cost: a shader with a huge loop can hold the GPU for minutes, and JavaScript cannot interrupt a draw once it starts. Before a shader is allowed to run at full size, the host times it on 32x32 and 64x64 viewports, subtracts the cost of a trivial shader, and scales to the real pixel count. Estimates over about 4 seconds per frame are refused with an error the model can act on. On a real GPU the thresholds are very generous; on software rendering they are the only thing between a bad loop and a frozen tab.

## Files

| File | Role |
|---|---|
| `shaderhost.js` | WebGL2 host: wraps and compiles the shader, maps errors to source lines, cost guard, flat/animated detection, frame capture, pointer input |
| `prompts.js` | System prompt, art directions, fix and review prompts, reply parsing |
| `loop.js` | Generate, compile, fix, review |
| `app.js`, `index.html` | The playground |
| `build-artifact.js` | Bundles everything into `dist/shader-design.html` for publishing as a Claude artifact |
| `e2e.js` | Headless Chrome test with a stubbed sampler |

## Running it

The playground asks Claude through the artifact `sample` capability, so it needs to run as a Claude artifact:

```bash
npm run build   # writes dist/shader-design.html
```

Publish that file with `capabilities: {"sample": {"images": true}, "downloads": true}`. Opened anywhere else, you can still edit and render a shader in the Code box.

## Tests

```bash
npm test
```

Needs Node 22 and Chrome (`CHROME=/path/to/chrome` to override). The test uses a stubbed sampler, so it needs no API access. It checks compile errors against line numbers, that a failed compile leaves the previous design running, that `glyph()` draws letters, that blank output is flagged, that animated and static shaders are told apart, that a runaway shader is refused, that `iMouse` follows real pointer input, that a captured frame holds the real pixels, and that the loop handles a broken draft, `KEEP`, a rate limit, a truncated reply, refused consent, a bad revision and a shader that never compiles.

## Not verified

The loop has only been run against a stubbed sampler. How good Claude's shaders are, and whether the review round improves them, is not measured. Typography is limited to one bold monospace face, and a shader is a poor fit for dense UI such as long forms.

## License

MIT
