import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { getCycleDate } from '../utils/cycleDate'

export default function QC() {
  const [trucks, setTrucks] = useState([])
  const [selectedTruck, setSelectedTruck] = useState('')
  const [temperature, setTemperature] = useState('')
  const [loadingBay, setLoadingBay] = useState('')
  const [photo, setPhoto] = useState(null)
  const [message, setMessage] = useState('')
  const [qcRecords, setQcRecords] = useState([])
  const [deletingId, setDeletingId] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetchTrucks()
    fetchQcRecords()
  }, [])

  async function fetchTrucks() {
    const { data } = await supabase
      .from('trucks')
      .select('*')
      .eq('Que_Date', await getCycleDate())
    setTrucks(data || [])
  }

  async function fetchQcRecords() {
    const cycleDate = await getCycleDate() // 'YYYY-MM-DD' ของรอบงาน
    const start = new Date(cycleDate + 'T00:00:00')
    const end = new Date(cycleDate + 'T00:00:00')
    end.setDate(end.getDate() + 2) // ครอบคลุมข้ามคืนถึงเช้า
    const { data } = await supabase
      .from('qc_records')
      .select('*')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false })
    setQcRecords(data || [])
  }

  async function handleSubmit() {
    if (!selectedTruck || !temperature || !loadingBay || !photo) {
      setMessage('กรุณากรอกข้อมูลให้ครบ')
      return
    }
    const fileName = `${Date.now()}_${photo.name}`
    const { error: uploadError } = await supabase.storage
      .from('qc-photos')
      .upload(fileName, photo)
    if (uploadError) {
      setMessage('อัปโหลดรูปไม่สำเร็จ')
      return
    }
    const { data: urlData } = supabase.storage
      .from('qc-photos')
      .getPublicUrl(fileName)
    const { error } = await supabase.from('qc_records').insert({
      truck_plate: selectedTruck,
      temperature: parseFloat(temperature),
      loading_bay: loadingBay,
      photo_url: urlData.publicUrl
    })
    if (error) {
      setMessage('เกิดข้อผิดพลาด กรุณาลองใหม่')
    } else {
      setMessage('✅ บันทึก QC สำเร็จ')
      setSelectedTruck('')
      setTemperature('')
      setLoadingBay('')
      setPhoto(null)
      fetchQcRecords()
    }
  }

  async function handleDelete(record) {
    if (!window.confirm(`ลบข้อมูล QC ของ ${record.truck_plate} (${record.loading_bay})?`)) return
    setDeletingId(record.id)
    const { error } = await supabase.from('qc_records').delete().eq('id', record.id)
    if (error) {
      alert('ลบไม่สำเร็จ กรุณาลองใหม่')
    } else {
      setQcRecords(prev => prev.filter(r => r.id !== record.id))
    }
    setDeletingId(null)
  }

  function formatTime(iso) {
    if (!iso) return ''
    return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <button onClick={() => navigate('/')} className="mb-4 text-blue-500">← กลับ</button>
      <h1 className="text-2xl font-bold text-center mb-6">🌡️ QC ตรวจรถ</h1>
      <div className="bg-white rounded-xl p-4 shadow space-y-4">
        <div>
          <label className="block text-sm font-bold mb-1">เลือกทะเบียนรถ</label>
          <select
            className="w-full border rounded-lg p-2"
            value={selectedTruck}
            onChange={e => setSelectedTruck(e.target.value)}
          >
            <option value="">เลือกรถ</option>
            {trucks.map(truck => (
              <option key={truck.ID} value={truck.Truck_Plate}>
                {truck.Truck_Plate} - {truck.Truck_Type}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">อุณหภูมิ (°C)</label>
          <input
            className="w-full border rounded-lg p-2"
            placeholder="เช่น -18"
            type="number"
            value={temperature}
            onChange={e => setTemperature(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">ลานโหลด</label>
          <select
            className="w-full border rounded-lg p-2"
            value={loadingBay}
            onChange={e => setLoadingBay(e.target.value)}
          >
            <option value="">เลือกลาน</option>
            <option value="ลานชิ้นส่วน">ลานชิ้นส่วน</option>
            <option value="ลานหัวเครื่องใน">ลานหัวเครื่องใน</option>
            <option value="ลานหมูซีก">ลานหมูซีก</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">ถ่ายรูปอุณหภูมิ</label>
          <input
            className="w-full border rounded-lg p-2"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={e => setPhoto(e.target.files[0])}
          />
        </div>
        {message && <div className="text-center font-semibold text-green-600">{message}</div>}
        <button
          onClick={handleSubmit}
          className="w-full bg-purple-500 text-white p-3 rounded-xl font-bold"
        >
          บันทึก QC
        </button>
      </div>

      {qcRecords.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-bold mb-3">รายการ QC วันนี้</h2>
          <div className="space-y-2">
            {qcRecords.map(record => (
              <div key={record.id} className="bg-white rounded-xl p-3 shadow flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm">{record.truck_plate}</div>
                  <div className="text-xs text-gray-500">{record.loading_bay} · {record.temperature}°C · {formatTime(record.created_at)}</div>
                </div>
                <button
                  onClick={() => handleDelete(record)}
                  disabled={deletingId === record.id}
                  className="bg-red-100 text-red-600 text-xs font-bold px-3 py-2 rounded-lg hover:bg-red-200 disabled:opacity-50 whitespace-nowrap"
                >
                  {deletingId === record.id ? '...' : '🗑 ลบ'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
