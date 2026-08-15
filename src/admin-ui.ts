export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Caveman Vs Dragon — Server Admin</title>
  <style>
    :root{color-scheme:dark;--bg:#11100f;--panel:#1c1917;--line:#443b32;--text:#fff7ed;--muted:#c8b8a4;--gold:#f59e0b;--red:#dc2626;--green:#16a34a}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#2b2119,var(--bg) 45%);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
    main{max-width:1440px;margin:auto;padding:24px}h1{margin:0 0 4px;font-size:28px}p{color:var(--muted)}.panel{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:14px;padding:16px;margin:16px 0;box-shadow:0 12px 35px #0005}
    .toolbar{display:flex;flex-wrap:wrap;gap:9px;align-items:end}.field{display:grid;gap:5px;min-width:220px;flex:1}.field span{color:var(--muted);font-size:12px}input,button,textarea{font:inherit;border-radius:8px;border:1px solid var(--line);padding:9px 11px;background:#0f0e0d;color:var(--text)}button{cursor:pointer;background:#332a22;font-weight:700}button:hover{border-color:var(--gold)}button.primary{background:#92400e}button.danger{background:var(--red);border-color:#ef4444}button.safe{background:#166534}button:disabled{opacity:.45;cursor:not-allowed}
    .notice{min-height:24px;padding:8px 0;color:var(--muted)}.notice.error{color:#fca5a5}.notice.success{color:#86efac}.metrics{white-space:pre-wrap;background:#0b0a09;border:1px solid var(--line);padding:12px;border-radius:8px;max-height:380px;overflow:auto}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:1180px;width:100%}th,td{padding:8px;border-bottom:1px solid #332d28;text-align:left;vertical-align:middle}th{position:sticky;top:0;background:#29231e;color:#fcd34d;z-index:1}td input{width:100%;min-width:78px;padding:6px}.row-actions{display:flex;gap:5px;flex-wrap:wrap}.rank-buttons{display:flex;gap:4px}.rank-buttons button{padding:5px 8px}.deleted-data{opacity:.5;text-decoration:line-through}.snapshot-id{display:inline-block;max-width:260px;overflow-wrap:anywhere;user-select:all;color:#fcd34d}.detail-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.danger-zone{border-color:#7f1d1d;background:#260f0f}.danger-zone h2{color:#fca5a5}.small{font-size:12px;color:var(--muted)}code{color:#fcd34d}@media(max-width:720px){main{padding:12px}.toolbar>*{width:100%}button{min-height:42px}}
  </style>
</head>
<body>
<main>
  <h1>Caveman Vs Dragon Server Admin</h1>
  <p>All times are UTC. Admin edits and deletions are audited. Account privacy deletion is permanent.</p>

  <section class="panel" id="authentication">
    <h2>Authentication</h2>
    <div class="toolbar">
      <label class="field"><span>Admin API token</span><input id="token" type="password" autocomplete="off" placeholder="Worker secret"></label>
      <label class="field"><span>Actor label</span><input id="actor" value="admin" maxlength="120"></label>
      <button id="saveToken" class="primary">Use token</button>
    </div>
    <div id="notice" class="notice">Enter the admin token to begin.</div>
  </section>

  <section class="panel" id="primaryLeaderboard">
    <h2>Primary Global Leaderboard — Primary Database</h2>
    <p>This is the live, public global leaderboard served from the primary database.</p>
    <div class="toolbar">
      <button id="refresh">Refresh leaderboard</button>
      <button id="saveOrder">Save displayed order</button>
      <button id="export">Export CSV</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Level</th><th>Achieved UTC</th><th>Platform</th><th>Device</th><th>Status</th><th>Manual rank</th><th>Admin note</th><th>Actions</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>

  <section class="panel" id="primarySnapshots">
    <h2>Primary Snapshots</h2>
    <p>Immutable, timestamped snapshots include active and soft-deleted entries. Every exact replacement first creates a restorable pre-replace safety snapshot.</p>
    <div class="toolbar"><button id="snapshots">Refresh snapshots</button><button id="latestPreClear" class="safe">Restore latest pre-clear snapshot</button></div>
    <div id="snapshotList" class="table-wrap" hidden><table><thead><tr><th>Created UTC</th><th>Trigger type</th><th>Actor</th><th>Entry count</th><th>Reason</th><th>Snapshot ID</th><th>Actions</th></tr></thead><tbody id="snapshotRows"></tbody></table></div>
    <div id="snapshotDetail" hidden>
      <div class="detail-header"><h3 id="snapshotDetailTitle">Snapshot contents</h3><button id="closeSnapshotDetail">Close contents</button></div>
      <div class="table-wrap"><table><thead><tr><th>State</th><th>Name</th><th>Score</th><th>Level</th><th>Order / manual rank</th><th>Achieved UTC</th><th>Updated UTC</th><th>Verification</th><th>Note</th><th>Platform</th><th>Device</th><th>Metadata</th></tr></thead><tbody id="snapshotEntryRows"></tbody></table></div>
    </div>
  </section>

  <section class="panel" id="primaryOperations">
    <h2>Primary Operations and Recovery</h2>
    <p>These controls inspect or change primary state. Restore primary from backup reads the backup database and changes the primary database; it does not change backup state.</p>
    <div class="toolbar">
      <button id="analytics">Load analytics</button>
      <button id="audit">Audit history</button>
      <button id="undo" class="safe" disabled>Undo last admin action</button>
      <button id="restore" class="safe">Restore primary from backup</button>
    </div>
    <pre id="metrics" class="metrics" hidden></pre>
  </section>

  <section class="panel danger-zone" id="primaryDanger">
    <h2>Primary Danger Zone</h2>
    <p>This action clears only the <strong>primary global leaderboard</strong>. The redundant backup database is deliberately not changed. The primary action is an audited soft-delete and can be undone.</p>
    <button id="clear" class="danger">Clear Global Leaderboard</button>
    <p class="small">Pressing the button requires two separate confirmations before the API will accept the operation.</p>
  </section>

  <section class="panel" id="backupLeaderboard">
    <h2>Backup Global Leaderboard — Independent Backup Database</h2>
    <p><strong>This is the independent backup leaderboard state. Changes made here are permanent and have no additional application-level backup or Undo.</strong></p>
    <p>Raw append-only backup event history remains immutable and is not edited by these controls. D1 Time Travel is infrastructure recovery, not an application Undo button.</p>
    <div class="toolbar"><button id="backupList">Refresh/list backup leaderboard</button><button id="backupSaveOrder">Save backup displayed order</button><button id="backupHistory">Backup admin history</button><button id="backupExport">Export backup leaderboard CSV</button><button id="backup">Backup status</button></div>
    <div class="table-wrap"><table><thead><tr><th>Order</th><th>Player</th><th>Name</th><th>Score</th><th>Level</th><th>Verification</th><th>Admin note</th><th>Latest action</th><th>Actions</th></tr></thead><tbody id="backupRows"></tbody></table></div>
    <pre id="backupData" class="metrics" hidden></pre>
  </section>

  <section class="panel danger-zone" id="backupDanger">
    <h2>Backup Danger Zone</h2>
    <p>Clear Backup Global Leaderboard permanently deactivates only managed backup state. Primary, accounts, primary snapshots, primary audit history, and raw backup events remain unchanged. Backup-based primary restoration will no longer recover cleared entries. There is no application-level Undo.</p>
    <button id="clearBackup" class="danger">Clear Backup Global Leaderboard</button>
  </section>
</main>
<script>
  'use strict';
  var tokenInput=document.getElementById('token');
  var actorInput=document.getElementById('actor');
  var notice=document.getElementById('notice');
  var rowsEl=document.getElementById('rows');
  var metrics=document.getElementById('metrics');
  var undoButton=document.getElementById('undo');
  var displayed=[];
  var backupDisplayed=[];
  var snapshotDisplayed=[];
  var lastAuditId=null;
  tokenInput.value=sessionStorage.getItem('cvd.adminToken')||'';
  actorInput.value=sessionStorage.getItem('cvd.adminActor')||'admin';

  function setNotice(message,type){notice.textContent=message;notice.className='notice '+(type||'');}
  function authHeaders(json){var headers={'Authorization':'Bearer '+tokenInput.value,'X-Admin-Actor':actorInput.value||'admin'};if(json)headers['Content-Type']='application/json';return headers;}
  async function api(path,options){
    var opts=options||{};opts.headers=Object.assign({},authHeaders(Boolean(opts.body)),opts.headers||{});
    var response=await fetch(path,opts);var contentType=response.headers.get('content-type')||'';
    var payload=contentType.indexOf('application/json')>=0?await response.json():await response.text();
    if(!response.ok){var msg=payload&&payload.error&&payload.error.message?payload.error.message:String(payload||response.statusText);throw new Error(msg);}
    return payload;
  }
  function setLastAudit(id){lastAuditId=id||null;undoButton.disabled=!lastAuditId;}
  function input(value,type){var el=document.createElement('input');el.type=type||'text';el.value=value==null?'':String(value);return el;}
  function button(label,handler,cls){var el=document.createElement('button');el.textContent=label;if(cls)el.className=cls;el.addEventListener('click',handler);return el;}
  function cell(child){var td=document.createElement('td');if(child instanceof Node)td.appendChild(child);else td.textContent=child==null?'':String(child);return td;}
  function renderRows(){
    rowsEl.textContent='';
    displayed.forEach(function(row,index){
      var tr=document.createElement('tr');tr.dataset.playerId=row.player_id;
      var name=input(row.display_name);name.dataset.field='display_name';
      var score=input(row.best_score,'number');score.dataset.field='best_score';
      var level=input(row.level==null?'':row.level,'number');level.dataset.field='level';
      var achieved=input(row.achieved_at);achieved.dataset.field='achieved_at';
      var manual=input(row.manual_rank==null?'':row.manual_rank,'number');manual.dataset.field='manual_rank';
      var note=input(row.admin_note||'');note.dataset.field='admin_note';
      var rankWrap=document.createElement('div');rankWrap.className='rank-buttons';
      rankWrap.appendChild(button('↑',function(){if(index>0){var x=displayed[index-1];displayed[index-1]=displayed[index];displayed[index]=x;renderRows();}}));
      rankWrap.appendChild(button('↓',function(){if(index<displayed.length-1){var x=displayed[index+1];displayed[index+1]=displayed[index];displayed[index]=x;renderRows();}}));
      var actions=document.createElement('div');actions.className='row-actions';
      if(row.deleted_at){actions.appendChild(button('Restore',async function(){await restoreRow(row.player_id);},'safe'));}
      else{actions.appendChild(button('Save',async function(){await saveRow(tr,row.player_id);},'primary'));actions.appendChild(button('Delete',async function(){await deleteRow(row.player_id);},'danger'));}
      var dataCells=[cell(String(index+1)),cell(name),cell(score),cell(level),cell(achieved),cell(row.source_platform+(row.web_source?' / '+row.web_source:'')),cell(row.device_type),cell(row.verification_status),cell(manual),cell(note)];
      if(row.deleted_at)dataCells.forEach(function(td){td.className='deleted-data';});dataCells.forEach(function(td){tr.appendChild(td);});
      if(row.deleted_at){[name,score,level,achieved,manual,note].forEach(function(el){el.disabled=true;});rankWrap.querySelectorAll('button').forEach(function(el){el.disabled=true;});}
      var actionCell=cell(rankWrap);actionCell.className='actions-cell';actionCell.appendChild(actions);tr.appendChild(actionCell);rowsEl.appendChild(tr);
    });
  }
  async function loadLeaderboard(){
    try{setNotice('Loading…');var result=await api('/v1/admin/leaderboard?limit=500&include_deleted=true');displayed=result.data.entries;renderRows();setNotice('Loaded '+result.data.total+' entries.','success');}
    catch(error){setNotice(error.message,'error');}
  }
  async function saveRow(tr,playerId){
    var body={};tr.querySelectorAll('input[data-field]').forEach(function(el){var value=el.value.trim();if(el.type==='number')body[el.dataset.field]=value===''?null:Number(value);else body[el.dataset.field]=value;});
    try{var result=await api('/v1/admin/leaderboard/'+encodeURIComponent(playerId),{method:'PATCH',body:JSON.stringify(body)});setLastAudit(result.data.audit_id);setNotice('Entry saved.','success');await loadLeaderboard();}
    catch(error){setNotice(error.message,'error');}
  }
  async function deleteRow(playerId){
    if(!window.confirm('Soft-delete this leaderboard entry? This can be undone.'))return;
    try{var result=await api('/v1/admin/leaderboard/'+encodeURIComponent(playerId),{method:'DELETE',body:JSON.stringify({reason:'Admin dashboard delete'})});setLastAudit(result.data.audit_id);setNotice('Entry deleted.','success');await loadLeaderboard();}
    catch(error){setNotice(error.message,'error');}
  }
  async function restoreRow(playerId){if(!window.confirm('Restore only this primary entry with its saved score and metadata?'))return;try{var r=await api('/v1/admin/leaderboard/'+encodeURIComponent(playerId)+'/restore',{method:'POST',body:JSON.stringify({})});setLastAudit(r.data.audit_id);setNotice('Entry restored and queued for normal backup replication.','success');await loadLeaderboard();}catch(e){setNotice(e.message,'error');}}
  document.getElementById('saveToken').addEventListener('click',function(){sessionStorage.setItem('cvd.adminToken',tokenInput.value);sessionStorage.setItem('cvd.adminActor',actorInput.value||'admin');setNotice('Token stored for this browser tab only.','success');loadLeaderboard();});
  document.getElementById('refresh').addEventListener('click',loadLeaderboard);
  document.getElementById('saveOrder').addEventListener('click',async function(){try{var ids=displayed.filter(function(x){return !x.deleted_at;}).map(function(x){return x.player_id;});var result=await api('/v1/admin/leaderboard/reorder',{method:'POST',body:JSON.stringify({player_ids:ids,reason:'Admin dashboard reorder'})});setLastAudit(result.data.audit_id);setNotice('Leaderboard order saved.','success');await loadLeaderboard();}catch(error){setNotice(error.message,'error');}});
  document.getElementById('export').addEventListener('click',async function(){try{var response=await fetch('/v1/admin/leaderboard/export.csv',{headers:authHeaders(false)});if(!response.ok)throw new Error('Export failed');var blob=await response.blob();var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='cavemanvsdragon-global-leaderboard.csv';a.click();URL.revokeObjectURL(url);setNotice('CSV exported.','success');}catch(error){setNotice(error.message,'error');}});
  async function showJson(path,output){try{var result=await api(path);output=output||metrics;output.hidden=false;output.textContent=JSON.stringify(result.data,null,2);}catch(error){setNotice(error.message,'error');}}
  document.getElementById('analytics').addEventListener('click',function(){showJson('/v1/admin/analytics/summary');});
  document.getElementById('backup').addEventListener('click',function(){showJson('/v1/admin/backups/status',document.getElementById('backupData'));});
  document.getElementById('restore').addEventListener('click',async function(){
    var first=window.confirm('RESTORE CONFIRMATION 1 OF 2\n\nRebuild the PRIMARY leaderboard from redundant backup score history?\n\nThe raw backup will remain unchanged.');
    if(!first)return;
    try{
      var challenge=await api('/v1/admin/backups/restore-leaderboard/challenge',{method:'POST',body:JSON.stringify({})});
      var second=window.confirm('RESTORE CONFIRMATION 2 OF 2 — FINAL\n\nProceed with restoring the PRIMARY leaderboard from backup now?');
      if(!second)return;
      var result=await api('/v1/admin/backups/restore-leaderboard',{method:'POST',body:JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'RESTORE PRIMARY FROM BACKUP',reason:'Double-confirmed primary leaderboard restore'})});
      setLastAudit(result.data.audit_id);setNotice('Restored '+result.data.restored_entries+' entries from backup. Backup unchanged.','success');await loadLeaderboard();
    }catch(error){setNotice(error.message,'error');}
  });
  document.getElementById('audit').addEventListener('click',function(){showJson('/v1/admin/audit?limit=100');});
  function readable(value){return value==null||value===''?'—':String(value);}
  async function copySnapshotId(id){try{await navigator.clipboard.writeText(id);setNotice('Snapshot ID copied.','success');}catch(e){setNotice('Copy unavailable; select the displayed snapshot ID.','error');}}
  function renderSnapshots(){var list=document.getElementById('snapshotList'),el=document.getElementById('snapshotRows');el.textContent='';snapshotDisplayed.forEach(function(row){var tr=document.createElement('tr'),id=document.createElement('code'),actions=document.createElement('div');id.className='snapshot-id';id.textContent=row.id;actions.className='row-actions';actions.appendChild(button('Copy ID',function(){copySnapshotId(row.id);}));actions.appendChild(button('View contents',function(){viewSnapshotContents(row.id);}));actions.appendChild(button('Restore this snapshot',function(){restoreChosenSnapshot(row.id);},'safe'));[row.created_at,row.trigger_type,row.actor,row.entry_count,readable(row.reason)].forEach(function(value){tr.appendChild(cell(value));});tr.appendChild(cell(id));tr.appendChild(cell(actions));el.appendChild(tr);});list.hidden=false;}
  async function loadSnapshots(){try{var result=await api('/v1/admin/snapshots?limit=100');snapshotDisplayed=result.data;renderSnapshots();setNotice('Loaded '+snapshotDisplayed.length+' snapshots.','success');}catch(e){setNotice(e.message,'error');}}
  async function viewSnapshotContents(id){try{var result=await api('/v1/admin/snapshots/'+encodeURIComponent(id)+'?limit=500&offset=0'),el=document.getElementById('snapshotEntryRows');el.textContent='';result.data.entries.forEach(function(row,index){var tr=document.createElement('tr');var values=[row.deleted_at?'Deleted':'Active',row.display_name,row.best_score,readable(row.level),readable(row.manual_rank==null?index+1:row.manual_rank),row.achieved_at,row.updated_at,row.verification_status,readable(row.admin_note),row.source_platform+(row.web_source?' / '+row.web_source:''),row.device_type,['Player ID: '+row.player_id,row.control_type?'Control: '+row.control_type:'',row.app_version?'App: '+row.app_version:''].filter(Boolean).join(' / ')];values.forEach(function(value){var td=cell(value);if(row.deleted_at)td.className='deleted-data';tr.appendChild(td);});el.appendChild(tr);});document.getElementById('snapshotDetailTitle').textContent='Snapshot contents — '+result.data.snapshot.id;document.getElementById('snapshotDetail').hidden=false;setNotice('Viewing '+result.data.entries.length+' snapshot entries (read-only).','success');}catch(e){setNotice(e.message,'error');}}
  document.getElementById('snapshots').addEventListener('click',loadSnapshots);
  document.getElementById('closeSnapshotDetail').addEventListener('click',function(){document.getElementById('snapshotDetail').hidden=true;document.getElementById('snapshotEntryRows').textContent='';});
  async function loadBackupRows(){try{var r=await api('/v1/admin/backup-leaderboard?limit=500');backupDisplayed=r.data;renderBackupRows();setNotice('Loaded independent managed backup state.','success');}catch(e){setNotice(e.message,'error');}}
  async function permanentBackup(action,target,payload,path,method){var phrase='PERMANENTLY '+action.toUpperCase()+' '+target;var accepted=window.confirm(action.toUpperCase()+' backup entry '+target+'?\n\nThis change is permanent and has no application Undo.');if(!accepted)return;var ch=await api('/v1/admin/backup-leaderboard/challenges',{method:'POST',body:JSON.stringify({action:action,target_id:target})});if(!window.confirm('Final confirmation: '+action+' '+target+'.\n\nPermanent; no application Undo.'))return;payload=Object.assign({},payload,{challenge_id:ch.data.challenge_id,confirmation:true,confirmation_phrase:phrase});await api(path,{method:method,body:JSON.stringify(payload)});await loadBackupRows();}
  function renderBackupRows(){var el=document.getElementById('backupRows');el.textContent='';backupDisplayed.forEach(function(row,index){var tr=document.createElement('tr');var name=input(row.display_name);var score=input(row.best_score,'number');var level=input(row.level==null?'':row.level,'number');var verification=input(row.verification_status);var note=input(row.admin_note||'');var actions=document.createElement('div');actions.className='row-actions';var up=button('↑',function(){if(index){var x=backupDisplayed[index-1];backupDisplayed[index-1]=row;backupDisplayed[index]=x;renderBackupRows();}}),down=button('↓',function(){if(index<backupDisplayed.length-1){var x=backupDisplayed[index+1];backupDisplayed[index+1]=row;backupDisplayed[index]=x;renderBackupRows();}});actions.appendChild(up);actions.appendChild(down);if(row.deleted_at){actions.appendChild(button('Restore permanently',function(){permanentBackup('restore',row.player_id,{},'/v1/admin/backup-leaderboard/'+encodeURIComponent(row.player_id)+'/restore','POST');},'safe'));[name,score,level,verification,note,up,down].forEach(function(control){control.disabled=true;});}else{actions.appendChild(button('Save permanently',function(){permanentBackup('edit',row.player_id,{display_name:name.value,best_score:Number(score.value),level:level.value===''?null:Number(level.value),verification_status:verification.value,admin_note:note.value},'/v1/admin/backup-leaderboard/'+encodeURIComponent(row.player_id),'PATCH');},'primary'));actions.appendChild(button('Deactivate permanently',function(){permanentBackup('delete',row.player_id,{},'/v1/admin/backup-leaderboard/'+encodeURIComponent(row.player_id),'DELETE');},'danger'));}var dataCells=[cell(String(index+1)),cell(row.player_id),cell(name),cell(score),cell(level),cell(verification),cell(note),cell(row.latest_action_type+' / '+row.latest_action_at)];if(row.deleted_at)dataCells.forEach(function(td){td.className='deleted-data';});dataCells.forEach(function(td){tr.appendChild(td);});var actionCell=cell(actions);actionCell.className='actions-cell';tr.appendChild(actionCell);el.appendChild(tr);});}
  document.getElementById('backupList').addEventListener('click',loadBackupRows);
  document.getElementById('backupSaveOrder').addEventListener('click',function(){var ids=backupDisplayed.filter(function(x){return !x.deleted_at;}).map(function(x){return x.player_id;});permanentBackup('reorder',String(ids.length),{player_ids:ids},'/v1/admin/backup-leaderboard/reorder','POST');});
  document.getElementById('backupHistory').addEventListener('click',function(){showJson('/v1/admin/backup-leaderboard/history?limit=100',document.getElementById('backupData'));});
  document.getElementById('backupExport').addEventListener('click',async function(){try{var r=await fetch('/v1/admin/backup-leaderboard/export.csv',{headers:authHeaders(false)});if(!r.ok)throw new Error('Backup export failed');var blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='backup-leaderboard.csv';a.click();URL.revokeObjectURL(url);}catch(e){setNotice(e.message,'error');}});
  async function restoreChosenSnapshot(id){var first=window.confirm('SNAPSHOT RESTORE CONFIRMATION 1 OF 2\n\nSelected snapshot: '+id+'\n\nThis will exactly replace every current primary leaderboard row, including active/deleted state, with the selected snapshot. BACKUP_DB will not be modified.');if(!first)return;try{var ch=await api('/v1/admin/snapshots/'+encodeURIComponent(id)+'/restore/challenge',{method:'POST',body:'{}'});id=ch.data.snapshot_id;var second=window.confirm('SNAPSHOT RESTORE CONFIRMATION 2 OF 2 — FINAL\n\nSelected snapshot: '+id+'\n\nA pre-replace safety snapshot of current primary state will be created first. Primary state will then be replaced exactly. BACKUP_DB will not be modified.');if(!second)return;var r=await api('/v1/admin/snapshots/'+encodeURIComponent(id)+'/restore',{method:'POST',body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:ch.data.confirmation_phrase})});setLastAudit(r.data.audit_id);setNotice('Exact snapshot restore complete; safety snapshot '+r.data.safety_snapshot_id+' is restorable.','success');await Promise.all([loadLeaderboard(),loadSnapshots()]);}catch(e){setNotice(e.message,'error');}}
  document.getElementById('latestPreClear').addEventListener('click',function(){restoreChosenSnapshot('latest-pre-clear');});
  document.getElementById('clearBackup').addEventListener('click',async function(){var one=window.confirm('BACKUP CONFIRMATION 1 OF 2\n\nPermanently deactivate every managed backup leaderboard entry? Primary remains unchanged; raw events remain immutable; there is no application Undo.');if(!one)return;try{var ch=await api('/v1/admin/backup-leaderboard/challenges',{method:'POST',body:JSON.stringify({action:'clear',target_id:'global'})});var typed=window.prompt('BACKUP CONFIRMATION 2 OF 2 — FINAL\n\nType exactly: CLEAR BACKUP PERMANENTLY');if(typed!=='CLEAR BACKUP PERMANENTLY')return;var r=await api('/v1/admin/backup-leaderboard/clear',{method:'POST',body:JSON.stringify({challenge_id:ch.data.challenge_id,confirmation:true,confirmation_1:true,confirmation_2:true,confirmation_phrase:typed})});setNotice('Permanently cleared '+r.data.affected_entries+' managed backup entries; primary unchanged.','success');}catch(e){setNotice(e.message,'error');}});
  undoButton.addEventListener('click',async function(){if(!lastAuditId||!window.confirm('Undo the most recent admin action from this tab?'))return;try{await api('/v1/admin/audit/'+encodeURIComponent(lastAuditId)+'/undo',{method:'POST',body:JSON.stringify({})});setLastAudit(null);setNotice('Admin action undone.','success');await loadLeaderboard();}catch(error){setNotice(error.message,'error');}});

  document.getElementById('clear').addEventListener('click',async function(){
    // Confirmation 1 of 2.
    var first=window.confirm('CONFIRMATION 1 OF 2\n\nClear the PRIMARY global leaderboard?\n\nThe backup database will remain unchanged.');
    if(!first)return;
    try{
      var challenge=await api('/v1/admin/leaderboard/clear/challenge',{method:'POST',body:JSON.stringify({})});
      // Confirmation 2 of 2. No deletion occurs unless this second dialog is accepted.
      var second=window.confirm('CONFIRMATION 2 OF 2 — FINAL\n\nClear all visible global leaderboard scores from the PRIMARY database now?\n\nThe backup will NOT be cleared.');
      if(!second)return;
      var result=await api('/v1/admin/leaderboard/clear',{method:'POST',body:JSON.stringify({challenge_id:challenge.data.challenge_id,confirmation_1:true,confirmation_2:true,confirmation_phrase:'CLEAR PRIMARY ONLY',reason:'Double-confirmed primary leaderboard clear'})});
      setLastAudit(result.data.audit_id);setNotice('Primary leaderboard cleared: '+result.data.cleared_entries+' entries. Backup unchanged.','success');await loadLeaderboard();
    }catch(error){setNotice(error.message,'error');}
  });
  if(tokenInput.value)loadLeaderboard();
</script>
</body>
</html>`;
