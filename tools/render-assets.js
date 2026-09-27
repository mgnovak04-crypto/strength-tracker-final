// Renders app icons + iOS launch (splash) screens from icons/icon.svg using headless Chromium.
// Usage: node tools/render-assets.js   (needs Playwright; set CHROME_PATH to use a specific Chromium)
// Output: icons/*.png, splash/*.png. Re-run only when the icon design changes.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8');
const sized = (px) => svg.replace('<svg ', `<svg width="${px}" height="${px}" `);
// splash glyph: drop the square background glow so it sits cleanly on pure black
const glyphOnly = (px) => sized(px).replace(/<rect width="1024" height="1024"[^>]*\/>/, '');
// [cssWidth, cssHeight, devicePixelRatio] — portrait iPhone viewports (SE through 17 series)
const IPHONES = require('./iphones.json');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const shot = async (w, h, dpr, html, file) => {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    await p.setContent(`<html><body style="margin:0;background:#000;overflow:hidden">${html}</body></html>`);
    await p.screenshot({ path: path.join(ROOT, file) });
    await p.close();
  };
  for (const [px, file] of [[180, 'icons/apple-touch-icon.png'], [192, 'icons/icon-192.png'], [512, 'icons/icon-512.png']]) await shot(px, px, 1, sized(px), file);
  // maskable: keep the artwork inside the 80% safe zone
  await shot(512, 512, 1, `<div style="width:512px;height:512px;background:#000;display:flex;align-items:center;justify-content:center">${sized(410)}</div>`, 'icons/icon-maskable-512.png');
  for (const [w, h, dpr] of IPHONES) {
    const glyph = Math.round(w * 0.42);
    const html = `<div style="width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif">
      ${glyphOnly(glyph)}
      <div style="margin-top:${Math.round(w * 0.04)}px;font-size:${Math.round(w * 0.085)}px;font-weight:800;letter-spacing:-0.5px;background:linear-gradient(90deg,#009A44,#fff 55%,#FF8C00);-webkit-background-clip:text;color:transparent">IronClad Pro</div>
    </div>`;
    await shot(w, h, dpr, html, `splash/splash-${w * dpr}x${h * dpr}.png`);
  }
  await b.close();
  console.log('Rendered', 4, 'icons +', IPHONES.length, 'splash screens');
})();
