import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { getCycleDate } from '../utils/cycleDate'

export default function Driver() {
  const [truckPlate, setTruckPlate] = useState('')
  const [truckType, setTruckType] = useState('')
  const [message, setMessage] = useState('')
  const navigate = useNavigate()

  async function handleScan() {
    if (!truckPlate || !truckType) {
      setMessage('กรุณากรอกข้อมูลให้ครบ')
      return
    }
    const cycleDate = await getCycleDate()
    const { error } = await supabase.from('trucks').insert({
      Truck_Plate: truckPlate,
      Truck_Type: truckType,
      Status: 'waiting',
      Que_Date: cycleDate
    })
    if (error) {
      setMessage('Error: ' + error.message)
    } else {
      setMessage('✅ สแกนเข้าโรงงานสำเร็จ')
      setTruckPlate('')
      setTruckType('')
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <button onClick={() => navigate('/')} className="mb-4 text-blue-500">← กลับ</button>
      <h1 className="text-2xl font-bold text-center mb-6">🚛 สแกนรถเข้าโรงงาน</h1>
      <div className="bg-white rounded-xl p-4 shadow space-y-4">
        <div>
          <label className="block text-sm font-bold mb-1">ทะเบียนรถ</label>
          <input
            className="w-full border rounded-lg p-2"
            placeholder="เช่น 1234"
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            value={truckPlate}
            onChange={e => setTruckPlate(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">ประเภทรถ</label>
          <select
            className="w-full border rounded-lg p-2"
            value={truckType}
            onChange={e => setTruckType(e.target.value)}
          >
            <option value="">เลือกประเภทรถ</option>
            <option value="รถเย็น">รถเย็น</option>
            <option value="รถทั่วไป">รถทั่วไป</option>
            <option value="รถพ่วง">รถพ่วง</option>
          </select>
        </div>
        {message && <div className="text-center font-semibold text-green-600">{message}</div>}
        <button
          onClick={handleScan}
          className="w-full bg-blue-500 text-white p-3 rounded-xl font-bold"
        >
          สแกนเข้าโรงงาน
        </button>
      </div>
    </div>
  )
}
