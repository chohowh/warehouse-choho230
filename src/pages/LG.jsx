import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'
import { getCycleDate } from '../utils/cycleDate'

export default function LG() {
  const [trucks, setTrucks] = useState([])
  const [selectedTruck, setSelectedTruck] = useState('')
  const [loadingBay, setLoadingBay] = useState('')
  const [message, setMessage] = useState('')
  const [manualPlate, setManualPlate] = useState('')
  const [manualType, setManualType] = useState('')
  const [manualMessage, setManualMessage] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetchTrucks()
  }, [])

  async function fetchTrucks() {
    const cycleDate = await getCycleDate()
    const { data } = await supabase
      .from('trucks')
      .select('*')
      .eq('Status', 'waiting')
      .eq('Que_Date', cycleDate)
    setTrucks(data || [])
  }

  async function handleManualAdd() {
    if (!manualPlate || !manualType) {
      setManualMessage('กรุณากรอกข้อมูลให้ครบ')
      return
    }
    const cycleDate = await getCycleDate()
    const { error } = await supabase.from('trucks').insert({
      Truck_Plate: manualPlate.trim(),
      Truck_Type: manualType,
      Status: 'waiting',
      Que_Date: cycleDate
    })
    if (error) {
      setManualMessage('เกิดข้อผิดพลาด: ' + error.message)
    } else {
      setManualMessage('✅ เพิ่มรถสำเร็จ')
      setManualPlate('')
      setManualType('')
      fetchTrucks()
    }
  }

  async function handleAssign() {
    if (!selectedTruck || !loadingBay) {
      setMessage('กรุณาเลือกข้อมูลให้ครบ')
      return
    }
    const { error } = await supabase
      .from('trucks')
      .update({ Loading_Bay: loadingBay, Status: 'assigned' })
      .eq('Truck_Plate', selectedTruck)
    if (error) {
      setMessage('เกิดข้อผิดพลาด กรุณาลองใหม่')
    } else {
      setMessage('✅ กำหนดลานโหลดสำเร็จ')
      setSelectedTruck('')
      setLoadingBay('')
      fetchTrucks()
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <button onClick={() => navigate('/')} className="mb-4 text-blue-500">← กลับ</button>
      <h1 className="text-2xl font-bold text-center mb-6">📋 LG จัดคิวรถ</h1>
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
          <label className="block text-sm font-bold mb-1">กำหนดลานโหลด</label>
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
        {message && <div className="text-center font-semibold text-green-600">{message}</div>}
        <button
          onClick={handleAssign}
          className="w-full bg-green-500 text-white p-3 rounded-xl font-bold"
        >
          ยืนยันการจัดคิว
        </button>
      </div>
      <div className="bg-white rounded-xl p-4 shadow space-y-4 mt-6">
        <h2 className="text-lg font-bold text-gray-700">🚛 คิวรถวันนี้</h2>
        {trucks.length === 0 ? (
          <p className="text-center text-gray-400">ยังไม่มีรถในคิว</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b">
                <th className="text-left py-1 pr-3">วันที่</th>
                <th className="text-left py-1 pr-3">ทะเบียนรถ</th>
                <th className="text-left py-1">ประเภทรถ</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {trucks.map(truck => (
                <tr key={truck.ID}>
                  <td className="py-2 pr-3 text-gray-500">{truck.Que_Date}</td>
                  <td className="py-2 pr-3 font-semibold">{truck.Truck_Plate}</td>
                  <td className="py-2 text-gray-500">{truck.Truck_Type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <hr />
        <p className="text-sm font-bold text-gray-600">➕ เพิ่มรถ Manual</p>
        <div>
          <label className="block text-sm font-bold mb-1">ทะเบียนรถ</label>
          <input
            className="w-full border rounded-lg p-2"
            placeholder="เช่น กข-1234"
            value={manualPlate}
            onChange={e => setManualPlate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-bold mb-1">ประเภทรถ</label>
          <select
            className="w-full border rounded-lg p-2"
            value={manualType}
            onChange={e => setManualType(e.target.value)}
          >
            <option value="">เลือกประเภทรถ</option>
            <option value="รถเย็น">รถเย็น</option>
            <option value="รถทั่วไป">รถทั่วไป</option>
            <option value="รถพ่วง">รถพ่วง</option>
          </select>
        </div>
        {manualMessage && <div className="text-center font-semibold text-green-600">{manualMessage}</div>}
        <button
          onClick={handleManualAdd}
          className="w-full bg-blue-500 text-white p-3 rounded-xl font-bold"
        >
          เพิ่มรถเข้าคิว
        </button>
      </div>
    </div>
  )
}
