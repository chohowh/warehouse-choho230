import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useNavigate } from 'react-router-dom'

export default function Dashboard() {
  const [trucks, setTrucks] = useState([])
  const [search, setSearch] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetchTrucks()
    const subscription = supabase
      .channel('trucks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trucks' }, fetchTrucks)
      .subscribe()
    return () => supabase.removeChannel(subscription)
  }, [])

  async function fetchTrucks() {
    const { data } = await supabase
      .from('trucks')
      .select('*')
      .order('Scan_Time', { ascending: false })
    setTrucks(data || [])
  }

  const filtered = search.trim()
    ? trucks.filter(t => t.Truck_Plate?.toLowerCase().includes(search.trim().toLowerCase()))
    : trucks

  return (
    <div className="min-h-screen bg-gray-100 p-4 xl:p-10 2xl:p-14">
      <h1 className="text-2xl xl:text-5xl 2xl:text-6xl font-bold text-center mb-6 xl:mb-10">🏭 Warehouse Phraputthabath</h1>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4 xl:gap-6 mb-6 xl:mb-10">
        <button onClick={() => navigate('/driver')} className="bg-blue-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">🚛 คนขับ</button>
        <button onClick={() => navigate('/lg')} className="bg-green-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">📋 LG</button>
        <button onClick={() => navigate('/picking')} className="bg-yellow-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">✅ Picking</button>
        <button onClick={() => navigate('/qc')} className="bg-purple-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">🌡️ QC</button>
        <button onClick={() => navigate('/loading-bay')} className="bg-orange-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">🏗️ ลานโหลด</button>
        <button onClick={() => navigate('/planner')} className="bg-red-500 text-white p-4 xl:p-8 rounded-xl text-center font-bold text-base xl:text-2xl 2xl:text-3xl">📊 วางแผน</button>
      </div>
      <div className="mb-4 xl:mb-6">
        <input
          type="text"
          placeholder="🔍 ค้นหาทะเบียนรถ..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full border rounded-xl p-3 xl:p-5 text-base xl:text-2xl 2xl:text-3xl shadow-sm bg-white"
        />
      </div>
      <h2 className="text-xl xl:text-3xl 2xl:text-4xl font-bold mb-4 xl:mb-6">
        รถในโรงงาน {search.trim() ? `(${filtered.length} คัน)` : ''}
      </h2>
      <div className="space-y-3 xl:space-y-5">
        {filtered.map(truck => (
          <div key={truck.ID} className="bg-white rounded-xl p-4 xl:p-6 2xl:p-8 shadow">
            <div className="font-bold text-lg xl:text-3xl 2xl:text-4xl">{truck.Truck_Plate}</div>
            <div className="text-gray-500 text-sm xl:text-xl 2xl:text-2xl">{truck.Truck_Type}</div>
            <div className="text-sm xl:text-xl 2xl:text-2xl mt-1">สถานะ: <span className="font-semibold">{truck.Status}</span></div>
            <div className="text-sm xl:text-xl 2xl:text-2xl">ลาน: {truck.Loading_Bay || '-'}</div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center text-gray-400 xl:text-2xl 2xl:text-3xl xl:py-8">
            {search.trim() ? `ไม่พบทะเบียน "${search}"` : 'ยังไม่มีรถเข้าโรงงานวันนี้'}
          </div>
        )}
      </div>
    </div>
  )
}
