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

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', id],
    queryFn: () => fetchJob(id),
    refetchInterval: (data) => {
      const status = (data as any)?.status
      return status === 'done' || status === 'error' ? false : 2000
    },
  })

  // Auto-scroll log to bottom
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

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back */}
      <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
        <ArrowLeft size={14} />
        Job history
      </Link>

      {/* Status card */}
      <div className={clsx('card flex items-start gap-4', sc.bg)}>
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
        {isDone && (
          <a
            href={resultDownloadUrl(id)}
            download
            className="btn-primary shrink-0"
          >
            <Download size={16} />
            Download CSV
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

      {/* Live Log */}
      {job.logs && job.logs.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            Live Log
            {isRunning && <span className="ml-2 badge-running animate-pulse">live</span>}
          </h2>
          <div
            ref={logRef}
            className="bg-slate-900 text-slate-200 text-xs font-mono rounded-lg p-4 h-64 overflow-y-auto leading-relaxed"
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
