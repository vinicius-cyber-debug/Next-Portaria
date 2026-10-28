/** Sessões de teste montadas no SQLite sem qualquer bypass de identidade na API. */
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const iso=()=>new Date().toISOString();
export function testSession(db,user){
  if(!user)return '';
  const sqlite=db.sqlite,id=user.id;
  const normalizedName=decodeURIComponent(user.name);
  if(!sqlite.prepare('SELECT id FROM operational_users WHERE id=?').get(id)){
    const existing=sqlite.prepare('SELECT count(*) AS n FROM operational_users').get().n;
    const invite=sqlite.prepare("SELECT role FROM operational_invites WHERE email=? AND status='pending'").get(user.email);
    const role=existing===0?'admin':invite?.role||'reader',status=existing===0||invite?'active':'pending';
    const now=iso();sqlite.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,user.email,normalizedName,role,status,now,now);
    if(invite)sqlite.prepare("UPDATE operational_invites SET status='accepted',accepted_at=?,accepted_by=? WHERE email=? AND status='pending'").run(now,id,user.email);
    const event={id:`identity:${id}`,at:now,actor:normalizedName,actorId:id,role,action:'USER_REGISTER',entity:'user',entityId:id,detail:'Usuário de teste cadastrado',changes:[{kind:'users',id,before:null,after:{id,email:user.email,name:normalizedName,role,status}}]};
    sqlite.prepare('INSERT INTO operational_audit (id,at,body) VALUES (?,?,?)').run(event.id,now,JSON.stringify(event));
    sqlite.prepare('INSERT OR IGNORE INTO operational_meta(id,revision) VALUES (1,0)').run();
    sqlite.prepare('UPDATE operational_meta SET revision=revision+1 WHERE id=1').run();
  }
  const token=hash('session-test:'+id);
  if(!sqlite.prepare('SELECT user_id FROM operational_credentials WHERE user_id=?').get(id))sqlite.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES (?,?,?,?,?,?,0)').run(id,'test_'+id,'0'.repeat(32),'0'.repeat(64),310000,iso());
  sqlite.prepare('INSERT OR IGNORE INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(hash(token),id,iso(),new Date(Date.now()+3600000).toISOString());
  return `porto_session=${token}`;
}
