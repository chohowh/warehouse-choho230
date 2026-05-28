import express from 'express';
import { readFileSync } from 'fs';

const NODE_ENV = process.env.NODE_ENV || 'development';

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

// Load env files: .env.[mode] → .env (same priority as Vite)
loadEnvFile(`.env.${NODE_ENV}`);
loadEnvFile('.env');

const app = express();
app.use(express.json({ limit: '25mb' }));

// Serve React build
app.use(express.static('dist'));

// SPA fallback
app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(new URL('./dist/index.html', import.meta.url).pathname);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`[${NODE_ENV}] http://localhost:${PORT}`));
