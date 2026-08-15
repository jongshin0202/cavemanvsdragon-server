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
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:1180px;width:100%}th,td{padding:8px;border-bottom:1px solid #332d28;text-align:left;vertical-align:middle}th{position:sticky;top:0;background:#29231e;color:#fcd34d;z-index:1}td input{width:100%;min-width:78px;padding:6px}.row-actions{display:flex;gap:5px}.rank-buttons{display:flex;gap:4px}.rank-buttons button{padding:5px 8px}.deleted{opacity:.5;text-decoration:line-through}.danger-zone{border-color:#7f1d1d;background:#260f0f}.danger-zone h2{color:#fca5a5}.small{font-size:12px;color:var(--muted)}code{color:#fcd34d}@media(max-width:720px){main{padding:12px}.toolbar>*{width:100%}button{min-height:42px}}
  </style>
</head>
<body>
<main>
  <h1>Caveman Vs Dragon Server Admin</h1>
  <p>All times are UTC. Admin edits and deletions are audited. Account privacy deletion is permanent.</p>

  <section class="panel">
    <div class="toolbar">
      <label class="field"><span>Admin API token</span><input id="token" type="password" autocomplete="off" placeholder="Worker secret"></label>
      <label class="field"><span>Actor label</span><input id="actor" value="admin" maxlength="120"></label>
      <button id="saveToken" class="primary">Use token</button>
      <button id="refresh">Refresh leaderboard</button>
      <button id="saveOrder">Save displayed order</button>
      <button id="export">Export CSV</button>
    </div>
    <div id="notice" class="notice">Enter the admin token to begin.</div>
  </section>

  <section class="panel">
    <div class="toolbar">
      <button id="analytics">Load analytics</button>
      <button id="backup">Backup status</button>
      <button id="restore" class="safe">Restore primary from backup</button>
      <button id="audit">Audit history</button>
      <button id="undo" class="safe" disabled>Undo last admin action</button>
    </div>
    <pre id="metrics" class="metrics" hidden></pre>
  </section>

  <section class="panel">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Level</th><th>Achieved UTC</th><th>Platform</th><th>Device</th><th>Status</th><th>Manual rank</th><th>Admin note</th><th>Actions</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>

  <section class="panel danger-zone">
    <h2>Danger zone</h2>
    <p>This action clears only the <strong>primary global leaderboard</strong>. The redundant backup database is deliberately not changed. The primary action is an audited soft-delete and can be undone.</p>
    <button id="clear" class="danger">Clear Global Leaderboard</button>
    <p class="small">Pressing the button requires two separate confirmations before the API will accept the operation.</p>
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
      var tr=document.createElement('tr');if(row.deleted_at)tr.className='deleted';tr.dataset.playerId=row.player_id;
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
      actions.appendChild(button('Save',async function(){await saveRow(tr,row.player_id);},'primary'));
      actions.appendChild(button('Delete',async function(){await deleteRow(row.player_id);},'danger'));
      tr.appendChild(cell(String(index+1)));tr.appendChild(cell(name));tr.appendChild(cell(score));tr.appendChild(cell(level));tr.appendChild(cell(achieved));
      tr.appendChild(cell(row.source_platform+(row.web_source?' / '+row.web_source:'')));tr.appendChild(cell(row.device_type));tr.appendChild(cell(row.verification_status));
      tr.appendChild(cell(manual));tr.appendChild(cell(note));var actionCell=cell(rankWrap);actionCell.appendChild(actions);tr.appendChild(actionCell);rowsEl.appendChild(tr);
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
  document.getElementById('saveToken').addEventListener('click',function(){sessionStorage.setItem('cvd.adminToken',tokenInput.value);sessionStorage.setItem('cvd.adminActor',actorInput.value||'admin');setNotice('Token stored for this browser tab only.','success');loadLeaderboard();});
  document.getElementById('refresh').addEventListener('click',loadLeaderboard);
  document.getElementById('saveOrder').addEventListener('click',async function(){try{var ids=displayed.filter(function(x){return !x.deleted_at;}).map(function(x){return x.player_id;});var result=await api('/v1/admin/leaderboard/reorder',{method:'POST',body:JSON.stringify({player_ids:ids,reason:'Admin dashboard reorder'})});setLastAudit(result.data.audit_id);setNotice('Leaderboard order saved.','success');await loadLeaderboard();}catch(error){setNotice(error.message,'error');}});
  document.getElementById('export').addEventListener('click',async function(){try{var response=await fetch('/v1/admin/leaderboard/export.csv',{headers:authHeaders(false)});if(!response.ok)throw new Error('Export failed');var blob=await response.blob();var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='cavemanvsdragon-global-leaderboard.csv';a.click();URL.revokeObjectURL(url);setNotice('CSV exported.','success');}catch(error){setNotice(error.message,'error');}});
  async function showJson(path){try{var result=await api(path);metrics.hidden=false;metrics.textContent=JSON.stringify(result.data,null,2);}catch(error){setNotice(error.message,'error');}}
  document.getElementById('analytics').addEventListener('click',function(){showJson('/v1/admin/analytics/summary');});
  document.getElementById('backup').addEventListener('click',function(){showJson('/v1/admin/backups/status');});
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
