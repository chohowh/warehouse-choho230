import { uploadBase64ToR2 } from '../server/r2Upload.js'

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  try {
    const { path, dataBase64, contentType } = req.body || {}
    const url = await uploadBase64ToR2(path, dataBase64, contentType)
    res.status(200).json({ url })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
}
