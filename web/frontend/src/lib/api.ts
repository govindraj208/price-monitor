import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

export const api = axios.create({ baseURL: API_URL })

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface JobProgress {
  processed: number
  total: number
  current: string
}

export interface ProductRecord {
  Section?: string
  SKU?: string
  'Product Title'?: string
  'OurShopee Price'?: string | number
  'Noon Price'?: string | number
  'Amazon Price'?: string | number
  'Best Competitor Price'?: string | number
  'Price Difference'?: string | number
  'OurShopee Link'?: string
  'Noon Link'?: string
  'Amazon Link'?: string
  'Amazon ASIN'?: string
  'Noon Product ID'?: string
  'Amazon Matched Title'?: string
  'Noon Matched Title'?: string
  'Amazon Confidence'?: string
  'Noon Confidence'?: string
  'Amazon Score'?: string | number
  'Noon Score'?: string | number
  'Price Flag'?: string
  Status?: string
}

export interface Job {
  id: string
  status: JobStatus
  progress: JobProgress
  startedAt: string
  finishedAt: string | null
  error: string | null
  logs?: string[]
  records?: ProductRecord[]
}

export interface SearchResult {
  title: string
  price: number | null
  priceRaw: string
  url: string
  id: string
  image?: string
}

// Upload CSV and start a job
export async function startJob(params: {
  file: File
  limit?: number
  headless?: boolean
  skus?: string
  exact?: boolean
}): Promise<{ jobId: string; status: string }> {
  const form = new FormData()
  form.append('file', params.file)
  if (params.limit) form.append('limit', String(params.limit))
  form.append('headless', String(params.headless ?? true))
  if (params.skus) form.append('skus', params.skus)
  if (params.exact) form.append('exact', 'true')

  const { data } = await api.post('/api/jobs', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}

// Poll job status
export async function fetchJob(jobId: string): Promise<Job> {
  const { data } = await api.get(`/api/jobs/${jobId}`)
  return data
}

// List jobs
export async function fetchJobs(): Promise<Job[]> {
  const { data } = await api.get('/api/jobs')
  return data
}

// Download result CSV (returns a blob URL)
export function resultDownloadUrl(jobId: string): string {
  return `${API_URL}/api/jobs/${jobId}/result`
}

// Quick search
export async function searchProducts(params: {
  q: string
  site?: string
  limit?: number
}): Promise<Record<string, SearchResult[] | { error: string }>> {
  const { data } = await api.get('/api/search', {
    params: { q: params.q, site: params.site ?? 'all', limit: params.limit ?? 5 },
  })
  return data
}

// Health check
export async function fetchHealth(): Promise<{ status: string; uptime: number }> {
  const { data } = await api.get('/api/health')
  return data
}
