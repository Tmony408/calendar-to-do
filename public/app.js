const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { user: null, tasks: [], categories: [], navFilter: 'all', listFilter: 'all', demo: false, authMode: 'login', view: 'tasks', journalPeriod: 'month', currentJournal: null };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(state.demo ? { 'x-demo-user': 'demo' } : {}), ...options.headers } });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'Request failed');
  return data;
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function initials(name = '') { return name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase(); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
function localInputDate(value) { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
function dueLabel(value) { if (!value) return ''; const date = new Date(value); const today = new Date(); const tomorrow = new Date(); tomorrow.setDate(today.getDate()+1); const same = (a,b)=>a.toDateString()===b.toDateString(); const day = same(date,today)?'Today':same(date,tomorrow)?'Tomorrow':date.toLocaleDateString([], { month:'short',day:'numeric' }); return `${day}, ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`; }
function dateValue(date) { const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return copy.toISOString().slice(0,10); }

async function bootstrap() {
  const demoSaved = sessionStorage.getItem('demo') === 'true';
  if (demoSaved) { state.demo = true; const data = await api('/api/demo/start', { method:'POST' }); state.user = data.user; return enterApp(); }
  try { state.user = (await api('/api/auth/me')).user; enterApp(); } catch { showAuth(); }
}
function showAuth() { $('#auth-view').classList.remove('hidden'); $('#app-view').classList.add('hidden'); }
async function enterApp() {
  $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  $('#user-name').textContent = state.user.name; $('#user-email').textContent = state.user.email; $('#avatar').textContent = initials(state.user.name);
  const hour = new Date().getHours(); const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'; $('#greeting').textContent = `${greeting}, ${state.user.name.split(' ')[0]}.`;
  $('#date-label').textContent = new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }).toUpperCase();
  $('#calendar-status').textContent = state.user.calendarConnected ? 'Two-way sync active' : 'Not connected'; $('#calendar-connect').textContent = state.user.calendarConnected ? 'Connected ✓' : 'Connect';
  await loadDashboard();
}
async function loadDashboard() { const data = await api('/api/dashboard'); state.tasks = data.tasks; state.categories = data.categories; render(); }
function filteredTasks() {
  const now = new Date(); const week = new Date(Date.now()+7*86400000);
  return state.tasks.filter((task) => {
    if (state.navFilter === 'upcoming' && (!task.due_at || new Date(task.due_at) < now || new Date(task.due_at) > week)) return false;
    if (state.navFilter === 'completed' && !task.completed) return false;
    if (state.navFilter === 'high' && task.priority !== 'high') return false;
    if (state.navFilter.startsWith('category:') && task.category_id !== state.navFilter.slice(9)) return false;
    if (state.listFilter === 'open' && task.completed) return false;
    if (state.listFilter === 'completed' && !task.completed) return false;
    return true;
  });
}
function render() {
  const tasks = filteredTasks(); const completed = state.tasks.filter((t)=>t.completed).length; const pct = state.tasks.length ? Math.round(completed/state.tasks.length*100):0; const week = Date.now()+7*86400000;
  $('#progress-text').textContent = `${completed} of ${state.tasks.length} completed`; $('#progress-percent').textContent=`${pct}%`; $('#progress-bar').style.width=`${pct}%`;
  $('#upcoming-count').textContent = `${state.tasks.filter((t)=>t.due_at&&!t.completed&&new Date(t.due_at).getTime()<=week).length} tasks`; $('#high-count').textContent=`${state.tasks.filter((t)=>t.priority==='high'&&!t.completed).length} tasks`; $('#today-count').textContent=state.tasks.filter((t)=>t.due_at&&new Date(t.due_at).toDateString()===new Date().toDateString()&&!t.completed).length;
  $('#category-list').innerHTML = state.categories.map((c)=>`<button class="category-item" data-category="${c.id}"><span class="category-dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</button>`).join('');
  $('#task-category').innerHTML = '<option value="">No category</option>'+state.categories.map((c)=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  $('#task-list').innerHTML = tasks.length ? tasks.map(taskTemplate).join('') : '<div class="empty-state">No tasks here yet. Add one small step to get moving.</div>';
  bindRendered();
}
function taskTemplate(task) {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : []; const done = subtasks.filter((s)=>s.completed).length;
  return `<article class="task-row ${task.completed?'completed':''}" data-id="${task.id}" data-priority="${task.priority}"><i class="priority-mark"></i><button class="task-check" data-action="toggle">${task.completed?'✓':''}</button><div><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta">${task.due_at?`<span class="badge ${new Date(task.due_at)<new Date()&&!task.completed?'danger':''}">◷ ${dueLabel(task.due_at)}</span>`:''}${task.category_name?`<span class="badge"><i class="category-dot" style="background:${task.category_color}"></i>${escapeHtml(task.category_name)}</span>`:''}${task.recurrence!=='none'?`<span class="badge">↻ ${task.recurrence}</span>`:''}${subtasks.length?`<span class="badge">${done}/${subtasks.length} subtasks</span>`:''}${task.sync_status==='synced'?'<span class="badge">Calendar ✓</span>':''}${task.sync_status==='error'?'<span class="badge sync-error" title="'+escapeHtml(task.sync_error)+'">Sync issue</span>':''}</div></div><div class="task-actions"><button data-action="edit" title="Edit">✎</button><button data-action="delete" title="Delete">×</button></div></article>`;
}
function bindRendered() {
  $$('.category-item').forEach((el)=>el.onclick=()=>{state.navFilter=`category:${el.dataset.category}`; closeMobileSidebar(); render();});
  $$('.task-row button').forEach((button)=>button.onclick=()=>handleTaskAction(button.closest('.task-row').dataset.id,button.dataset.action));
}
async function handleTaskAction(id, action) {
  const task = state.tasks.find((t)=>t.id===id);
  if (action==='toggle') { await api(`/api/tasks/${id}`,{method:'PATCH',body:JSON.stringify({completed:!task.completed})}); toast(task.completed?'Task reopened':'Nice work — task complete!'); await loadDashboard(); }
  if (action==='delete' && confirm(`Delete “${task.title}”?`)) { await api(`/api/tasks/${id}`,{method:'DELETE'}); toast('Task deleted'); await loadDashboard(); }
  if (action==='edit') openTask(task);
}
function openTask(task=null) {
  $('#task-form').reset(); $('#task-id').value=task?.id||''; $('#modal-title').textContent=task?'Edit task':'Add a new task'; $('#task-title').value=task?.title||''; $('#task-notes').value=task?.notes||''; $('#task-due').value=localInputDate(task?.due_at); $('#task-priority').value=task?.priority||'medium'; $('#task-recurrence').value=task?.recurrence||'none'; $('#task-reminder').value=String(task?.reminder_minutes??30); $('#task-category').value=task?.category_id||''; $('#task-dialog').showModal(); setTimeout(()=>$('#task-title').focus(),50);
  $('#subtask-box').classList.toggle('hidden', !task); renderModalSubtasks(task);
}
function renderModalSubtasks(task) {
  const subtasks = task?.subtasks || [];
  $('#subtask-list').innerHTML = subtasks.map((subtask)=>`<div class="modal-subtask ${subtask.completed?'done':''}" data-subtask-id="${subtask.id}"><button type="button" data-subtask-action="toggle">${subtask.completed?'☑':'☐'}</button><span>${escapeHtml(subtask.title)}</span><button type="button" data-subtask-action="delete">×</button></div>`).join('');
  $$('.modal-subtask button').forEach((button)=>button.onclick=async()=>{const row=button.closest('.modal-subtask');const current=subtasks.find((item)=>item.id===row.dataset.subtaskId);if(button.dataset.subtaskAction==='toggle')await api(`/api/subtasks/${current.id}`,{method:'PATCH',body:JSON.stringify({completed:!current.completed})});else await api(`/api/subtasks/${current.id}`,{method:'DELETE'});await loadDashboard();renderModalSubtasks(state.tasks.find((item)=>item.id===task.id));});
}

function selectJournalPeriod(period) {
  state.journalPeriod = period; $$('#journal-periods button').forEach((button)=>button.classList.toggle('active', button.dataset.period===period));
  if (period === 'custom') return;
  const now = new Date(); const from = new Date(now);
  if (period === 'week') from.setDate(now.getDate() - ((now.getDay()+6)%7));
  if (period === 'month') from.setDate(1);
  if (period === 'year') { from.setMonth(0); from.setDate(1); }
  $('#journal-from').value = dateValue(from); $('#journal-to').value = dateValue(now);
}
async function showJournal() {
  state.view='journal'; closeMobileSidebar(); $$('.nav-item').forEach((button)=>button.classList.toggle('active', button.id==='journal-nav'));
  $('.stats-grid').classList.add('hidden'); $('.task-section').classList.add('hidden'); $('#journal-view').classList.remove('hidden'); $('#add-task').classList.add('hidden');
  $('#date-label').textContent='PROGRESS, REMEMBERED'; $('#greeting').textContent='My Journal'; selectJournalPeriod(state.journalPeriod); await Promise.all([loadJournalList(),loadJournalReminder()]);
}
function showTasks() {
  state.view='tasks'; $('#journal-view').classList.add('hidden'); $('.stats-grid').classList.remove('hidden'); $('.task-section').classList.remove('hidden'); $('#add-task').classList.remove('hidden');
  const hour=new Date().getHours(); const greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening'; $('#greeting').textContent=`${greeting}, ${state.user.name.split(' ')[0]}.`; $('#date-label').textContent=new Date().toLocaleDateString([], {weekday:'long',month:'long',day:'numeric'}).toUpperCase();
}
function journalQuery() { return { periodType:state.journalPeriod, from:$('#journal-from').value, to:$('#journal-to').value }; }
function renderFacts(facts) {
  const m=facts.metrics; $('#journal-facts').classList.remove('hidden'); $('#journal-facts').innerHTML=`<h3>Verified facts</h3><p class="muted">These numbers come directly from your Tmony activity for ${escapeHtml(facts.period.start)} to ${escapeHtml(facts.period.end)}.</p><div class="fact-grid"><div class="fact"><strong>${m.completedTasks}</strong><small>TASKS COMPLETED</small></div><div class="fact"><strong>${m.completionRate}%</strong><small>COMPLETION RATE</small></div><div class="fact"><strong>${m.highPriorityCompleted}</strong><small>HIGH PRIORITY</small></div><div class="fact"><strong>${m.longestStreak}</strong><small>DAY STREAK</small></div><div class="fact"><strong>${m.subtasksCompleted}</strong><small>SUBTASKS DONE</small></div><div class="fact"><strong>${m.recurringCompleted}</strong><small>RECURRING WINS</small></div><div class="fact"><strong>${m.overdueRecovered}</strong><small>OVERDUE RECOVERED</small></div><div class="fact"><strong>${Object.keys(facts.categories).length}</strong><small>CATEGORIES</small></div></div>`;
}
function journalSection(title, field, values) { return values?.length?`<h3>${title}</h3><ul>${values.map((value,index)=>`<li class="journal-editable" data-field="${field}" data-index="${index}">${escapeHtml(value)}</li>`).join('')}</ul>`:''; }
function renderJournal(journal) {
  state.currentJournal=journal; const c=journal.content; $('#journal-result').classList.remove('hidden');
  $('#journal-result').innerHTML=`<div class="journal-result-head"><div><h2 class="journal-editable" data-field="title">${escapeHtml(c.title)}</h2><p>${journal.period_start} — ${journal.period_end} · ${journal.provider==='groq'?'Written with Groq AI':'Facts-only local edition'}</p></div><div class="journal-result-actions"><button id="journal-edit">Edit</button><button id="journal-save" class="hidden">Save changes</button><button data-download="pdf">PDF ↓</button><button data-download="markdown">Markdown ↓</button></div></div><div class="journal-body"><p class="journal-editable" data-field="overview">${escapeHtml(c.overview)}</p>${journalSection('Achievements','achievements',c.achievements)}${journalSection('Milestones','milestones',c.milestones)}${journalSection('Challenges overcome','challenges',c.challenges)}${journalSection('Progress by category','category_progress',c.category_progress)}${c.daily_journal?.length?`<h3>Daily journal</h3>${c.daily_journal.map((item,index)=>`<div class="journal-day"><strong>${escapeHtml(item.date)}</strong><p class="journal-editable" data-field="daily_journal" data-index="${index}">${escapeHtml(item.entry)}</p></div>`).join('')}`:''}${journalSection('Lessons and reflections','lessons',c.lessons)}${journalSection('Next steps','next_steps',c.next_steps)}<span class="provider-note">Every achievement and number is grounded in your recorded Tmony activity.</span></div>`;
  $('#journal-edit').onclick=()=>{ $$('.journal-editable').forEach((el)=>el.contentEditable='true'); $('#journal-edit').classList.add('hidden'); $('#journal-save').classList.remove('hidden'); };
  $('#journal-save').onclick=saveJournalEdits; $$('[data-download]').forEach((button)=>button.onclick=()=>downloadJournal(button.dataset.download));
  $('#journal-result').scrollIntoView({behavior:'smooth',block:'start'});
}
async function saveJournalEdits() {
  const journal=state.currentJournal; const content=structuredClone(journal.content);
  $$('.journal-editable').forEach((el)=>{const field=el.dataset.field;const value=el.textContent.trim();if(field==='title'||field==='overview')content[field]=value;else if(field==='daily_journal')content.daily_journal[Number(el.dataset.index)].entry=value;else content[field][Number(el.dataset.index)]=value;});
  try{const data=await api(`/api/journals/${journal.id}`,{method:'PATCH',body:JSON.stringify({title:content.title,reflection:journal.reflection,content})});renderJournal(data.journal);toast('Journal changes saved');await loadJournalList();}catch(error){toast(error.message)}
}
async function downloadJournal(format) {
  try{const response=await fetch(`/api/journals/${state.currentJournal.id}/download?format=${format}`,{headers:state.demo?{'x-demo-user':'demo'}:{}});if(!response.ok)throw new Error('Download failed');const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`tmony-journal.${format==='pdf'?'pdf':'md'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){toast(error.message)}
}
async function loadJournalList() {
  try{const data=await api('/api/journals');$('#journal-list').innerHTML=data.journals.length?data.journals.map((journal)=>`<button data-journal-id="${journal.id}"><strong>${escapeHtml(journal.title)}</strong><small>${journal.period_start} — ${journal.period_end}</small><small class="source">${journal.provider==='groq'?'Groq AI':'Local summary'}</small></button>`).join(''):'<p class="muted">No journals yet. Generate your first story.</p>';$$('[data-journal-id]').forEach((button)=>button.onclick=async()=>{try{renderJournal((await api(`/api/journals/${button.dataset.journalId}`)).journal)}catch(error){toast(error.message)}});}catch(error){toast(error.message)}
}
async function loadJournalReminder() {
  try{const {reminder}=await api('/api/journal/reminder');$('#reminder-enabled').checked=reminder.enabled;$('#reminder-day').value=String(reminder.dayOfWeek);$('#reminder-morning').value=reminder.morningTime;$('#reminder-evening').value=reminder.eveningTime;$('#reminder-enabled').disabled=!reminder.calendarConnected;$('#reminder-save').disabled=!reminder.calendarConnected;$('#reminder-status').textContent=!reminder.calendarConnected?'Connect Google Calendar to enable reminders.':reminder.syncStatus==='synced'?'Google Calendar notifications are active.':reminder.syncStatus==='error'?`Sync issue: ${reminder.syncError}`:'Notifications are currently off.';}catch(error){toast(error.message)}
}

$('#auth-switch').onclick=()=>{ state.authMode=state.authMode==='login'?'register':'login'; const register=state.authMode==='register'; $('#name-field').classList.toggle('hidden',!register); $('#auth-title').textContent=register?'Create your calm workspace.':'Good to see you again.'; $('#auth-subtitle').textContent=register?'A better day starts with one clear task.':'Sign in and pick up right where you left off.'; $('#auth-submit').textContent=register?'Create account':'Sign in'; $('#switch-prompt').textContent=register?'Already have an account?':'New here?'; $('#auth-switch').textContent=register?'Sign in':'Create an account'; };
$('#auth-form').onsubmit=async(event)=>{event.preventDefault();try{const body={name:$('#name').value,email:$('#email').value,password:$('#password').value};const data=await api(`/api/auth/${state.authMode}`,{method:'POST',body:JSON.stringify(body)});state.user=data.user;enterApp();}catch(e){toast(e.message)}};
$('#google-login').onclick=()=>location.href='/api/google/login/start';
$('#demo-start').onclick=async()=>{state.demo=true;sessionStorage.setItem('demo','true');const data=await api('/api/demo/start',{method:'POST'});state.user=data.user;enterApp();};
$('#logout').onclick=async()=>{if(!state.demo)await api('/api/auth/logout',{method:'POST'});sessionStorage.removeItem('demo');state.demo=false;state.user=null;showAuth();};
$('#calendar-connect').onclick=()=>{if(state.demo)return toast('Calendar connection becomes available after deployment setup');if(state.user.calendarConnected)return toast('Google Calendar is syncing both ways');location.href='/api/google/calendar/start';};
$('#add-task').onclick=$('#quick-add').onclick=()=>openTask(); $('#modal-close').onclick=$('#modal-cancel').onclick=()=>$('#task-dialog').close();
$('#task-form').onsubmit=async(event)=>{event.preventDefault();const id=$('#task-id').value;const body={title:$('#task-title').value,notes:$('#task-notes').value,dueAt:$('#task-due').value?new Date($('#task-due').value).toISOString():null,priority:$('#task-priority').value,recurrence:$('#task-recurrence').value,reminderMinutes:Number($('#task-reminder').value),categoryId:$('#task-category').value||null};try{await api(id?`/api/tasks/${id}`:'/api/tasks',{method:id?'PATCH':'POST',body:JSON.stringify(body)});$('#task-dialog').close();toast(id?'Task updated':'Task added');await loadDashboard();}catch(e){toast(e.message)}};
$('#subtask-add').onclick=async()=>{const taskId=$('#task-id').value;const title=$('#subtask-title').value.trim();if(!title)return;try{await api(`/api/tasks/${taskId}/subtasks`,{method:'POST',body:JSON.stringify({title})});$('#subtask-title').value='';await loadDashboard();renderModalSubtasks(state.tasks.find((item)=>item.id===taskId));}catch(e){toast(e.message)}};
$('#category-add').onclick=()=>$('#category-dialog').showModal(); $('#category-close').onclick=()=>$('#category-dialog').close();
$('#category-form').onsubmit=async(event)=>{event.preventDefault();try{await api('/api/categories',{method:'POST',body:JSON.stringify({name:$('#category-name').value,color:$('#category-color').value})});$('#category-dialog').close();event.target.reset();await loadDashboard();}catch(e){toast(e.message)}};
$$('.nav-item[data-filter]').forEach((button)=>button.onclick=()=>{showTasks();$$('.nav-item').forEach((b)=>b.classList.remove('active'));button.classList.add('active');state.navFilter=button.dataset.filter;closeMobileSidebar();render();});
$('#journal-nav').onclick=showJournal;
$$('#journal-periods button').forEach((button)=>button.onclick=()=>selectJournalPeriod(button.dataset.period));
$('#journal-from').onchange=$('#journal-to').onchange=()=>{state.journalPeriod='custom';$$('#journal-periods button').forEach((button)=>button.classList.toggle('active',button.dataset.period==='custom'));};
$('#journal-preview').onclick=async()=>{try{$('#journal-view').classList.add('journal-loading');const query=new URLSearchParams(journalQuery());renderFacts((await api(`/api/journal/preview?${query}`)).facts);}catch(error){toast(error.message)}finally{$('#journal-view').classList.remove('journal-loading')}};
$('#journal-generate').onclick=async()=>{try{$('#journal-view').classList.add('journal-loading');$('#journal-generate').textContent='Writing your story…';const data=await api('/api/journal/generate',{method:'POST',body:JSON.stringify({...journalQuery(),reflection:$('#journal-reflection').value})});renderFacts(data.journal.facts);renderJournal(data.journal);toast(data.cached?'Opened your saved journal':data.journal.provider==='groq'?'Your Groq journal is ready':'Journal ready — local facts-only edition');await loadJournalList();}catch(error){toast(error.message)}finally{$('#journal-view').classList.remove('journal-loading');$('#journal-generate').textContent='✦ Generate journal'}};
$('#reminder-save').onclick=async()=>{try{$('#reminder-save').disabled=true;$('#reminder-save').textContent='Syncing with Google…';const {reminder}=await api('/api/journal/reminder',{method:'PUT',body:JSON.stringify({enabled:$('#reminder-enabled').checked,dayOfWeek:Number($('#reminder-day').value),morningTime:$('#reminder-morning').value,eveningTime:$('#reminder-evening').value})});toast(reminder.enabled?'Weekly Calendar notifications enabled':'Weekly notifications disabled');await loadJournalReminder();}catch(error){toast(error.message)}finally{$('#reminder-save').textContent='Save notification schedule';if(state.user?.calendarConnected)$('#reminder-save').disabled=false;}};
$$('.chip').forEach((button)=>button.onclick=()=>{$$('.chip').forEach((b)=>b.classList.remove('active'));button.classList.add('active');state.listFilter=button.dataset.listFilter;render();});
$('#theme-toggle').onclick=()=>{document.body.classList.toggle('dark');localStorage.setItem('theme',document.body.classList.contains('dark')?'dark':'light');};
function closeMobileSidebar() {
  $('.sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-open');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}
$('#mobile-menu').setAttribute('aria-expanded', 'false');
$('#mobile-menu').onclick=()=>{
  const open = $('.sidebar').classList.toggle('open');
  document.body.classList.toggle('sidebar-open', open);
  $('#mobile-menu').setAttribute('aria-expanded', String(open));
};
$('#sidebar-backdrop').onclick=closeMobileSidebar;
document.addEventListener('keydown', (event)=>{ if (event.key === 'Escape') closeMobileSidebar(); });
window.addEventListener('resize', ()=>{ if (window.innerWidth > 900) closeMobileSidebar(); });
if(localStorage.getItem('theme')==='dark')document.body.classList.add('dark');
bootstrap();
