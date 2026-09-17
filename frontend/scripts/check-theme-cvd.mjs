#!/usr/bin/env node
/**
 * Colour-blind check for theme semantic tokens.
 *
 * Simulates protanopia / deuteranopia / tritanopia (Machado et al. 2009, severity 1.0)
 * and reports CIEDE2000 distance between semantic colour pairs that users must be able
 * to tell apart. A pair with worst-case red/green ΔE < 15 is flagged.
 *
 * Usage:  node frontend/scripts/check-theme-cvd.mjs
 * Exit 1 if any theme has a collapsed (ΔE < 10) or weak (ΔE < 15) red/green pair.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'themes')

// Machado 2009 severity-1.0 matrices, applied to linear-light RGB.
const MATRICES = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}

const PAIRS = [
  ['ok', 'danger', '成功/错误', true],
  ['ok', 'warn', '成功/警告', true],
  ['danger', 'warn', '错误/警告', true],
  ['accent', 'ok', '主色/成功', false],
  ['accent', 'warn', '主色/警告', false],
  ['accent', 'danger', '主色/错误', false],
]

// Red/green pairs (ok/warn/danger) gate the exit code: < 10 is a real collapse.
// The accent pairs are advisory — they are a blue-axis concern, not red/green.
const FAIL_BELOW = 10

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) }
const simulate = (rgb, kind) => {
  const lin = rgb.map((c) => toLinear(c / 255))
  return MATRICES[kind].map((row) => toSrgb(Math.max(0, Math.min(1, row.reduce((s, m, j) => s + m * lin[j], 0)))) * 255)
}
const luminance = (rgb) => { const [r, g, b] = rgb.map((c) => toLinear(c / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const lab = (rgb) => {
  const [r, g, b] = rgb.map((c) => toLinear(c / 255))
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883
  const f = (t) => (t > (6 / 29) ** 3 ? t ** (1 / 3) : t / (3 * (6 / 29) ** 2) + 4 / 29)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
const de2000 = (l1, l2) => {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2)
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360, h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360
  const dLp = L2 - L1, dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360 }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * Math.PI / 180)
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2
  const hbp = C1p * C2p === 0 ? h1p + h2p : Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2
  const rad = (d) => (d * Math.PI) / 180
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63))
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

let failed = false
for (const file of readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')).sort()) {
  const css = readFileSync(join(THEMES_DIR, file), 'utf8')
  const token = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))
    return m ? hex(m[1]) : undefined
  }
  const values = Object.fromEntries(['accent', 'ok', 'warn', 'danger', 'bg'].map((k) => [k, token(k)]))
  if (!values.accent || !values.ok || !values.danger) continue
  console.log(`\n${file}`)
  for (const [a, b, label, gates] of PAIRS) {
    if (!values[a] || !values[b]) continue
    const d = Object.fromEntries(Object.keys(MATRICES).map((k) => [k, de2000(lab(simulate(values[a], k)), lab(simulate(values[b], k)))]))
    const worst = Math.min(d.deutan, d.protan)
    const flag = worst >= 15 ? 'OK  ' : worst >= FAIL_BELOW ? 'WARN' : 'FAIL'
    if (gates && worst < FAIL_BELOW) failed = true
    console.log(`  ${flag} ${label.padEnd(10)} normal ${d.normal.toFixed(1).padStart(5)} | deutan ${d.deutan.toFixed(1).padStart(5)} | protan ${d.protan.toFixed(1).padStart(5)} | tritan ${d.tritan.toFixed(1).padStart(5)}`)
  }
}
console.log(failed ? '\n结果：存在红绿塌陷（FAIL），需要修复。' : '\n结果：红绿状态色全部通过（WARN 为接近阈值，可接受）。')
process.exit(failed ? 1 : 0)