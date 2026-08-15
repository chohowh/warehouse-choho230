import { AwsClient } from 'aws4fetch'

const ALLOWED_PREFIXES = ['qc/', 'sample/', 'loading/']

let r2

function getR2Client() {
  if (!r2) {
    r2 = new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    })
  }
  return r2
}

export async function uploadBase64ToR2(path, dataBase64, contentType) {
  if (!path || !ALLOWED_PREFIXES.some(p => path.startsWith(p))) {
    throw new Error('เส้นทางไฟล์ไม่ถูกต้อง')
  }
  if (!dataBase64) {
    throw new Error('ไม่มีข้อมูลรูปภาพ')
  }

  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const bucket = process.env.R2_BUCKET
  const publicUrl = process.env.R2_PUBLIC_URL
  const url = `${endpoint}/${bucket}/${path}`

  const buffer = Buffer.from(dataBase64, 'base64')
  const res = await getR2Client().fetch(url, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': contentType || 'image/jpeg' },
  })
  if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`)
  return `${publicUrl}/${path}`
}
