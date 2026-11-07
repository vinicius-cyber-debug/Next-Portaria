import type {Pool} from 'pg';

/** pg-pool removes clients from its list before their sockets emit `end`. */
export function trackPoolShutdown(pool:Pool):()=>Promise<void>{
  const pending=new Set<Promise<void>>();let closing:Promise<void>|undefined;
  pool.on('connect',client=>{
    let finish!:()=>void;
    const closed=new Promise<void>(resolve=>{finish=resolve;});pending.add(closed);
    client.once('end',()=>{pending.delete(closed);finish();});
  });
  return ()=>closing??=(async()=>{await pool.end();await Promise.all([...pending]);})();
}
