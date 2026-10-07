'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  PlayCircle,
  Search,
  History,
  Settings,
  ShoppingCart,
} from 'lucide-react'
import { clsx } from 'clsx'

const nav = [
  { href: '/',         label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/run',      label: 'Run Monitor',  icon: PlayCircle },
  { href: '/jobs',     label: 'Job History',  icon: History },
  { href: '/search',   label: 'Product Search', icon: Search },
]

export function Sidebar() {
  const path = usePathname()

  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 min-h-screen bg-white border-r border-slate-200">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-slate-200">
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center text-white">
          <ShoppingCart size={16} />
        </div>
        <div>
          <p className="text-sm font-bold text-slate-900 leading-tight">Price Monitor</p>
          <p className="text-xs text-slate-400">OurShopee</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = path === href || (href !== '/' && path.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                active
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              <Icon size={18} className={active ? 'text-brand-600' : 'text-slate-400'} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-slate-200">
        <p className="text-xs text-slate-400">Amazon.ae · Noon · OurShopee</p>
      </div>
    </aside>
  )
}
