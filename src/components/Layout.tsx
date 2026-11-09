import { useState } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, ShoppingCart, ShoppingBag, ArrowLeftRight, Package, PackageOpen, Receipt, Settings, LogOut, MoreHorizontal, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import ErrorBoundary from './ErrorBoundary'

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/bundles', icon: ShoppingBag, label: 'Bundles' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/trades', icon: ArrowLeftRight, label: 'Trades' },
  { to: '/breakdowns', icon: PackageOpen, label: 'Breakdowns' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

/**
 * Mobile tab bar holds at most 5 targets (4 primary + "More") — 8 tabs at 375px
 * left ~47px each, which collided labels and pushed Settings off-screen.
 */
const MOBILE_PRIMARY = ['/dashboard', '/sales', '/inventory', '/expenses']
const MOBILE_PRIMARY_NAV = NAV.filter(n => MOBILE_PRIMARY.includes(n.to))
const MOBILE_MORE_NAV = NAV.filter(n => !MOBILE_PRIMARY.includes(n.to))

export default function Layout() {
  const [moreOpen, setMoreOpen] = useState(false)
  const { pathname } = useLocation()
  const moreActive = MOBILE_MORE_NAV.some(n => pathname.startsWith(n.to))

  return (
    <div className="flex h-dvh bg-gray-50 overflow-hidden">
      {/* Sidebar — desktop only */}
      <aside className="hidden md:flex w-52 shrink-0 bg-gray-900 flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="text-white font-semibold text-sm leading-tight">Reseller</div>
          <div className="text-gray-400 text-xs">Dashboard</div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`
              }
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-800">
          <button
            onClick={() => supabase.auth.signOut()}
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-gray-400 hover:text-white hover:bg-gray-800 w-full transition-colors"
          >
            <LogOut size={15} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content — overflow-x clipped as a backstop; pages are built to fit. */}
      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden pb-nav-safe md:pb-0">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>

      {/* "More" sheet — mobile only */}
      {moreOpen && (
        <div className="fixed inset-0 z-30 md:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-xl pb-nav-safe"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-sm font-semibold text-gray-900">More</span>
              <button onClick={() => setMoreOpen(false)} className="p-1.5 -mr-1.5 text-gray-400" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1 px-3 pb-2">
              {MOBILE_MORE_NAV.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    `flex flex-col items-center gap-1 rounded-xl py-3 text-xs ${
                      isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600 active:bg-gray-100'
                    }`
                  }
                >
                  <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </div>
            <div className="border-t border-gray-100 px-3 py-2">
              <button
                onClick={() => supabase.auth.signOut()}
                className="flex items-center gap-2.5 w-full px-3 py-3 rounded-xl text-sm text-gray-600 active:bg-gray-100"
              >
                <LogOut size={16} /> Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom tab bar — mobile only */}
      <nav aria-label="Main navigation" className="fixed bottom-0 inset-x-0 z-30 flex md:hidden bg-white border-t border-gray-200 pb-safe">
        {MOBILE_PRIMARY_NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => setMoreOpen(false)}
            className={({ isActive }) =>
              `flex-1 min-w-0 flex flex-col items-center justify-center pt-2 pb-1 text-[11px] transition-colors ${
                isActive ? 'text-blue-600' : 'text-gray-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={22} strokeWidth={isActive ? 2.5 : 1.75} aria-hidden="true" />
                <span className="mt-0.5 truncate max-w-full">{label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(o => !o)}
          aria-expanded={moreOpen}
          className={`flex-1 min-w-0 flex flex-col items-center justify-center pt-2 pb-1 text-[11px] transition-colors ${
            moreActive || moreOpen ? 'text-blue-600' : 'text-gray-400'
          }`}
        >
          <MoreHorizontal size={22} strokeWidth={moreActive || moreOpen ? 2.5 : 1.75} aria-hidden="true" />
          <span className="mt-0.5">More</span>
        </button>
      </nav>
    </div>
  )
}
