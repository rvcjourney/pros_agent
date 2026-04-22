require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const PROSPEO_KEY = process.env.PROSPEO_API_KEY;
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!PROSPEO_KEY || PROSPEO_KEY === 'pk_your_key_here') {
  console.error('FATAL: PROSPEO_API_KEY is not set. Add it to .env');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('FATAL: N8N_WEBHOOK_URL is not set. Add it to .env');
  process.exit(1);
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Block sensitive files from being served as static assets
const BLOCKED = ['/config.json', '/.env', '/.env.example', '/server.js', '/package.json', '/package-lock.json'];
app.use((req, res, next) => {
  if (BLOCKED.includes(req.path)) return res.status(403).end();
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// Health check for Docker / load balancer
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Suggestions: location or job title autocomplete
app.post('/api/search-suggestions', async (req, res) => {
  const { location_search, job_title_search } = req.body;
  if (!location_search && !job_title_search) {
    return res.status(400).json({ error: true, message: 'location_search or job_title_search is required' });
  }

  const body = {};
  if (location_search)  body.location_search  = String(location_search).slice(0, 100);
  if (job_title_search) body.job_title_search = String(job_title_search).slice(0, 100);

  try {
    const upstream = await fetch('https://api.prospeo.io/search-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-KEY': PROSPEO_KEY },
      body: JSON.stringify(body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: true, message: 'Failed to reach Prospeo API' });
  }
});

// Pipe n8n response back — force file download for non-JSON
async function pipeN8nResponse(upstream, res, filename) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const disposition = upstream.headers.get('content-disposition');
  const isJson = contentType.includes('application/json');

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  if (!isJson) {
    res.setHeader('Content-Disposition', disposition || `attachment; filename="${filename}"`);
  }

  const buffer = await upstream.arrayBuffer();
  res.send(Buffer.from(buffer));
}

// Fetch n8n with a timeout to prevent hanging connections
function fetchN8n(body, timeoutMs = 5 * 60 * 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

// Submit: Search Filters → n8n → pipe Excel back
app.post('/api/submit-search', async (req, res) => {
  const { prospeo_payload, meta } = req.body;

  // Server-side limits
  const filters = prospeo_payload?.filters || {};
  const names    = filters.company?.names?.include    || [];
  const websites = filters.company?.websites?.include || [];
  const maxPpl   = filters.max_person_per_company;

  if (names.length > 10)    return res.status(400).json({ ok: false, message: 'Max 10 company names allowed.' });
  if (websites.length > 10) return res.status(400).json({ ok: false, message: 'Max 10 company websites allowed.' });
  if (maxPpl && maxPpl > 2) {
    prospeo_payload.filters.max_person_per_company = 2;
  }
  try {
    const upstream = await fetchN8n({ prospeo_payload, meta });
    await pipeN8nResponse(upstream, res, 'leads.xlsx');
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ ok: false, message: 'n8n timed out after 5 minutes' });
    res.status(502).json({ ok: false, message: 'Failed to reach n8n webhook' });
  }
});

// Submit: LinkedIn Lookup → n8n → pipe Excel back
app.post('/api/submit-linkedin', async (req, res) => {
  const { linkedin_urls, meta } = req.body;
  if (!Array.isArray(linkedin_urls) || linkedin_urls.length === 0) {
    return res.status(400).json({ ok: false, message: 'At least one LinkedIn URL is required.' });
  }
  if (linkedin_urls.length > 5) {
    return res.status(400).json({ ok: false, message: 'Max 5 LinkedIn URLs allowed.' });
  }
  try {
    const upstream = await fetchN8n({ linkedin_urls, meta });
    await pipeN8nResponse(upstream, res, 'linkedin-leads.xlsx');
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ ok: false, message: 'n8n timed out after 5 minutes' });
    res.status(502).json({ ok: false, message: 'Failed to reach n8n webhook' });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down');
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running → http://0.0.0.0:${PORT}`);
});
