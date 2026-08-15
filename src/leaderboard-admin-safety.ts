import { newId, readJson, utcNow } from './http';
import { backupOutboxStatement } from './backup';
import { HttpError, type AdminAuth, type Env, type LeaderboardRow } from './types';

const ENTRY_COLUMNS = `player_id, display_name, best_score, level, achieved_at, updated_at,
 source_platform, web_source, device_type, control_type, app_version, verification_status,
 manual_rank, admin_note, deleted_at`;
const ENTRY_SELECT = `SELECT l.player_id, p.display_name, l.best_score, l.level, l.achieved_at,
 l.updated_at, l.source_platform, l.web_source, l.device_type, l.control_type, l.app_version,
 l.verification_status, l.manual_rank, l.admin_note, l.deleted_at
 FROM leaderboard_entries l JOIN players p ON p.id=l.player_id`;

export function snapshotStatements(env: Env, input: { id: string; actor: string; reason?: string | null;
  trigger: string; source?: string | null; createdAt: string; }): D1PreparedStatement[] {
  return [
    env.DB.prepare(`INSERT INTO primary_leaderboard_snapshots
      (id,created_at,actor,reason,trigger_type,source_action_id,entry_count)
      SELECT ?,?,?,?,?,?,COUNT(*) FROM leaderboard_entries`).bind(
      input.id, input.createdAt, input.actor, input.reason ?? null, input.trigger, input.source ?? null,
    ),
    env.DB.prepare(`INSERT INTO primary_leaderboard_snapshot_entries (snapshot_id,${ENTRY_COLUMNS})
      SELECT ?,${ENTRY_COLUMNS} FROM (${ENTRY_SELECT})`).bind(input.id),
  ];
}

export async function listSnapshots(env: Env, url: URL) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const rows = await env.DB.prepare(`SELECT id,created_at,actor,reason,trigger_type,source_action_id,entry_count
    FROM primary_leaderboard_snapshots ORDER BY created_at DESC,id DESC LIMIT ?`).bind(limit).all();
  return rows.results;
}

export async function viewSnapshot(env: Env, id: string, url: URL) {
  if (!/^[A-Za-z0-9-]{20,64}$/.test(id)) throw new HttpError(400, 'invalid_snapshot_id', 'Invalid snapshot ID.');
  const snapshot = await env.DB.prepare('SELECT * FROM primary_leaderboard_snapshots WHERE id=?').bind(id).first();
  if (!snapshot) throw new HttpError(404, 'snapshot_not_found', 'Snapshot was not found.');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const entries = await env.DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM primary_leaderboard_snapshot_entries
    WHERE snapshot_id=? ORDER BY CASE WHEN manual_rank IS NULL THEN 1 ELSE 0 END,manual_rank,best_score DESC LIMIT ? OFFSET ?`)
    .bind(id, limit, offset).all();
  return { snapshot, entries: entries.results };
}

export async function createSnapshotRestoreChallenge(env: Env, admin: AdminAuth, snapshotId: string) {
  const source = snapshotId === 'latest-pre-clear'
    ? await env.DB.prepare(`SELECT id FROM primary_leaderboard_snapshots WHERE trigger_type='pre_clear' ORDER BY created_at DESC LIMIT 1`).first<{id:string}>()
    : await env.DB.prepare('SELECT id FROM primary_leaderboard_snapshots WHERE id=?').bind(snapshotId).first<{id:string}>();
  if (!source) throw new HttpError(404, 'snapshot_not_found', 'Snapshot was not found.');
  const id = newId(), now = utcNow(), expires = new Date(Date.now() + 300_000).toISOString();
  await env.DB.prepare(`INSERT INTO admin_confirmation_challenges(id,actor,action,created_at,expires_at)
    VALUES(?,? ,?, ?,?)`).bind(id, admin.actor, `snapshot.restore:${source.id}`, now, expires).run();
  return { challenge_id: id, snapshot_id: source.id, expires_at: expires, confirmation_phrase: `RESTORE SNAPSHOT ${source.id}` };
}

export async function restoreSnapshot(request: Request, env: Env, admin: AdminAuth, snapshotId: string) {
  const body = await readJson<Record<string, unknown>>(request);
  const phrase = `RESTORE SNAPSHOT ${snapshotId}`;
  if (body.confirmation_1 !== true || body.confirmation_2 !== true || body.confirmation_phrase !== phrase || typeof body.challenge_id !== 'string')
    throw new HttpError(400, 'double_confirmation_required', 'Two exact confirmations are required.');
  const challenge = await env.DB.prepare(`SELECT id FROM admin_confirmation_challenges
    WHERE id=? AND actor=? AND action=? AND used_at IS NULL AND expires_at>?`).bind(
      body.challenge_id, admin.actor, `snapshot.restore:${snapshotId}`, utcNow()).first<{id:string}>();
  if (!challenge) throw new HttpError(409, 'confirmation_expired', 'Confirmation is invalid, expired, or used.');
  const source = await env.DB.prepare(`SELECT id,entry_count FROM primary_leaderboard_snapshots WHERE id=?
    AND entry_count=(SELECT COUNT(*) FROM primary_leaderboard_snapshot_entries WHERE snapshot_id=?)`).bind(snapshotId,snapshotId).first<{id:string;entry_count:number}>();
  if (!source) throw new HttpError(409, 'invalid_restore_source', 'Snapshot is missing or incomplete.');
  const now=utcNow(), safetyId=newId(), auditId=newId();
  await env.DB.batch([
    ...snapshotStatements(env,{id:safetyId,actor:admin.actor,reason:`Safety snapshot before restore from ${snapshotId}`,trigger:'pre_replace',source:snapshotId,createdAt:now}),
    env.DB.prepare('DELETE FROM leaderboard_entries'),
    env.DB.prepare(`INSERT INTO leaderboard_entries (player_id,best_score,level,achieved_at,updated_at,source_platform,web_source,device_type,control_type,app_version,verification_status,manual_rank,admin_note,deleted_at)
      SELECT player_id,best_score,level,achieved_at,updated_at,source_platform,web_source,device_type,control_type,app_version,verification_status,manual_rank,admin_note,deleted_at
      FROM primary_leaderboard_snapshot_entries WHERE snapshot_id=?`).bind(snapshotId),
    env.DB.prepare(`UPDATE players SET display_name=(SELECT display_name FROM primary_leaderboard_snapshot_entries s WHERE s.snapshot_id=? AND s.player_id=players.id)
      WHERE id IN (SELECT player_id FROM primary_leaderboard_snapshot_entries WHERE snapshot_id=?)`).bind(snapshotId,snapshotId),
    env.DB.prepare(`INSERT INTO admin_audit_logs(id,actor,action,target_type,target_id,before_json,after_json,reason,created_at)
      VALUES(?,?,'leaderboard.restore_snapshot','leaderboard',?,NULL,?,?,?)`).bind(auditId,admin.actor,snapshotId,JSON.stringify({source_id:snapshotId,safety_snapshot_id:safetyId,entries:source.entry_count}),String(body.reason||'Snapshot exact replace').slice(0,500),now),
    env.DB.prepare('UPDATE admin_confirmation_challenges SET used_at=? WHERE id=? AND used_at IS NULL').bind(now,challenge.id),
  ]);
  return { audit_id:auditId, safety_snapshot_id:safetyId, source_snapshot_id:snapshotId, restored_entries:source.entry_count, backup_modified:false };
}

export async function restorePrimaryEntry(env: Env, admin: AdminAuth, playerId: string) {
  const before=await env.DB.prepare(`${ENTRY_SELECT} WHERE l.player_id=?`).bind(playerId).first<LeaderboardRow>();
  if (!before) throw new HttpError(404,'leaderboard_entry_not_found','Entry was not found.');
  if (!before.deleted_at) throw new HttpError(409,'entry_active','Entry is already active.');
  const now=utcNow(), auditId=newId(), after={...before,deleted_at:null,updated_at:now};
  await env.DB.batch([
    env.DB.prepare('UPDATE leaderboard_entries SET deleted_at=NULL,updated_at=? WHERE player_id=? AND deleted_at IS NOT NULL').bind(now,playerId),
    env.DB.prepare(`INSERT INTO admin_audit_logs(id,actor,action,target_type,target_id,before_json,after_json,created_at)
      VALUES(?,?,'leaderboard.restore_entry','leaderboard_entry',?,?,?,?)`).bind(auditId,admin.actor,playerId,JSON.stringify(before),JSON.stringify(after),now),
    backupOutboxStatement(env.DB,{entity_type:'leaderboard_entry',entity_id:playerId,subject_player_id:playerId,payload:after,occurred_at:now}),
  ]);
  return {audit_id:auditId,entry:after};
}

const BACKUP_ACTIONS = ['edit','reorder','delete','restore','clear_step1','clear'] as const;
export async function createBackupChallenge(request:Request,env:Env,admin:AdminAuth){
  const b=await readJson<Record<string,unknown>>(request), action=String(b.action||''), target=String(b.target_id||'');
  if (!(BACKUP_ACTIONS as readonly string[]).includes(action)||!target||target.length>128) throw new HttpError(400,'invalid_challenge','Action or target is invalid.');
  if(!['clear','reorder'].includes(action)&&!/^[A-Za-z0-9-]{20,64}$/.test(target))throw new HttpError(400,'invalid_target','Player target is invalid.');
  const phrase=action==='clear'?'CLEAR BACKUP PERMANENTLY':`PERMANENTLY ${action.toUpperCase()} ${target}`;
  const id=newId(),now=utcNow(),expires=new Date(Date.now()+300_000).toISOString();
  await env.BACKUP_DB.prepare(`INSERT INTO backup_confirmation_challenges(id,actor,action,target_id,required_phrase,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(id,admin.actor,action,target,phrase,now,expires).run();
  return {challenge_id:id,action,target_id:target,confirmation_phrase:phrase,expires_at:expires,permanent_no_undo:true};
}
async function consumeConfirmation(env:Env,admin:AdminAuth,b:Record<string,unknown>,action:string,target:string){
  if(b.confirmation!==true||typeof b.challenge_id!=='string'||typeof b.confirmation_phrase!=='string') throw new HttpError(400,'confirmation_required','Permanent backup mutation confirmation is required.');
  const row=await env.BACKUP_DB.prepare(`SELECT id,required_phrase FROM backup_confirmation_challenges WHERE id=? AND actor=? AND action=? AND target_id=? AND used_at IS NULL AND expires_at>?`)
    .bind(b.challenge_id,admin.actor,action,target,utcNow()).first<{id:string;required_phrase:string}>();
  if(!row||b.confirmation_phrase!==row.required_phrase) throw new HttpError(409,'confirmation_invalid','Confirmation is expired, used, or does not match actor, action, target, or phrase.');
  return row.id;
}
export async function listBackupState(env:Env,url:URL){const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||100));const r=await env.BACKUP_DB.prepare(`SELECT * FROM managed_leaderboard_state ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,CASE WHEN manual_rank IS NULL THEN 1 ELSE 0 END,manual_rank,best_score DESC LIMIT ?`).bind(limit).all();return r.results;}
export async function backupHistory(env:Env,url:URL){const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50));return (await env.BACKUP_DB.prepare('SELECT * FROM backup_admin_actions ORDER BY created_at DESC LIMIT ?').bind(limit).all()).results;}
export async function exportBackupCsv(env:Env){const rows=await listBackupState(env,new URL('https://local/?limit=500'));const headers=ENTRY_COLUMNS.split(',').map(x=>x.trim()).concat(['latest_action_type','latest_action_at','source_action_id']);const cell=(v:unknown)=>{const s=v==null?'':String(v);return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};return [headers.join(','),...rows.map(r=>headers.map(h=>cell((r as Record<string,unknown>)[h])).join(','))].join('\r\n');}
export async function reorderBackup(request:Request,env:Env,admin:AdminAuth){const b=await readJson<Record<string,unknown>>(request);if(!Array.isArray(b.player_ids)||b.player_ids.length>500||b.player_ids.some(x=>typeof x!=='string')||new Set(b.player_ids).size!==b.player_ids.length)throw new HttpError(400,'invalid_order','player_ids is invalid.');const target=String(b.player_ids.length),cid=await consumeConfirmation(env,admin,b,'reorder',target);const existing=await env.BACKUP_DB.prepare('SELECT player_id,manual_rank FROM managed_leaderboard_state WHERE deleted_at IS NULL ORDER BY player_id').all<{player_id:string;manual_rank:number|null}>();const ids=b.player_ids as string[];if(ids.length!==existing.results.length||ids.some(x=>!existing.results.some(e=>e.player_id===x)))throw new HttpError(400,'invalid_order','Order must contain every active managed entry exactly once.');const now=utcNow(),id=newId(),stmts=[env.BACKUP_DB.prepare('UPDATE managed_leaderboard_state SET manual_rank=NULL WHERE deleted_at IS NULL')];ids.forEach((x,i)=>stmts.push(env.BACKUP_DB.prepare(`UPDATE managed_leaderboard_state SET manual_rank=?,latest_action_type='backup_admin_reorder',latest_action_at=?,source_action_id=? WHERE player_id=?`).bind(i+1,now,cid,x)));stmts.push(env.BACKUP_DB.prepare(`INSERT INTO backup_admin_actions(id,actor,action,target_type,target_id,before_json,after_json,reason,confirmation_challenge_id,created_at) VALUES(?,?,'reorder','leaderboard','global',?,?,?,?,?)`).bind(id,admin.actor,JSON.stringify(existing.results),JSON.stringify(ids.map((player_id,i)=>({player_id,manual_rank:i+1}))),String(b.reason||'').slice(0,500)||null,cid,now),env.BACKUP_DB.prepare('UPDATE backup_confirmation_challenges SET used_at=? WHERE id=?').bind(now,cid));await env.BACKUP_DB.batch(stmts);return {action_id:id,reordered:ids.length,permanent_no_undo:true};}
export async function mutateBackup(request:Request,env:Env,admin:AdminAuth,action:string,target:string){
  if(!['edit','delete','restore'].includes(action))throw new HttpError(400,'invalid_action','Invalid backup action.');
  if(!/^[A-Za-z0-9-]{20,64}$/.test(target))throw new HttpError(400,'invalid_target','Player target is invalid.');
  const b=await readJson<Record<string,unknown>>(request),cid=await consumeConfirmation(env,admin,b,action,target);
  const before=await env.BACKUP_DB.prepare('SELECT * FROM managed_leaderboard_state WHERE player_id=?').bind(target).first<Record<string,unknown>>();if(!before)throw new HttpError(404,'backup_entry_not_found','Backup entry not found.');
  const now=utcNow(), after={...before};
  if(action==='delete')after.deleted_at=now; else if(action==='restore')after.deleted_at=null; else {
    for(const k of ['display_name','best_score','level','achieved_at','updated_at','source_platform','web_source','device_type','control_type','app_version','verification_status','manual_rank','admin_note'] as const)if(b[k]!==undefined)after[k]=b[k];
    if(typeof after.best_score!=='number'||!Number.isInteger(after.best_score)||after.best_score<1||after.best_score>=100000000)throw new HttpError(400,'invalid_field','best_score is invalid.');
    if(typeof after.display_name!=='string'||!/^[A-Za-z0-9 ]{1,10}$/.test(after.display_name.trim()))throw new HttpError(400,'invalid_field','display_name is invalid.');
    if(after.level!==null&&(typeof after.level!=='number'||!Number.isInteger(after.level)||after.level<1||after.level>10000))throw new HttpError(400,'invalid_field','level is invalid.');
    if(after.manual_rank!==null&&(typeof after.manual_rank!=='number'||!Number.isInteger(after.manual_rank)||after.manual_rank<1||after.manual_rank>1000000))throw new HttpError(400,'invalid_field','manual_rank is invalid.');
    if(!['android','ios','web'].includes(String(after.source_platform))||!['phone','tablet','desktop','tv','handheld','unknown'].includes(String(after.device_type))||!['unverified','verified','flagged','rejected'].includes(String(after.verification_status)))throw new HttpError(400,'invalid_field','Platform, device, or verification status is invalid.');
    for(const key of ['achieved_at','updated_at'] as const)if(typeof after[key]!=='string'||Number.isNaN(Date.parse(after[key] as string)))throw new HttpError(400,'invalid_field',`${key} is invalid.`);
    if(after.admin_note!==null&&(typeof after.admin_note!=='string'||after.admin_note.length>500))throw new HttpError(400,'invalid_field','admin_note is invalid.');
  }
  after.latest_action_type=`backup_admin_${action}`;after.latest_action_at=now;after.source_action_id=cid;
  const keys=Object.keys(after),id=newId();
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare(`UPDATE managed_leaderboard_state SET ${keys.filter(k=>k!=='player_id').map(k=>`${k}=?`).join(',')} WHERE player_id=?`).bind(...keys.filter(k=>k!=='player_id').map(k=>after[k]??null),target),
    env.BACKUP_DB.prepare(`INSERT INTO backup_admin_actions(id,actor,action,target_type,target_id,before_json,after_json,reason,confirmation_challenge_id,created_at) VALUES(?,?,?,'leaderboard_entry',?,?,?,?,?,?)`).bind(id,admin.actor,action,target,JSON.stringify(before),JSON.stringify(after),String(b.reason||'').slice(0,500)||null,cid,now),
    env.BACKUP_DB.prepare('UPDATE backup_confirmation_challenges SET used_at=? WHERE id=? AND used_at IS NULL').bind(now,cid),
  ]);return {action_id:id,entry:after,permanent_no_undo:true};
}
interface BackupClearAction { id:string; actor:string; before_json:string|null; reason:string|null; created_at:string; primary_audit_id:string|null; primary_audit_synced_at:string|null }
async function syncBackupClearAudit(env:Env,action:BackupClearAction){
  const before=JSON.parse(action.before_json ?? '{"active":0}') as {active?:number};
  const auditId=action.primary_audit_id ?? action.id;
  await env.DB.prepare(`INSERT OR IGNORE INTO admin_audit_logs(id,actor,action,target_type,target_id,before_json,after_json,reason,created_at)
    VALUES(?,?,'backup.leaderboard.clear','backup_leaderboard','global',?,?,?,?)`).bind(auditId,action.actor,JSON.stringify({affected:before.active??0}),JSON.stringify({primary_modified:false,backup_action_id:action.id}),action.reason,action.created_at).run();
  await env.BACKUP_DB.prepare('UPDATE backup_admin_actions SET primary_audit_id=?,primary_audit_synced_at=? WHERE id=? AND primary_audit_synced_at IS NULL').bind(auditId,utcNow(),action.id).run();
}
export async function clearBackup(request:Request,env:Env,admin:AdminAuth){
  const b=await readJson<Record<string,unknown>>(request);
  if(b.confirmation_1!==true||b.confirmation_2!==true)throw new HttpError(400,'double_confirmation_required','Two confirmations are required.');
  if(typeof b.challenge_id!=='string'||b.confirmation!==true||b.confirmation_phrase!=='CLEAR BACKUP PERMANENTLY')throw new HttpError(400,'confirmation_required','Exact permanent backup confirmation is required.');
  const prior=await env.BACKUP_DB.prepare(`SELECT a.id,a.actor,a.before_json,a.reason,a.created_at,a.primary_audit_id,a.primary_audit_synced_at
    FROM backup_admin_actions a JOIN backup_confirmation_challenges c ON c.id=a.confirmation_challenge_id
    WHERE a.confirmation_challenge_id=? AND a.action='clear' AND c.actor=? AND c.action='clear' AND c.target_id='global' AND c.required_phrase='CLEAR BACKUP PERMANENTLY'`).bind(b.challenge_id,admin.actor).first<BackupClearAction>();
  if(prior){if(prior.primary_audit_synced_at)throw new HttpError(409,'confirmation_invalid','Confirmation has already been used.');try{await syncBackupClearAudit(env,prior);}catch{throw new HttpError(503,'backup_mutation_committed_audit_pending','Backup clear is committed; primary audit reconciliation is pending. Retry with the same challenge.');}const before=JSON.parse(prior.before_json??'{}') as {active?:number};return {affected_entries:before.active??0,primary_modified:false,raw_events_modified:false,permanent_no_undo:true,reconciled:true};}
  const cid=await consumeConfirmation(env,admin,b,'clear','global'),now=utcNow();
  const count=await env.BACKUP_DB.prepare('SELECT COUNT(*) total FROM managed_leaderboard_state WHERE deleted_at IS NULL').first<{total:number}>();
  const id=newId(),auditId=newId(),reason=String(b.reason||'').slice(0,500)||null;
  await env.BACKUP_DB.batch([
    env.BACKUP_DB.prepare(`UPDATE managed_leaderboard_state SET deleted_at=?,latest_action_type='backup_admin_clear',latest_action_at=?,source_action_id=? WHERE deleted_at IS NULL`).bind(now,now,cid),
    env.BACKUP_DB.prepare(`INSERT INTO backup_admin_actions(id,actor,action,target_type,target_id,before_json,after_json,reason,confirmation_challenge_id,created_at,primary_audit_id) VALUES(?,?,'clear','leaderboard','global',?,?,?,?,?,?)`).bind(id,admin.actor,JSON.stringify({active:count?.total||0}),JSON.stringify({active:0}),reason,cid,now,auditId),
    env.BACKUP_DB.prepare('UPDATE backup_confirmation_challenges SET used_at=? WHERE id=? AND used_at IS NULL').bind(now,cid),
  ]);
  const action={id,actor:admin.actor,before_json:JSON.stringify({active:count?.total||0}),reason,created_at:now,primary_audit_id:auditId,primary_audit_synced_at:null};
  try{await syncBackupClearAudit(env,action);}catch{throw new HttpError(503,'backup_mutation_committed_audit_pending','Backup clear is committed; primary audit reconciliation is pending. Retry with the same challenge.');}
  return {affected_entries:count?.total||0,primary_modified:false,raw_events_modified:false,permanent_no_undo:true,reconciled:false};
}

export async function restorePrimaryFromManagedBackup(request:Request,env:Env,admin:AdminAuth){
  const b=await readJson<Record<string,unknown>>(request);
  if(typeof b.challenge_id!=='string'||b.confirmation_1!==true||b.confirmation_2!==true||b.confirmation_phrase!=='RESTORE PRIMARY FROM BACKUP')throw new HttpError(400,'double_confirmation_required','Two confirmations are required.');
  const challenge=await env.DB.prepare(`SELECT id FROM admin_confirmation_challenges WHERE id=? AND actor=? AND action='leaderboard.restore_from_backup' AND used_at IS NULL AND expires_at>?`).bind(b.challenge_id,admin.actor,utcNow()).first<{id:string}>();
  if(!challenge)throw new HttpError(409,'confirmation_expired','Restore confirmation is invalid, expired, or used.');
  const rows=await env.BACKUP_DB.prepare(`SELECT ${ENTRY_COLUMNS} FROM managed_leaderboard_state ORDER BY player_id LIMIT 100000`).all<Record<string,unknown>>();
  for(const r of rows.results)if(typeof r.player_id!=='string'||typeof r.display_name!=='string'||typeof r.best_score!=='number'||!Number.isInteger(r.best_score)||r.best_score<1||r.best_score>=100000000||!['android','ios','web'].includes(String(r.source_platform)))throw new HttpError(409,'invalid_restore_source','Managed backup contains an invalid entry; primary was not changed.');
  const batchId=newId();
  try{for(let i=0;i<rows.results.length;i+=75){await env.DB.batch(rows.results.slice(i,i+75).map(r=>env.DB.prepare(`INSERT INTO leaderboard_exact_restore_staging(batch_id,${ENTRY_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(batchId,...ENTRY_COLUMNS.split(',').map(k=>r[k.trim()]??null))));}}
  catch(e){await env.DB.prepare('DELETE FROM leaderboard_exact_restore_staging WHERE batch_id=?').bind(batchId).run();throw e;}
  const valid=await env.DB.prepare(`SELECT COUNT(*) total FROM leaderboard_exact_restore_staging s JOIN players p ON p.id=s.player_id AND p.deleted_at IS NULL WHERE s.batch_id=?`).bind(batchId).first<{total:number}>();
  if((valid?.total||0)!==rows.results.length){await env.DB.prepare('DELETE FROM leaderboard_exact_restore_staging WHERE batch_id=?').bind(batchId).run();throw new HttpError(409,'invalid_restore_source','Managed backup references missing/deleted accounts; primary was not changed.');}
  const now=utcNow(),safetyId=newId(),auditId=newId();
  await env.DB.batch([...snapshotStatements(env,{id:safetyId,actor:admin.actor,reason:'Safety snapshot before exact managed-backup restore',trigger:'pre_replace',source:'managed_backup',createdAt:now}),env.DB.prepare('DELETE FROM leaderboard_entries'),env.DB.prepare(`INSERT INTO leaderboard_entries(player_id,best_score,level,achieved_at,updated_at,source_platform,web_source,device_type,control_type,app_version,verification_status,manual_rank,admin_note,deleted_at) SELECT player_id,best_score,level,achieved_at,updated_at,source_platform,web_source,device_type,control_type,app_version,verification_status,manual_rank,admin_note,deleted_at FROM leaderboard_exact_restore_staging WHERE batch_id=?`).bind(batchId),env.DB.prepare(`UPDATE players SET display_name=(SELECT display_name FROM leaderboard_exact_restore_staging s WHERE s.batch_id=? AND s.player_id=players.id) WHERE id IN(SELECT player_id FROM leaderboard_exact_restore_staging WHERE batch_id=?)`).bind(batchId,batchId),env.DB.prepare(`INSERT INTO admin_audit_logs(id,actor,action,target_type,target_id,after_json,reason,created_at) VALUES(?,?,'leaderboard.restore_from_backup','leaderboard','managed_backup',?,?,?)`).bind(auditId,admin.actor,JSON.stringify({safety_snapshot_id:safetyId,source_id:'managed_backup',restored_entries:rows.results.length}),String(b.reason||'').slice(0,500)||null,now),env.DB.prepare('DELETE FROM leaderboard_exact_restore_staging WHERE batch_id=?').bind(batchId),env.DB.prepare('UPDATE admin_confirmation_challenges SET used_at=? WHERE id=?').bind(now,challenge.id)]);
  return {audit_id:auditId,safety_snapshot_id:safetyId,restored_entries:rows.results.length,backup_modified:false};
}
