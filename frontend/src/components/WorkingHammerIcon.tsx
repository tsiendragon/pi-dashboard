/**
 * Animated "working" status glyph — a hammer repeatedly striking a nail.
 * Rendered at 1em so it slots in wherever the plain 🔨 emoji used to sit
 * (chat sidebar rows, live-session sidebar rows, subagent chips, gallery
 * cards). Falls back to the static contact pose under
 * `prefers-reduced-motion` (see index.css).
 */
export default function WorkingHammerIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`working-hammer ${className}`.trim()}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-testid="working-hammer"
    >
      {/* Whole glyph is nudged down inside its box and, in the two-line row
          variant, re-centred horizontally — see `.working-hammer` rules in
          index.css. The nail and head are sized to survive small sizes. */}
      <g>
        {/* nail — jolts down at the moment of impact */}
        <g className="working-hammer-nail" fill="currentColor" opacity=".7">
          <rect x="7" y="6.4" width="2" height="1.1" rx=".25" />
          <path d="M7.45 7.5h1.1v4.5L8 13.3l-.55-1.3z" />
        </g>
        {/* hammer head + handle — swings around the grip pivot */}
        <g className="working-hammer-hit">
          <line x1="8.2" y1="5.6" x2="13.1" y2="13.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <rect x="5.7" y="3.9" width="4.6" height="2.3" rx=".5" fill="currentColor" />
        </g>
      </g>
    </svg>
  )
}