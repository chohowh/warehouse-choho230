const fs = require('fs');
const code = fs.readFileSync('src/App.jsx', 'utf8');
const urlMatch = code.match(/createClient\(['"`](.*?)['"`]/);
const keyMatch = code.match(/createClient\(.*?,\s*['"`](.*?)['"`]\)/);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(urlMatch[1], keyMatch[1]);
async function test() {
  const { error } = await supabase.from('wh_queue').insert({ id: 'WALK-TEST', data: { plate: 'TEST-123' } });
  console.log('Insert error:', error);
  if (!error) {
    await supabase.from('wh_queue').delete().eq('id', 'WALK-TEST');
  }
}
test();
