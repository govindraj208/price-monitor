'use client'
import { useState } from 'react'
import { searchProducts } from '../../lib/api'
import { Search, Loader2, ExternalLink, AlertCircle } from 'lucide-react'

const AED = (v: number | null) =>
  v != null ? `AED ${v.toFixed(2)}` : '—'

const SITES = ['all', 'amazon', 'noon', 'ourshopee']

type Candidate = { title: string; price: number | null; priceRaw: string; url: string; id: string }

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [site, setSite] = useState('all')
  const [limit, setLimit] = useState(5)
  const [results, setResults] = useState<Record<string, Candidate[] | { error: string }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const data = await searchProducts({ q: query, site, limit })
      setResults(data as any)
    } catch (err: any) {
      setError(err.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Product Search</h1>
        <p className="text-slate-500 mt-0.5">Look up a product by title or SKU across all three sites.</p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSearch} className="card space-y-4">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder='e.g. "Apple iPhone 15 Pro 256GB" or SKU PQ4055'
              className="w-full border border-slate-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <button type="submit" disabled={loading} className="btn-primary px-5">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Search
          </button>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-slate-600">Site:</span>
            {SITES.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSite(s)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  site === s
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {s === 'all' ? 'All sites' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Results per site:
            <select
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
              className="border border-slate-200 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {[3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-5">
          {Object.entries(results).map(([siteName, data]) => {
            const isError = !Array.isArray(data)
            const candidates = isError ? [] : (data as Candidate[])

            return (
              <div key={siteName} className="card">
                <h2 className="font-semibold text-slate-800 mb-4 capitalize flex items-center gap-2">
                  {siteName}
                  <span className="badge bg-slate-100 text-slate-500">{candidates.length} results</span>
                </h2>
                {isError ? (
                  <p className="text-red-500 text-sm">{(data as any).error}</p>
                ) : candidates.length === 0 ? (
                  <p className="text-slate-400 text-sm">No results found.</p>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {candidates.map((c, i) => (
                      <div key={i} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                        <span className="text-slate-300 font-mono text-xs mt-0.5 w-4 shrink-0">{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-800 leading-snug line-clamp-2">{c.title}</p>
                          <div className="flex items-center gap-3 mt-1">
                            {c.id && (
                              <span className="text-xs text-slate-400 font-mono">{c.id}</span>
                            )}
                            <span className="text-xs text-slate-400">{c.priceRaw || AED(c.price)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-sm font-semibold text-slate-900 whitespace-nowrap">
                            {AED(c.price)}
                          </span>
                          {c.url && (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-brand-600 hover:text-brand-800 transition-colors"
                            >
                              <ExternalLink size={14} />
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
