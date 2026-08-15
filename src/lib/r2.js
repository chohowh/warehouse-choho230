// อัปโหลดรูปผ่าน /api/upload-photo (server เป็นคนเซ็น/อัปโหลดไป R2 จริง) — เพราะตัวแปร
// VITE_* ทุกตัวจะถูกฝังลงใน JS ที่ส่งให้ browser เสมอ ถ้าเซ็น request ฝั่ง client เอง
// R2 secret key จะรั่วไปอยู่ในไฟล์ JS สาธารณะ (เคยเป็นแบบนั้นมาก่อน แก้แล้ว)
const blobToBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'))
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
  reader.readAsDataURL(blob)
})

export async function uploadToR2(path, blob) {
  const dataBase64 = await blobToBase64(blob)
  const res = await fetch('/api/upload-photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, dataBase64, contentType: blob.type || 'image/jpeg' }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `อัปโหลดรูปไม่สำเร็จ: ${res.status}`)
  return body.url
}
