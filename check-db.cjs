const fs = require('fs');
const code = fs.readFileSync('src/App.jsx', 'utf8');
const urlMatch = code.match(/createClient\(['"`](.*?)['"`]/);
const keyMatch = code.match(/createClient\(.*?,\s*['"`](.*?)['"`]\)/);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(urlMatch[1], keyMatch[1]);
async function test() {
  const { data, error } = await supabase.from('wh_queue').select('*');
  console.log('Queue count:', data?.length);
  console.log('Walk-ins:', data?.filter(r => r.id.startsWith('WALK-')));
}
test();
