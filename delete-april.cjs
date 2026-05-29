const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://lacrtyuvlweeiprdrryz.supabase.co',
  'sb_publishable_ByhscTE0LsMBcruWTeNJtA_f1VBJpDX'
);

const BUCKET = 'truck-photos';
const TARGET_MONTH = '2026-04';

// top-level folders ตามโค้ด
const TOP_FOLDERS = ['qc', 'loading/lane_parts', 'loading/lane_head', 'loading/lane_pork'];

async function listFiles(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) { console.error(`❌ list ${prefix}:`, error.message); return []; }
  return data || [];
}

async function deleteAprilFiles() {
  console.log(`\n🔍 กำลังหาไฟล์เดือน ${TARGET_MONTH}...`);
  let totalDeleted = 0;

  for (const topFolder of TOP_FOLDERS) {
    const dates = await listFiles(topFolder);
    const aprilDates = dates.filter(d => d.name.startsWith(TARGET_MONTH));

    if (aprilDates.length === 0) continue;
    console.log(`\n📁 ${topFolder}: พบ ${aprilDates.length} วัน`);

    for (const dateFolder of aprilDates) {
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

deleteAprilFiles();
