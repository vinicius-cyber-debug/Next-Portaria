/** Apply a server delta without mutating the last usable offline snapshot. */
export function mergeSyncState(previous,delta={}){
  if(!previous)throw new Error('Uma sincronização incremental exige o estado inicial.');
  const next={...previous,...(delta.values||{})};
  for(const [name,change] of Object.entries(delta.collections||{})){
    const removed=new Set(change.remove||[]),upserts=change.upsert||[],updates=new Map(upserts.map(row=>[row.id,row]));
    const existing=Array.isArray(previous[name])?previous[name]:[];
    const rows=existing.filter(row=>!removed.has(row.id)).map(row=>{const update=updates.get(row.id);updates.delete(row.id);return update||row});
    next[name]=[...updates.values()].filter(row=>!removed.has(row.id)).concat(rows);
    if(name==='audit')next[name]=next[name].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))).slice(0,100);
  }
  return next;
}
