import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from './src/context-builder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3001);
const API_KEY = String(process.env.API_KEY || '');

let activeContext = '';
let activeMetadata = {
  loaded: false,
  sourceCount: 0,
  characters: 0,
  updatedAt: null,
  urls: []
};

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      success: false,
      error: 'Server API key is not configured. Set API_KEY.'
    });
  }

  const supplied = req.get('x-api-key');
  if (!supplied || !safeEqual(supplied, API_KEY)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'web-context-for-llm' });
});

app.use('/api', requireApiKey);

app.get('/api/status', (req, res) => {
  res.json({ success: true, ...activeMetadata });
});

app.post('/api/context/test', async (req, res) => {
  try {
    const result = await buildContext(req.body?.urls);
    res.json({ success: true, mode: 'test', saved: false, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      details: error.details || undefined
    });
  }
});

app.post('/api/context/load', async (req, res) => {
  try {
    const result = await buildContext(req.body?.urls);
    activeContext = result.context;
    activeMetadata = {
      loaded: true,
      sourceCount: result.sources.filter((source) => source.success).length,
      characters: result.totalCharacters,
      updatedAt: new Date().toISOString(),
      urls: result.sources.filter((source) => source.success).map((source) => source.url)
    };

    res.json({
      success: true,
      mode: 'load',
      saved: true,
      ...activeMetadata,
      sources: result.sources,
      warnings: result.warnings
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      details: error.details || undefined
    });
  }
});

app.get('/api/context', (req, res) => {
  if (!activeMetadata.loaded || !activeContext) {
    return res.status(404).type('text/plain').send('No active context loaded.');
  }

  res.status(200)
    .type('text/plain; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(activeContext);
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Web Context for LLM listening on http://localhost:${PORT}`);
  console.log('Active context is stored only in this Node.js process memory.');
  if (!API_KEY) console.warn('API_KEY is not configured; protected endpoints will reject requests.');
});
