import { AwsClient } from 'aws4fetch'

const r2 = new AwsClient({
  accessKeyId:     import.meta.env.VITE_R2_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.VITE_R2_SECRET_ACCESS_KEY,
  service: 's3',
  region:  'auto',
})

const ENDPOINT = `https://${import.meta.env.VITE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
const BUCKET   = import.meta.env.VITE_R2_BUCKET
const PUBLIC   = import.meta.env.VITE_R2_PUBLIC_URL

export async function uploadToR2(path, blob) {
  const url = `${ENDPOINT}/${BUCKET}/${path}`
  const res = await r2.fetch(url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
  })
  if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`)
  return `${PUBLIC}/${path}`
}
