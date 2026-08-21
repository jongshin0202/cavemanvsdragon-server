import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir=mkdtempSync(join(tmpdir(),'cvd-migrations-'));
const run=(db:string,sql:string)=>execFileSync('sqlite3',[db],{input:sql,encoding:'utf8'});
const query=(db:string,sql:string)=>execFileSync('sqlite3',['-json',db,sql],{encoding:'utf8'}).trim();
const primary1=readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
const primary2=readFileSync(new URL('../migrations/0002_leaderboard_snapshots.sql',import.meta.url),'utf8');
const primary3=readFileSync(new URL('../migrations/0003_snapshot_archival.sql',import.meta.url),'utf8');
const primary4=readFileSync(new URL('../migrations/0004_leaderboard_profiles.sql',import.meta.url),'utf8');
const backup1=readFileSync(new URL('../backup-migrations/0001_backup.sql',import.meta.url),'utf8');
const backup2=readFileSync(new URL('../backup-migrations/0002_managed_leaderboard.sql',import.meta.url),'utf8');
afterAll(()=>rmSync(dir,{recursive:true,force:true}));

describe('numbered migration rollout',()=>{
  it('applies primary migrations to an empty database',()=>{const db=join(dir,'primary.db');run(db,primary1);run(db,primary2);run(db,primary3);run(db,primary4);expect(JSON.parse(query(db,"SELECT value FROM schema_meta WHERE key='schema_version'"))[0].value).toBe('4');expect(JSON.parse(query(db,"SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name IN ('primary_snapshots_no_update','primary_snapshots_no_delete','primary_snapshot_entries_no_update','primary_snapshot_entries_no_delete')"))[0].count).toBe(4);expect(query(db,'PRAGMA foreign_key_check')).toBe('');});
  it('applies backup 0001 then 0002 to an empty database',()=>{const db=join(dir,'backup.db');run(db,backup1);run(db,backup2);expect(JSON.parse(query(db,"SELECT value FROM backup_meta WHERE key='schema_version'"))[0].value).toBe('2');});
  it('safely reapplies idempotent migration SQL',()=>{expect(primary2).toContain('CREATE TABLE IF NOT EXISTS');expect(primary3).toContain('CREATE TABLE IF NOT EXISTS');expect(()=>run(join(dir,'primary.db'),primary2)).not.toThrow();expect(()=>run(join(dir,'primary.db'),primary3)).not.toThrow();expect(JSON.parse(query(join(dir,'primary.db'),"SELECT value FROM schema_meta WHERE key='schema_version'"))[0].value).toBe('3');expect(backup2).toContain('INSERT OR IGNORE');expect(()=>run(join(dir,'backup.db'),backup2)).not.toThrow();});
  it('initializes complete managed state with deletion and source action intact',()=>{const db=join(dir,'complete.db');run(db,backup1);const payload={display_name:'CAVE TEST',best_score:42,level:2,achieved_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-02T00:00:00Z',source_platform:'web',web_source:'desktop_web',device_type:'desktop',control_type:'keyboard',app_version:'1',verification_status:'flagged',manual_rank:3,admin_note:'n',deleted_at:'2026-01-03T00:00:00Z'};run(db,`INSERT INTO backup_entity_snapshots VALUES('leaderboard_entry','player-complete-1234567890','player-complete-1234567890','${JSON.stringify(payload)}','source-action-1','delete','2026-01-03T00:00:00Z');`);run(db,backup2);const row=JSON.parse(query(db,"SELECT display_name,deleted_at,source_action_id,latest_action_type FROM managed_leaderboard_state"))[0];expect(row).toEqual({display_name:'CAVE TEST',deleted_at:'2026-01-03T00:00:00Z',source_action_id:'source-action-1',latest_action_type:'soft_deleted'});});
  it('uses the best valid score for documented lossy legacy fallback',()=>{const db=join(dir,'legacy.db');run(db,backup1);for(const [id,score] of [['s1',10],['s2',99]] as const){const p={player_id:'legacy-player-123456789',display_name:'Legacy',score,level:1,submitted_at:`2026-01-0${score===10?2:1}T00:00:00Z`,source_platform:'web',device_type:'desktop'};run(db,`INSERT INTO backup_entity_snapshots VALUES('score_submission','${id}',NULL,'${JSON.stringify(p)}','${id}','upsert','2026-01-03T00:00:00Z');`);}run(db,backup2);const row=JSON.parse(query(db,"SELECT best_score,latest_action_type,manual_rank,deleted_at FROM managed_leaderboard_state"))[0];expect(row).toEqual({best_score:99,latest_action_type:'legacy_score_fallback',manual_rank:null,deleted_at:null});});
  it('ignores invalid historical JSON without partial managed rows',()=>{const db=join(dir,'invalid.db');run(db,backup1);run(db,"INSERT INTO backup_entity_snapshots VALUES('leaderboard_entry','bad',NULL,'{bad','source','upsert','2026-01-01T00:00:00Z');");run(db,backup2);expect(JSON.parse(query(db,'SELECT COUNT(*) count FROM managed_leaderboard_state'))[0].count).toBe(0);});
});
