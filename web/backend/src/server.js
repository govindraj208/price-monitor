// Express API server for OurShopee Price Monitor
// Wraps the existing scraper engine and exposes REST endpoints
// for the Next.js frontend hosted on Vercel.
//
// POST /api/jobs        — upload CSV, start a scrape job
// GET  /api/jobs/:id    — poll status + progress
// GET  /api/jobs/:id/result — download result CSV
// GET  /api/search      — quick single-product lookup (diagnose mode)
// GET  /api/health      — liveness probe

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { runJob } = require('./jobRunner');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

app.use(express.json());

// ── File Upload ───────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const RESULTS_DIR = path.join(__dirname, '../results');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.match(/\.csv$/i)) {
      return cb(new Error('Only CSV files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ── In-memory job store ───────────────────────────────────────────────────────
// For production use Redis or a DB; for Railway this is fine.
const jobs = new Map();

function getJob(id) {
  return jobs.get(id) || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Start a scrape job
// Body (multipart): file=<csv>, limit=<number>, headless=<bool>
app.post('/api/jobs', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded' });
  }

  const jobId = uuidv4();
  const inputPath = req.file.path;
  const outputPath = path.join(RESULTS_DIR, `Result_${jobId}.csv`);

  const options = {
    limit: parseInt(req.body.limit, 10) || Infinity,
    headless: req.body.headless !== 'false',
    skus: req.body.skus ? String(req.body.skus).split(',').map(s => s.trim()) : null,
    exact: req.body.exact === 'true',
  };

  const job = {
    id: jobId,
    status: 'queued',   // queued | running | done | error
    progress: { processed: 0, total: 0, current: '' },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputPath,
    logs: [],
    error: null,
  };

  jobs.set(jobId, job);

  // Start job asynchronously — do NOT await
  runJob({ jobId, inputPath, outputPath, options, job }).catch(err => {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });

  res.status(202).json({ jobId, status: 'queued' });
});

// Poll job status
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    // Last 50 log lines for the live log panel
    logs: job.logs.slice(-50),
  });
});

// Download result CSV
app.get('/api/jobs/:id/result', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job not finished yet' });
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'Result file not found' });

  res.download(job.outputPath, `PriceMonitor_Result_${job.id.slice(0, 8)}.csv`);
});

// List recent jobs (last 20)
app.get('/api/jobs', (_req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 20)
    .map(j => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      error: j.error,
    }));
  res.json(list);
});

// Quick single-product diagnose/search
// GET /api/search?q=<title_or_sku>&site=amazon|noon|all&limit=5
app.get('/api/search', async (req, res) => {
  const { q, site = 'all', limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query param ?q=' });

  try {
    const { runSearch } = require('./jobRunner');
    const results = await runSearch({ query: String(q), site: String(site), limit: Number(limit) });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Price Monitor API listening on port ${PORT}`);
});
