/**
 * Animated "working" status glyph — a mallet tapping a wooden fish (木鱼),
 * drawn as the side-view silhouette: a domed body with a slit mouth, struck
 * on top by a ball-headed mallet. Every strike squashes the body, flashes a
 * couple of impact ticks and floats a "+1" (功德 +1) upwards.
 *
 * Rendered at 1em so it slots in wherever the status emoji used to sit
 * (chat sidebar rows, live-session sidebar rows, subagent chips, gallery
 * cards). `className` sizes the outer box; the SVG fills it. Falls back to a
 * static pose without the "+1" under `prefers-reduced-motion` (see index.css).
 */
import { useId } from 'react'

export default function MuyuIcon({ className = '' }: { className?: string }) {
  // Several glyphs can be on screen at once — the mask id must be unique.
  const maskId = `muyu-mouth-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <span className={`working-muyu ${className}`.trim()} aria-hidden="true" data-testid="working-muyu">
      <svg viewBox="0 0 16 16" focusable="false">
        <defs>
          {/* The mouth is cut out of the body, so it is transparent on every theme. */}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20">
            <rect x="-2" y="-2" width="20" height="20" fill="#fff" />
            <path d="M.2 9.9H5.4" stroke="#000" strokeWidth=".75" strokeLinecap="round" />
            <circle cx="5.6" cy="9.9" r="1.05" fill="#000" />
          </mask>
        </defs>
        {/* body — squashes against its flat base on impact */}
        <path
          className="working-muyu-body"
          mask={`url(#${maskId})`}
          fill="currentColor"
          d="M1 12.6C.1 12.2 0 10.1.6 9 1.7 7.1 4.1 6.3 7 6.3c3.2 0 5.7 1.7 6.4 4.3.3 1.2-.1 2-.9 2C9 12.6 4 13 1 12.6z"
        />
        {/* impact ticks next to the strike point */}
        <path
          className="working-muyu-tok"
          d="M3.3 5.9 2.3 5.3M3.9 4.6 3.4 3.7"
          stroke="currentColor"
          strokeWidth=".6"
          strokeLinecap="round"
          fill="none"
        />
        {/* mallet — pivots around the end of the handle */}
        <g className="working-muyu-mallet">
          <line x1="6.4" y1="2.6" x2="14.6" y2="6" stroke="currentColor" strokeWidth=".95" strokeLinecap="round" />
          <circle cx="6.3" cy="2.6" r="1.05" fill="currentColor" />
        </g>
      </svg>
      <span className="working-muyu-merit">+1</span>
    </span>
  )
}
