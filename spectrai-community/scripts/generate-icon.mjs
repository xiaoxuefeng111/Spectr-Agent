/**
 * ClaudeOps Icon Generator
 * Design: Rounded square with gradient background,
 *         stylized "C" with terminal cursor + orchestration nodes
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, '..', 'build');

function generateSVG(size) {
  const s = size;
  const r = s * 0.18; // corner radius
  const cx = s / 2;
  const cy = s / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <!-- Main background gradient: deep indigo to warm coral -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="50%" stop-color="#16213e"/>
      <stop offset="100%" stop-color="#0f3460"/>
    </linearGradient>

    <!-- Accent glow gradient -->
    <radialGradient id="glow" cx="40%" cy="35%" r="60%">
      <stop offset="0%" stop-color="#e94560" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#e94560" stop-opacity="0"/>
    </radialGradient>

    <!-- Claude orange accent -->
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e94560"/>
      <stop offset="100%" stop-color="#f5a623"/>
    </linearGradient>

    <!-- Node connection line gradient -->
    <linearGradient id="line-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e94560" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#f5a623" stop-opacity="0.6"/>
    </linearGradient>

    <!-- Terminal text gradient -->
    <linearGradient id="terminal" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e0e0e0"/>
    </linearGradient>

    <!-- Subtle inner shadow -->
    <filter id="inner-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="${s * 0.02}" result="blur"/>
      <feOffset dx="0" dy="${s * 0.01}"/>
      <feComposite in2="SourceAlpha" operator="arithmetic" k2="-1" k3="1"/>
      <feFlood flood-color="#000" flood-opacity="0.3"/>
      <feComposite in2="SourceGraphic" operator="in"/>
      <feComposite in="SourceGraphic"/>
    </filter>

    <!-- Glow effect for nodes -->
    <filter id="node-glow">
      <feGaussianBlur stdDeviation="${s * 0.008}" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Background rounded rectangle -->
  <rect x="${s * 0.02}" y="${s * 0.02}" width="${s * 0.96}" height="${s * 0.96}" rx="${r}" ry="${r}" fill="url(#bg)"/>

  <!-- Subtle glow overlay -->
  <rect x="${s * 0.02}" y="${s * 0.02}" width="${s * 0.96}" height="${s * 0.96}" rx="${r}" ry="${r}" fill="url(#glow)"/>

  <!-- Grid pattern (subtle orchestration background) -->
  <g opacity="0.06" stroke="#ffffff" stroke-width="${s * 0.002}">
    ${Array.from({ length: 7 }, (_, i) => {
      const pos = s * 0.15 + (s * 0.7 / 6) * i;
      return `<line x1="${pos}" y1="${s * 0.1}" x2="${pos}" y2="${s * 0.9}"/>
    <line x1="${s * 0.1}" y1="${pos}" x2="${s * 0.9}" y2="${pos}"/>`;
    }).join('\n    ')}
  </g>

  <!-- Orchestration connection lines -->
  <g stroke="url(#line-grad)" stroke-width="${s * 0.008}" fill="none" opacity="0.5">
    <!-- Top-left to center -->
    <line x1="${s * 0.22}" y1="${s * 0.25}" x2="${s * 0.42}" y2="${s * 0.42}"/>
    <!-- Top-right to center -->
    <line x1="${s * 0.78}" y1="${s * 0.28}" x2="${s * 0.58}" y2="${s * 0.42}"/>
    <!-- Bottom-left to center -->
    <line x1="${s * 0.25}" y1="${s * 0.75}" x2="${s * 0.42}" y2="${s * 0.58}"/>
    <!-- Bottom-right to center -->
    <line x1="${s * 0.78}" y1="${s * 0.72}" x2="${s * 0.58}" y2="${s * 0.58}"/>
  </g>

  <!-- Center "C" letter - stylized as terminal prompt -->
  <g transform="translate(${cx}, ${cy})">
    <!-- Large C shape -->
    <path d="M ${s * 0.12} ${-s * 0.02}
             C ${s * 0.12} ${-s * 0.16}, ${s * 0.04} ${-s * 0.22}, ${-s * 0.02} ${-s * 0.22}
             C ${-s * 0.12} ${-s * 0.22}, ${-s * 0.18} ${-s * 0.14}, ${-s * 0.18} ${0}
             C ${-s * 0.18} ${s * 0.14}, ${-s * 0.12} ${s * 0.22}, ${-s * 0.02} ${s * 0.22}
             C ${s * 0.04} ${s * 0.22}, ${s * 0.12} ${s * 0.16}, ${s * 0.12} ${s * 0.02}"
          fill="none" stroke="url(#accent)" stroke-width="${s * 0.04}"
          stroke-linecap="round"/>

    <!-- Terminal cursor blinking effect -->
    <rect x="${s * 0.10}" y="${s * 0.06}" width="${s * 0.04}" height="${s * 0.12}"
          fill="#f5a623" opacity="0.9" rx="${s * 0.005}"/>
  </g>

  <!-- Orchestration nodes (small dots at connection endpoints) -->
  <g filter="url(#node-glow)">
    <!-- Top-left node -->
    <circle cx="${s * 0.20}" cy="${s * 0.23}" r="${s * 0.028}" fill="#e94560"/>
    <circle cx="${s * 0.20}" cy="${s * 0.23}" r="${s * 0.014}" fill="#ffffff" opacity="0.8"/>

    <!-- Top-right node -->
    <circle cx="${s * 0.80}" cy="${s * 0.26}" r="${s * 0.028}" fill="#f5a623"/>
    <circle cx="${s * 0.80}" cy="${s * 0.26}" r="${s * 0.014}" fill="#ffffff" opacity="0.8"/>

    <!-- Bottom-left node -->
    <circle cx="${s * 0.23}" cy="${s * 0.77}" r="${s * 0.028}" fill="#f5a623"/>
    <circle cx="${s * 0.23}" cy="${s * 0.77}" r="${s * 0.014}" fill="#ffffff" opacity="0.8"/>

    <!-- Bottom-right node -->
    <circle cx="${s * 0.80}" cy="${s * 0.74}" r="${s * 0.028}" fill="#e94560"/>
    <circle cx="${s * 0.80}" cy="${s * 0.74}" r="${s * 0.014}" fill="#ffffff" opacity="0.8"/>
  </g>

  <!-- Subtle "Ops" text at bottom -->
  <text x="${cx}" y="${s * 0.92}" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-weight="700"
        font-size="${s * 0.07}" fill="#ffffff" opacity="0.4"
        letter-spacing="${s * 0.01}">OPS</text>

  <!-- Top-left corner highlight -->
  <rect x="${s * 0.02}" y="${s * 0.02}" width="${s * 0.96}" height="${s * 0.96}" rx="${r}" ry="${r}"
        fill="none" stroke="url(#accent)" stroke-width="${s * 0.003}" opacity="0.3"/>
</svg>`;
}

async function main() {
  console.log('🎨 Generating ClaudeOps icon...\n');

  const sizes = [16, 32, 48, 64, 128, 256, 512];
  const pngBuffers = {};

  // Generate PNGs at all sizes
  for (const size of sizes) {
    const svg = generateSVG(size);
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    pngBuffers[size] = pngBuffer;

    const pngPath = join(buildDir, `icon-${size}.png`);
    writeFileSync(pngPath, pngBuffer);
    console.log(`  ✅ icon-${size}.png`);
  }

  // Save 512x512 as main icon.png (electron-builder macOS requires >= 512x512)
  writeFileSync(join(buildDir, 'icon.png'), pngBuffers[512]);
  console.log('  ✅ icon.png (512x512)');

  // Generate ICO file (needs 16, 32, 48, 256)
  const icoSizes = [16, 32, 48, 256];
  const icoPngs = icoSizes.map(s => join(buildDir, `icon-${s}.png`));

  try {
    const icoBuffer = await pngToIco(icoPngs);
    writeFileSync(join(buildDir, 'icon.ico'), icoBuffer);
    console.log('  ✅ icon.ico');
  } catch (err) {
    console.error('  ❌ ICO generation failed:', err.message);
    // Fallback: create ICO from 256px only
    try {
      const icoBuffer = await pngToIco([join(buildDir, 'icon-256.png')]);
      writeFileSync(join(buildDir, 'icon.ico'), icoBuffer);
      console.log('  ✅ icon.ico (fallback: 256px only)');
    } catch (err2) {
      console.error('  ❌ ICO fallback also failed:', err2.message);
    }
  }

  console.log('\n✨ Icon generation complete!');
  console.log(`   Output: ${buildDir}`);
}

main().catch(console.error);
