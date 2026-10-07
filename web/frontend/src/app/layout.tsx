import type { Metadata } from 'next'
import './globals.css'
import { Providers } from '../components/Providers'
import { Sidebar } from '../components/Sidebar'

export const metadata: Metadata = {
  title: 'OurShopee Price Monitor',
  description: 'Daily Amazon.ae & Noon price comparison dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 min-w-0 p-6 md:p-8">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  )
}
