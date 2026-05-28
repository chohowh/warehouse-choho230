import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { getCycleDate } from '../utils/cycleDate'

export default function LoadingBay() {
  const [trucks, setTrucks] = useState([])
  const [selectedTruck, setSelectedTruck] = useState('')
  const [photo, setPhoto] = useState(null)
  const [message, setMessage] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetchTrucks()
  }, [])

  async function fetchTrucks() {
    const cycleDate = await getCycleDate()
    const { data } = await supabase
      .from('trucks')
      .select('*')
      .eq('Que_Date', cycleDate)
      .neq('Status', 'done')
    setTrucks(data || [])
  }

  async function handleFinish() {
    if (!selectedTruck || !photo) {
      setMessage('กรุณาเลือกรถและถ่ายรูปก่อน')
      return
    }
    const fileName = `${Date.now()}_${photo.name}`
    const { error: uploadError } = await supabase.storage
      .from('loading-photos')
      .upload(fileName, photo)
    if (uploadError) {
      setMessage('อัปโหลดรูปไม่สำเร็จ')
      return
    }
    const { data: urlData } = supabase.storage
      .from('loading-photos')
      .getPublicUrl(fileName)
    const truck = trucks.find(t => t.Truck_Plate === selectedTruck)
    const { error } = await supabase.from('loading_records').insert({
      truck_plate: selectedTruck,
      loading_bay: truck?.Loading_Bay,
      photo_url: urlData.publicUrl
    })
    if (!error) {
      await supabase
        .from('trucks')
        .update({ Status: 'done' })
        .eq('Truck_Plate', selectedTruck)
      setMessage('✅ บันทึกโหลดเสร็จสำเร็จ')
      setSelectedTruck('')
      setPhoto(null)
      fetchTrucks()
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <button onClick={() => navigate('/')} className="mb-4 text-blue-500">← กลับ</button>
      <h1 className="text-2xl font-bold text-center mb-6">🏗️ ลานโหลด</h1>
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
                {truck.Truck_Plate} - {truck.Loading_Bay || 'ยังไม่กำหนดลาน'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">ถ่ายรูปหลังโหลดเสร็จ</label>
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
          onClick={handleFinish}
          className="w-full bg-orange-500 text-white p-3 rounded-xl font-bold"
        >
          ✅ แจ้งโหลดเสร็จ
        </button>
      </div>
    </div>
  )
}
