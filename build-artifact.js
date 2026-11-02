// node build-artifact.js
// Inlines prompts.js, shaderhost.js, loop.js and app.js into index.html and writes dist/shader-design.html,
// one file you can publish as a Claude artifact (it asks Claude through the `sample` capability).
const fs = require('fs');
const path = require('path');

const dir = __dirname;
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const js = fs.readFileSync(path.join(dir, src), 'utf8');
  if (/<\/script/i.test(js)) throw new Error(src + ' contains a raw </script, which would end the inline script');
  return '<script>\n' + js + '\n</script>';
});
// The artifact host wraps the page in its own document skeleton, so publish only title, style and body content.
const grab = re => { const m = re.exec(html); if (!m) throw new Error('index.html is missing ' + re); return m[1]; };
html = `<title>${grab(/<title>([\s\S]*?)<\/title>/)}</title>\n<style>${grab(/<style>([\s\S]*?)<\/style>/)}</style>\n${grab(/<body>([\s\S]*)<\/body>/).trim()}\n`;
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
const out = path.join(dir, 'dist', 'shader-design.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(dir, out)} (${(html.length / 1024).toFixed(1)} KB)`);
