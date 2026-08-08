(function(){

function uid(){ return 'xxxxxxxx'.replace(/x/g,()=>Math.floor(Math.random()*16).toString(16)); }
function pick(...vals){ for(const v of vals){ if(v !== undefined) return v; } return undefined; }
function strHash(str){
  let hash = 0;
  if(!str) return hash;
  for(let i=0;i<str.length;i++){ hash = ((hash<<5)-hash) + str.charCodeAt(i); hash |= 0; }
  return Math.abs(hash);
}

/* ---------------- ST reference tables ---------------- */
const ST_POSITIONS = [
  {v:0, label:'Before character definitions'},
  {v:1, label:'After character definitions'},
  {v:2, label:'Before example messages'},
  {v:3, label:'After example messages'},
  {v:4, label:'Top of author\u2019s note'},
  {v:5, label:'Bottom of author\u2019s note'},
  {v:6, label:'At depth'},
  {v:7, label:'Outlet'}
];
const ST_LOGIC = [
  {v:0, label:'AND ANY — any filter key present'},
  {v:1, label:'AND ALL — every filter key present'},
  {v:2, label:'NOT ANY — no filter key present'},
  {v:3, label:'NOT ALL — not every filter key present'}
];
const ST_ROLES = [{v:0,label:'System'},{v:1,label:'User'},{v:2,label:'Assistant'}];

/* ---------------- data model ---------------- */
function newEntry(){
  return {
    id:uid(), keys:[], secondary_keys:[], comment:'', content:'',
    constant:false, selective:false, selective_logic:0, use_regex:false,
    insertion_order:100, enabled:true,
    st_position:0, depth:4, role:0, outlet_name:'',
    probability:100, use_probability:false,
    case_sensitive:null, match_whole_words:null, scan_depth:null, vectorized:false,
    group:'', group_override:false, group_weight:100, use_group_scoring:false,
    automation_id:'',
    exclude_recursion:false, prevent_recursion:false, delay_until_recursion:false,
    sticky:0, cooldown:0, delay:0,
    match_character_description:false, match_scenario:false,
    match_creator_notes:false, match_persona_description:false,
    ignore_budget:false
  };
}
function newBook(){ return { name:'', description:'', scan_depth:3, token_budget:1500, recursive_scanning:false, entries:[] }; }
function newData(){
  return {
    name:'', description:'', scenario:'',
    first_mes:'', first_mes_meta:{title:'', description:''},
    mes_example:'', creator_notes:'', system_prompt:'',
    post_history_instructions:'',
    alternate_greetings:[],
    tags:[], creator:'', character_version:'',
    character_book:newBook(), raw_extensions:{}
  };
}

const state = {
  data:newData(),
  avatarBuffer:null,
  avatarUrl:null,
  activeTab:'portrait',
  openEntry:null
};

/* ---------------- token estimate ---------------- */
function estimateTokens(){
  const d = state.data;
  const pool = [d.description, d.scenario, d.mes_example, d.system_prompt,
    d.post_history_instructions, d.first_mes].concat((d.alternate_greetings||[]).map(g=>g.text||''));
  return Math.round(pool.join(' ').length/4);
}
function refreshHeader(){
  document.getElementById('tokenBadge').innerHTML = '~<b>'+estimateTokens()+'</b> tokens';
  const nameEl = document.getElementById('previewName');
  if(state.data.name){ nameEl.textContent = state.data.name; nameEl.classList.remove('empty'); }
  else { nameEl.textContent = 'unnamed character'; nameEl.classList.add('empty'); }
  document.getElementById('previewTags').textContent = state.data.tags.join(' \u00b7 ');
}

/* ---------------- PNG chunk utilities ---------------- */
let crcTable;
function crc32(bytes){
  if(!crcTable){
    crcTable = [];
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++){ c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); }
      crcTable[n]=c>>>0;
    }
  }
  let crc = 0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++){ crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc>>>8); }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function u32(n){ const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,n); return b; }
function strBytes(s){ return Uint8Array.from(s.split('').map(c=>c.charCodeAt(0))); }
function parsePNGChunks(buffer){
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 8;
  const chunks = [];
  while(offset < bytes.length){
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]);
    const data = bytes.slice(offset+8, offset+8+length);
    chunks.push({type,data});
    offset += 12 + length;
  }
  return chunks;
}
function buildPNG(chunks){
  const sig = Uint8Array.from([137,80,78,71,13,10,26,10]);
  const parts = [sig];
  for(const ch of chunks){
    const typeBytes = strBytes(ch.type);
    const crcInput = new Uint8Array(typeBytes.length + ch.data.length);
    crcInput.set(typeBytes,0); crcInput.set(ch.data, typeBytes.length);
    parts.push(u32(ch.data.length), typeBytes, ch.data, u32(crc32(crcInput)));
  }
  let total = 0; for(const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0; for(const p of parts){ out.set(p,pos); pos += p.length; }
  return out;
}
function makeTextChunk(keyword,text){
  const kw = strBytes(keyword);
  const txt = strBytes(text);
  const data = new Uint8Array(kw.length+1+txt.length);
  data.set(kw,0); data[kw.length]=0; data.set(txt,kw.length+1);
  return {type:'tEXt',data};
}
function chunkKeyword(data){
  const idx = data.indexOf(0);
  if(idx<0) return null;
  return String.fromCharCode.apply(null, data.slice(0,idx));
}
function utf8ToBase64(str){
  const bytes = new TextEncoder().encode(str);
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b));
  return btoa(bin);
}
function base64ToUtf8(b64){
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin.split('').map(c=>c.charCodeAt(0)));
  return new TextDecoder().decode(bytes);
}

function isPngBuffer(buffer){
  const b = new Uint8Array(buffer);
  return b.length > 8 && b[0]===137 && b[1]===80 && b[2]===78 && b[3]===71 && b[4]===13 && b[5]===10 && b[6]===26 && b[7]===10;
}
/* Any non-PNG image (jpg, webp, gif...) gets re-encoded to a real PNG via canvas.
   Feeding a non-PNG buffer into the chunk splicer below is what corrupts exports,
   since it has no PNG chunk structure to begin with. */
async function toPngBuffer(buffer, mimeType){
  if(isPngBuffer(buffer)) return buffer;
  const blobUrl = URL.createObjectURL(new Blob([buffer],{type:mimeType||'image/*'}));
  try{
    const img = await new Promise((resolve,reject)=>{
      const im = new Image();
      im.onload = ()=>resolve(im);
      im.onerror = ()=>reject(new Error('Could not read that image file.'));
      im.src = blobUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width || 400;
    canvas.height = img.naturalHeight || img.height || 400;
    canvas.getContext('2d').drawImage(img,0,0);
    const blob = await new Promise(res=>canvas.toBlob(res,'image/png'));
    return await blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
async function setAvatarFromFile(file){
  const raw = await file.arrayBuffer();
  const buf = await toPngBuffer(raw, file.type);
  state.avatarBuffer = buf;
  if(state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = URL.createObjectURL(new Blob([buf],{type:'image/png'}));
  render();
}
async function generateDefaultAvatarPNG(){
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1815'; ctx.fillRect(0,0,400,400);
  ctx.strokeStyle = '#c9a84c'; ctx.lineWidth = 6;
  ctx.strokeRect(14,14,372,372);
  ctx.fillStyle = '#c9a84c';
  ctx.font = '600 160px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const letter = (state.data.name||'?').trim().charAt(0).toUpperCase() || '?';
  ctx.fillText(letter, 200, 215);
  const blob = await new Promise(res=>c.toBlob(res,'image/png'));
  return await blob.arrayBuffer();
}

/* ---------------- lorebook entry <-> spec ---------------- */
function entryToSpec(e,i){
  return {
    keys:e.keys, secondary_keys:e.secondary_keys, comment:e.comment, content:e.content,
    constant:e.constant, selective:e.selective, insertion_order:e.insertion_order,
    enabled:e.enabled, position: e.st_position===0 ? 'before_char' : 'after_char',
    case_sensitive:e.case_sensitive, use_regex:e.use_regex, id:i,
    extensions:{
      position:e.st_position, exclude_recursion:e.exclude_recursion, display_index:i,
      probability:e.probability, useProbability:e.use_probability, depth:e.depth,
      selectiveLogic:e.selective_logic, outlet_name:e.outlet_name, group:e.group,
      group_override:e.group_override, group_weight:e.group_weight,
      prevent_recursion:e.prevent_recursion, delay_until_recursion:e.delay_until_recursion,
      scan_depth:e.scan_depth, match_whole_words:e.match_whole_words,
      use_group_scoring:e.use_group_scoring, case_sensitive:e.case_sensitive,
      automation_id:e.automation_id, role:e.role, vectorized:e.vectorized,
      sticky:e.sticky, cooldown:e.cooldown, delay:e.delay,
      match_persona_description:e.match_persona_description,
      match_character_description:e.match_character_description,
      match_character_personality:false, match_character_depth_prompt:false,
      match_scenario:e.match_scenario, match_creator_notes:e.match_creator_notes,
      triggers:[], ignore_budget:e.ignore_budget
    }
  };
}
function entryFromAny(e){
  e = e || {};
  const ext = e.extensions || {};
  let keys = e.keys || e.key || [];
  if(!Array.isArray(keys)) keys = keys ? [keys] : [];
  let secondary = e.secondary_keys || e.keysecondary || [];
  if(!Array.isArray(secondary)) secondary = secondary ? [secondary] : [];
  let stPosition = pick(ext.position, typeof e.position === 'number' ? e.position : undefined);
  if(stPosition === undefined) stPosition = (e.position === 'after_char') ? 1 : 0;
  const enabled = e.enabled !== undefined ? e.enabled !== false : (e.disable !== undefined ? !e.disable : true);
  return {
    id:uid(), keys, secondary_keys:secondary,
    comment:e.comment || e.name || '', content:e.content || '',
    constant:!!e.constant, selective:!!e.selective,
    selective_logic:pick(ext.selectiveLogic, e.selectiveLogic, 0),
    use_regex:!!pick(e.use_regex, e.useRegex, false),
    insertion_order:pick(e.insertion_order, e.order, 100),
    enabled,
    st_position:stPosition, depth:pick(ext.depth, e.depth, 4), role:pick(ext.role, e.role, 0),
    outlet_name:pick(ext.outlet_name, e.outletName, ''),
    probability:pick(ext.probability, e.probability, 100),
    use_probability:!!pick(ext.useProbability, e.useProbability, false),
    case_sensitive:pick(e.case_sensitive, ext.case_sensitive, e.caseSensitive, null),
    match_whole_words:pick(ext.match_whole_words, e.matchWholeWords, null),
    scan_depth:pick(ext.scan_depth, e.scanDepth, null),
    vectorized:!!pick(ext.vectorized, e.vectorized, false),
    group:pick(ext.group, e.group, ''),
    group_override:!!pick(ext.group_override, e.groupOverride, false),
    group_weight:pick(ext.group_weight, e.groupWeight, 100),
    use_group_scoring:!!pick(ext.use_group_scoring, e.useGroupScoring, false),
    automation_id:pick(ext.automation_id, e.automationId, ''),
    exclude_recursion:!!pick(ext.exclude_recursion, e.excludeRecursion, false),
    prevent_recursion:!!pick(ext.prevent_recursion, e.preventRecursion, false),
    delay_until_recursion:!!pick(ext.delay_until_recursion, e.delayUntilRecursion, false),
    sticky:pick(ext.sticky, e.sticky, 0), cooldown:pick(ext.cooldown, e.cooldown, 0),
    delay:pick(ext.delay, e.delay, 0),
    match_character_description:!!pick(ext.match_character_description, e.matchCharacterDescription, false),
    match_scenario:!!pick(ext.match_scenario, e.matchScenario, false),
    match_creator_notes:!!pick(ext.match_creator_notes, e.matchCreatorNotes, false),
    match_persona_description:!!pick(ext.match_persona_description, e.matchPersonaDescription, false),
    ignore_budget:!!pick(ext.ignore_budget, e.ignoreBudget, false)
  };
}
function bookToSpec(book){
  return {
    name:book.name, description:book.description, scan_depth:book.scan_depth,
    token_budget:book.token_budget, recursive_scanning:book.recursive_scanning,
    extensions:{}, entries: book.entries.map(entryToSpec)
  };
}
function bookFromAny(json){
  const book = newBook();
  if(!json) return book;
  book.name = json.name || '';
  book.description = json.description || '';
  book.scan_depth = json.scan_depth ?? 3;
  book.token_budget = json.token_budget ?? 1500;
  book.recursive_scanning = !!json.recursive_scanning;
  const raw = json.entries !== undefined ? json.entries : json;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  book.entries = arr.map(entryFromAny);
  return book;
}

/* ---------------- card spec building / loading ---------------- */
function buildGreetingExtensions(d){
  let hasMeta = (d.first_mes_meta && (d.first_mes_meta.title || d.first_mes_meta.description));
  const altG = d.alternate_greetings || [];
  for(const g of altG){ if(g.title || g.description) hasMeta = true; }
  if(!hasMeta) return {};
  const gt = { greetings:{}, indexMap:{} };
  if(d.first_mes_meta && (d.first_mes_meta.title || d.first_mes_meta.description)){
    gt.mainGreeting = { id:'g_'+uid(), title:d.first_mes_meta.title||'', description:d.first_mes_meta.description||'', contentHash:strHash(d.first_mes||'') };
  }
  altG.forEach((g,i)=>{
    const gid = 'g_'+uid();
    gt.indexMap[String(i)] = gid;
    gt.greetings[gid] = { id:gid, title:g.title||'', description:g.description||'', contentHash:strHash(g.text||'') };
  });
  return { greeting_tools: gt };
}
function buildV2Card(){
  const d = state.data;
  const extensions = Object.assign({}, d.raw_extensions||{}, buildGreetingExtensions(d));
  if(d.character_book.entries.length) extensions.world = d.character_book.name || '';
  else delete extensions.world;
  return {
    spec:'chara_card_v2', spec_version:'2.0',
    data:{
      name:d.name, description:d.description, personality:'', scenario:d.scenario,
      first_mes:d.first_mes, mes_example:d.mes_example, creator_notes:d.creator_notes,
      system_prompt:d.system_prompt, post_history_instructions:d.post_history_instructions,
      alternate_greetings:(d.alternate_greetings||[]).map(g=>g.text||''),
      character_book: d.character_book.entries.length ? bookToSpec(d.character_book) : undefined,
      tags:d.tags, creator:d.creator, character_version:d.character_version, extensions
    }
  };
}
function loadFromSpec(json){
  const d = (json && json.data) ? json.data : json;
  if(!d) throw new Error('unrecognized card format');
  const ext = Object.assign({}, d.extensions || {});
  const gt = ext.greeting_tools || {};
  delete ext.greeting_tools;
  const mainG = gt.mainGreeting || {};
  const altTexts = d.alternate_greetings || [];
  const altGreetings = altTexts.map((textItem,i)=>{
    const gid = (gt.indexMap||{})[String(i)];
    const meta = (gid && (gt.greetings||{})[gid]) || {};
    return { text: typeof textItem==='string' ? textItem : (textItem.text||''), title:meta.title||'', description:meta.description||'' };
  });
  state.data = Object.assign(newData(), {
    name:d.name||'', description:d.description||'', scenario:d.scenario||'',
    first_mes:d.first_mes||'', first_mes_meta:{ title:mainG.title||'', description:mainG.description||'' },
    mes_example:d.mes_example||'', creator_notes:d.creator_notes||'', system_prompt:d.system_prompt||'',
    post_history_instructions:d.post_history_instructions||'',
    alternate_greetings:altGreetings,
    tags:d.tags||[], creator:d.creator||'', character_version:d.character_version||'',
    character_book:bookFromAny(d.character_book), raw_extensions:ext
  });
}

/* ---------------- import / export ---------------- */
function downloadBlob(blob,filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
async function exportPng(){
  let arrayBuffer = state.avatarBuffer || await generateDefaultAvatarPNG();
  if(!isPngBuffer(arrayBuffer)) arrayBuffer = await toPngBuffer(arrayBuffer);
  let chunks = parsePNGChunks(arrayBuffer);
  chunks = chunks.filter(c => !(c.type==='tEXt' && ['chara','ccv3'].includes(chunkKeyword(c.data))));
  const iendIndex = chunks.findIndex(c=>c.type==='IEND');
  const insertAt = iendIndex<0 ? chunks.length : iendIndex;
  const toInsert = [makeTextChunk('chara', utf8ToBase64(JSON.stringify(buildV2Card())))];
  chunks.splice(insertAt,0,...toInsert);
  const bytes = buildPNG(chunks);
  downloadBlob(new Blob([bytes],{type:'image/png'}), (state.data.name||'character')+'.png');
}
function exportJson(){
  const card = buildV2Card();
  downloadBlob(new Blob([JSON.stringify(card,null,2)],{type:'application/json'}), (state.data.name||'character')+'.json');
}
async function importFile(file){
  if(file.type === 'application/json' || file.name.endsWith('.json')){
    const text = await file.text();
    loadFromSpec(JSON.parse(text));
    render();
    return;
  }
  const buffer = await file.arrayBuffer();
  if(!isPngBuffer(buffer)){ alert('That file isn\u2019t a valid PNG.'); return; }
  const chunks = parsePNGChunks(buffer);
  let found = null;
  for(const c of chunks){
    if(c.type==='tEXt'){
      const kw = chunkKeyword(c.data);
      if(kw==='ccv3'){ found = {kw,c}; break; }
      if(kw==='chara' && !found){ found = {kw,c}; }
    }
  }
  if(!found){ alert('No character data found in this PNG.'); return; }
  const idx = found.c.data.indexOf(0);
  const chunkStr = new TextDecoder().decode(found.c.data.slice(idx+1));
  let jsonStr;
  try{ jsonStr = base64ToUtf8(chunkStr); } catch(e){ jsonStr = chunkStr; }
  loadFromSpec(JSON.parse(jsonStr));
  state.avatarBuffer = buffer;
  if(state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = URL.createObjectURL(new Blob([buffer],{type:'image/png'}));
  render();
}

/* ---------------- chip input component ---------------- */
function renderChips(container, arr, placeholder, onChange){
  container.innerHTML = '';
  container.className = 'chips';
  arr.forEach((val,i)=>{
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<span></span><button type="button" aria-label="Remove">\u00d7</button>';
    chip.querySelector('span').textContent = val;
    chip.querySelector('button').onclick = ()=>{ arr.splice(i,1); renderChips(container,arr,placeholder,onChange); if(onChange) onChange(); };
    container.appendChild(chip);
  });
  const input = document.createElement('input');
  input.className = 'chip-input';
  input.placeholder = placeholder || 'add + enter';
  input.onkeydown = (e)=>{
    if((e.key==='Enter' || e.key===',') && input.value.trim()){
      e.preventDefault();
      input.value.split(',').map(s=>s.trim()).filter(Boolean).forEach(v=>arr.push(v));
      renderChips(container,arr,placeholder,onChange);
      if(onChange) onChange();
      const newInput = container.querySelector('input');
      if(newInput) newInput.focus();
    } else if(e.key==='Backspace' && !input.value && arr.length){
      arr.pop();
      renderChips(container,arr,placeholder,onChange);
      const newInput = container.querySelector('input');
      if(newInput) newInput.focus();
    }
  };
  container.appendChild(input);
}

/* ---------------- generic field helpers ---------------- */
function el(tag,attrs,children){
  const e = document.createElement(tag);
  if(attrs) for(const k in attrs) e.setAttribute(k,attrs[k]);
  if(children) (Array.isArray(children)?children:[children]).forEach(c=>{
    if(typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else if(c) e.appendChild(c);
  });
  return e;
}
function fieldWrap(container,labelText,inputEl,hint){
  const wrap = el('div',{class:'field'});
  wrap.appendChild(el('label',{},labelText));
  wrap.appendChild(inputEl);
  if(hint) wrap.appendChild(el('div',{class:'field-hint'},hint));
  container.appendChild(wrap);
  return inputEl;
}
function fieldTextarea(container,labelText,key,rows,hint){
  const ta = el('textarea',{rows:rows||4});
  ta.value = state.data[key] || '';
  ta.oninput = ()=>{ state.data[key] = ta.value; refreshHeader(); };
  return fieldWrap(container,labelText,ta,hint);
}
function fieldInput(container,labelText,key,hint){
  const inp = el('input',{type:'text'});
  inp.value = state.data[key] || '';
  inp.oninput = ()=>{ state.data[key] = inp.value; refreshHeader(); };
  return fieldWrap(container,labelText,inp,hint);
}
function fieldChips(container,labelText,key,placeholder){
  const box = el('div',{});
  fieldWrap(container,labelText,box);
  renderChips(box, state.data[key], placeholder, refreshHeader);
}
function switchToggle(container,labelText,sub,getVal,setVal){
  const row = el('div',{class:'switch-row'});
  const lab = el('div',{class:'switch-label'},labelText);
  if(sub) lab.appendChild(el('small',{},sub));
  const sw = el('div',{class:'switch'+(getVal()?' on':''),role:'switch',tabindex:'0','aria-checked':getVal()?'true':'false','aria-label':labelText});
  function toggle(){ setVal(!getVal()); sw.className = 'switch'+(getVal()?' on':''); sw.setAttribute('aria-checked', getVal()?'true':'false'); }
  sw.onclick = toggle;
  sw.onkeydown = e=>{ if(e.key===' ' || e.key==='Enter'){ e.preventDefault(); toggle(); } };
  row.appendChild(lab); row.appendChild(sw);
  container.appendChild(row);
  return sw;
}
function textInput(value,oninput){ const i=el('input',{type:'text'}); i.value=value||''; i.oninput=()=>oninput(i.value); return i; }
function numberInput(value,oninput,attrs){ const i=el('input',Object.assign({type:'number'},attrs||{})); i.value=(value===null||value===undefined)?'':value; i.oninput=()=>oninput(i.value===''?null:(parseFloat(i.value)||0)); return i; }
function selectInput(value,options,oninput){
  const s = el('select',{});
  options.forEach(o=>{
    const op = el('option',{value:String(o.v)},o.label);
    if(String(o.v)===String(value)) op.setAttribute('selected','selected');
    s.appendChild(op);
  });
  s.onchange = ()=>oninput(s.value);
  return s;
}
function subhead(container,text){ container.appendChild(el('div',{class:'subhead'},text)); }
function switchGrid(container){ const g = el('div',{class:'switch-grid'}); container.appendChild(g); return g; }
function showModal({title,message,buttons}){
  return new Promise(resolve=>{
    const overlay = el('div',{class:'modal-overlay'});
    const box = el('div',{class:'modal-box'});
    box.appendChild(el('h3',{class:'modal-title'},title));
    box.appendChild(el('p',{class:'modal-message'},message));
    const row = el('div',{class:'modal-buttons'});
    let settled = false;
    function finish(value){
      if(settled) return;
      settled = true;
      document.body.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e){ if(e.key==='Escape') finish(null); }
    buttons.forEach(b=>{
      const btn = el('button',{class:'btn'+(b.variant?' '+b.variant:''),type:'button'},b.label);
      btn.onclick = ()=>finish(b.value);
      row.appendChild(btn);
    });
    box.appendChild(row);
    overlay.appendChild(box);
    overlay.onclick = e=>{ if(e.target===overlay) finish(null); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

function confirmModal(title,message,confirmLabel){
  return showModal({
    title, message,
    buttons:[{label:'Cancel',value:false},{label:confirmLabel||'Confirm',value:true,variant:'danger'}]
  }).then(v=>!!v);
}
const TABS = [
  {id:'portrait', label:'Cover'},
  {id:'persona', label:'Core'},
  {id:'greetings', label:'Greetings'},
  {id:'lorebook', label:'Lorebook'},
  {id:'export', label:'Archive'}
];

function renderTabs(){
  const box = document.getElementById('tabs');
  box.innerHTML = '';
  TABS.forEach((t,i)=>{
    const b = el('button',{class:'tab'+(state.activeTab===t.id?' active':'')});
    b.innerHTML = '<span class="num">'+String(i+1).padStart(2,'0')+'</span>'+t.label;
    b.onclick = ()=>{ state.activeTab = t.id; render(); };
    box.appendChild(b);
  });
}

function renderTabContent(){
  const c = document.getElementById('tabContent');
  c.innerHTML = '';
  if(state.activeTab === 'portrait'){
    c.appendChild(el('h2',{class:'section-title'},'Cover'));
    c.appendChild(el('p',{class:'section-desc'},'Who this character is, at a glance.'));
    fieldInput(c,'Name','name');
    const row = el('div',{class:'row'});
    const wrapC = el('div',{class:'field'});
    wrapC.appendChild(el('label',{},'Creator'));
    wrapC.appendChild(textInput(state.data.creator, v=>state.data.creator=v));
    const wrapV = el('div',{class:'field'});
    wrapV.appendChild(el('label',{},'Version'));
    wrapV.appendChild(textInput(state.data.character_version, v=>state.data.character_version=v));
    row.appendChild(wrapC); row.appendChild(wrapV);
    c.appendChild(row);
    fieldChips(c,'Tags','tags','genre, setting, etc \u2014 separate with commas or Enter');
    fieldTextarea(c,'Creator notes','creator_notes',3,'Add usage tips, tested models, content warnings. Whatever\u2019s useful to know before starting a chat. It isn\u2019t sent to the model. Same spot as JanitorAI\u2019s \u201cbio\u201d or Saucepen\u2019s \u201cdescription.\u201d');
  }
  else if(state.activeTab === 'persona'){
    c.appendChild(el('h2',{class:'section-title'},'Core'));
    c.appendChild(el('p',{class:'section-desc'},'The core traits and voice sent to the model on every message.'));
    fieldTextarea(c,'Description','description',7,'Appearance, background, defining traits \u2014 the main body of who this character is.');
    fieldTextarea(c,'Scenario','scenario',3,'The setting or circumstance the chat begins in.');
    fieldTextarea(c,'Example dialogue','mes_example',6,'Use <START> to separate examples, and {{char}} / {{user}} placeholders.');
    fieldTextarea(c,'System prompt','system_prompt',3,'Overrides the client default system prompt, if set.');
    fieldTextarea(c,'Post-history instructions','post_history_instructions',3,'Injected after the chat history \u2014 good for reminders and steering.');
  }
  else if(state.activeTab === 'greetings'){
    c.appendChild(el('h2',{class:'section-title'},'Greetings'));
    c.appendChild(el('p',{class:'section-desc'},'The opening lines a chat can start from.'));
    const gtNote = el('div',{class:'field-hint',style:'margin:-10px 0 20px'});
    gtNote.innerHTML = 'The optional title/summary on each greeting only does anything if the user has the <a href="https://github.com/Wolfsblvt/SillyTavern-GreetingTools" target="_blank" rel="noopener" style="color:var(--teal)">SillyTavern-GreetingTools</a> extension installed \u2014 otherwise they\u2019re just notes to yourself.';
    c.appendChild(gtNote);

    const fmWrap = el('div',{class:'greeting-item'});
    const fmHead = el('div',{class:'greeting-item-head'});
    fmHead.appendChild(el('span',{},'Main greeting'));
    fmWrap.appendChild(fmHead);
    const fmTa = el('textarea',{rows:4,placeholder:"Sent as the character's opening line."});
    fmTa.value = state.data.first_mes;
    fmTa.oninput = ()=>{ state.data.first_mes = fmTa.value; refreshHeader(); };
    fmWrap.appendChild(fmTa);
    const fmRow = el('div',{class:'row',style:'margin-top:10px'});
    const fmTitleWrap = el('div',{class:'field',style:'margin-bottom:0'});
    const fmTitle = el('input',{type:'text',placeholder:'Optional title'});
    fmTitle.value = state.data.first_mes_meta.title;
    fmTitle.oninput = ()=> state.data.first_mes_meta.title = fmTitle.value;
    fmTitleWrap.appendChild(fmTitle);
    const fmDescWrap = el('div',{class:'field',style:'margin-bottom:0'});
    const fmDesc = el('input',{type:'text',placeholder:'Optional summary'});
    fmDesc.value = state.data.first_mes_meta.description;
    fmDesc.oninput = ()=> state.data.first_mes_meta.description = fmDesc.value;
    fmDescWrap.appendChild(fmDesc);
    fmRow.appendChild(fmTitleWrap); fmRow.appendChild(fmDescWrap);
    fmWrap.appendChild(fmRow);
    c.appendChild(fmWrap);

    const wrap = el('div',{class:'field'});
    wrap.appendChild(el('label',{},'Alternate greetings'));
    const list = el('div',{}); wrap.appendChild(list);
    const addBtn = el('button',{class:'entry-add',type:'button',style:'width:100%;margin-top:6px'},'+ Add alternate greeting');
    wrap.appendChild(addBtn);
    c.appendChild(wrap);
    function renderGreetings(){
      list.innerHTML = '';
      state.data.alternate_greetings.forEach((g,i)=>{
        const item = el('div',{class:'greeting-item'});
        const head = el('div',{class:'greeting-item-head'});
        head.appendChild(el('span',{},'Alternate '+(i+1)));
        const del = el('button',{class:'btn small danger',type:'button'},'Remove');
        del.onclick = ()=>{ state.data.alternate_greetings.splice(i,1); renderGreetings(); };
        head.appendChild(del);
        item.appendChild(head);
        const ta = el('textarea',{rows:3});
        ta.value = g.text;
        ta.oninput = ()=> state.data.alternate_greetings[i].text = ta.value;
        item.appendChild(ta);
        const gRow = el('div',{class:'row',style:'margin-top:10px'});
        const gT = el('div',{class:'field',style:'margin-bottom:0'});
        const gTi = el('input',{type:'text',placeholder:'Optional title'});
        gTi.value = g.title; gTi.oninput = ()=> state.data.alternate_greetings[i].title = gTi.value;
        gT.appendChild(gTi);
        const gD = el('div',{class:'field',style:'margin-bottom:0'});
        const gDi = el('input',{type:'text',placeholder:'Optional summary'});
        gDi.value = g.description; gDi.oninput = ()=> state.data.alternate_greetings[i].description = gDi.value;
        gD.appendChild(gDi);
        gRow.appendChild(gT); gRow.appendChild(gD);
        item.appendChild(gRow);
        list.appendChild(item);
      });
    }
    addBtn.onclick = ()=>{ state.data.alternate_greetings.push({text:'',title:'',description:''}); renderGreetings(); };
    renderGreetings();
  }
  else if(state.activeTab === 'lorebook'){
    renderLorebook(c);
  }
  else if(state.activeTab === 'export'){
    c.appendChild(el('h2',{class:'section-title'},'Archive'));
    c.appendChild(el('p',{class:'section-desc'},'Avatar image, spec details, and the raw card data.'));
    const dz = el('div',{class:'dropzone'},'Click or drop an image to set the avatar');
    dz.onclick = ()=> document.getElementById('fileAvatar').click();
    dz.ondragover = e=>{ e.preventDefault(); dz.classList.add('drag'); };
    dz.ondragleave = ()=> dz.classList.remove('drag');
    dz.ondrop = e=>{
      e.preventDefault();
      dz.classList.remove('drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if(f) setAvatarFromFile(f).catch(err=>alert('Could not use that image: '+err.message));
    };
    c.appendChild(dz);
    const raw = el('div',{class:'field',style:'margin-top:22px'});
    raw.appendChild(el('label',{},'Raw card JSON (V2)'));
    const pre = el('div',{class:'raw-json'});
    pre.textContent = JSON.stringify(buildV2Card(), null, 2);
    raw.appendChild(pre);
    c.appendChild(raw);
  }
}

/* ---------------- lorebook tab ---------------- */
function renderLorebook(c){
  c.appendChild(el('h2',{class:'section-title'},'Lorebook'));
  c.appendChild(el('p',{class:'section-desc'},'World info entries injected into context when their keys match recent chat. Fields mirror SillyTavern\u2019s World Info spec.'));

  const importStrip = el('div',{class:'import-strip'});
  const btnAttach = el('button',{class:'btn primary',type:'button',style:'flex-shrink:0'},'Attach lorebook');
  btnAttach.onclick = ()=> document.getElementById('fileLorebook').click();
  const textWrap = el('div',{class:'import-text'});
  textWrap.innerHTML = 'Attach a <b>.json</b> Lorebook to this card. Attaching more than one merges them together.';
  importStrip.appendChild(btnAttach); importStrip.appendChild(textWrap);
  c.appendChild(importStrip);

  const converterNote = el('div',{class:'converter-note'});
  converterNote.innerHTML = 'Got a lorebook from JanitorAI? <a href="https://dwenne.github.io/LBconverter" target="_blank" rel="noopener">Convert it to SillyTavern format</a> first, then attach the result above. (<a href="https://drevaine.neocities.org/lbconverter" target="_blank" rel="noopener">mirror</a>)';
  c.appendChild(converterNote);

  const book = state.data.character_book;
  const row = el('div',{class:'row'});
  const w1 = el('div',{class:'field'}); w1.appendChild(el('label',{},'Book name'));
  w1.appendChild(textInput(book.name, v=>book.name=v));
  w1.appendChild(el('div',{class:'field-hint'},'Shown as the lorebook\u2019s name in SillyTavern.'));
  const w2 = el('div',{class:'field'}); w2.appendChild(el('label',{},'Scan depth'));
  w2.appendChild(numberInput(book.scan_depth, v=>book.scan_depth=v??0, {min:'0'}));
  w2.appendChild(el('div',{class:'field-hint'},'How many recent messages to scan for key matches.'));
  const w3 = el('div',{class:'field'}); w3.appendChild(el('label',{},'Token budget'));
  w3.appendChild(numberInput(book.token_budget, v=>book.token_budget=v??0, {min:'0'}));
  w3.appendChild(el('div',{class:'field-hint'},'Max tokens the lorebook can spend per generation.'));
  row.appendChild(w1); row.appendChild(w2); row.appendChild(w3);
  c.appendChild(row);

  const recBox = el('div',{class:'field'});
  switchToggle(recBox,'Recursive scanning','Let matched entries trigger other entries by mentioning their keywords.',
    ()=>book.recursive_scanning, v=>book.recursive_scanning=v);
  c.appendChild(recBox);

  const list = el('div',{});
  c.appendChild(list);
  const controlsRow = el('div',{style:'display:flex;gap:10px;margin-top:4px'});
  const addBtn = el('button',{class:'entry-add',type:'button',style:'flex:1'},'+ Add entry');
  addBtn.onclick = ()=>{ const e=newEntry(); book.entries.push(e); state.openEntry=e.id; renderEntries(); };
  const clearBtn = el('button',{class:'btn danger ghost',type:'button'},'Clear all');
  clearBtn.onclick = async ()=>{
    if(!await confirmModal('Clear the lorebook?','This resets the name, scan depth, token budget, and removes all entries.','Clear all')) return;
    state.data.character_book = newBook();
    state.openEntry = null;
    renderTabContent();
  };
  controlsRow.appendChild(addBtn); controlsRow.appendChild(clearBtn);
  c.appendChild(controlsRow);

  function renderEntries(){
    list.innerHTML = '';
    if(book.entries.length===0){
      list.appendChild(el('div',{class:'section-desc'},'No entries yet. Add one, or attach a World Info JSON above.'));
    }
    book.entries.forEach(entry=>{
      const card = el('div',{class:'entry'+(entry.enabled?'':' disabled')+(state.openEntry===entry.id?' open':'')});
      const head = el('div',{class:'entry-head'});
      head.appendChild(el('div',{class:'entry-order'},String(entry.insertion_order)));
      const summary = el('div',{class:'entry-summary'});
      const commentEl = el('div',{class:'entry-comment'+(entry.comment?'':' empty')}, entry.comment || 'untitled entry');
      const keysEl = el('div',{class:'entry-keys'}, entry.keys.length ? entry.keys.join(', ') : 'no keys set');
      summary.appendChild(commentEl); summary.appendChild(keysEl);
      head.appendChild(summary);
      const badges = el('div',{class:'entry-badges'});
      if(!entry.enabled) badges.appendChild(el('span',{class:'badge off'},'off'));
      if(entry.constant) badges.appendChild(el('span',{class:'badge const'},'always'));
      if(entry.selective) badges.appendChild(el('span',{class:'badge sel'},'filtered'));
      head.appendChild(badges);
      const quickDel = el('button',{class:'btn small danger ghost',type:'button','aria-label':'Delete entry'},'\u00d7');
      quickDel.onclick = async (ev)=>{
        ev.stopPropagation();
        if(await confirmModal('Delete this entry?','This can\u2019t be undone.','Delete')){
          book.entries = book.entries.filter(e=>e.id!==entry.id); renderEntries();
        }
      };
      head.appendChild(quickDel);
      head.appendChild(el('span',{class:'entry-chevron'},'\u203a'));
      head.onclick = ()=>{ state.openEntry = state.openEntry===entry.id ? null : entry.id; renderEntries(); };
      card.appendChild(head);

      if(state.openEntry===entry.id){
        const body = el('div',{class:'entry-body'});

        subhead(body,'Content');
        fieldWrap(body,'Comment / title', (()=>{ const i=textInput(entry.comment, v=>{ entry.comment=v; commentEl.textContent=v||'untitled entry'; commentEl.className='entry-comment'+(v?'':' empty'); }); return i; })());
        fieldWrap(body,'Content', (()=>{ const t=el('textarea',{rows:4}); t.value=entry.content; t.oninput=()=>entry.content=t.value; return t; })());

        subhead(body,'Keys');
        const kbox = el('div',{}); fieldWrap(body,'Primary keys', kbox);
        renderChips(kbox, entry.keys, 'trigger word + enter', ()=>{ keysEl.textContent = entry.keys.length?entry.keys.join(', '):'no keys set'; });
        const keyGrid = switchGrid(body);
        switchToggle(keyGrid,'Regex keys','Match as JS regex, not plain text.', ()=>entry.use_regex, v=>entry.use_regex=v);
        switchToggle(keyGrid,'Secondary filter','Require the filter keys below too.', ()=>entry.selective, v=>{ entry.selective=v; renderEntries(); });
        if(entry.selective){
          const skbox = el('div',{}); fieldWrap(body,'Optional filter keys', skbox);
          renderChips(skbox, entry.secondary_keys, 'filter word + enter');
          fieldWrap(body,'Filter logic', selectInput(entry.selective_logic, ST_LOGIC, v=>entry.selective_logic=parseInt(v)));
        }

        subhead(body,'Placement');
        const posRow = el('div',{class:'row'});
        const posW = el('div',{class:'field',style:'flex:2'}); posW.appendChild(el('label',{},'Insertion position'));
        posW.appendChild(selectInput(entry.st_position, ST_POSITIONS, v=>{ entry.st_position=parseInt(v); renderEntries(); }));
        const ordW = el('div',{class:'field'}); ordW.appendChild(el('label',{},'Order'));
        ordW.appendChild(numberInput(entry.insertion_order, v=>{ entry.insertion_order=v??0; head.querySelector('.entry-order').textContent=entry.insertion_order; }));
        posRow.appendChild(posW); posRow.appendChild(ordW);
        body.appendChild(posRow);
        if(entry.st_position===6){
          const dRow = el('div',{class:'row'});
          const dW = el('div',{class:'field'}); dW.appendChild(el('label',{},'Depth'));
          dW.appendChild(numberInput(entry.depth, v=>entry.depth=v??0, {min:'0'}));
          const rW = el('div',{class:'field'}); rW.appendChild(el('label',{},'Role'));
          rW.appendChild(selectInput(entry.role, ST_ROLES, v=>entry.role=parseInt(v)));
          dRow.appendChild(dW); dRow.appendChild(rW);
          body.appendChild(dRow);
        }
        if(entry.st_position===7){
          fieldWrap(body,'Outlet name', textInput(entry.outlet_name, v=>entry.outlet_name=v), 'Pull in with {{outlet::'+(entry.outlet_name||'Name')+'}}.');
        }

        subhead(body,'Activation');
        const actGrid = switchGrid(body);
        switchToggle(actGrid,'Enabled','Off without deleting.',
          ()=>entry.enabled, v=>{ entry.enabled=v; card.className='entry'+(entry.enabled?'':' disabled')+' open'; badges.innerHTML=''; if(!entry.enabled) badges.appendChild(el('span',{class:'badge off'},'off')); if(entry.constant) badges.appendChild(el('span',{class:'badge const'},'always')); if(entry.selective) badges.appendChild(el('span',{class:'badge sel'},'filtered')); });
        switchToggle(actGrid,'Always active','Ignores key matches.',
          ()=>entry.constant, v=>{ entry.constant=v; badges.innerHTML=''; if(!entry.enabled) badges.appendChild(el('span',{class:'badge off'},'off')); if(entry.constant) badges.appendChild(el('span',{class:'badge const'},'always')); if(entry.selective) badges.appendChild(el('span',{class:'badge sel'},'filtered')); });
        const probRow = el('div',{class:'row'});
        const probW = el('div',{class:'field'}); probW.appendChild(el('label',{},'Probability %'));
        probW.appendChild(numberInput(entry.probability, v=>entry.probability=v??100, {min:'0',max:'100'}));
        const scanW = el('div',{class:'field'}); scanW.appendChild(el('label',{},'Scan depth override'));
        scanW.appendChild(numberInput(entry.scan_depth, v=>entry.scan_depth=v, {min:'0'}));
        probRow.appendChild(probW); probRow.appendChild(scanW);
        body.appendChild(probRow);
        const act2Grid = switchGrid(body);
        switchToggle(act2Grid,'Enforce probability','Otherwise always 100%.', ()=>entry.use_probability, v=>entry.use_probability=v);
        switchToggle(act2Grid,'Vectorized','Eligible for embedding match.', ()=>entry.vectorized, v=>entry.vectorized=v);
        const caseRow = el('div',{class:'row'});
        const caseW = el('div',{class:'field'}); caseW.appendChild(el('label',{},'Case sensitivity'));
        caseW.appendChild(selectInput(entry.case_sensitive===null?'null':String(entry.case_sensitive), [{v:'null',label:'Inherit global'},{v:'true',label:'On'},{v:'false',label:'Off'}], v=>entry.case_sensitive = v==='null'?null:(v==='true')));
        const wholeW = el('div',{class:'field'}); wholeW.appendChild(el('label',{},'Match whole words'));
        wholeW.appendChild(selectInput(entry.match_whole_words===null?'null':String(entry.match_whole_words), [{v:'null',label:'Inherit global'},{v:'true',label:'On'},{v:'false',label:'Off'}], v=>entry.match_whole_words = v==='null'?null:(v==='true')));
        caseRow.appendChild(caseW); caseRow.appendChild(wholeW);
        body.appendChild(caseRow);

        subhead(body,'Grouping');
        const grpRow = el('div',{class:'row'});
        const grpW = el('div',{class:'field',style:'flex:2'}); grpW.appendChild(el('label',{},'Inclusion group'));
        grpW.appendChild(textInput(entry.group, v=>entry.group=v));
        const gwW = el('div',{class:'field'}); gwW.appendChild(el('label',{},'Weight'));
        gwW.appendChild(numberInput(entry.group_weight, v=>entry.group_weight=v??100, {min:'0'}));
        grpRow.appendChild(grpW); grpRow.appendChild(gwW);
        body.appendChild(grpRow);
        body.appendChild(el('div',{class:'field-hint',style:'margin:-10px 0 14px'},'Only one entry per group activates.'));
        const grpGrid = switchGrid(body);
        switchToggle(grpGrid,'Prioritize inclusion','By order, not random weight.', ()=>entry.group_override, v=>entry.group_override=v);
        switchToggle(grpGrid,'Use group scoring','Most matched keys wins.', ()=>entry.use_group_scoring, v=>entry.use_group_scoring=v);

        subhead(body,'Recursion & timing');
        const recGrid = switchGrid(body);
        switchToggle(recGrid,'Non-recursable','Others can\u2019t trigger this.', ()=>entry.exclude_recursion, v=>entry.exclude_recursion=v);
        switchToggle(recGrid,'Prevent recursion','This won\u2019t trigger others.', ()=>entry.prevent_recursion, v=>entry.prevent_recursion=v);
        switchToggle(recGrid,'Delay until recursion','Skips the first scan pass.', ()=>entry.delay_until_recursion, v=>entry.delay_until_recursion=v);
        switchToggle(recGrid,'Ignore token budget','Inserts even if over budget.', ()=>entry.ignore_budget, v=>entry.ignore_budget=v);
        const timeRow = el('div',{class:'row'});
        const stW = el('div',{class:'field'}); stW.appendChild(el('label',{},'Sticky'));
        stW.appendChild(numberInput(entry.sticky, v=>entry.sticky=v??0, {min:'0'}));
        const coW = el('div',{class:'field'}); coW.appendChild(el('label',{},'Cooldown'));
        coW.appendChild(numberInput(entry.cooldown, v=>entry.cooldown=v??0, {min:'0'}));
        const deW = el('div',{class:'field'}); deW.appendChild(el('label',{},'Delay'));
        deW.appendChild(numberInput(entry.delay, v=>entry.delay=v??0, {min:'0'}));
        timeRow.appendChild(stW); timeRow.appendChild(coW); timeRow.appendChild(deW);
        body.appendChild(timeRow);
        body.appendChild(el('div',{class:'field-hint',style:'margin:-10px 0 14px'},'Sticky/cooldown/delay are counted in messages.'));

        subhead(body,'Additional matching sources');
        const matchGrid = switchGrid(body);
        switchToggle(matchGrid,'Description','Scans the description field.', ()=>entry.match_character_description, v=>entry.match_character_description=v);
        switchToggle(matchGrid,'Scenario','Scans the scenario field.', ()=>entry.match_scenario, v=>entry.match_scenario=v);
        switchToggle(matchGrid,'Creator\u2019s notes','Scans creator notes.', ()=>entry.match_creator_notes, v=>entry.match_creator_notes=v);
        switchToggle(matchGrid,'Persona description','Scans the user\u2019s persona.', ()=>entry.match_persona_description, v=>entry.match_persona_description=v);

        subhead(body,'Other');
        fieldWrap(body,'Automation ID', textInput(entry.automation_id, v=>entry.automation_id=v), 'Matches a Quick Reply automation ID, if used.');

        const delBtn = el('button',{class:'btn small danger',type:'button',style:'margin-top:6px'},'Delete entry');
        delBtn.onclick = async ()=>{
          if(await confirmModal('Delete this entry?','This can\u2019t be undone.','Delete')){
            book.entries = book.entries.filter(e=>e.id!==entry.id); renderEntries();
          }
        };
        body.appendChild(delBtn);

        card.appendChild(body);
      }
      list.appendChild(card);
    });
  }
  renderEntries();
}

/* ---------------- top-level render ---------------- */
function render(){
  renderTabs();
  renderTabContent();
  refreshHeader();
  const img = document.getElementById('avatarImg');
  const empty = document.getElementById('avatarEmpty');
  if(state.avatarUrl){ img.src = state.avatarUrl; img.style.display='block'; empty.style.display='none'; }
  else { img.style.display='none'; empty.style.display='flex'; empty.textContent = (state.data.name||'?').trim().charAt(0).toUpperCase() || '?'; }
}

/* ---------------- wire up static controls ---------------- */
document.getElementById('btnNew').onclick = async ()=>{
  if(!await confirmModal('Start a new character?','Everything in the current card will be lost unless you\u2019ve already exported it.','Start new')) return;
  state.data = newData();
  state.avatarBuffer = null;
  if(state.avatarUrl) URL.revokeObjectURL(state.avatarUrl);
  state.avatarUrl = null; state.openEntry = null;
  render();
};
document.getElementById('btnExportJson').onclick = exportJson;
document.getElementById('btnExportPng').onclick = ()=> exportPng().catch(err=>alert('Export failed: '+err.message));
document.getElementById('btnImport').onclick = ()=> document.getElementById('fileImport').click();
document.getElementById('fileImport').addEventListener('change', e=>{
  const f = e.target.files[0];
  if(f) importFile(f).catch(err=>alert('Import failed: '+err.message));
  e.target.value = '';
});
document.getElementById('fileLorebook').addEventListener('change', async e=>{
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  try{
    const parsed = await Promise.all(files.map(async f=>bookFromAny(JSON.parse(await f.text()))));
    const incoming = newBook();
    parsed.forEach(b=>{
      incoming.entries = incoming.entries.concat(b.entries);
      if(!incoming.name && b.name) incoming.name = b.name;
      if(!incoming.description && b.description) incoming.description = b.description;
    });
    const current = state.data.character_book;
    if(current.entries.length > 0){
      const choice = await showModal({
        title:'Attach lorebook',
        message:'You already have '+current.entries.length+' entr'+(current.entries.length===1?'y':'ies')+' in this card. '+(files.length>1?'The '+files.length+' files you picked have ':'The file you picked has ')+incoming.entries.length+' between them. Merge the new ones in alongside what you have, or replace the lorebook entirely?',
        buttons:[
          {label:'Cancel', value:'cancel'},
          {label:'Replace', value:'replace', variant:'danger'},
          {label:'Merge', value:'merge', variant:'primary'}
        ]
      });
      if(choice==='cancel' || choice===null){ e.target.value=''; return; }
      if(choice==='merge'){ current.entries = current.entries.concat(incoming.entries); }
      else{ state.data.character_book = incoming; }
    } else {
      state.data.character_book = incoming;
    }
    state.openEntry = null;
    render();
  } catch(err){
    alert('Could not parse one of those files as a World Info JSON.\n\n'+err.message);
  }
  e.target.value = '';
});
document.getElementById('fileAvatar').addEventListener('change', async e=>{
  const f = e.target.files[0];
  if(!f) return;
  try{ await setAvatarFromFile(f); }
  catch(err){ alert('Could not use that image: '+err.message); }
  e.target.value = '';
});
document.getElementById('avatarImg').onclick = ()=> document.getElementById('fileAvatar').click();
document.getElementById('avatarEmpty').onclick = ()=> document.getElementById('fileAvatar').click();

window.addEventListener('beforeunload', e=>{
  const d = state.data;
  const hasContent = d.name || d.description || d.first_mes || d.scenario ||
    d.character_book.entries.length || state.avatarBuffer;
  if(hasContent){ e.preventDefault(); e.returnValue = ''; }
});

/* ---------------- theme ---------------- */
function getStoredTheme(){
  try{ return localStorage.getItem('folio-theme'); } catch(e){ return null; }
}
function storeTheme(t){
  try{ localStorage.setItem('folio-theme', t); } catch(e){ /* storage unavailable, theme just won't persist */ }
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btnTheme');
  if(!btn) return;
  btn.textContent = theme==='light' ? '\u2600' : '\u263e';
  btn.setAttribute('aria-label', theme==='light' ? 'Switch to dark theme' : 'Switch to light theme');
}
let currentTheme = getStoredTheme();
if(!currentTheme){
  currentTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}
applyTheme(currentTheme);
const btnThemeEl = document.getElementById('btnTheme');
if(btnThemeEl) btnThemeEl.onclick = ()=>{
  currentTheme = currentTheme==='light' ? 'dark' : 'light';
  applyTheme(currentTheme);
  storeTheme(currentTheme);
};

render();
})();
