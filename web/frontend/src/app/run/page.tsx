'use client'
import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { startJob } from '../../lib/api'
import { Upload, PlayCircle, AlertCircle, FileText, X } from 'lucide-react'
import { clsx } from 'clsx'

export default function RunPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [limit, setLimit] = useState('')
  const [skus, setSkus] = useState('')
  const [headless, setHeadless] = useState(true)
  const [exact, setExact] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = (f: File) => {
    if (!f.name.endsWith('.csv')) {
      setError('Please upload a CSV file.')
      return
    }
    setFile(f)
    setError(null)
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [])

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = () => setDragging(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) { setError('Please select a CSV file'); return }
    setLoading(true)
    setError(null)
    try {
      const { jobId } = await startJob({
        file,
        limit: limit ? Number(limit) : undefined,
        headless,
        skus: skus || undefined,
        exact,
      })
      router.push(`/jobs/${jobId}`)
    } catch (err: any) {
      setError(err.response?.data?.error || err.message)
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Run Price Monitor</h1>
        <p className="text-slate-500 mt-1">Upload your daily dump CSV and start a comparison run.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Drop zone */}
        <div
          className={clsx(
            'card border-2 border-dashed transition-colors cursor-pointer text-center py-10',
            dragging ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-brand-300',
            file && 'border-emerald-300 bg-emerald-50'
          )}
          onClick={() => inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          {file ? (
            <div className="flex items-center justify-center gap-3">
              <FileText size={24} className="text-emerald-600" />
              <div className="text-left">
                <p className="font-medium text-emerald-800">{file.name}</p>
                <p className="text-xs text-emerald-600">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setFile(null) }}
                className="ml-4 text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div>
              <Upload size={32} className="mx-auto text-slate-300 mb-2" />
              <p className="text-slate-600 font-medium">Drop your CSV here or click to browse</p>
              <p className="text-xs text-slate-400 mt-1">Columns: Section, SKU, Product Title, OurShopee Price, Noon Price</p>
            </div>
          )}
        </div>

        {/* Options */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-slate-800">Options</h2>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-slate-600 mb-1 block">Product limit</span>
              <input
                type="number"
                min="1"
                placeholder="All products"
                value={limit}
                onChange={e => setLimit(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </label>

            <label className="block">
              <span className="text-sm text-slate-600 mb-1 block">Filter by SKUs</span>
              <input
                type="text"
                placeholder="PQ4055,PQ4072 (comma-separated)"
                value={skus}
                onChange={e => setSkus(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </label>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={headless}
                onChange={e => setHeadless(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-slate-700">Headless browser (recommended)</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={exact}
                onChange={e => setExact(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-slate-700">Exact columns only</span>
            </label>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <button type="submit" disabled={loading || !file} className="btn-primary w-full justify-center py-3">
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Starting job…
            </>
          ) : (
            <>
              <PlayCircle size={18} />
              Start Price Comparison
            </>
          )}
        </button>
      </form>
    </div>
  )
}
