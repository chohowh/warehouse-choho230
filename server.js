import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { uploadBase64ToR2 } from './server/r2Upload.js';

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

loadEnvFile(`.env.${NODE_ENV}`);
loadEnvFile('.env');

const app = express();
app.use(express.json({ limit: '25mb' }));

app.post('/api/upload-photo', async (req, res) => {
  try {
    const { path, dataBase64, contentType } = req.body || {};
    const url = await uploadBase64ToR2(path, dataBase64, contentType);
    res.status(200).json({ url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use(express.static('dist'));

app.get(/^(?!\/api).*$/, (req, res) => {
  res.sendFile(fileURLToPath(new URL('./dist/index.html', import.meta.url)));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`[${NODE_ENV}] http://localhost:${PORT}`));
