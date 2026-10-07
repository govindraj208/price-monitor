'use client'
import { useQuery } from '@tanstack/react-query'
import { fetchJobs, fetchHealth } from '../lib/api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { CheckCircle2, Clock, AlertCircle, Activity, Zap } from 'lucide-react'
import Link from 'next/link'

const STATUS_COLOR: Record<string, string> = {
  done: '#10b981',
  running: '#3b82f6',
  error: '#ef4444',
  queued: '#94a3b8',
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: any; color: string }) {
  return (
    <div className="card flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center`} style={{ backgroundColor: `${color}1a` }}>
        <Icon size={22} style={{ color }} />
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { data: jobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: fetchJobs,
    refetchInterval: 8000,
  })
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 15000,
  })

  const done    = jobs.filter(j => j.status === 'done').length
  const running = jobs.filter(j => j.status === 'running' || j.status === 'queued').length
  const errors  = jobs.filter(j => j.status === 'error').length

  // Last 7 jobs for chart
  const chartData = jobs.slice(0, 7).reverse().map(j => ({
    name: new Date(j.startedAt).toLocaleDateString('en-AE', { month: 'short', day: 'numeric' }),
    rows: j.progress.processed || 0,
    status: j.status,
  }))

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Price Monitor Dashboard</h1>
          <p className="text-slate-500 mt-0.5">OurShopee vs Amazon.ae & Noon</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full ${health?.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className="text-slate-600">{health?.status === 'ok' ? 'Backend online' : 'Backend offline'}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Jobs" value={jobs.length} icon={Activity} color="#0ea5e9" />
        <StatCard label="Completed" value={done} icon={CheckCircle2} color="#10b981" />
        <StatCard label="Active" value={running} icon={Clock} color="#3b82f6" />
        <StatCard label="Errors" value={errors} icon={AlertCircle} color="#ef4444" />
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="card">
          <h2 className="text-base font-semibold text-slate-800 mb-4">Products Processed (Last 7 Runs)</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} barSize={28}>
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [`${v} products`, 'Processed']} />
              <Bar dataKey="rows" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={STATUS_COLOR[entry.status] || '#94a3b8'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent jobs */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-800">Recent Jobs</h2>
          <Link href="/jobs" className="text-sm text-brand-600 hover:underline">View all →</Link>
        </div>

        {jobsLoading ? (
          <p className="text-slate-400 text-sm py-6 text-center">Loading…</p>
        ) : jobs.length === 0 ? (
          <div className="text-center py-10">
            <Zap size={36} className="mx-auto text-slate-300 mb-3" />
            <p className="text-slate-500 text-sm">No jobs yet.</p>
            <Link href="/run" className="btn-primary mt-4 text-sm">Run your first job →</Link>
          </div>
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-5 py-2.5 text-slate-400 font-medium">Job ID</th>
                  <th className="text-left px-5 py-2.5 text-slate-400 font-medium">Status</th>
                  <th className="text-left px-5 py-2.5 text-slate-400 font-medium">Progress</th>
                  <th className="text-left px-5 py-2.5 text-slate-400 font-medium">Started</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 5).map(job => (
                  <tr key={job.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 font-mono text-xs text-slate-600">{job.id.slice(0, 8)}</td>
                    <td className="px-5 py-3">
                      <span className={`badge-${job.status}`}>{job.status}</span>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {job.progress.total
                        ? `${job.progress.processed} / ${job.progress.total}`
                        : job.progress.processed || '–'}
                    </td>
                    <td className="px-5 py-3 text-slate-400 text-xs">
                      {new Date(job.startedAt).toLocaleString('en-AE')}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link href={`/jobs/${job.id}`} className="text-brand-600 hover:underline text-xs">View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
