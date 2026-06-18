const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://lacrtyuvlweeiprdrryz.supabase.co',
  'sb_publishable_ByhscTE0LsMBcruWTeNJtA_f1VBJpDX'
);

const BUCKET = 'truck-photos';
const TARGET_DATES = [
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04',
  '2026-05-05', '2026-05-06', '2026-05-07',
];
const TOP_FOLDERS = ['qc', 'loading/lane_parts', 'loading/lane_head', 'loading/lane_pork'];

async function listFiles(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) { console.error(`❌ list ${prefix}:`, error.message); return []; }
  return data || [];
}

async function deleteMay1to7() {
  console.log('\n🔍 กำลังหาไฟล์วันที่ 1-7 พ.ค. 2026...');
  let totalDeleted = 0;

  for (const topFolder of TOP_FOLDERS) {
    const dates = await listFiles(topFolder);
    const targetDates = dates.filter(d => TARGET_DATES.includes(d.name));

    if (targetDates.length === 0) continue;
    console.log(`\n📁 ${topFolder}: พบ ${targetDates.length} วัน`);

    for (const dateFolder of targetDates) {
      const datePath = `${topFolder}/${dateFolder.name}`;
      const plates = await listFiles(datePath);

      for (const plate of plates) {
        const platePath = `${datePath}/${plate.name}`;
        const files = await listFiles(platePath);
        const paths = files.map(f => `${platePath}/${f.name}`);
        if (paths.length === 0) continue;

        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) {
          console.error(`  ❌ ${platePath}:`, error.message);
        } else {
          console.log(`  🗑️  ลบ ${paths.length} ไฟล์ จาก ${platePath}`);
          totalDeleted += paths.length;
        }
      }
    }
  }

  console.log(`\n✅ ลบทั้งหมด ${totalDeleted} ไฟล์`);
}

deleteMay1to7();
