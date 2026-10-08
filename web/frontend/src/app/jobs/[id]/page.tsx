'use client'
import { useQuery } from '@tanstack/react-query'
import { fetchJob, resultDownloadUrl } from '../../../lib/api'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { Download, ArrowLeft, CheckCircle2, AlertCircle, Loader2, Clock } from 'lucide-react'
import { clsx } from 'clsx'

function ProgressBar({ processed, total }: { processed: number; total: number }) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-slate-600">{processed} / {total} products</span>
        <span className="font-semibold text-slate-800">{pct}%</span>
      </div>
      <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-500 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const logRef = useRef<HTMLDivElement>(null)
  const [filterText, setFilterText] = useState('')

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', id],
    queryFn: () => fetchJob(id),
    refetchInterval: (data) => {
      const status = (data as any)?.status
      return status === 'done' || status === 'error' ? false : 2000
    },
  })

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [job?.logs])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Loader2 size={24} className="animate-spin mr-2" />
        Loading job…
      </div>
    )
  }

  if (!job) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Job not found.</p>
        <Link href="/jobs" className="btn-secondary mt-4">← Back to jobs</Link>
      </div>
    )
  }

  const isDone    = job.status === 'done'
  const isRunning = job.status === 'running'
  const isError   = job.status === 'error'
  const isQueued  = job.status === 'queued'

  const statusConfig = {
    done:    { icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    running: { icon: Loader2,      color: 'text-blue-600',    bg: 'bg-blue-50' },
    error:   { icon: AlertCircle,  color: 'text-red-600',     bg: 'bg-red-50' },
    queued:  { icon: Clock,        color: 'text-slate-500',   bg: 'bg-slate-50' },
  }
  const sc = statusConfig[job.status] || statusConfig.queued
  const StatusIcon = sc.icon

  const records = job.records || []
  const filteredRecords = records.filter(r => {
    if (!filterText) return true
    const q = filterText.toLowerCase()
    return (
      (r['Product Title'] || '').toLowerCase().includes(q) ||
      (r.SKU || '').toLowerCase().includes(q) ||
      (r.Section || '').toLowerCase().includes(q)
    )
  })

  // Helper to format prices and check price comparisons
  const parseNum = (v: any) => {
    if (v === '' || v === null || v === undefined) return null
    const n = parseFloat(String(v).replace(/,/g, ''))
    return isNaN(n) || n <= 0 ? null : n
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Back */}
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
        <ArrowLeft size={14} />
        Job history
      </Link>

      {/* Status card */}
      <div className={clsx('card flex items-start justify-between gap-4', sc.bg)}>
        <div className="flex items-start gap-4">
          <div className={clsx('mt-0.5', sc.color)}>
            <StatusIcon size={24} className={isRunning ? 'animate-spin' : ''} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-lg font-bold text-slate-900">Job {id.slice(0, 8)}</h1>
              <span className={`badge-${job.status}`}>{job.status}</span>
            </div>
            <p className="text-xs text-slate-400">
              Started {new Date(job.startedAt).toLocaleString('en-AE')}
              {job.finishedAt && ` · Finished ${new Date(job.finishedAt).toLocaleString('en-AE')}`}
            </p>
            {isError && job.error && (
              <p className="text-red-700 text-sm mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {job.error}
              </p>
            )}
          </div>
        </div>

        {isDone && (
          <a
            href={resultDownloadUrl(id)}
            download
            className="btn-primary shrink-0"
          >
            <Download size={16} />
            Download Result CSV
          </a>
        )}
      </div>

      {/* Progress */}
      {job.progress.total > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Progress</h2>
          <ProgressBar processed={job.progress.processed} total={job.progress.total} />
          {job.progress.current && isRunning && (
            <p className="text-xs text-slate-400 mt-2 truncate">{job.progress.current}</p>
          )}
        </div>
      )}

      {/* Price Comparison Table */}
      {records.length > 0 && (
        <div className="card space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Price Comparison Results</h2>
              <p className="text-xs text-slate-500">
                Showing {filteredRecords.length} of {records.length} products
              </p>
            </div>
            <input
              type="text"
              placeholder="Filter by title, SKU, or section..."
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-xs w-full sm:w-64 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="overflow-x-auto -mx-5 border-t border-slate-100">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">SKU / Section</th>
                  <th className="px-4 py-3">Product Title</th>
                  <th className="px-4 py-3 text-right">OurShopee</th>
                  <th className="px-4 py-3 text-right">Amazon.ae</th>
                  <th className="px-4 py-3 text-right">Noon.com</th>
                  <th className="px-4 py-3 text-right">Best Competitor</th>
                  <th className="px-4 py-3 text-right">Difference</th>
                  <th className="px-4 py-3 text-center">Links</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRecords.map((r, i) => {
                  const ourPrice = parseNum(r['OurShopee Price'])
                  const amzPrice = parseNum(r['Amazon Price'])
                  const noonPrice = parseNum(r['Noon Price'])
                  const compPrices = [amzPrice, noonPrice].filter(p => p !== null) as number[]
                  const bestComp = compPrices.length > 0 ? Math.min(...compPrices) : null

                  // Highlighting rules (strictly ignoring 0 or empty):
                  // If our price is greater than best competitor -> HIGHLIGHT RED
                  // If our price is cheaper than or equal to competitor -> HIGHLIGHT GREEN
                  const isMoreExpensive = ourPrice !== null && bestComp !== null && ourPrice > bestComp
                  const isCheaperOrEqual = ourPrice !== null && bestComp !== null && ourPrice <= bestComp

                  return (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold text-slate-800">{r.SKU || '–'}</span>
                        {r.Section && <span className="block text-slate-400 text-[10px]">{r.Section}</span>}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <p className="font-medium text-slate-800 line-clamp-2 leading-snug">
                          {r['Product Title']}
                        </p>
                      </td>

                      {/* OurShopee Price (Color coded) */}
                      <td className="px-4 py-3 text-right">
                        {ourPrice !== null ? (
                          <span
                            className={clsx(
                              'inline-block font-bold px-2 py-0.5 rounded',
                              isMoreExpensive
                                ? 'bg-red-100 text-red-700 font-bold border border-red-200'
                                : isCheaperOrEqual
                                ? 'bg-emerald-100 text-emerald-800 font-bold border border-emerald-200'
                                : 'text-slate-800'
                            )}
                          >
                            AED {ourPrice.toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Amazon Price */}
                      <td className="px-4 py-3 text-right">
                        {amzPrice !== null ? (
                          <span className="text-slate-800 font-medium">AED {amzPrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Noon Price */}
                      <td className="px-4 py-3 text-right">
                        {noonPrice !== null ? (
                          <span className="text-slate-800 font-medium">AED {noonPrice.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Best Competitor Price */}
                      <td className="px-4 py-3 text-right font-semibold">
                        {bestComp !== null ? (
                          <span className="text-slate-900">AED {bestComp.toFixed(2)}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Price Difference */}
                      <td className="px-4 py-3 text-right">
                        {ourPrice !== null && bestComp !== null ? (
                          <span
                            className={clsx(
                              'font-bold px-1.5 py-0.5 rounded text-[11px]',
                              isMoreExpensive ? 'text-red-700 bg-red-50' : 'text-emerald-700 bg-emerald-50'
                            )}
                          >
                            {ourPrice > bestComp ? `+${(ourPrice - bestComp).toFixed(2)}` : (ourPrice - bestComp).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Clickable Links */}
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {r['OurShopee Link'] ? (
                            <a
                              href={r['OurShopee Link']}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View on OurShopee"
                              className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-[10px] font-medium"
                            >
                              OurShopee
                            </a>
                          ) : null}
                          {r['Amazon Link'] ? (
                            <a
                              href={r['Amazon Link']}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View on Amazon.ae"
                              className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 hover:bg-amber-100 text-[10px] font-medium"
                            >
                              Amazon
                            </a>
                          ) : null}
                          {r['Noon Link'] ? (
                            <a
                              href={r['Noon Link']}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="View on Noon.com"
                              className="px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-800 hover:bg-yellow-100 text-[10px] font-medium"
                            >
                              Noon
                            </a>
                          ) : null}
                          {!r['OurShopee Link'] && !r['Amazon Link'] && !r['Noon Link'] && (
                            <span className="text-slate-300 text-[10px]">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Live Log */}
      {job.logs && job.logs.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            Live Terminal Log
            {isRunning && <span className="ml-2 badge-running animate-pulse">live</span>}
          </h2>
          <div
            ref={logRef}
            className="bg-slate-900 text-slate-200 text-xs font-mono rounded-lg p-4 h-56 overflow-y-auto leading-relaxed"
          >
            {job.logs.map((line, i) => (
              <div
                key={i}
                className={clsx(
                  line.includes('ERROR') || line.includes('FATAL') ? 'text-red-400' :
                  line.includes('Done') || line.includes('Finished') ? 'text-emerald-400' :
                  line.includes('[Gemini AI]') ? 'text-yellow-300' : ''
                )}
              >
                {line}
              </div>
            ))}
            {isRunning && <span className="animate-pulse">█</span>}
          </div>
        </div>
      )}
    </div>
  )
}
