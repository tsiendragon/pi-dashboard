import { NavLink, useLocation } from 'react-router-dom'
import LiveSessionGalleryPage from './LiveSessionGalleryPage'
import SessionGraphPage from './graph/SessionGraphPage'

/** One entry point, with existing URLs retained for bookmarks and session links. */
export default function SessionOverviewPage() {
  const { pathname, search } = useLocation()
  const isGraph = pathname === '/live-sessions/graph'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-bg px-4 py-3">
        <h1 className="text-sm font-semibold text-text-strong">会话总览</h1>
        <nav aria-label="会话视图" className="flex flex-wrap gap-1">
          {[
            { path: '/live-sessions/gallery', label: '会话卡片' },
            { path: '/live-sessions/graph', label: '家族图谱' },
          ].map(view => (
            <NavLink
              key={view.path}
              to={view.path + search}
              className={({ isActive }) => 
                'rounded px-3 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
                (isActive ? 'bg-accent-subtle text-accent' : 'text-muted hover:bg-card hover:text-text-strong')
              }
            >
              {view.label}
            </NavLink>
          ))}
        </nav>
      </header>
      {isGraph ? <SessionGraphPage /> : <LiveSessionGalleryPage />}
    </div>
  )
}
