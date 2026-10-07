'use client'
import { useQuery } from '@tanstack/react-query'
import { fetchJobs } from '../../lib/api'
import Link from 'next/link'
import { Clock, CheckCircle2, AlertCircle, Loader2, PlayCircle } from 'lucide-react'

function StatusIcon({ status }: { status: string }) {
  if (status === 'done')    return <CheckCircle2 size={16} className="text-emerald-500" />
  if (status === 'error')   return <AlertCircle  size={16} className="text-red-500" />
  if (status === 'running') return <Loader2      size={16} className="text-blue-500 animate-spin" />
  return <Clock size={16} className="text-slate-400" />
}

function duration(startedAt: string, finishedAt: string | null) {
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${secs % 60}s`
}

export default function JobsPage() {
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: fetchJobs,
    refetchInterval: 5000,
  })

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Job History</h1>
          <p className="text-slate-500 mt-0.5">All price monitor runs</p>
        </div>
        <Link href="/run" className="btn-primary">
          <PlayCircle size={16} />
          New Run
        </Link>
      </div>

      <div className="card overflow-x-auto -p-5">
        {isLoading ? (
          <p className="text-center py-12 text-slate-400">Loading…</p>
        ) : jobs.length === 0 ? (
          <div className="text-center py-14">
            <p className="text-slate-400 mb-4">No jobs yet.</p>
            <Link href="/run" className="btn-primary">Start your first run</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Status</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Job ID</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Progress</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Duration</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Started</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => (
                <tr key={job.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={job.status} />
                      <span className={`badge-${job.status}`}>{job.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{job.id.slice(0, 12)}…</td>
                  <td className="px-4 py-3 text-slate-600">
                    {job.progress.total
                      ? `${job.progress.processed} / ${job.progress.total} products`
                      : `${job.progress.processed || 0} products`}
                    {job.status === 'running' && job.progress.current && (
                      <p className="text-xs text-slate-400 truncate max-w-xs mt-0.5">{job.progress.current}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {duration(job.startedAt, job.finishedAt)}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {new Date(job.startedAt).toLocaleString('en-AE')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/jobs/${job.id}`} className="text-brand-600 hover:underline text-xs font-medium">
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
