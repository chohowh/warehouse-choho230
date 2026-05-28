import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { getCycleDate } from '../utils/cycleDate'

export default function Picking() {
  const [trucks, setTrucks] = useState([])
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
      .order('Scan_Time', { ascending: true })
    setTrucks(data || [])
  }

  async function handlePrint(truck, type) {
    const status = type === 'picking' ? 'printed_picking' : 'printed_summary'
    await supabase
      .from('trucks')
      .update({ Status: status })
      .eq('ID', truck.ID)
    setMessage(`✅ ปริ้น${type === 'picking' ? 'ใบเบิกสินค้า' : 'ใบสรุปจ่าย'}สำเร็จ`)
    fetchTrucks()
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <button onClick={() => navigate('/')} className="mb-4 text-blue-500">← กลับ</button>
      <h1 className="text-2xl font-bold text-center mb-6">✅ Picking</h1>
      {message && <div className="text-center font-semibold text-green-600 mb-4">{message}</div>}
      <div className="space-y-3">
        {trucks.map(truck => (
          <div key={truck.ID} className="bg-white rounded-xl p-4 shadow">
            <div className="font-bold text-lg">{truck.Truck_Plate}</div>
            <div className="text-gray-500 text-sm">{truck.Truck_Type}</div>
            <div className="text-sm mt-1">ลาน: {truck.Loading_Bay || '-'}</div>
            <div className="text-sm">สถานะ: <span className="font-semibold">{truck.Status}</span></div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => handlePrint(truck, 'picking')}
                className="flex-1 bg-yellow-500 text-white p-2 rounded-lg text-sm font-bold"
              >
                🖨️ ใบเบิกสินค้า
              </button>
              <button
                onClick={() => handlePrint(truck, 'summary')}
                className="flex-1 bg-orange-500 text-white p-2 rounded-lg text-sm font-bold"
              >
                🖨️ ใบสรุปจ่าย
              </button>
            </div>
          </div>
        ))}
        {trucks.length === 0 && <div className="text-center text-gray-400">ยังไม่มีรถวันนี้</div>}
      </div>
    </div>
  )
}
