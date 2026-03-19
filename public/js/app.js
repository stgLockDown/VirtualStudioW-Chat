/* ═══════════════════════════════════════════════════════════════════
   Virtual Studio — Main Application
   Dashboard + WebRTC + Recording + Transcription + Annotations
   ═══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const ICE_SERVERS = [
  { urls:'stun:stun.l.google.com:19302' },
  { urls:'stun:stun1.l.google.com:19302' },
  { urls:'stun:stun2.l.google.com:19302' }
];

// ─── State ──────────────────────────────────────────────────────
const S = {
  socket: null,
  localStream: null,
  screenStream: null,
  peers: new Map(),
  roomId: null,
  roomType: null,
  roomName: '',
  userName: '',
  userRole: 'admin',
  isHost: false,
  audioEnabled: true,
  videoEnabled: true,
  screenSharing: false,
  handRaised: false,
  isRecording: false,
  mediaRecorder: null,
  recordedChunks: [],
  recordingStartTime: null,
  blurEnabled: false,
  mirrorVideo: true,
  viewMode: 'gallery',
  participants: [],
  chatMessages: [],
  unreadChat: 0,
  chatOpen: false,
  participantsOpen: false,
  transcriptOpen: false,
  breakoutOpen: false,
  breakoutRooms: [],
  meetingStartTime: null,
  timerInterval: null,
  settings: {},
  waitingList: [],
  // Annotation
  annotating: false,
  annotationTool: 'pen',
  annotationColor: '#e04040',
  annotationSize: 4,
  annotationHistory: [],
  isDrawing: false,
  // Transcription
  recognition: null,
  transcriptEntries: [],
  transcriptLiveText: '',
  // Dashboard
  currentView: 'overview',
  basicMode: false,
  classrooms: [],
  meetingRooms: [],
  recordings: [],
  summaries: [],
  // Theme
  currentTheme: null,
  // Remote Control
  remoteControlling: null,    // socketId of person whose screen we're controlling
  remoteControlledBy: null,   // socketId of person controlling our screen
  rcPendingRequest: null,     // {fromId, fromName} of pending request
  // Integrations
  integrations: []
};

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);

// ─── Utilities ──────────────────────────────────────────────────
function toast(msg, type='info') {
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=msg;
  $('#toast-container').appendChild(t);
  setTimeout(()=>t.remove(),3000);
}
function fmtTime(sec) {
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return h>0?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function initials(n){return n.split(' ').map(x=>x[0]).join('').toUpperCase().slice(0,2);}
function genColor(n){let h=0;for(let i=0;i<n.length;i++)h=n.charCodeAt(i)+((h<<5)-h);const c=['#2d8cff','#8b5cf6','#e04040','#2dd272','#f5a623','#ec4899','#06b6d4','#84cc16'];return c[Math.abs(h)%c.length];}
function escHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function showPage(id){$$('.page').forEach(p=>p.classList.remove('active'));$(`#${id}`).classList.add('active');}
window.openModal=function(id){$(`#${id}`).classList.add('open');};
window.closeModal=function(id){$(`#${id}`).classList.remove('open');};
function fmtDate(ts){if(!ts)return'—';return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function fmtDuration(ms){if(!ms)return'0m';const m=Math.floor(ms/60000);if(m<60)return m+'m';return Math.floor(m/60)+'h '+m%60+'m';}
function fmtSize(b){if(!b)return'0 B';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';}

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════
async function loadDashboard() {
  const view = S.currentView;
  $('#dashboard-title').textContent = {overview:'Overview',classrooms:'Classrooms',meetings:'Meeting Rooms',recordings:'Recordings',summaries:'Meeting Summaries',admin:'Admin Panel',roles:'User Roles'}[view]||'Overview';
  $$('.sidebar-item').forEach(i=>{i.classList.toggle('active',i.dataset.view===view);});
  const c=$('#dashboard-content');

  if(view==='overview') await renderOverview(c);
  else if(view==='classrooms') await renderClassrooms(c);
  else if(view==='meetings') await renderMeetings(c);
  else if(view==='recordings') await renderRecordings(c);
  else if(view==='summaries') await renderSummaries(c);
  else if(view==='admin') await renderAdmin(c);
  else if(view==='roles') await renderRoles(c);
}

async function renderOverview(c) {
  let stats={classrooms:0,meetings:0,recordings:0,summaries:0,activeRooms:0,totalParticipants:0,waitingArea:0};
  try{
    const r=await fetch('/api/overview/stats', { headers: getAuthHeaders() });
    if(r.ok) { const data=await r.json(); stats={...stats,...data}; }
  }catch(e){}
  let liveRooms=[];
  try{const r=await fetch('/api/live-rooms');liveRooms=await r.json();if(!Array.isArray(liveRooms))liveRooms=[];}catch(e){liveRooms=[];}
  liveRooms=liveRooms.filter(r=>(r.participantCount||0)>0);

  c.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon blue">🏫</div><div><div class="stat-value">${stats.classrooms}</div><div class="stat-label">Classrooms</div></div></div>
      <div class="stat-card"><div class="stat-icon green">🤝</div><div><div class="stat-value">${stats.meetings}</div><div class="stat-label">Meeting Rooms</div></div></div>
      <div class="stat-card"><div class="stat-icon purple">🔴</div><div><div class="stat-value">${stats.activeRooms}</div><div class="stat-label">Live Now</div></div></div>
      <div class="stat-card"><div class="stat-icon orange">👥</div><div><div class="stat-value">${stats.totalParticipants}</div><div class="stat-label">In Meetings</div></div></div>
      <div class="stat-card"><div class="stat-icon teal">🎬</div><div><div class="stat-value">${stats.recordings}</div><div class="stat-label">Recordings</div></div></div>
      <div class="stat-card"><div class="stat-icon red">📝</div><div><div class="stat-value">${stats.summaries}</div><div class="stat-label">Summaries</div></div></div>
    </div>
    ${liveRooms.length?`
      <div class="section-header"><h2>🔴 Live Rooms</h2></div>
      <div class="rooms-grid">${liveRooms.map(r=>`
        <div class="room-card" onclick="window.joinRoom('${r.id}','${r.type}','${escHtml(r.name)}')">
          <div class="room-card-header">
            <div class="room-card-icon ${r.type==='classroom'?'classroom':'meeting'}">${r.type==='classroom'?'🏫':'🤝'}</div>
            <span class="room-card-status active">● Live</span>
          </div>
          <h3>${escHtml(r.name)}</h3>
          <p>Host: ${escHtml(r.hostName)} · ${r.participantCount} participant${r.participantCount!==1?'s':''}</p>
          <div class="room-card-footer">
            <span class="room-card-meta">${r.isRecording?'⏺️ Recording':''}</span>
            <button class="btn btn-primary btn-sm">Join →</button>
          </div>
        </div>`).join('')}</div>`:''}
    <div class="section-header" style="margin-top:16px;"><h2>Quick Actions</h2></div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      ${isPrivilegedRole()?`<button class="btn btn-primary" onclick="openModal('create-classroom-modal')">🏫 New Classroom</button>
      <button class="btn btn-success" onclick="openModal('create-meeting-modal')">🤝 New Meeting Room</button>`:''}
      <button class="btn btn-secondary" onclick="S.currentView='recordings';loadDashboard();">🎬 View Recordings</button>
      <button class="btn btn-secondary" onclick="S.currentView='summaries';loadDashboard();">📝 View Summaries</button>
    </div>`;
}

async function renderClassrooms(c) {
  const headers = S.authToken ? { 'Authorization': 'Bearer ' + S.authToken } : {};
  try{const r=await fetch('/api/classrooms', { headers });S.classrooms=await r.json();}catch(e){S.classrooms=[];}
  let liveRooms=[];
  try{const r=await fetch('/api/live-rooms');liveRooms=await r.json();}catch(e){}
  const liveMap=new Map(liveRooms.map(r=>[r.id,r.participantCount||0]));

  c.innerHTML=`
    <div class="section-header"><h2>🏫 Classrooms</h2>${isPrivilegedRole()?`<button class="btn btn-primary" onclick="openModal('create-classroom-modal')">+ New Classroom</button>`:''}</div>
    ${S.classrooms.length?`<div class="rooms-grid">${S.classrooms.map(r=>{const pc=liveMap.get(r.id)||0;const isActive=pc>0;return `
      <div class="room-card">
        <div class="room-card-header">
          <div class="room-card-icon classroom">🏫</div>
          <span class="room-card-status ${isActive?'active':'available'}">${isActive?'● Live ('+pc+')':'● Available'}</span>
        </div>
        <h3>${escHtml(r.name)}</h3>
        <p>${escHtml(r.description||'No description')}</p>
        <div class="room-card-footer">
          <span class="room-card-meta">👥 Max ${r.max_students}</span>
          <div class="room-card-actions">
            ${isActive?`<button class="btn btn-primary btn-sm" onclick="window.joinRoom('${r.id}','classroom','${escHtml(r.name)}')">Join</button>`
            :`${isPrivilegedRole()?`<button class="btn btn-success btn-sm" onclick="window.startRoom('${r.id}','classroom','${escHtml(r.name)}')">Start</button>`:'<span style="font-size:11px;color:var(--text-muted);">Waiting for host</span>'}`}
            ${isPrivilegedRole()?`<button class="room-card-theme-btn" onclick="window.openThemeCustomizer('${r.id}','classroom')">🎨 Theme</button>
            <button class="btn btn-danger btn-sm" onclick="window.deleteClassroom('${r.id}')">🗑️</button>`:''}
            ${isAdminRole()?`<button class="btn btn-sm btn-secondary" onclick="window.openAssignStudents('${r.id}','${escHtml(r.name)}')">📚 Assign</button>`:''}
          </div>
        </div>
      </div>`}).join('')}</div>`
    :`<div class="empty-state"><div class="icon">🏫</div><h3>No classrooms${S.userRole==='student'?' assigned to you':''}</h3><p>${S.userRole==='student'?'Ask your admin to assign you to a classroom':'Create your first classroom to get started'}</p>${isPrivilegedRole()?`<button class="btn btn-primary" onclick="openModal('create-classroom-modal')">+ Create Classroom</button>`:''}</div>`}`;
}

async function renderMeetings(c) {
  try{const r=await fetch('/api/meeting-rooms');S.meetingRooms=await r.json();}catch(e){S.meetingRooms=[];}
  let liveRooms=[];
  try{const r=await fetch('/api/live-rooms');liveRooms=await r.json();}catch(e){}
  const liveMap=new Map(liveRooms.map(r=>[r.id,r.participantCount||0]));

  c.innerHTML=`
    <div class="section-header"><h2>🤝 Meeting Rooms</h2>${isPrivilegedRole()?`<button class="btn btn-primary" onclick="openModal('create-meeting-modal')">+ New Room</button>`:''}</div>
    ${S.meetingRooms.length?`<div class="rooms-grid">${S.meetingRooms.map(r=>{const pc=liveMap.get(r.id)||0;const isActive=pc>0;return `
      <div class="room-card">
        <div class="room-card-header">
          <div class="room-card-icon meeting">🤝</div>
          <span class="room-card-status ${isActive?'active':'available'}">${isActive?'● Live ('+pc+')':'● Available'}</span>
        </div>
        <h3>${escHtml(r.name)}</h3>
        <p>${escHtml(r.description||'No description')}</p>
        <div class="room-card-footer">
          <span class="room-card-meta">👥 Max ${r.max_participants}</span>
          <div class="room-card-actions">
            ${isActive?`<button class="btn btn-primary btn-sm" onclick="window.joinRoom('${r.id}','meeting','${escHtml(r.name)}')">Join</button>`
            :`${isPrivilegedRole()?`<button class="btn btn-success btn-sm" onclick="window.startRoom('${r.id}','meeting','${escHtml(r.name)}')">Start</button>`:'<span style="font-size:11px;color:var(--text-muted);">Waiting for host</span>'}`}
            ${isPrivilegedRole()?`<button class="room-card-theme-btn" onclick="window.openThemeCustomizer('${r.id}','meeting')">🎨 Theme</button>
            <button class="btn btn-danger btn-sm" onclick="window.deleteMeeting('${r.id}')">🗑️</button>`:''}
          </div>
        </div>
      </div>`}).join('')}</div>`
    :`<div class="empty-state"><div class="icon">🤝</div><h3>No meeting rooms yet</h3><p>Create a meeting room for your team</p><button class="btn btn-primary" onclick="openModal('create-meeting-modal')">+ Create Room</button></div>`}`;
}

async function renderRecordings(c) {
  // Fetch recordings with search/filter params
  const params = new URLSearchParams();
  if (S._recSearch) params.set('search', S._recSearch);
  if (S._recInstructor) params.set('instructor', S._recInstructor);
  if (S._recTag) params.set('tag', S._recTag);
  if (S._recStatus) params.set('status', S._recStatus);
  if (S._recRoomType) params.set('roomType', S._recRoomType);
  params.set('sortBy', S._recSortBy || 'created_at');
  params.set('sortDir', S._recSortDir || 'DESC');
  params.set('limit', '50');
  params.set('offset', S._recOffset || '0');

  let recData = { recordings: [], total: 0 };
  try {
    const r = await fetch('/api/recordings?' + params.toString());
    recData = await r.json();
  } catch(e) {}
  S.recordings = recData.recordings || [];
  const total = recData.total || 0;

  // Fetch filter options
  let allTags = [], allInstructors = [];
  try { const r = await fetch('/api/recordings/meta/tags'); allTags = await r.json(); } catch(e) {}
  try { const r = await fetch('/api/recordings/meta/instructors'); allInstructors = await r.json(); } catch(e) {}

  // Stats bar (admin+ only)
  let statsHtml = '';
  if (isAdminRole()) {
    let stats = {};
    try { const r = await fetch('/api/admin/stats', { headers: { 'Authorization': 'Bearer ' + S.authToken } }); stats = await r.json(); } catch(e) {}
    statsHtml = `<div class="recordings-stats">
      <div class="rec-stat-card"><div class="rec-stat-value">${stats.recordings || 0}</div><div class="rec-stat-label">Total Recordings</div></div>
      <div class="rec-stat-card"><div class="rec-stat-value">${fmtSize(stats.totalStorageBytes || 0)}</div><div class="rec-stat-label">Storage Used</div></div>
      <div class="rec-stat-card"><div class="rec-stat-value">${stats.totalViews || 0}</div><div class="rec-stat-label">Total Views</div></div>
      <div class="rec-stat-card"><div class="rec-stat-value">${stats.totalDownloads || 0}</div><div class="rec-stat-label">Total Downloads</div></div>
    </div>`;
  }

  const viewMode = S._recViewMode || 'grid';

  c.innerHTML = `
    ${statsHtml}
    <div class="recordings-toolbar">
      <input type="text" class="recordings-search" id="rec-search" placeholder="Search by name, instructor, room..." value="${escHtml(S._recSearch || '')}">
      <select class="recordings-filter-select" id="rec-filter-instructor">
        <option value="">All Instructors</option>
        ${allInstructors.map(i => `<option value="${escHtml(i.id)}" ${S._recInstructor === i.id ? 'selected' : ''}>${escHtml(i.name)}</option>`).join('')}
      </select>
      <select class="recordings-filter-select" id="rec-filter-tag">
        <option value="">All Tags</option>
        ${allTags.map(t => `<option value="${escHtml(t)}" ${S._recTag === t ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}
      </select>
      <select class="recordings-filter-select" id="rec-filter-status">
        <option value="">All Status</option>
        <option value="new" ${S._recStatus === 'new' ? 'selected' : ''}>New</option>
        <option value="watched" ${S._recStatus === 'watched' ? 'selected' : ''}>Watched</option>
        <option value="flagged" ${S._recStatus === 'flagged' ? 'selected' : ''}>Flagged</option>
        <option value="archived" ${S._recStatus === 'archived' ? 'selected' : ''}>Archived</option>
      </select>
      <select class="recordings-filter-select" id="rec-sort">
        <option value="created_at" ${S._recSortBy === 'created_at' ? 'selected' : ''}>Newest</option>
        <option value="duration" ${S._recSortBy === 'duration' ? 'selected' : ''}>Duration</option>
        <option value="file_size" ${S._recSortBy === 'file_size' ? 'selected' : ''}>Size</option>
        <option value="view_count" ${S._recSortBy === 'view_count' ? 'selected' : ''}>Most Viewed</option>
      </select>
      <div class="recordings-view-toggle">
        <button class="view-toggle-icon ${viewMode === 'grid' ? 'active' : ''}" data-view-mode="grid" title="Grid View">▦</button>
        <button class="view-toggle-icon ${viewMode === 'list' ? 'active' : ''}" data-view-mode="list" title="List View">☰</button>
      </div>
    </div>
    ${S.recordings.length === 0 ? `<div class="recordings-empty"><div class="empty-icon">🎬</div><p>No recordings found</p></div>` :
      viewMode === 'grid' ? renderRecordingsGrid(S.recordings) : renderRecordingsList(S.recordings)}
    ${total > 50 ? `<div class="recordings-pagination">
      <button class="pagination-btn" id="rec-prev" ${parseInt(S._recOffset || 0) === 0 ? 'disabled' : ''}>← Previous</button>
      <span class="pagination-info">Showing ${parseInt(S._recOffset || 0) + 1}-${Math.min(parseInt(S._recOffset || 0) + 50, total)} of ${total}</span>
      <button class="pagination-btn" id="rec-next" ${parseInt(S._recOffset || 0) + 50 >= total ? 'disabled' : ''}>Next →</button>
    </div>` : ''}`;

  // Bind events
  const searchInput = document.getElementById('rec-search');
  let searchTimeout;
  if (searchInput) searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { S._recSearch = searchInput.value; S._recOffset = 0; renderRecordings(c); }, 300);
  });
  document.getElementById('rec-filter-instructor')?.addEventListener('change', e => { S._recInstructor = e.target.value; S._recOffset = 0; renderRecordings(c); });
  document.getElementById('rec-filter-tag')?.addEventListener('change', e => { S._recTag = e.target.value; S._recOffset = 0; renderRecordings(c); });
  document.getElementById('rec-filter-status')?.addEventListener('change', e => { S._recStatus = e.target.value; S._recOffset = 0; renderRecordings(c); });
  document.getElementById('rec-sort')?.addEventListener('change', e => { S._recSortBy = e.target.value; renderRecordings(c); });
  document.querySelectorAll('.view-toggle-icon').forEach(btn => btn.addEventListener('click', () => { S._recViewMode = btn.dataset.viewMode; renderRecordings(c); }));
  document.querySelectorAll('.recording-card, .recording-list-item').forEach(el => el.addEventListener('click', () => openVideoPlayer(el.dataset.recId)));
  document.getElementById('rec-prev')?.addEventListener('click', () => { S._recOffset = Math.max(0, parseInt(S._recOffset || 0) - 50); renderRecordings(c); });
  document.getElementById('rec-next')?.addEventListener('click', () => { S._recOffset = parseInt(S._recOffset || 0) + 50; renderRecordings(c); });
}

function renderRecordingsGrid(recordings) {
  return `<div class="recordings-grid">${recordings.map(r => `
    <div class="recording-card" data-rec-id="${r.id}">
      <div class="recording-card-thumb">
        <span class="thumb-icon">🎬</span>
        <span class="thumb-duration">${fmtDuration(r.duration)}</span>
        ${r.recording_status ? `<span class="thumb-status ${r.recording_status}">${r.recording_status}</span>` : ''}
      </div>
      <div class="recording-card-info">
        <div class="recording-card-title">${escHtml(r.instructor_name || r.recorded_by_name || 'Unknown')} — ${escHtml(r.room_name || 'Recording')}</div>
        <div class="recording-card-meta">
          <span>${fmtDate(r.created_at)}</span>
          <span class="meta-dot"></span>
          <span>${fmtSize(r.file_size)}</span>
          <span class="meta-dot"></span>
          <span>${r.view_count || 0} views</span>
        </div>
        ${r.tags && r.tags !== '[]' ? `<div class="recording-card-tags">${(typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : r.tags).map(t => `<span class="rec-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function renderRecordingsList(recordings) {
  return `<div class="recordings-list-header">
    <span></span><span>Title</span><span>Instructor</span><span>Date</span><span>Duration</span><span>Size</span><span></span>
  </div>
  <div class="recordings-list">${recordings.map(r => `
    <div class="recording-list-item" data-rec-id="${r.id}">
      <div class="list-thumb">🎬</div>
      <div class="list-title">${escHtml(r.room_name || 'Recording')} <span style="font-size:11px;opacity:.6;">${r.recording_status ? `[${r.recording_status}]` : ''}</span></div>
      <div class="list-meta">${escHtml(r.instructor_name || r.recorded_by_name || '—')}</div>
      <div class="list-meta">${fmtDate(r.created_at)}</div>
      <div class="list-meta">${fmtDuration(r.duration)}</div>
      <div class="list-meta">${fmtSize(r.file_size)}</div>
      <div class="list-meta">${r.view_count || 0}👁</div>
    </div>`).join('')}</div>`;
}

/* ─── Video Player ─────────────────────────────────────────────────── */
window.openVideoPlayer = async function(recId) {
  const modal = document.getElementById('video-player-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const video = document.getElementById('video-player');

  // Fetch recording details
  let rec;
  try { const r = await fetch('/api/recordings/' + recId); rec = await r.json(); } catch(e) { return; }

  // Set video source with streaming endpoint
  video.src = '/api/recordings/' + recId + '/stream';
  video.load();

  // Record view
  try {
    await fetch('/api/recordings/' + recId + '/view', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.authToken },
      body: JSON.stringify({ watched_duration: 0, completed: false })
    });
  } catch(e) {}

  // Populate info
  document.getElementById('video-player-name').textContent = (rec.instructor_name || rec.recorded_by_name || 'Unknown') + ' — ' + (rec.room_name || 'Recording');
  document.getElementById('video-player-meta').textContent = fmtDate(rec.created_at);
  document.getElementById('vp-instructor').textContent = rec.instructor_name || rec.recorded_by_name || '—';
  document.getElementById('vp-date').textContent = fmtDate(rec.created_at);
  document.getElementById('vp-duration').textContent = fmtDuration(rec.duration);
  document.getElementById('vp-size').textContent = fmtSize(rec.file_size);
  document.getElementById('vp-room').textContent = rec.room_name || '—';
  document.getElementById('vp-type').textContent = rec.session_type || rec.room_type || '—';
  document.getElementById('vp-views').textContent = (rec.view_count || 0) + ' views';
  document.getElementById('vp-status').textContent = rec.recording_status || 'new';

  // Tags
  const tagsEl = document.getElementById('vp-tags');
  const tagList = rec.tagList || (typeof rec.tags === 'string' ? JSON.parse(rec.tags || '[]') : rec.tags || []);
  tagsEl.innerHTML = tagList.map(t => `<span class="rec-tag">${escHtml(t)}</span>`).join('');

  // Description
  const descEl = document.getElementById('vp-description');
  if (rec.description) { descEl.textContent = rec.description; descEl.classList.add('has-content'); }
  else { descEl.textContent = ''; descEl.classList.remove('has-content'); }

  // Speed controls
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.speed === '1');
    btn.onclick = () => {
      video.playbackRate = parseFloat(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Fullscreen
  document.getElementById('video-fullscreen-btn').onclick = () => {
    if (video.requestFullscreen) video.requestFullscreen();
    else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
  };

  // Download
  document.getElementById('video-download-btn').onclick = () => {
    window.open('/api/recordings/' + recId + '/download', '_blank');
  };
};

window.closeVideoPlayer = function() {
  const modal = document.getElementById('video-player-modal');
  const video = document.getElementById('video-player');
  if (video) { video.pause(); video.src = ''; }
  if (modal) modal.style.display = 'none';
};

async function renderSummaries(c) {
  try{const r=await fetch('/api/summaries');S.summaries=await r.json();}catch(e){S.summaries=[];}
  c.innerHTML=`
    <div class="section-header"><h2>📝 Meeting Summaries</h2></div>
    ${S.summaries.length?`<div class="rooms-grid">${S.summaries.map(s=>`
      <div class="room-card" onclick="window.viewSummary('${s.id}')">
        <div class="room-card-header">
          <div class="room-card-icon" style="background:linear-gradient(135deg,var(--accent-orange),var(--accent-red));">📝</div>
          <span style="font-size:11px;color:var(--text-muted)">${fmtDate(s.generated_at)}</span>
        </div>
        <h3>${escHtml(s.title||s.room_name||'Meeting Summary')}</h3>
        <p>${escHtml((s.summary||'').slice(0,120))}${(s.summary||'').length>120?'...':''}</p>
        <div class="room-card-footer">
          <span class="room-card-meta">⏱️ ${fmtDuration(s.duration)} · 👥 ${(s.attendees||[]).length} attendees</span>
          <button class="btn btn-primary btn-sm">View →</button>
        </div>
      </div>`).join('')}</div>`
    :`<div class="empty-state"><div class="icon">📝</div><h3>No summaries yet</h3><p>Generate summaries from your recordings</p></div>`}`;
}

async function renderAdmin(c) {
  let stats={};
  try{const r=await fetch('/api/admin/stats', { headers: { 'Authorization': 'Bearer ' + S.authToken } });stats=await r.json();}catch(e){}
  const rb = stats.roleBreakdown || {};
  c.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon blue">🏫</div><div><div class="stat-value">${stats.classrooms||0}</div><div class="stat-label">Classrooms</div></div></div>
      <div class="stat-card"><div class="stat-icon green">🤝</div><div><div class="stat-value">${stats.meetings||0}</div><div class="stat-label">Meeting Rooms</div></div></div>
      <div class="stat-card"><div class="stat-icon teal">🎬</div><div><div class="stat-value">${stats.recordings||0}</div><div class="stat-label">Recordings</div></div></div>
      <div class="stat-card"><div class="stat-icon orange">📝</div><div><div class="stat-value">${stats.summaries||0}</div><div class="stat-label">Summaries</div></div></div>
      <div class="stat-card"><div class="stat-icon purple">👥</div><div><div class="stat-value">${stats.users||0}</div><div class="stat-label">Total Users</div></div></div>
      <div class="stat-card"><div class="stat-icon red">💾</div><div><div class="stat-value">${fmtSize(stats.totalStorageBytes||0)}</div><div class="stat-label">Storage Used</div></div></div>
    </div>
    <div class="section-header"><h2>Role Breakdown</h2></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon" style="background:rgba(255,193,7,.15);color:#ffc107;">👑</div><div><div class="stat-value">${rb.owner||0}</div><div class="stat-label">Owners</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(156,39,176,.15);color:#ce93d8;">💻</div><div><div class="stat-value">${rb.developer||0}</div><div class="stat-label">Developers</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(244,67,54,.15);color:#ef5350;">🛡️</div><div><div class="stat-value">${rb.admin||0}</div><div class="stat-label">Admins</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(45,140,255,.15);color:#6db3f8;">🎓</div><div><div class="stat-value">${rb.instructor||0}</div><div class="stat-label">Instructors</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:rgba(76,175,80,.15);color:#81c784;">📚</div><div><div class="stat-value">${rb.student||0}</div><div class="stat-label">Students</div></div></div>
    </div>
    <div class="section-header"><h2>System Info</h2></div>
    <div class="room-card" style="cursor:default;">
      <p style="color:var(--text-secondary);line-height:1.8;">
        <strong>Active Rooms:</strong> ${stats.activeRooms||0}<br>
        <strong>Total Participants:</strong> ${stats.totalParticipants||0}<br>
        <strong>Waiting Area:</strong> ${stats.waitingArea||0}<br>
        <strong>Total Views:</strong> ${stats.totalViews||0}<br>
        <strong>Total Downloads:</strong> ${stats.totalDownloads||0}<br>
        <strong>Server:</strong> Railway-ready Node.js + Socket.IO<br>
        <strong>Database:</strong> PostgreSQL<br>
        <strong>Media:</strong> WebRTC P2P Mesh + MediaRecorder API<br>
        <strong>Transcription:</strong> Web Speech API (live)<br>
        <strong>AI Summaries:</strong> OpenAI-compatible (set OPENAI_API_KEY)<br>
      </p>
    </div>
    <div class="section-header" style="margin-top:24px;"><h2>🔗 Integrations</h2></div>
    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px;">Connect Slack, Discord, or webhooks to automatically receive meeting summaries and notifications.</p>
    <button class="btn btn-primary" onclick="window.openIntegrations()">⚙️ Manage Integrations</button>`;
}

/* ─── Roles Management View ──────────────────────────────────────── */
async function renderRoles(c) {
  if (!isAdminRole()) { S.currentView = 'overview'; loadDashboard(); return; }
  let users = [];
  try {
    const r = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + S.authToken } });
    users = await r.json();
  } catch(e) {}

  c.innerHTML = `
    <div class="section-header"><h2>👥 User Role Management</h2></div>
    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">
      Hierarchy: <span class="role-badge owner">Owner</span> &gt;
      <span class="role-badge developer">Developer</span> &gt;
      <span class="role-badge admin">Admin</span> &gt;
      <span class="role-badge instructor">Instructor</span> &gt;
      <span class="role-badge student">Student</span>
      &nbsp;|&nbsp; Users with <strong>@game-u.com</strong> email are auto-assigned Instructor on signup.
    </p>
    <table class="roles-table">
      <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Joined</th><th>Last Seen</th><th>Action</th></tr></thead>
      <tbody>
        ${users.map(u => `<tr>
          <td><strong>${escHtml(u.name)}</strong></td>
          <td>${escHtml(u.username)}</td>
          <td>${escHtml(u.email || '—')}</td>
          <td><span class="role-badge ${u.role}">${u.role}</span></td>
          <td style="font-size:12px;">${fmtDate(u.created_at)}</td>
          <td style="font-size:12px;">${u.last_seen ? fmtDate(u.last_seen) : '—'}</td>
          <td>${u.id !== S.authUser?.id ? `<button class="role-change-btn" onclick="window.openRoleChange('${u.id}','${escHtml(u.name)}','${u.role}')">Change</button>` : '<span style="font-size:11px;color:var(--text-secondary);">You</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

window.openRoleChange = function(userId, userName, currentRole) {
  document.getElementById('role-change-user-id').value = userId;
  document.getElementById('role-change-user-info').innerHTML = `Changing role for <strong>${userName}</strong> (currently <span class="role-badge ${currentRole}">${currentRole}</span>)`;
  document.getElementById('role-change-select').value = currentRole;
  document.getElementById('role-change-error').style.display = 'none';
  openModal('role-management-modal');
};

document.getElementById('role-change-save-btn')?.addEventListener('click', async () => {
  const userId = document.getElementById('role-change-user-id').value;
  const newRole = document.getElementById('role-change-select').value;
  const errEl = document.getElementById('role-change-error');
  try {
    const resp = await fetch('/api/admin/users/' + userId + '/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.authToken },
      body: JSON.stringify({ role: newRole })
    });
    const data = await resp.json();
    if (!resp.ok) {
      errEl.textContent = data.error || 'Failed to change role';
      errEl.style.display = '';
      return;
    }
    closeModal('role-management-modal');
    toast('Role updated to ' + newRole, 'success');
    if (S.currentView === 'roles') renderRoles(document.getElementById('dashboard-content'));
  } catch(e) {
    errEl.textContent = 'Connection error';
    errEl.style.display = '';
  }
});

// ─── Dashboard Actions ──────────────────────────────────────────
window.deleteClassroom=async function(id){if(!confirm('Delete this classroom?'))return;await fetch(`/api/classrooms/${id}`,{method:'DELETE'});toast('Classroom deleted','success');loadDashboard();};
window.deleteMeeting=async function(id){if(!confirm('Delete this meeting room?'))return;await fetch(`/api/meeting-rooms/${id}`,{method:'DELETE'});toast('Meeting room deleted','success');loadDashboard();};
window.deleteRecording=async function(id){if(!confirm('Delete this recording?'))return;await fetch(`/api/recordings/${id}`,{method:'DELETE'});toast('Recording deleted','success');loadDashboard();};

window.viewSummary=async function(id){
  try{
    const r=await fetch(`/api/summaries/${id}`);const s=await r.json();
    const data = {
      title: s.title || s.room_name || 'Meeting Summary',
      summary: s.summary || '',
      keyPoints: s.key_points || [],
      actionItems: s.action_items || [],
      attendees: s.attendees || [],
      roomName: s.room_name || '',
      duration: fmtDuration(s.duration)
    };
    openModal('ai-summary-modal');
    renderAISummary(data, s.recording_id);
    $('#ai-summary-footer').style.display='flex';
  }catch(e){toast('Failed to load summary','error');}
};

window.viewSummaryForRecording=async function(recId){
  try{
    const r=await fetch('/api/summaries');const all=await r.json();
    const s=all.find(x=>x.recording_id===recId);
    if(s)window.viewSummary(s.id);else toast('No summary found','warning');
  }catch(e){toast('Error','error');}
};

window.generateSummary=async function(recId){
  try{
    // Show AI summary modal with loading state
    openModal('ai-summary-modal');
    $('#ai-summary-content').innerHTML='<div style="text-align:center;padding:40px;"><div class="spinner"></div><p style="color:var(--text-secondary);margin-top:12px;">🤖 Generating AI summary...</p></div>';
    $('#ai-summary-footer').style.display='none';

    const r=await fetch(`/api/recordings/${recId}/generate-summary`,{method:'POST',headers:{'Content-Type':'application/json'}});
    const data=await r.json();
    if(data.error){throw new Error(data.error);}

    // Render rich summary
    renderAISummary(data, recId);
    $('#ai-summary-footer').style.display='flex';
    toast('✅ AI Summary generated!','success');
    loadDashboard();
  }catch(e){
    $('#ai-summary-content').innerHTML=`<div style="text-align:center;padding:40px;color:var(--text-secondary);"><div style="font-size:48px;margin-bottom:12px;">⚠️</div><p>Failed to generate summary: ${escHtml(e.message)}</p><button class="btn btn-primary" onclick="closeModal('ai-summary-modal')">Close</button></div>`;
    toast('Failed to generate summary','error');
  }
};

function renderAISummary(data, recId) {
  const html = `<div class="ai-summary-container">
    <div class="ai-summary-header">
      <div>
        <span class="ai-summary-badge">🤖 AI Generated</span>
        <div class="ai-summary-title">${escHtml(data.title||'Meeting Summary')}</div>
        <div class="ai-summary-meta">${escHtml(data.roomName||'')} • ${escHtml(data.duration||'')} • ${data.attendees?.length||0} participants</div>
      </div>
    </div>
    <div class="ai-summary-section">
      <h4>📋 Summary</h4>
      <p>${escHtml(data.summary||'No summary available')}</p>
    </div>
    ${data.keyPoints&&data.keyPoints.length?`<div class="ai-summary-section">
      <h4>🔑 Key Points</h4>
      <ul>${data.keyPoints.map(k=>`<li>${escHtml(k)}</li>`).join('')}</ul>
    </div>`:''}
    ${data.actionItems&&data.actionItems.length?`<div class="ai-summary-section">
      <h4>✅ Action Items</h4>
      <ul class="action-items">${data.actionItems.map(a=>`<li>${escHtml(a)}</li>`).join('')}</ul>
    </div>`:''}
    ${data.decisions&&data.decisions.length?`<div class="ai-summary-section">
      <h4>⚖️ Decisions</h4>
      <ul class="decisions">${data.decisions.map(d=>`<li>${escHtml(d)}</li>`).join('')}</ul>
    </div>`:''}
    ${data.topics&&data.topics.length?`<div class="ai-summary-section">
      <h4>💬 Topics</h4>
      <div class="ai-summary-topics">${data.topics.map(t=>`<span class="ai-summary-topic">${escHtml(t)}</span>`).join('')}</div>
    </div>`:''}
    ${data.attendees&&data.attendees.length?`<div class="ai-summary-section">
      <h4>👥 Attendees</h4>
      <div class="ai-summary-attendees">${data.attendees.map(a=>`<span class="ai-summary-attendee">👤 ${escHtml(a)}</span>`).join('')}</div>
    </div>`:''}
  </div>`;
  $('#ai-summary-content').innerHTML = html;

  // Wire up export buttons
  $('#summary-export-md').onclick = () => {
    const md = `# ${data.title||'Meeting Summary'}\n\n**Room:** ${data.roomName||'N/A'}\n**Duration:** ${data.duration||'N/A'}\n**Attendees:** ${(data.attendees||[]).join(', ')}\n\n## Summary\n${data.summary||''}\n\n## Key Points\n${(data.keyPoints||[]).map(k=>`- ${k}`).join('\n')}\n\n## Action Items\n${(data.actionItems||[]).map(a=>`- [ ] ${a}`).join('\n')}\n\n${data.decisions?.length?`## Decisions\n${data.decisions.map(d=>`- ${d}`).join('\n')}\n`:''}\n${data.topics?.length?`## Topics\n${data.topics.join(', ')}\n`:''}\n---\n*Generated by Virtual Studio AI*`;
    const blob = new Blob([md], {type:'text/markdown'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`summary-${Date.now()}.md`; a.click();
    URL.revokeObjectURL(url);
    toast('📄 Markdown exported!','success');
  };
  $('#summary-send-integrations').onclick = async () => {
    try {
      const intResp = await fetch('/api/integrations');
      const integrations = await intResp.json();
      const enabled = integrations.filter(i => i.enabled);
      if (enabled.length === 0) {
        toast('No integrations configured. Go to Admin > Integrations to set up.','warning');
        return;
      }
      // Trigger re-dispatch by calling the summary endpoint again
      toast(`🔗 Sending to ${enabled.length} integration(s)...`,'info');
      // The server already dispatched on generation, but we can trigger manually
      for (const int of enabled) {
        await fetch(`/api/integrations/${int.id}/test`, {method:'POST'});
      }
      toast('✅ Sent to all integrations!','success');
    } catch(e) { toast('Failed to send to integrations','error'); }
  };
}

// ─── Integrations Management ──────────────────────────────────────
window.openIntegrations=async function(){
  openModal('integrations-modal');
  await loadIntegrations();
};

async function loadIntegrations(){
  try{
    const r=await fetch('/api/integrations');
    S.integrations=await r.json();
  }catch(e){S.integrations=[];}
  renderIntegrations();
}

function renderIntegrations(){
  const list=$('#integrations-list');
  if(!S.integrations.length){
    list.innerHTML='<div class="integration-empty"><div class="icon">🔗</div><h3>No integrations yet</h3><p>Add Slack, Discord, or webhook integrations to receive meeting summaries automatically.</p></div>';
    return;
  }
  list.innerHTML=S.integrations.map(int=>{
    const icons={slack:'💬',discord:'🎮',webhook:'🔗'};
    const evts=(int.events||[]).join(', ');
    return `<div class="integration-card" data-id="${int.id}">
      <div class="integration-icon ${int.type}">${icons[int.type]||'🔗'}</div>
      <div class="integration-info">
        <div class="integration-name">${escHtml(int.name)}</div>
        <div class="integration-meta">${int.type.toUpperCase()} • Events: ${evts}</div>
      </div>
      <div class="integration-actions">
        <button class="btn btn-sm btn-secondary" onclick="window.testIntegration('${int.id}')">🧪 Test</button>
        <div class="integration-toggle ${int.enabled?'active':''}" onclick="window.toggleIntegration('${int.id}',${int.enabled?0:1})"></div>
        <button class="btn btn-sm btn-danger" onclick="window.deleteIntegration('${int.id}')" style="padding:4px 8px;">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

window.testIntegration=async function(id){
  try{
    toast('🧪 Testing integration...','info');
    const r=await fetch(`/api/integrations/${id}/test`,{method:'POST'});
    const data=await r.json();
    if(data.success)toast('✅ Test successful!','success');
    else toast('❌ Test failed: '+(data.error||'Unknown error'),'error');
  }catch(e){toast('❌ Test failed','error');}
};

window.toggleIntegration=async function(id,enabled){
  await fetch(`/api/integrations/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!!enabled})});
  await loadIntegrations();
};

window.deleteIntegration=async function(id){
  if(!confirm('Delete this integration?'))return;
  await fetch(`/api/integrations/${id}`,{method:'DELETE'});
  toast('Integration deleted','success');
  await loadIntegrations();
};

// ─── Room Start / Join ──────────────────────────────────────────
window.startRoom=function(id,type,name){
  S.roomId=id; S.roomType=type; S.roomName=name; S.isHost=true;
  goToLobby();
};

window.joinRoom=function(id,type,name){
  S.roomId=id; S.roomType=type; S.roomName=name; S.isHost=false;
  goToLobby();
};

async function goToLobby(){
  S.userName = S.authUser ? S.authUser.name : ($('#user-name-input').value.trim()||'User');
  S.userRole = S.authUser ? S.authUser.role : $('#user-role-select').value;
  showPage('lobby-page');
  $('#lobby-title').textContent=S.isHost?`Start: ${S.roomName}`:`Join: ${S.roomName}`;
  $('#lobby-subtitle').textContent=`${S.roomType==='classroom'?'Classroom':'Meeting'} · ${S.roomId}`;
  $('#lobby-avatar').textContent=initials(S.userName);
  try{
    const vidConstraints = S.basicMode ? {width:{ideal:320},height:{ideal:240},frameRate:{ideal:10,max:15}} : {width:{ideal:1280},height:{ideal:720}};
    S.localStream=await navigator.mediaDevices.getUserMedia({video:vidConstraints,audio:{echoCancellation:true,noiseSuppression:true}});
    $('#lobby-video').srcObject=S.localStream;
    $('#lobby-video').style.display='block';
    $('#lobby-placeholder').style.display='none';
  }catch(e){
    try{S.localStream=await navigator.mediaDevices.getUserMedia({audio:true});S.videoEnabled=false;}
    catch(e2){S.localStream=new MediaStream();S.audioEnabled=false;S.videoEnabled=false;}
    $('#lobby-video').style.display='none';
    $('#lobby-placeholder').style.display='flex';
    toast('⚠️ Camera not available','warning');
  }
  updateLobbyControls();
}

function updateLobbyControls(){
  $('#lobby-mic-btn').classList.toggle('off',!S.audioEnabled);
  $('#lobby-mic-btn').textContent=S.audioEnabled?'🎤':'🔇';
  $('#lobby-cam-btn').classList.toggle('off',!S.videoEnabled);
}

// ─── Socket Connection ──────────────────────────────────────────
function connectSocket(){
  if(S.socket&&S.socket.connected)return;
  S.socket=io(window.location.origin,{transports:['websocket','polling'],reconnection:true,reconnectionAttempts:10});
  S.socket.on('connect',()=>{console.log('[Socket] Connected');S.socket.emit('register-user',{name:S.userName,role:S.userRole,userId:S.authUser?.id});});
  S.socket.on('disconnect',()=>{toast('⚠️ Connection lost','warning');});
  S.socket.on('reconnect',()=>{toast('✅ Reconnected','success');});

  // Signaling
  S.socket.on('user-joined',async({userId,userName,userRole,audioEnabled,videoEnabled})=>{
    toast(`👋 <b>${userName}</b> joined`,'info');
    await createPeer(userId,userName,userRole,true,audioEnabled,videoEnabled);
  });
  S.socket.on('offer',async({from,offer})=>{
    let peer=S.peers.get(from);
    if(!peer){await createPeer(from,'Participant','student',false,true,true);peer=S.peers.get(from);}
    if(!peer) return;
    try {
      const pc = peer.pc;
      // Perfect negotiation: handle offer collision
      const offerCollision = (peer._makingOffer || pc.signalingState !== 'stable');
      // Polite peer: the one with the lower socket ID yields
      const polite = S.socket.id < from;
      peer._ignoreOffer = !polite && offerCollision;
      if(peer._ignoreOffer) return;

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      // If we had pending ICE candidates, they're now applied
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      S.socket.emit('answer',{to:from,answer:pc.localDescription});
    } catch(e){ console.error('[WebRTC] offer handling error:', e); }
  });
  S.socket.on('answer',async({from,answer})=>{const p=S.peers.get(from);if(p)try{await p.pc.setRemoteDescription(new RTCSessionDescription(answer));}catch(e){}});
  S.socket.on('ice-candidate',async({from,candidate})=>{const p=S.peers.get(from);if(p&&candidate)try{await p.pc.addIceCandidate(new RTCIceCandidate(candidate));}catch(e){}});
  S.socket.on('user-left',({userId,userName})=>{removePeer(userId);if(userName)toast(`👋 <b>${userName}</b> left`,'info');});
  S.socket.on('user-toggle-audio',({userId,enabled})=>{const p=S.peers.get(userId);if(p){p.audioEnabled=enabled;updateVideoGrid();}});
  S.socket.on('user-toggle-video',({userId,enabled})=>{const p=S.peers.get(userId);if(p){p.videoEnabled=enabled;updateVideoGrid();}});
  S.socket.on('user-screen-share',({userId,sharing})=>{const p=S.peers.get(userId);if(p){p.screenSharing=sharing;updateVideoGrid();updateRemoteControlVisibility();}});
  S.socket.on('user-hand-raised',({userId,raised,userName})=>{const p=S.peers.get(userId);if(p)p.handRaised=raised;updateVideoGrid();if(raised)toast(`✋ <b>${userName}</b> raised hand`,'info');});
  S.socket.on('chat-message',msg=>{S.chatMessages.push(msg);renderChatMsg(msg);if(!S.chatOpen){S.unreadChat++;updateBadges();}});
  S.socket.on('reaction',({userName,emoji})=>{showReaction(emoji);toast(`${emoji} <b>${userName}</b>`,'info');});
  S.socket.on('force-mute',()=>{toggleAudio(false);toast('🔇 You were muted by the host','warning');});
  S.socket.on('removed-from-meeting',()=>{toast('⛔ Removed from meeting','error');leaveMeeting();});
  S.socket.on('meeting-ended',()=>{toast('⛔ Meeting ended','error');leaveMeeting();});
  S.socket.on('meeting-locked',({locked})=>{S.settings.locked=locked;$('#meeting-lock-icon').style.display=locked?'inline':'none';});
  S.socket.on('recording-status',({recording,startedBy})=>{S.isRecording=recording;$('#recording-indicator').classList.toggle('active',recording);toast(recording?`⏺️ Recording by ${startedBy}`:'⏹️ Recording stopped','info');});
  S.socket.on('settings-updated',s=>{S.settings=s;});
  S.socket.on('new-host',({hostId,hostName})=>{S.isHost=(S.socket.id===hostId);toast(`👑 <b>${hostName}</b> is now host`,'info');updateHostUI();});
  S.socket.on('participants-update',({participants})=>{S.participants=participants;renderParticipants();updateBadges();});
  S.socket.on('waiting-room-update',({waitingList})=>{S.waitingList=waitingList;renderWaitingRoom();});
  S.socket.on('admitted',data=>{$('#lobby-waiting').style.display='none';$('#lobby-join-btn').style.display='';enterMeeting(data);});
  S.socket.on('denied',()=>{$('#lobby-waiting').style.display='none';$('#lobby-join-btn').style.display='';toast('⛔ Denied by host','error');showPage('dashboard-page');});
  // Transcript
  S.socket.on('transcript-segment',seg=>{
    if(seg.isFinal){S.transcriptEntries.push(seg);renderTranscriptEntry(seg);}
    else{$('#transcript-live').textContent=`${seg.speaker}: ${seg.text}`;}
  });
  // Annotations
  S.socket.on('annotation-draw',data=>{drawAnnotation(data);});
  S.socket.on('annotation-clear',()=>{clearCanvas();});
  S.socket.on('theme-updated',(theme)=>{handleThemeUpdate(theme);});
  S.socket.on('annotation-sync',data=>{clearCanvas();data.forEach(d=>drawAnnotation(d));});
  // Remote control - proper approval flow
  S.socket.on('remote-control-request',({fromId,fromName})=>{
    S.rcPendingRequest={fromId,fromName};
    $('#rc-requester-name').textContent=fromName;
    openModal('remote-control-modal');
    // Auto-deny after 30s
    S._rcTimeout=setTimeout(()=>{
      if(S.rcPendingRequest&&S.rcPendingRequest.fromId===fromId){
        S.socket.emit('deny-remote-control',{toId:fromId});
        S.rcPendingRequest=null;
        closeModal('remote-control-modal');
      }
    },30000);
  });
  S.socket.on('remote-control-granted',({sharerId,sharerName})=>{
    S.remoteControlling=sharerId;
    toast('🖱️ Remote control granted! You can now control the shared screen.','success');
    showRemoteControlBar(`You are controlling ${sharerName||'the screen'}`,true);
    initRemoteControlSender(sharerId);
  });
  S.socket.on('remote-control-denied',({sharerName})=>{
    toast(`🖱️ ${sharerName||'User'} denied your control request`,'info');
  });
  S.socket.on('remote-control-revoked',()=>{
    S.remoteControlling=null;
    toast('🖱️ Remote control revoked','info');
    hideRemoteControlBar();
    cleanupRemoteControl();
  });
  S.socket.on('remote-control-active',({controllerId,controllerName,sharerId,sharerName})=>{
    if(controllerId!==S.socket.id&&sharerId!==S.socket.id){
      toast(`🖱️ ${controllerName} is controlling ${sharerName||'the screen'}`,'info');
    }
  });
  S.socket.on('remote-control-ended',()=>{
    S.remoteControlling=null;
    S.remoteControlledBy=null;
    hideRemoteControlBar();
    cleanupRemoteControl();
  });
  S.socket.on('remote-control-event',({fromId,event})=>{
    handleIncomingControlEvent(event);
  });
  // Breakout
  S.socket.on('breakout-rooms-update',({breakoutRooms})=>{S.breakoutRooms=breakoutRooms;renderBreakoutRooms(breakoutRooms);});
  S.socket.on('breakout-invitation',({breakoutId,breakoutName})=>{if(confirm(`You're invited to breakout room "${breakoutName}". Join?`)){S.socket.emit('leave-room');S.roomId=breakoutId;S.socket.emit('join-room',{roomId:breakoutId,userName:S.userName,userRole:S.userRole},(r)=>{if(r.success&&!r.waiting)enterMeeting(r);});}});
  S.socket.on('breakout-closed',({returnTo})=>{toast('Breakout room closed, returning...','info');S.socket.emit('leave-room');S.peers.forEach(p=>p.pc.close());S.peers.clear();S.roomId=returnTo;S.socket.emit('join-room',{roomId:returnTo,userName:S.userName,userRole:S.userRole},(r)=>{if(r.success&&!r.waiting)enterMeeting(r);});});
}

// ─── WebRTC ─────────────────────────────────────────────────────
async function createPeer(id,name,role,initiator,audioEnabled=true,videoEnabled=true){
  if(S.peers.has(id))return;
  const pc=new RTCPeerConnection({iceServers:ICE_SERVERS});
  const peer={pc,stream:null,name,role,audioEnabled,videoEnabled,screenSharing:false,handRaised:false,_makingOffer:false,_ignoreOffer:false};
  S.peers.set(id,peer);

  // Add all local tracks
  const streamToSend = S.screenSharing && S.screenStream ? S.screenStream : S.localStream;
  if(S.localStream) {
    S.localStream.getTracks().forEach(t => {
      // If screen sharing, replace video track with screen track
      if(t.kind === 'video' && S.screenSharing && S.screenStream) {
        const screenTrack = S.screenStream.getVideoTracks()[0];
        if(screenTrack) { pc.addTrack(screenTrack, S.localStream); return; }
      }
      pc.addTrack(t, S.localStream);
    });
  } else if(S.screenStream) {
    S.screenStream.getTracks().forEach(t => pc.addTrack(t, S.screenStream));
  }

  pc.ontrack = e => {
    if(e.streams && e.streams[0]) {
      peer.stream = e.streams[0];
      // Also listen for tracks being added later (renegotiation)
      e.streams[0].onaddtrack = () => updateVideoGrid();
      e.streams[0].onremovetrack = () => updateVideoGrid();
      updateVideoGrid();
    }
  };
  pc.onicecandidate = e => { if(e.candidate) S.socket.emit('ice-candidate',{to:id,candidate:e.candidate}); };
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if(state === 'failed') { console.warn(`[WebRTC] ICE failed for ${name}, restarting...`); pc.restartIce(); }
    else if(state === 'connected' || state === 'completed') updateVideoGrid();
  };
  pc.onconnectionstatechange = () => {
    if(pc.connectionState === 'failed') pc.restartIce();
  };

  // Perfect negotiation: handle onnegotiationneeded
  pc.onnegotiationneeded = async () => {
    try {
      peer._makingOffer = true;
      const offer = await pc.createOffer();
      if(pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      S.socket.emit('offer',{to:id,offer:pc.localDescription});
    } catch(e) { console.warn('[WebRTC] negotiationneeded error:', e); }
    finally { peer._makingOffer = false; }
  };

  if(initiator){
    try{
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      S.socket.emit('offer',{to:id,offer:pc.localDescription});
    } catch(e){ console.warn('[WebRTC] initial offer error:', e); }
  }
  updateVideoGrid();
}
function removePeer(id){const p=S.peers.get(id);if(p){p.pc.close();S.peers.delete(id);updateVideoGrid();}}

// ─── Media Controls ─────────────────────────────────────────────
function toggleAudio(enabled){
  if(enabled===undefined)enabled=!S.audioEnabled;
  S.audioEnabled=enabled;
  if(S.localStream)S.localStream.getAudioTracks().forEach(t=>{t.enabled=enabled;});
  updateToolbar();
  if(S.socket)S.socket.emit('toggle-audio',{enabled});
}
function toggleVideo(enabled){
  if(enabled===undefined)enabled=!S.videoEnabled;
  S.videoEnabled=enabled;
  if(S.localStream)S.localStream.getVideoTracks().forEach(t=>{t.enabled=enabled;});
  updateToolbar();updateVideoGrid();
  if(S.socket)S.socket.emit('toggle-video',{enabled});
}

// ─── Screen Share Picker ──────────────────────────────────────────────
async function showScreenSharePicker() {
  // Electron path: use desktopCapturer
  const electronAPI = window.electronAPI || window.desktop;
  const isElectron = electronAPI && electronAPI.getScreenSources;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;flex-direction:column;align-items:center;padding:30px;overflow-y:auto;backdrop-filter:blur(8px);';

    const title = document.createElement('h2');
    title.textContent = 'Choose what to share';
    title.style.cssText = 'color:#e8eaed;margin-bottom:6px;font-family:Inter,sans-serif;font-size:22px;';
    overlay.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.textContent = isElectron ? 'Select a screen or window' : 'Select a sharing option below';
    subtitle.style.cssText = 'color:#9aa0a6;font-size:13px;margin-bottom:20px;font-family:Inter,sans-serif;';
    overlay.appendChild(subtitle);

    // Audio toggle
    const audioRow = document.createElement('div');
    audioRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:10px 16px;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:10px;';
    const audioCb = document.createElement('input');
    audioCb.type = 'checkbox'; audioCb.id = 'share-audio-cb'; audioCb.checked = true;
    audioCb.style.cssText = 'width:18px;height:18px;accent-color:#2d8cff;cursor:pointer;';
    const audioLabel = document.createElement('label');
    audioLabel.htmlFor = 'share-audio-cb';
    audioLabel.style.cssText = 'color:#e8eaed;font-size:14px;cursor:pointer;font-family:Inter,sans-serif;';
    audioLabel.textContent = '\uD83D\uDD0A Share system audio';
    audioRow.appendChild(audioCb); audioRow.appendChild(audioLabel);
    overlay.appendChild(audioRow);

    if (isElectron) {
      electronAPI.getScreenSources().then(sources => {
        const screens = sources.filter(s => s.id.startsWith('screen:'));
        const windows = sources.filter(s => !s.id.startsWith('screen:'));

        function addSection(label, items) {
          if (items.length === 0) return;
          const sectionTitle = document.createElement('div');
          sectionTitle.textContent = label;
          sectionTitle.style.cssText = 'color:#9aa0a6;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px;width:100%;max-width:1000px;font-family:Inter,sans-serif;';
          overlay.appendChild(sectionTitle);
          const grid = document.createElement('div');
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;max-width:1000px;width:100%;';
          items.forEach(src => {
            const card = document.createElement('div');
            card.style.cssText = 'background:#1a1a2e;border:2px solid #2a2a3e;border-radius:12px;padding:12px;cursor:pointer;transition:all 0.2s;';
            card.onmouseenter = () => { card.style.borderColor = '#2d8cff'; card.style.transform = 'scale(1.02)'; };
            card.onmouseleave = () => { card.style.borderColor = '#2a2a3e'; card.style.transform = 'scale(1)'; };
            const img = document.createElement('img');
            img.src = src.thumbnail;
            img.style.cssText = 'width:100%;border-radius:8px;margin-bottom:8px;aspect-ratio:16/9;object-fit:cover;background:#0f0f17;';
            card.appendChild(img);
            const lbl = document.createElement('div');
            lbl.textContent = src.name;
            lbl.style.cssText = 'color:#e8eaed;font-size:13px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-family:Inter,sans-serif;';
            card.appendChild(lbl);
            card.onclick = () => { overlay.remove(); resolve({ type: 'electron', sourceId: src.id, shareAudio: audioCb.checked }); };
            grid.appendChild(card);
          });
          overlay.appendChild(grid);
        }
        addSection('Screens', screens);
        addSection('Application Windows', windows);
      });
    } else {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;max-width:700px;width:100%;';
      const options = [
        { icon: '\uD83D\uDDA5\uFE0F', label: 'Entire Screen', desc: 'Share your full screen', type: 'screen' },
        { icon: '\uD83E\uDE9F', label: 'Window', desc: 'Share a specific window', type: 'window' },
        { icon: '\uD83D\uDCD1', label: 'Browser Tab', desc: 'Share a browser tab', type: 'tab' }
      ];
      options.forEach(opt => {
        const card = document.createElement('div');
        card.style.cssText = 'background:#1a1a2e;border:2px solid #2a2a3e;border-radius:12px;padding:24px 16px;cursor:pointer;transition:all 0.2s;text-align:center;';
        card.onmouseenter = () => { card.style.borderColor = '#2d8cff'; card.style.transform = 'scale(1.02)'; card.style.background = '#1e1e35'; };
        card.onmouseleave = () => { card.style.borderColor = '#2a2a3e'; card.style.transform = 'scale(1)'; card.style.background = '#1a1a2e'; };
        card.innerHTML = '<div style="font-size:36px;margin-bottom:10px;">' + opt.icon + '</div><div style="color:#e8eaed;font-size:15px;font-weight:600;margin-bottom:4px;font-family:Inter,sans-serif;">' + opt.label + '</div><div style="color:#9aa0a6;font-size:12px;font-family:Inter,sans-serif;">' + opt.desc + '</div>';
        card.onclick = () => { overlay.remove(); resolve({ type: 'browser', shareType: opt.type, shareAudio: audioCb.checked }); };
        grid.appendChild(card);
      });
      overlay.appendChild(grid);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'margin-top:24px;padding:10px 36px;background:#2a2a3e;color:#e8eaed;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-family:Inter,sans-serif;transition:background 0.2s;';
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = '#3a3a4e'; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = '#2a2a3e'; };
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
    overlay.appendChild(cancelBtn);

    const escHandler = (e) => { if(e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(null); } };
    document.addEventListener('keydown', escHandler);
    document.body.appendChild(overlay);
  });
}

async function toggleScreenShare(){
  if(S.screenSharing){
    if(S.screenStream){ S.screenStream.getTracks().forEach(t=>t.stop()); }
    S.screenStream=null;
    S.screenSharing=false;

    const camTrack = S.localStream ? S.localStream.getVideoTracks()[0] : null;
    const replacePromises = [];
    S.peers.forEach((p) => {
      const videoSender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (videoSender && camTrack) {
        replacePromises.push(videoSender.replaceTrack(camTrack).catch(e => console.warn('replaceTrack restore:', e)));
      } else if (videoSender && !camTrack) {
        replacePromises.push(videoSender.replaceTrack(null).catch(e => console.warn('replaceTrack null:', e)));
      }
      // Remove extra screen audio sender if present
      const audioSenders = p.pc.getSenders().filter(s => s.track && s.track.kind === 'audio');
      if(audioSenders.length > 1) {
        try { p.pc.removeTrack(audioSenders[audioSenders.length - 1]); } catch(e) {}
      }
    });
    await Promise.all(replacePromises);

    S.socket.emit('screen-share-stopped');
    updateToolbar();
    updateVideoGrid();
    updateRemoteControlVisibility();
  } else {
    try {
      const choice = await showScreenSharePicker();
      if(!choice) return;

      const electronAPI = window.electronAPI || window.desktop;

      if(choice.type === 'electron') {
        S.screenStream = await navigator.mediaDevices.getUserMedia({
          audio: choice.shareAudio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: choice.sourceId } } : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: choice.sourceId, maxFrameRate: 30 } }
        });
      } else {
        const displayMediaOpts = {
          video: { cursor: 'always', frameRate: { ideal: 30 } },
          audio: choice.shareAudio
        };
        if(choice.shareType === 'tab') displayMediaOpts.video.displaySurface = 'browser';
        else if(choice.shareType === 'window') displayMediaOpts.video.displaySurface = 'window';
        else if(choice.shareType === 'screen') displayMediaOpts.video.displaySurface = 'monitor';
        if(choice.shareAudio) { displayMediaOpts.systemAudio = 'include'; }
        S.screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOpts);
      }

      S.screenSharing = true;
      const screenTrack = S.screenStream.getVideoTracks()[0];
      const screenAudioTrack = S.screenStream.getAudioTracks()[0] || null;

      const replacePromises = [];
      S.peers.forEach((p) => {
        const videoSender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          replacePromises.push(videoSender.replaceTrack(screenTrack).catch(e => console.warn('replaceTrack screen:', e)));
        }
        if(screenAudioTrack) {
          try { p.pc.addTrack(screenAudioTrack, S.screenStream); } catch(e) { console.warn('addTrack screen audio:', e); }
        }
      });
      await Promise.all(replacePromises);

      screenTrack.onended = () => { if (S.screenSharing) toggleScreenShare(); };

      S.socket.emit('screen-share-started');
      updateToolbar();
      updateVideoGrid();
      updateRemoteControlVisibility();
      toast('\uD83D\uDDA5\uFE0F Screen sharing started' + (screenAudioTrack ? ' with audio' : ''), 'success');
    } catch(e) {
      if (e.name !== 'NotAllowedError') toast('\u274C Screen share failed: ' + e.message, 'error');
    }
  }
}

// ─── Recording (Full Room Composite) ──────────────────────────────────
function toggleRecording(){
  if(S.isRecording){stopRecording();}
  else{startRecording();}
}

function startRecording(){
  try {
    // Create an offscreen canvas to composite all participants + screen share
    const recCanvas = document.createElement('canvas');
    recCanvas.width = 1920; recCanvas.height = 1080;
    const ctx = recCanvas.getContext('2d');
    S._recCanvas = recCanvas;
    S._recCtx = ctx;

    // Mix all audio tracks into one destination
    const audioCtx = new AudioContext();
    const destination = audioCtx.createMediaStreamDestination();
    S._recAudioCtx = audioCtx;

    // Add local audio
    if(S.localStream) {
      S.localStream.getAudioTracks().forEach(t => {
        const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
        src.connect(destination);
      });
    }
    // Add screen share audio
    if(S.screenStream) {
      S.screenStream.getAudioTracks().forEach(t => {
        const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
        src.connect(destination);
      });
    }
    // Add all remote peer audio
    S.peers.forEach((p) => {
      if(p.stream) {
        p.stream.getAudioTracks().forEach(t => {
          try {
            const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
            src.connect(destination);
          } catch(e) { /* track may be ended */ }
        });
      }
    });

    // Composite video: draw all video tiles onto canvas at ~24fps
    S._recAnimFrame = null;
    function drawFrame() {
      const W = recCanvas.width, H = recCanvas.height;
      ctx.fillStyle = '#0f0f17';
      ctx.fillRect(0, 0, W, H);

      // Collect all video elements from the grid
      const videos = Array.from(document.querySelectorAll('#video-grid video'));
      const count = videos.length;

      if(count === 0) {
        ctx.fillStyle = '#9aa0a6';
        ctx.font = '28px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No video', W/2, H/2);
      } else if(count === 1) {
        // Single video: fill the canvas
        _drawVideoFit(ctx, videos[0], 0, 0, W, H);
      } else {
        // Check for screen share mode (large main + small tiles)
        const mainTile = document.querySelector('.video-tile.ss-main video');
        if(mainTile) {
          // Screen share layout: main takes 75% width, strip on right
          const mainW = Math.floor(W * 0.75);
          _drawVideoFit(ctx, mainTile, 0, 0, mainW, H);

          const others = videos.filter(v => v !== mainTile);
          const stripW = W - mainW;
          const tileH = others.length > 0 ? Math.floor(H / Math.min(others.length, 6)) : H;
          others.forEach((v, i) => {
            if(i < 6) _drawVideoFit(ctx, v, mainW, i * tileH, stripW, tileH);
          });
        } else {
          // Gallery layout: grid arrangement
          const cols = count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
          const rows = Math.ceil(count / cols);
          const tileW = Math.floor(W / cols);
          const tileH = Math.floor(H / rows);
          videos.forEach((v, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            _drawVideoFit(ctx, v, col * tileW, row * tileH, tileW, tileH);
          });
        }
      }

      // Draw participant names
      const tiles = document.querySelectorAll('#video-grid .video-tile');
      ctx.font = '16px Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';

      // Timestamp overlay
      ctx.font = '14px Inter, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.textAlign = 'right';
      const elapsed = S.recordingStartTime ? Math.floor((Date.now() - S.recordingStartTime) / 1000) : 0;
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      ctx.fillText(`REC ${mm}:${ss}`, W - 16, H - 16);

      // Red recording dot
      ctx.beginPath();
      ctx.arc(W - 90, H - 20, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#e04040';
      ctx.fill();

      S._recAnimFrame = requestAnimationFrame(drawFrame);
    }

    drawFrame();

    // Create combined stream: canvas video + mixed audio
    const canvasStream = recCanvas.captureStream(24);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...destination.stream.getAudioTracks()
    ]);

    S.recordedChunks = [];
    // Try VP9 first, fall back to VP8
    let mimeType = 'video/webm;codecs=vp9,opus';
    if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
    if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

    S.mediaRecorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 4000000 });
    S.mediaRecorder.ondataavailable = e => { if(e.data.size > 0) S.recordedChunks.push(e.data); };
    S.mediaRecorder.onstop = () => uploadRecording();
    S.mediaRecorder.start(1000);
    S.isRecording = true;
    S.recordingStartTime = Date.now();
    S.socket.emit('toggle-recording', { recording: true });
    updateToolbar();
    toast('\u23FA\uFE0F Recording started \u2014 capturing entire room', 'success');
  } catch(e) { toast('\u274C Recording failed: ' + e.message, 'error'); console.error(e); }
}

function _drawVideoFit(ctx, video, x, y, w, h) {
  try {
    if(!video || video.readyState < 2 || video.videoWidth === 0) {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#4a4d52';
      ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No video', x + w/2, y + h/2);
      return;
    }
    // Maintain aspect ratio (cover)
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    // Border
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  } catch(e) { /* video element may not be ready */ }
}

function stopRecording(){
  if(S._recAnimFrame) { cancelAnimationFrame(S._recAnimFrame); S._recAnimFrame = null; }
  if(S._recAudioCtx) { try { S._recAudioCtx.close(); } catch(e) {} S._recAudioCtx = null; }
  S._recCanvas = null; S._recCtx = null;
  if(S.mediaRecorder && S.mediaRecorder.state !== 'inactive'){
    S.mediaRecorder.stop();
  }
  S.isRecording = false;
  S.socket.emit('toggle-recording', { recording: false });
  updateToolbar();
  toast('\u23F9\uFE0F Recording stopped, uploading...', 'info');
}

async function uploadRecording(){
  try{
    const blob = new Blob(S.recordedChunks, { type: 'video/webm' });
    const duration = S.recordingStartTime ? Date.now() - S.recordingStartTime : 0;
    const fd = new FormData();
    fd.append('recording', blob, `recording-${Date.now()}.webm`);
    fd.append('roomId', S.roomId || '');
    fd.append('roomName', S.roomName || '');
    fd.append('roomType', S.roomType || 'meeting');
    fd.append('recordedBy', S.socket?.id || '');
    fd.append('recordedByName', S.userName);
    fd.append('duration', String(duration));
    // Include transcript
    const transcriptText = S.transcriptEntries.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
    fd.append('transcript', transcriptText);
    // Include participant names
    const participants = [S.userName];
    S.peers.forEach(p => participants.push(p.name));
    fd.append('participants', JSON.stringify(participants));

    const r = await fetch('/api/recordings/upload', { method: 'POST', body: fd });
    const data = await r.json();
    toast('\u2705 Recording uploaded!', 'success');

    // Auto-generate summary
    if(S.transcriptEntries.length > 0){
      setTimeout(() => window.generateSummary(data.id), 500);
    }
  } catch(e) { toast('\u274C Upload failed', 'error'); console.error(e); }
}

// ─── Live Transcription ─────────────────────────────────────────
function startTranscription(){
  if(!('webkitSpeechRecognition' in window)&&!('SpeechRecognition' in window)){
    toast('⚠️ Speech recognition not supported in this browser','warning');return;
  }
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  S.recognition=new SR();
  S.recognition.continuous=true;
  S.recognition.interimResults=true;
  S.recognition.lang='en-US';
  S.recognition.onresult=e=>{
    let interim='',final='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const t=e.results[i][0].transcript;
      if(e.results[i].isFinal){final+=t;}else{interim+=t;}
    }
    if(final){S.socket.emit('transcript-segment',{text:final.trim(),isFinal:true});}
    if(interim){S.socket.emit('transcript-segment',{text:interim,isFinal:false});}
  };
  S.recognition.onerror=e=>{if(e.error!=='no-speech')console.error('Speech error:',e.error);};
  S.recognition.onend=()=>{if(S.transcriptOpen&&S.recognition)try{S.recognition.start();}catch(e){}};
  S.recognition.start();
}
function stopTranscription(){
  if(S.recognition){try{S.recognition.stop();}catch(e){}S.recognition=null;}
}
function renderTranscriptEntry(seg){
  const d=document.createElement('div');
  d.className='transcript-entry';
  d.innerHTML=`<span class="speaker">${escHtml(seg.speaker)}</span>${escHtml(seg.text)}<span class="time">${new Date(seg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>`;
  $('#transcript-entries').appendChild(d);
  $('#transcript-entries').scrollTop=$('#transcript-entries').scrollHeight;
  $('#transcript-live').textContent='';
}

// ─── Annotations ────────────────────────────────────────────────
function initAnnotationCanvas(){
  const canvas=$('#annotation-canvas');
  const container=$('.video-grid-container');
  function resize(){canvas.width=container.clientWidth;canvas.height=container.clientHeight;}
  resize();
  window.addEventListener('resize',resize);
  const ctx=canvas.getContext('2d');

  canvas.addEventListener('mousedown',e=>{if(!S.annotating)return;S.isDrawing=true;const r=canvas.getBoundingClientRect();const x=(e.clientX-r.left)/r.width;const y=(e.clientY-r.top)/r.height;S.lastAnnotPt={x,y};});
  canvas.addEventListener('mousemove',e=>{if(!S.isDrawing||!S.annotating)return;const r=canvas.getBoundingClientRect();const x=(e.clientX-r.left)/r.width;const y=(e.clientY-r.top)/r.height;const data={tool:S.annotationTool,color:S.annotationColor,size:S.annotationSize,x1:S.lastAnnotPt.x,y1:S.lastAnnotPt.y,x2:x,y2:y};drawAnnotation(data);S.socket.emit('annotation-draw',data);S.lastAnnotPt={x,y};});
  canvas.addEventListener('mouseup',()=>{S.isDrawing=false;});
  canvas.addEventListener('mouseleave',()=>{S.isDrawing=false;});
}
function drawAnnotation(data){
  const canvas=$('#annotation-canvas');
  const ctx=canvas.getContext('2d');
  const w=canvas.width,h=canvas.height;
  ctx.strokeStyle=data.color;ctx.lineWidth=data.size;ctx.lineCap='round';ctx.lineJoin='round';
  if(data.tool==='pen'||data.tool==='highlighter'){
    if(data.tool==='highlighter'){ctx.globalAlpha=0.3;ctx.lineWidth=data.size*4;}
    ctx.beginPath();ctx.moveTo(data.x1*w,data.y1*h);ctx.lineTo(data.x2*w,data.y2*h);ctx.stroke();
    ctx.globalAlpha=1;
  }else if(data.tool==='pointer'){
    // Laser pointer - temporary dot
    ctx.fillStyle=data.color;ctx.globalAlpha=0.7;
    ctx.beginPath();ctx.arc(data.x2*w,data.y2*h,8,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;
    setTimeout(()=>{ctx.clearRect(data.x2*w-12,data.y2*h-12,24,24);},500);
  }
}
function clearCanvas(){const c=$('#annotation-canvas');c.getContext('2d').clearRect(0,0,c.width,c.height);}

// ─── Remote Screen Control ──────────────────────────────────────────
function showRemoteControlBar(text, isController) {
  $('#rc-bar-text').textContent = text;
  $('#remote-control-bar').style.display = 'block';
  if (isController) {
    $('#remote-cursor-overlay').style.display = 'block';
  }
}
function hideRemoteControlBar() {
  $('#remote-control-bar').style.display = 'none';
  $('#remote-cursor-overlay').style.display = 'none';
}

function initRemoteControlSender(targetId) {
  cleanupRemoteControl();
  const screenTile = document.querySelector('.video-tile.ss-main') ||
                     document.querySelector('.video-tile.screen-share-tile') ||
                     document.querySelector('.video-tile');
  if (!screenTile) return;

  let layer = document.createElement('div');
  layer.className = 'screen-control-layer active';
  layer.tabIndex = 0;
  screenTile.style.position = 'relative';
  screenTile.appendChild(layer);
  setTimeout(() => layer.focus(), 50);

  const sendMouseEvent = (type, e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = layer.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    S.socket.emit('remote-control-event', { targetId, event: { type, x, y, button: e.button, buttons: e.buttons, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey } });
  };
  const sendKeyEvent = (type, e) => {
    e.preventDefault(); e.stopPropagation();
    S.socket.emit('remote-control-event', { targetId, event: { type, key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey } });
  };

  layer._rcMouseMove = (e) => sendMouseEvent('mousemove', e);
  layer._rcMouseDown = (e) => { sendMouseEvent('mousedown', e); layer.focus(); };
  layer._rcMouseUp = (e) => sendMouseEvent('mouseup', e);
  layer._rcClick = (e) => sendMouseEvent('click', e);
  layer._rcDblClick = (e) => sendMouseEvent('dblclick', e);
  layer._rcContextMenu = (e) => { e.preventDefault(); sendMouseEvent('contextmenu', e); };
  layer._rcKeyDown = (e) => sendKeyEvent('keydown', e);
  layer._rcKeyUp = (e) => sendKeyEvent('keyup', e);
  layer._rcWheel = (e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = layer.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    S.socket.emit('remote-control-event', { targetId, event: { type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey } });
  };

  layer.addEventListener('mousemove', layer._rcMouseMove);
  layer.addEventListener('mousedown', layer._rcMouseDown);
  layer.addEventListener('mouseup', layer._rcMouseUp);
  layer.addEventListener('click', layer._rcClick);
  layer.addEventListener('dblclick', layer._rcDblClick);
  layer.addEventListener('contextmenu', layer._rcContextMenu);
  layer.addEventListener('wheel', layer._rcWheel, { passive: false });
  layer.addEventListener('keydown', layer._rcKeyDown);
  layer.addEventListener('keyup', layer._rcKeyUp);
  layer.addEventListener('blur', () => { if (S.remoteControlling) setTimeout(() => layer.focus(), 10); });

  S._rcLayer = layer;
  S._rcTargetId = targetId;
  toast('\u{1F5B1}\uFE0F Remote control active — click on the screen to interact', 'success');
}

function handleIncomingControlEvent(event) {
  if (['mousemove','click','mousedown','mouseup','dblclick','contextmenu'].includes(event.type)) {
    const overlay = $('#remote-cursor-overlay');
    const cursor = $('#remote-cursor');
    if (overlay && cursor) {
      overlay.style.display = 'block';
      const mainTile = document.querySelector('.video-tile.ss-main') || $('#video-grid');
      if (mainTile) {
        const rect = mainTile.getBoundingClientRect();
        cursor.style.left = (rect.left + event.x * rect.width) + 'px';
        cursor.style.top = (rect.top + event.y * rect.height) + 'px';
      }
    }
  }
  if (window.electronAPI && window.electronAPI.injectInput) {
    window.electronAPI.injectInput(event);
    return;
  }
  const mainTile = document.querySelector('.video-tile.ss-main') || $('#video-grid');
  if (!mainTile) return;
  if (event.type === 'click' || event.type === 'mousedown') showClickIndicator(event.x, event.y);
  if (event.type === 'wheel') showScrollIndicator(event.x, event.y, event.deltaY);
  if (event.type === 'keydown') showKeyIndicator(event.key);
}

function showClickIndicator(x, y) {
  const mainTile = document.querySelector('.video-tile.ss-main') || $('#video-grid');
  if (!mainTile) return;
  const rect = mainTile.getBoundingClientRect();
  const indicator = document.createElement('div');
  indicator.style.cssText = `position:fixed;left:${rect.left + x * rect.width - 15}px;top:${rect.top + y * rect.height - 15}px;width:30px;height:30px;border:3px solid #2d8cff;border-radius:50%;pointer-events:none;z-index:10000;animation:rcClickPulse 0.5s ease forwards;`;
  document.body.appendChild(indicator);
  setTimeout(() => indicator.remove(), 600);
}

function showScrollIndicator(x, y, deltaY) {
  const mainTile = document.querySelector('.video-tile.ss-main') || $('#video-grid');
  if (!mainTile) return;
  const rect = mainTile.getBoundingClientRect();
  const arrow = deltaY > 0 ? '\u25BC' : '\u25B2';
  const indicator = document.createElement('div');
  indicator.style.cssText = `position:fixed;left:${rect.left + x * rect.width - 12}px;top:${rect.top + y * rect.height - 12}px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:#2d8cff;font-size:18px;pointer-events:none;z-index:10000;opacity:0.8;`;
  indicator.textContent = arrow;
  document.body.appendChild(indicator);
  setTimeout(() => indicator.remove(), 400);
}

function showKeyIndicator(key) {
  const existing = document.querySelector('.rc-key-indicator');
  if (existing) existing.remove();
  const indicator = document.createElement('div');
  indicator.className = 'rc-key-indicator';
  const displayKey = key.length === 1 ? key.toUpperCase() : key;
  indicator.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(45,140,255,0.9);color:#fff;padding:4px 14px;border-radius:6px;font-size:14px;font-weight:600;pointer-events:none;z-index:10000;font-family:monospace;`;
  indicator.textContent = displayKey;
  document.body.appendChild(indicator);
  setTimeout(() => indicator.remove(), 500);
}

function cleanupRemoteControl() {
  if (S._rcLayer) {
    const events = ['mousemove','mousedown','mouseup','click','dblclick','contextmenu','keydown','keyup'];
    const handlers = ['_rcMouseMove','_rcMouseDown','_rcMouseUp','_rcClick','_rcDblClick','_rcContextMenu','_rcKeyDown','_rcKeyUp'];
    events.forEach((evt, i) => { if (S._rcLayer[handlers[i]]) S._rcLayer.removeEventListener(evt, S._rcLayer[handlers[i]]); });
    if (S._rcLayer._rcWheel) S._rcLayer.removeEventListener('wheel', S._rcLayer._rcWheel);
    S._rcLayer.remove();
    S._rcLayer = null;
  }
  S._rcTargetId = null;
  const overlay = $('#remote-cursor-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Video Grid ─────────────────────────────────────────────────
function updateVideoGrid(){
  const grid=$('#video-grid');
  grid.innerHTML='';
  grid.className='video-grid';

  const total=1+S.peers.size;

  // Detect screen sharer
  let screenSharer=null;
  if(S.screenSharing){
    screenSharer={id:'local',isLocal:true};
  } else {
    for(const [pid,p] of S.peers){
      if(p.screenSharing){screenSharer={id:pid,peer:p,isLocal:false};break;}
    }
  }

  // ─── SCREEN SHARE MODE ───
  if(screenSharer){
    grid.classList.add('screenshare-mode');
    grid.removeAttribute('data-count');

    if(screenSharer.isLocal){
      const mainTile=createTile({id:'local-screen',name:S.userName+' (Screen)',stream:S.screenStream,audioEnabled:S.audioEnabled,videoEnabled:true,isHost:S.isHost,role:S.userRole,handRaised:false,screenSharing:true,isLocal:true,mirror:false});
      mainTile.classList.add('ss-main');
      grid.appendChild(mainTile);

      const isInstructor=(isPrivilegedRole()||S.isHost);
      const camTile=createTile({id:'local-cam',name:S.userName+' (You)',stream:S.localStream,audioEnabled:S.audioEnabled,videoEnabled:S.videoEnabled,isHost:S.isHost,role:S.userRole,handRaised:S.handRaised,screenSharing:false,isLocal:true,mirror:S.mirrorVideo});
      camTile.classList.add(isInstructor?'ss-pip-instructor':'ss-pip-student');
      camTile.style.aspectRatio='4/3';
      makeDraggable(camTile);
      grid.appendChild(camTile);

      if(S.peers.size>0){
        const strip=document.createElement('div');
        strip.className='ss-participant-strip';
        S.peers.forEach((p,pid)=>{
          const t=createTile({id:pid,name:p.name,stream:p.stream,audioEnabled:p.audioEnabled,videoEnabled:p.videoEnabled,isHost:false,role:p.role,handRaised:p.handRaised,screenSharing:false,isLocal:false,mirror:false});
          t.style.aspectRatio='16/9';
          strip.appendChild(t);
        });
        grid.appendChild(strip);
      }
    } else {
      const sp=screenSharer.peer;
      const mainTile=createTile({id:screenSharer.id,name:sp.name+' (Screen)',stream:sp.stream,audioEnabled:sp.audioEnabled,videoEnabled:true,isHost:false,role:sp.role,handRaised:false,screenSharing:true,isLocal:false,mirror:false});
      mainTile.classList.add('ss-main');
      grid.appendChild(mainTile);

      const sharerIsInstructor=(sp.role==='instructor'||sp.role==='admin');
      const sharerPip=createTile({id:screenSharer.id+'-cam',name:sp.name,stream:null,audioEnabled:sp.audioEnabled,videoEnabled:false,isHost:false,role:sp.role,handRaised:sp.handRaised,screenSharing:false,isLocal:false,mirror:false});
      sharerPip.classList.add(sharerIsInstructor?'ss-pip-instructor':'ss-pip-student');
      sharerPip.style.aspectRatio='4/3';
      makeDraggable(sharerPip);
      grid.appendChild(sharerPip);

      const myTile=createTile({id:'local',name:S.userName+' (You)',stream:S.localStream,audioEnabled:S.audioEnabled,videoEnabled:S.videoEnabled,isHost:S.isHost,role:S.userRole,handRaised:S.handRaised,screenSharing:false,isLocal:true,mirror:S.mirrorVideo});
      const otherPeers=[];
      S.peers.forEach((p,pid)=>{ if(pid!==screenSharer.id) otherPeers.push({pid,p}); });

      const strip=document.createElement('div');
      strip.className='ss-participant-strip';
      myTile.style.aspectRatio='16/9';
      strip.appendChild(myTile);
      otherPeers.forEach(({pid,p})=>{
        const t=createTile({id:pid,name:p.name,stream:p.stream,audioEnabled:p.audioEnabled,videoEnabled:p.videoEnabled,isHost:false,role:p.role,handRaised:p.handRaised,screenSharing:false,isLocal:false,mirror:false});
        t.style.aspectRatio='16/9';
        strip.appendChild(t);
      });
      grid.appendChild(strip);
    }

    if(S.remoteControlling){ setTimeout(()=>initRemoteControlSender(S.remoteControlling),100); }
    return;
  }

  // ─── ZOOM 2-PERSON MODE ───
  if(total===2){
    grid.classList.add('zoom-mode');
    grid.removeAttribute('data-count');

    let remotePid=null, remotePeer=null;
    S.peers.forEach((p,pid)=>{remotePid=pid;remotePeer=p;});

    const mainTile=createTile({id:remotePid,name:remotePeer.name,stream:remotePeer.stream,audioEnabled:remotePeer.audioEnabled,videoEnabled:remotePeer.videoEnabled,isHost:false,role:remotePeer.role,handRaised:remotePeer.handRaised,screenSharing:false,isLocal:false,mirror:false});
    mainTile.classList.add('zoom-main');
    mainTile.style.aspectRatio='auto';
    grid.appendChild(mainTile);

    const pipTile=createTile({id:'local',name:S.userName+' (You)',stream:S.localStream,audioEnabled:S.audioEnabled,videoEnabled:S.videoEnabled,isHost:S.isHost,role:S.userRole,handRaised:S.handRaised,screenSharing:false,isLocal:true,mirror:S.mirrorVideo});
    pipTile.classList.add('zoom-pip');
    pipTile.style.aspectRatio='4/3';
    makeDraggable(pipTile);
    grid.appendChild(pipTile);
    return;
  }

  // ─── GALLERY MODE (3+ or solo) ───
  const tilesPerPage=9;
  const allTiles=[
    {id:'local',name:S.userName+' (You)',stream:S.localStream,audioEnabled:S.audioEnabled,videoEnabled:S.videoEnabled,isHost:S.isHost,role:S.userRole,handRaised:S.handRaised,screenSharing:false,isLocal:true,mirror:S.mirrorVideo},
    ...Array.from(S.peers.entries()).map(([pid,p])=>({id:pid,name:p.name,stream:p.stream,audioEnabled:p.audioEnabled,videoEnabled:p.videoEnabled,isHost:false,role:p.role,handRaised:p.handRaised,screenSharing:false,isLocal:false,mirror:false}))
  ];
  const totalPages=Math.ceil(allTiles.length/tilesPerPage);
  if(!S.videoPage)S.videoPage=1;
  if(S.videoPage>totalPages)S.videoPage=totalPages;
  const startIndex=(S.videoPage-1)*tilesPerPage;
  const endIndex=startIndex+tilesPerPage;
  const visibleTiles=allTiles.slice(startIndex,endIndex);
  grid.setAttribute('data-count',Math.min(visibleTiles.length,9));
  visibleTiles.forEach(tile=>grid.appendChild(createTile(tile)));
  if(totalPages>1){
    const nav=document.createElement('div');
    nav.className='video-pagination';
    nav.innerHTML=`<button class="btn btn-secondary btn-sm" onclick="S.videoPage--;updateVideoGrid()" ${S.videoPage<=1?'disabled':''}>\u2190 Prev</button>
      <span>Page ${S.videoPage} of ${totalPages}</span>
      <button class="btn btn-secondary btn-sm" onclick="S.videoPage++;updateVideoGrid()" ${S.videoPage>=totalPages?'disabled':''}>Next \u2192</button>`;
    grid.appendChild(nav);
  }
}

function createTile({id,name,stream,audioEnabled,videoEnabled,isHost,role,handRaised,screenSharing,isLocal,mirror}){
  const tile=document.createElement('div');
  tile.className='video-tile';
  tile.dataset.peerId=id;
  if(screenSharing)tile.classList.add('screen-share-tile');

  if(stream&&videoEnabled){
    const v=document.createElement('video');
    v.srcObject=stream;v.autoplay=true;v.playsInline=true;
    if(isLocal)v.muted=true;
    if(mirror)v.classList.add('mirror');
    tile.appendChild(v);
  }else{
    const av=document.createElement('div');
    av.className='video-tile-avatar';
    av.textContent=initials(name.replace(' (You)','').replace(' (Screen)',''));
    av.style.background=`linear-gradient(135deg,${genColor(name)},${genColor(name+'2')})`;
    tile.appendChild(av);
  }
  if(handRaised){const h=document.createElement('div');h.className='video-tile-hand';h.textContent='\u270B';tile.appendChild(h);}

  const ov=document.createElement('div');ov.className='video-tile-overlay';
  const nm=document.createElement('div');nm.className='video-tile-name';
  let html=escHtml(name);
  if(isHost)html+=' <span class="host-badge">Host</span>';
  if(role==='instructor')html+=' <span class="role-badge">Instructor</span>';
  if(screenSharing)html+=' \uD83D\uDDA5\uFE0F';
  nm.innerHTML=html;
  const ic=document.createElement('div');ic.className='video-tile-icons';
  if(!audioEnabled)ic.innerHTML+='<span>\uD83D\uDD07</span>';
  ov.appendChild(nm);ov.appendChild(ic);tile.appendChild(ov);
  return tile;
}

function makeDraggable(el){
  let isDragging=false,startX,startY,origLeft,origTop;
  el.addEventListener('mousedown',(e)=>{
    if(e.target.tagName==='BUTTON')return;
    isDragging=true;
    el.style.cursor='grabbing';
    const rect=el.getBoundingClientRect();
    const parentRect=el.parentElement.getBoundingClientRect();
    origLeft=rect.left-parentRect.left;
    origTop=rect.top-parentRect.top;
    startX=e.clientX;startY=e.clientY;
    e.preventDefault();
  });
  document.addEventListener('mousemove',(e)=>{
    if(!isDragging)return;
    const dx=e.clientX-startX, dy=e.clientY-startY;
    el.style.left=(origLeft+dx)+'px';
    el.style.top=(origTop+dy)+'px';
    el.style.right='auto';
    el.style.bottom='auto';
  });
  document.addEventListener('mouseup',()=>{
    if(isDragging){isDragging=false;el.style.cursor='grab';}
  });
}

// ─── Chat ───────────────────────────────────────────────────────
function renderChatMsg(msg){
  const d=document.createElement('div');
  const self=msg.senderId===S.socket?.id;
  d.className=`chat-message ${self?'self':''}`;
  d.innerHTML=`<div class="chat-message-header">
    <span class="chat-message-sender">${self?'You':escHtml(msg.senderName)}</span>
    ${msg.senderRole&&msg.senderRole!=='student'?`<span class="chat-message-role">${msg.senderRole}</span>`:''}
    <span class="chat-message-time">${new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
  </div><div class="chat-message-body">${escHtml(msg.message)}</div>`;
  $('#chat-messages').appendChild(d);
  $('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;
}
function sendChat(){const m=$('#chat-input').value.trim();if(!m)return;S.socket.emit('chat-message',{message:m,type:'text'});$('#chat-input').value='';}

// ─── Participants ───────────────────────────────────────────────
function renderParticipants(){
  const list=$('#participants-list');list.innerHTML='';
  $('#participants-count').textContent=`${S.participants.length} participant${S.participants.length!==1?'s':''}`;
  S.participants.forEach(p=>{
    const me=p.id===S.socket?.id;
    const item=document.createElement('div');item.className='participant-item';
    item.innerHTML=`
      <div class="participant-avatar" style="background:linear-gradient(135deg,${genColor(p.name)},${genColor(p.name+'2')})">${initials(p.name)}</div>
      <div class="participant-info">
        <div class="participant-name">${escHtml(me?p.name+' (You)':p.name)} ${p.isHost?'👑':''} ${p.handRaised?'✋':''}</div>
        <div class="participant-role-tag">${p.role||'student'}</div>
      </div>
      <div class="participant-status">${p.audioEnabled?'<span>🎤</span>':'<span>🔇</span>'} ${p.videoEnabled?'<span>📷</span>':''}</div>
      ${(S.isHost||isPrivilegedRole())&&!me?`<div class="participant-actions">
        <button class="participant-action-btn" data-act="mute" data-pid="${p.id}" title="Mute">🔇</button>
        ${S.isHost?`<button class="participant-action-btn" data-act="remove" data-pid="${p.id}" title="Remove">❌</button>`:''}
      </div>`:''}`;
    item.querySelectorAll('.participant-action-btn').forEach(b=>{
      b.addEventListener('click',()=>{
        if(b.dataset.act==='mute')S.socket.emit('mute-participant',{participantId:b.dataset.pid});
        if(b.dataset.act==='remove')S.socket.emit('remove-participant',{participantId:b.dataset.pid});
      });
    });
    list.appendChild(item);
  });
}
function renderWaitingRoom(){
  const c=$('#waiting-room-container');
  if((!S.isHost && !isPrivilegedRole())||!S.waitingList.length){c.innerHTML='';return;}
  c.innerHTML=`<div class="waiting-room-section">
    <div class="waiting-room-title">⏳ Waiting (${S.waitingList.length}) <button class="btn btn-success btn-sm" style="margin-left:auto;" onclick="S.socket.emit('admit-all')">Admit All</button></div>
    ${S.waitingList.map(w=>`<div class="waiting-item">
      <div class="participant-avatar" style="background:linear-gradient(135deg,${genColor(w.name)},${genColor(w.name+'2')});width:28px;height:28px;font-size:10px;">${initials(w.name)}</div>
      <span class="waiting-item-name">${escHtml(w.name)} <span style="font-size:10px;color:var(--text-muted)">(${w.role})</span></span>
      <div class="waiting-item-actions">
        <button class="btn btn-success btn-sm" onclick="S.socket.emit('admit-participant',{participantId:'${w.id}'})">Admit</button>
        <button class="btn btn-danger btn-sm" onclick="S.socket.emit('deny-participant',{participantId:'${w.id}'})">Deny</button>
      </div>
    </div>`).join('')}</div>`;
}

// ─── Breakout Rooms ─────────────────────────────────────────────
function renderBreakoutRooms(rooms){
  const c=$('#breakout-content');
  const canManage = S.isHost || isPrivilegedRole();
  c.innerHTML=`
    ${canManage?`<button class="btn btn-primary btn-sm btn-block" style="margin-bottom:12px;" onclick="openModal('create-breakout-modal')">+ Create Breakout Room</button>`:''}
    ${rooms&&rooms.length?rooms.map(r=>`
      <div class="room-card" style="margin-bottom:10px;padding:14px;">
        <h3 style="font-size:14px;">${escHtml(r.name)}</h3>
        <p style="font-size:12px;">Assigned: ${(r.assignedStudents||[]).length} students</p>
        ${canManage?`<div style="display:flex;gap:6px;margin-top:8px;">
          <button class="btn btn-primary btn-sm" onclick="window.joinRoom('${r.id}','breakout','${escHtml(r.name)}')">Join</button>
          <button class="btn btn-danger btn-sm" onclick="S.socket.emit('close-breakout',{breakoutId:'${r.id}'})">Close</button>
        </div>`:`<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="window.joinRoom('${r.id}','breakout','${escHtml(r.name)}')">Join</button>`}
      </div>`).join(''):'<p style="color:var(--text-muted);font-size:13px;">No breakout rooms yet</p>'}
    ${canManage&&rooms&&rooms.length?`<button class="btn btn-danger btn-sm btn-block" style="margin-top:12px;" onclick="S.socket.emit('close-all-breakouts')">Close All Breakouts</button>`:''}`;
}

// ─── Reactions ──────────────────────────────────────────────────
function showReaction(emoji){
  const b=document.createElement('div');b.className='reaction-bubble';b.textContent=emoji;
  $('#reactions-container').appendChild(b);setTimeout(()=>b.remove(),3000);
}

// ─── Meeting Timer ──────────────────────────────────────────────
function startTimer(){S.meetingStartTime=Date.now();S.timerInterval=setInterval(()=>{$('#meeting-timer').textContent=fmtTime(Math.floor((Date.now()-S.meetingStartTime)/1000));},1000);}
function stopTimer(){if(S.timerInterval){clearInterval(S.timerInterval);S.timerInterval=null;}}

// ─── UI Updates ─────────────────────────────────────────────────
function updateToolbar(){
  $('#toolbar-mic').classList.toggle('off',!S.audioEnabled);
  $('#toolbar-mic').querySelector('.toolbar-btn-icon').textContent=S.audioEnabled?'🎤':'🔇';
  $('#toolbar-camera').classList.toggle('off',!S.videoEnabled);
  $('#toolbar-screen').classList.toggle('active',S.screenSharing);
  $('#toolbar-hand').classList.toggle('active',S.handRaised);
  $('#toolbar-annotate').classList.toggle('active',S.annotating);
  $('#toolbar-record').classList.toggle('active',S.isRecording);
  $('#toolbar-record').querySelector('.toolbar-btn-icon').textContent=S.isRecording?'⏹️':'⏺️';
  $('#toolbar-record').querySelector('.toolbar-btn-label').textContent=S.isRecording?'Stop':'Record';
  $('#toolbar-transcript').classList.toggle('active',S.transcriptOpen);
}
function updateBadges(){
  const pb=$('#participants-badge');pb.style.display=S.participants.length?'flex':'none';pb.textContent=S.participants.length;
  const cb=$('#chat-badge');if(S.unreadChat>0){cb.style.display='flex';cb.textContent=S.unreadChat>9?'9+':S.unreadChat;}else cb.style.display='none';
}
function updateHostUI(){
  const isPrivileged = S.isHost || isPrivilegedRole();
  $('#end-meeting-btn').style.display=S.isHost?'block':'none';
  $('#toolbar-breakout').style.display=isPrivileged?'flex':'none';
  // Recording only for instructors/admins
  $('#toolbar-record').style.display=isPrivileged?'flex':'none';
  updateRemoteControlVisibility();
}

function updateRemoteControlVisibility(){
  // Show remote control button to ALL users when someone else is screen sharing
  const sharer = Array.from(S.peers.entries()).find(([_, p]) => p.screenSharing);
  // Also show if WE are controlling someone
  const showControl = sharer || S.remoteControlling;
  $('#toolbar-remote').style.display = showControl ? 'flex' : 'none';

  // Update button label based on state
  if (S.remoteControlling) {
    $('#toolbar-remote').querySelector('.toolbar-btn-label').textContent = 'Stop Control';
    $('#toolbar-remote').classList.add('active');
  } else {
    $('#toolbar-remote').querySelector('.toolbar-btn-label').textContent = 'Control';
    $('#toolbar-remote').classList.remove('active');
  }
}

function closeAllPanels(){
  S.chatOpen=S.participantsOpen=S.transcriptOpen=S.breakoutOpen=false;
  $('#chat-panel').classList.remove('open');
  $('#participants-panel').classList.remove('open');
  $('#transcript-panel').classList.remove('open');
  $('#breakout-panel').classList.remove('open');
}
function togglePanel(name){
  const panels={chat:'chat-panel',participants:'participants-panel',transcript:'transcript-panel',breakout:'breakout-panel'};
  const key=name+'Open';
  const wasOpen=S[key];
  closeAllPanels();
  if(!wasOpen){S[key]=true;$('#'+panels[name]).classList.add('open');
    if(name==='chat'){S.unreadChat=0;updateBadges();$('#chat-input').focus();}
    if(name==='breakout'){renderBreakoutRooms(S.breakoutRooms||[]);}
    if(name==='transcript'&&!S.recognition)startTranscription();
  }
  if(name==='transcript'&&wasOpen)stopTranscription();
}

// ─── Enter Meeting ──────────────────────────────────────────────
function enterMeeting(data){
  S.roomId=data.roomId;S.settings=data.settings||{};S.participants=data.participants||[];
  // Detect if current user is host from participants list
  if(S.socket && data.participants){
    const me = data.participants.find(p => p.id === S.socket.id);
    if(me && me.isHost) S.isHost = true;
  }
  showPage('meeting-page');
  $('#meeting-name-display').textContent=data.meetingName||S.roomName;
  $('#meeting-id-display').textContent=`ID: ${data.roomId}`;
  $('#meeting-lock-icon').style.display=S.settings.locked?'inline':'none';
  if(data.muteOnEntry){toggleAudio(false);toast('🔇 Muted on entry','info');}
  if(data.chatHistory)(data.chatHistory).forEach(m=>renderChatMsg(m));
  if(data.transcript)(data.transcript).forEach(t=>{S.transcriptEntries.push(t);renderTranscriptEntry(t);});
  if(data.isRecording){S.isRecording=true;$('#recording-indicator').classList.add('active');}
  // Apply room theme
  if(data.theme && Object.keys(data.theme).length>0) applyRoomTheme(data.theme);
  // Show theme button for host
  $('#toolbar-theme').style.display=S.isHost?'flex':'none';
  updateHostUI();updateToolbar();updateVideoGrid();renderParticipants();updateBadges();startTimer();
  applyMeetingRoleVisibility();
  initAnnotationCanvas();
  // Create peers for existing participants — WE initiate since we're the new joiner
  if(data.participants)data.participants.forEach(p=>{if(p.id!==S.socket.id && !S.peers.has(p.id))createPeer(p.id,p.name,p.role,true,p.audioEnabled,p.videoEnabled);});
}

function leaveMeeting(){
  if(S.isRecording)stopRecording();
  stopTranscription();
  if(S.socket)S.socket.emit('leave-room');
  S.peers.forEach(p=>p.pc.close());S.peers.clear();
  if(S.localStream){S.localStream.getTracks().forEach(t=>t.stop());S.localStream=null;}
  if(S.screenStream){S.screenStream.getTracks().forEach(t=>t.stop());S.screenStream=null;}
  stopTimer();
  S.roomId=null;S.isHost=false;S.screenSharing=false;S.handRaised=false;S.isRecording=false;
  S.chatMessages=[];S.unreadChat=0;S.participants=[];S.waitingList=[];
  S.transcriptEntries=[];S.annotating=false;
  closeAllPanels();
  $('#chat-messages').innerHTML='';$('#transcript-entries').innerHTML='';
  $('#recording-indicator').classList.remove('active');
  $('#annotation-toolbar').classList.remove('open');
  $('#annotation-canvas').classList.remove('active');
  clearCanvas();
  removeRoomTheme();
  // Clean up remote control
  S.remoteControlling=null;S.remoteControlledBy=null;S.rcPendingRequest=null;
  hideRemoteControlBar();
  cleanupRemoteControl();
  showPage('dashboard-page');loadDashboard();
}


// ═══════════════════════════════════════════════════════════════════════
//  THEME SYSTEM
// ═══════════════════════════════════════════════════════════════════════

const THEME_PRESETS = [
  { name: 'Default', preset: 'default', primaryColor: '#2d8cff', secondaryColor: '#8b5cf6', accentColor: '#2dd272', bgColor: '#0f0f17', bgSecondary: '#1a1a2e', headerBg: '#12121e', toolbarBg: '#111119', panelBg: '#161625', textColor: '#e8eaed', textSecondary: '#9aa0a6', borderColor: '#2a2a3e', fontFamily: 'Inter, sans-serif', bgPattern: 'none', layout: 'default', videoGridRadius: '12', toolbarStyle: 'default' },
  { name: 'Ocean', preset: 'ocean', primaryColor: '#0ea5e9', secondaryColor: '#06b6d4', accentColor: '#22d3ee', bgColor: '#0c1222', bgSecondary: '#132035', headerBg: '#0e1829', toolbarBg: '#0b1420', panelBg: '#111d30', textColor: '#e0f2fe', textSecondary: '#7dd3fc', borderColor: '#1e3a5f', fontFamily: "'DM Sans', sans-serif", bgPattern: 'waves', layout: 'default', videoGridRadius: '16', toolbarStyle: 'floating' },
  { name: 'Forest', preset: 'forest', primaryColor: '#22c55e', secondaryColor: '#16a34a', accentColor: '#86efac', bgColor: '#0a1510', bgSecondary: '#132a1a', headerBg: '#0c1a12', toolbarBg: '#091410', panelBg: '#112218', textColor: '#dcfce7', textSecondary: '#86efac', borderColor: '#1a3d24', fontFamily: "'Space Grotesk', sans-serif", bgPattern: 'dots', layout: 'default', videoGridRadius: '8', toolbarStyle: 'default' },
  { name: 'Sunset', preset: 'sunset', primaryColor: '#f97316', secondaryColor: '#ef4444', accentColor: '#fbbf24', bgColor: '#1a0f0a', bgSecondary: '#2d1810', headerBg: '#1e120c', toolbarBg: '#180e08', panelBg: '#24160e', textColor: '#fef3c7', textSecondary: '#fdba74', borderColor: '#4a2516', fontFamily: "'Poppins', sans-serif", bgPattern: 'gradient-radial', layout: 'spacious', videoGridRadius: '20', toolbarStyle: 'pill' },
  { name: 'Midnight', preset: 'midnight', primaryColor: '#a78bfa', secondaryColor: '#7c3aed', accentColor: '#c4b5fd', bgColor: '#0f0a1a', bgSecondary: '#1a1030', headerBg: '#120d1e', toolbarBg: '#0e0918', panelBg: '#160e28', textColor: '#ede9fe', textSecondary: '#a78bfa', borderColor: '#2e1f5e', fontFamily: "'Playfair Display', serif", bgPattern: 'gradient-mesh', layout: 'default', videoGridRadius: '12', toolbarStyle: 'floating' },
  { name: 'Rose', preset: 'rose', primaryColor: '#ec4899', secondaryColor: '#db2777', accentColor: '#f9a8d4', bgColor: '#1a0a14', bgSecondary: '#2d1020', headerBg: '#1e0c18', toolbarBg: '#180a12', panelBg: '#240e1c', textColor: '#fce7f3', textSecondary: '#f9a8d4', borderColor: '#4a1630', fontFamily: "'DM Sans', sans-serif", bgPattern: 'dots', layout: 'default', videoGridRadius: '16', toolbarStyle: 'default' },
  { name: 'Cyber', preset: 'cyber', primaryColor: '#00ff88', secondaryColor: '#00cc6a', accentColor: '#00ffcc', bgColor: '#0a0e0a', bgSecondary: '#0f1a0f', headerBg: '#0c120c', toolbarBg: '#080c08', panelBg: '#0e160e', textColor: '#d0ffd0', textSecondary: '#80ff80', borderColor: '#1a3a1a', fontFamily: "'JetBrains Mono', monospace", bgPattern: 'circuit', layout: 'compact', videoGridRadius: '4', toolbarStyle: 'minimal' },
  { name: 'Arctic', preset: 'arctic', primaryColor: '#38bdf8', secondaryColor: '#e2e8f0', accentColor: '#f0f9ff', bgColor: '#f8fafc', bgSecondary: '#e2e8f0', headerBg: '#f1f5f9', toolbarBg: '#f8fafc', panelBg: '#e2e8f0', textColor: '#0f172a', textSecondary: '#475569', borderColor: '#cbd5e1', fontFamily: "'Inter', sans-serif", bgPattern: 'none', layout: 'spacious', videoGridRadius: '16', toolbarStyle: 'pill' },
];

const THEME_FIELDS = ['primaryColor','secondaryColor','accentColor','bgColor','bgSecondary','headerBg','toolbarBg','panelBg','textColor','textSecondary','borderColor'];
const THEME_NON_COLOR = ['fontFamily','bgPattern','bgImage','logoUrl','bannerText','layout','videoGridRadius','toolbarStyle'];

// Current theme being edited
let editingTheme = {};
let editingRoomId = null;
let editingRoomType = null;

function applyRoomTheme(theme) {
  if (!theme || Object.keys(theme).length === 0) return;
  const mp = $('#meeting-page');
  mp.classList.add('themed');
  
  // Apply CSS custom properties
  const root = mp.style;
  if (theme.primaryColor) { root.setProperty('--primary', theme.primaryColor); root.setProperty('--theme-primary', theme.primaryColor); }
  if (theme.secondaryColor) root.setProperty('--theme-secondary', theme.secondaryColor);
  if (theme.accentColor) root.setProperty('--theme-accent', theme.accentColor);
  if (theme.bgColor) { root.setProperty('--bg-primary', theme.bgColor); root.setProperty('--theme-bg', theme.bgColor); mp.style.backgroundColor = theme.bgColor; }
  if (theme.bgSecondary) { root.setProperty('--bg-secondary', theme.bgSecondary); root.setProperty('--theme-bg-secondary', theme.bgSecondary); }
  if (theme.headerBg) root.setProperty('--theme-header-bg', theme.headerBg);
  if (theme.toolbarBg) root.setProperty('--theme-toolbar-bg', theme.toolbarBg);
  if (theme.panelBg) root.setProperty('--theme-panel-bg', theme.panelBg);
  if (theme.textColor) { root.setProperty('--text-primary', theme.textColor); mp.style.color = theme.textColor; }
  if (theme.textSecondary) root.setProperty('--text-secondary', theme.textSecondary);
  if (theme.borderColor) root.setProperty('--border-color', theme.borderColor);
  if (theme.videoGridRadius) root.setProperty('--theme-tile-radius', theme.videoGridRadius + 'px');
  
  // Font family
  if (theme.fontFamily) {
    mp.style.fontFamily = theme.fontFamily;
    // Load Google Font if needed
    const fontName = theme.fontFamily.split(',')[0].replace(/'/g,'').trim();
    if (fontName !== 'Inter' && fontName !== 'system-ui') {
      const link = document.createElement('link');
      link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g,'+')}:wght@400;500;600;700&display=swap`;
      link.rel = 'stylesheet';
      if (!document.querySelector(`link[href*="${fontName.replace(/ /g,'+')}"]`)) document.head.appendChild(link);
    }
  }
  
  // Background pattern
  const body = $('.meeting-body');
  if (body) {
    body.className = 'meeting-body';
    if (theme.bgPattern && theme.bgPattern !== 'none') body.classList.add('bg-pattern-' + theme.bgPattern);
  }
  
  // Background image
  if (theme.bgImage) {
    if (body) body.style.backgroundImage = `url(${theme.bgImage})`;
    if (body) body.style.backgroundSize = 'cover';
    if (body) body.style.backgroundPosition = 'center';
  }
  
  // Toolbar style
  const toolbar = $('.meeting-toolbar');
  if (toolbar) {
    toolbar.classList.remove('toolbar-floating','toolbar-minimal','toolbar-pill');
    if (theme.toolbarStyle && theme.toolbarStyle !== 'default') toolbar.classList.add('toolbar-' + theme.toolbarStyle);
  }
  
  // Logo
  const headerInfo = $('.meeting-info');
  if (headerInfo) {
    const existingLogo = headerInfo.querySelector('.meeting-logo');
    if (existingLogo) existingLogo.remove();
    if (theme.logoUrl) {
      const img = document.createElement('img');
      img.src = theme.logoUrl; img.className = 'meeting-logo'; img.onerror = () => img.remove();
      headerInfo.insertBefore(img, headerInfo.firstChild);
    }
  }
  
  // Banner text
  const headerRight = $('.meeting-header-right');
  if (headerRight) {
    const existingBanner = headerRight.querySelector('.meeting-banner');
    if (existingBanner) existingBanner.remove();
    if (theme.bannerText) {
      const span = document.createElement('span');
      span.className = 'meeting-banner'; span.textContent = theme.bannerText;
      headerRight.insertBefore(span, headerRight.firstChild);
    }
  }
  
  S.currentTheme = theme;
}

function removeRoomTheme() {
  const mp = $('#meeting-page');
  mp.classList.remove('themed');
  mp.style.cssText = '';
  const body = $('.meeting-body');
  if (body) { body.className = 'meeting-body'; body.style.backgroundImage = ''; body.style.backgroundSize = ''; body.style.backgroundPosition = ''; }
  const toolbar = $('.meeting-toolbar');
  if (toolbar) toolbar.classList.remove('toolbar-floating','toolbar-minimal','toolbar-pill');
  const logo = mp.querySelector('.meeting-logo');
  if (logo) logo.remove();
  const banner = mp.querySelector('.meeting-banner');
  if (banner) banner.remove();
  S.currentTheme = null;
}

// Open theme customizer from dashboard or meeting
window.openThemeCustomizer = async function(roomId, roomType) {
  editingRoomId = roomId;
  editingRoomType = roomType;
  
  // Load existing theme
  try {
    const endpoint = roomType === 'classroom' ? 'classrooms' : 'meeting-rooms';
    const r = await fetch(`/api/${endpoint}/${roomId}/theme`);
    editingTheme = await r.json();
    if (!editingTheme || !editingTheme.preset) editingTheme = { ...THEME_PRESETS[0] };
  } catch(e) {
    editingTheme = { ...THEME_PRESETS[0] };
  }
  
  renderThemePresets();
  populateThemeForm(editingTheme);
  updateThemePreview(editingTheme);
  openModal('theme-customizer-modal');
};

function renderThemePresets() {
  const container = $('#theme-presets');
  container.innerHTML = THEME_PRESETS.map(p => `
    <div class="theme-preset ${editingTheme.preset===p.preset?'active':''}" data-preset="${p.preset}" onclick="window.selectThemePreset('${p.preset}')">
      <div class="theme-preset-top" style="background: linear-gradient(135deg, ${p.bgColor} 0%, ${p.primaryColor}33 100%);"></div>
      <div class="theme-preset-bottom" style="background: ${p.toolbarBg};">
        <span class="theme-preset-name" style="color:${p.primaryColor};">${p.name}</span>
      </div>
    </div>
  `).join('');
}

window.selectThemePreset = function(presetName) {
  const preset = THEME_PRESETS.find(p => p.preset === presetName);
  if (!preset) return;
  editingTheme = { ...preset };
  populateThemeForm(editingTheme);
  updateThemePreview(editingTheme);
  renderThemePresets();
};

function populateThemeForm(theme) {
  THEME_FIELDS.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el && theme[f]) { el.value = theme[f]; }
    const hex = $(`#hex-${f}`);
    if (hex && theme[f]) hex.textContent = theme[f];
  });
  THEME_NON_COLOR.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el && theme[f] !== undefined) el.value = theme[f];
  });
  const radiusVal = $('#theme-videoGridRadius-val');
  if (radiusVal) radiusVal.textContent = (theme.videoGridRadius || '12') + 'px';
}

function readThemeForm() {
  const theme = { ...editingTheme };
  THEME_FIELDS.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el) theme[f] = el.value;
  });
  THEME_NON_COLOR.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el) theme[f] = el.value;
  });
  theme.preset = 'custom';
  return theme;
}

function updateThemePreview(theme) {
  const preview = $('#theme-preview');
  if (!preview) return;
  preview.style.background = theme.bgColor || '#0f0f17';
  preview.style.fontFamily = theme.fontFamily || 'Inter, sans-serif';
  preview.style.color = theme.textColor || '#e8eaed';
  
  const header = $('#tp-header');
  if (header) {
    header.style.background = theme.headerBg || '#12121e';
    header.style.borderBottomColor = theme.borderColor || 'rgba(255,255,255,0.08)';
  }
  
  const nameEl = $('#tp-name');
  if (nameEl) { nameEl.textContent = S.roomName || 'Room Name'; nameEl.style.color = theme.textColor || '#e8eaed'; }
  
  const logoEl = $('#tp-logo');
  if (logoEl) { logoEl.innerHTML = theme.logoUrl ? `<img src="${theme.logoUrl}" style="height:16px;border-radius:3px;" onerror="this.remove()">` : ''; }
  
  const bannerEl = $('#tp-banner');
  if (bannerEl) { bannerEl.textContent = theme.bannerText || ''; bannerEl.style.color = theme.accentColor || theme.primaryColor; bannerEl.style.fontSize = '10px'; bannerEl.style.opacity = '0.7'; }
  
  const grid = $('#tp-grid');
  if (grid) {
    grid.style.background = theme.bgColor || '#0f0f17';
    if (theme.bgPattern && theme.bgPattern !== 'none') {
      grid.className = 'theme-preview-grid bg-pattern-' + theme.bgPattern;
    } else {
      grid.className = 'theme-preview-grid';
    }
  }
  
  $$('.tp-tile').forEach(t => {
    t.style.background = theme.bgSecondary || '#1a1a2e';
    t.style.borderRadius = (theme.videoGridRadius || '12') + 'px';
    t.style.color = theme.textSecondary || '#9aa0a6';
    t.style.border = `1px solid ${theme.borderColor || '#2a2a3e'}`;
  });
  
  const toolbar = $('#tp-toolbar');
  if (toolbar) {
    toolbar.style.background = theme.toolbarBg || '#111119';
    toolbar.style.borderTopColor = theme.borderColor || 'rgba(255,255,255,0.08)';
    if (theme.toolbarStyle === 'floating' || theme.toolbarStyle === 'pill') {
      toolbar.style.margin = '0 20px 8px';
      toolbar.style.borderRadius = theme.toolbarStyle === 'pill' ? '999px' : '12px';
      toolbar.style.border = `1px solid ${theme.borderColor || 'rgba(255,255,255,0.1)'}`;
    } else {
      toolbar.style.margin = '0';
      toolbar.style.borderRadius = '0';
      toolbar.style.borderLeft = 'none';
      toolbar.style.borderRight = 'none';
      toolbar.style.borderBottom = 'none';
    }
  }
  
  $$('.tp-btn').forEach(b => {
    b.style.background = `${theme.primaryColor || '#2d8cff'}22`;
    b.style.border = `1px solid ${theme.primaryColor || '#2d8cff'}44`;
  });
}

function initThemeListeners() {
  // Color inputs - live preview
  THEME_FIELDS.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el) {
      el.addEventListener('input', () => {
        const hex = $(`#hex-${f}`);
        if (hex) hex.textContent = el.value;
        editingTheme[f] = el.value;
        editingTheme.preset = 'custom';
        updateThemePreview(editingTheme);
        renderThemePresets();
      });
    }
  });
  
  // Non-color inputs
  THEME_NON_COLOR.forEach(f => {
    const el = $(`#theme-${f}`);
    if (el) {
      el.addEventListener('input', () => {
        editingTheme[f] = el.value;
        editingTheme.preset = 'custom';
        if (f === 'videoGridRadius') {
          const val = $('#theme-videoGridRadius-val');
          if (val) val.textContent = el.value + 'px';
        }
        updateThemePreview(editingTheme);
        renderThemePresets();
      });
    }
  });
  
  // Save button
  $('#theme-save-btn').addEventListener('click', async () => {
    const theme = readThemeForm();
    editingTheme = theme;
    
    // Save to backend
    if (editingRoomId) {
      const endpoint = editingRoomType === 'classroom' ? 'classrooms' : 'meeting-rooms';
      try {
        await fetch(`/api/${endpoint}/${editingRoomId}/theme`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme })
        });
      } catch(e) { console.error('Failed to save theme:', e); }
    }
    
    // If we're in a meeting, apply live and broadcast
    if (S.roomId && S.socket && S.isHost) {
      applyRoomTheme(theme);
      S.socket.emit('update-room-theme', theme);
    }
    
    closeModal('theme-customizer-modal');
    toast('🎨 Theme saved!', 'success');
  });
  
  // Reset button
  $('#theme-reset-btn').addEventListener('click', () => {
    editingTheme = { ...THEME_PRESETS[0] };
    populateThemeForm(editingTheme);
    updateThemePreview(editingTheme);
    renderThemePresets();
  });
  
  // Theme button in toolbar
  $('#toolbar-theme').addEventListener('click', () => {
    if (S.roomId && S.isHost) {
      editingRoomId = S.roomId;
      editingRoomType = S.roomType;
      editingTheme = S.currentTheme ? { ...S.currentTheme } : { ...THEME_PRESETS[0] };
      renderThemePresets();
      populateThemeForm(editingTheme);
      updateThemePreview(editingTheme);
      openModal('theme-customizer-modal');
    }
  });
  
  // Listen for theme updates from other users (via socket)
  // This is set up in connectSocket but we add the handler here
}

// Socket handler for theme updates (called from connectSocket)
function handleThemeUpdate(theme) {
  if (theme && Object.keys(theme).length > 0) {
    applyRoomTheme(theme);
    toast('🎨 Room theme updated', 'info');
  }
}


// ═══════════════════════════════════════════════════════════════════
//  EVENT HANDLERS
//
// ─── ROLE-BASED ACCESS CONTROL ──────────────────────────────────────

/* ─── Role Hierarchy Helpers ─────────────────────────────────────────── */
const ROLE_LEVELS = { student: 1, instructor: 2, admin: 3, developer: 4, owner: 5 };
function roleLevel(r) { return ROLE_LEVELS[r] || 0; }
function hasRoleAtLeast(userRole, required) { return roleLevel(userRole) >= roleLevel(required); }

function isPrivilegedRole() {
  return hasRoleAtLeast(S.userRole, 'instructor');
}
function isAdminRole() {
  return hasRoleAtLeast(S.userRole, 'admin');
}

function applyRoleVisibility() {
  const privileged = isPrivilegedRole();
  const admin = isAdminRole();

  // Sidebar: hide admin section for students, hide roles for non-admin
  const adminSection = document.getElementById('sidebar-admin-section');
  if (adminSection) adminSection.style.display = privileged ? '' : 'none';
  const rolesNav = document.getElementById('nav-roles');
  if (rolesNav) rolesNav.style.display = admin ? 'flex' : 'none';

  $$('.sidebar-item[data-view]').forEach(item => {
    if (item.dataset.view === 'admin') {
      item.style.display = admin ? 'flex' : 'none';
    }
  });

  // If user is viewing a restricted view, redirect to overview
  if (!admin && (S.currentView === 'admin' || S.currentView === 'roles')) {
    S.currentView = 'overview';
    loadDashboard();
  }

  // Update sidebar role display
  $('#sidebar-user-role').textContent = S.userRole;
}

function applyMeetingRoleVisibility() {
  const privileged = isPrivilegedRole();

  // Students cannot: record, manage breakouts, change theme, annotate (optional)
  $('#toolbar-record').style.display = privileged ? 'flex' : 'none';
  $('#toolbar-breakout').style.display = (S.isHost || privileged) ? 'flex' : 'none';
  $('#toolbar-theme').style.display = S.isHost ? 'flex' : 'none';

  // Students CAN: mic, camera, screen share, chat, participants, transcript, reactions, hand raise, remote control
  // These remain visible for all roles

  // Bot injection button — developer+ only
  const botBtn = $('#toolbar-bots');
  if (botBtn) {
    const isDev = S.authUser && (S.authUser.role === 'developer' || S.authUser.role === 'owner');
    botBtn.style.display = isDev ? 'flex' : 'none';
  }

  // Hide "End for All" button for non-hosts
  $('#end-meeting-btn').style.display = S.isHost ? 'block' : 'none';
}

/* ═══════════════════════════════════════════════════════════════════════════
   BASIC MODE — Low-resource mode for performance
   ═══════════════════════════════════════════════════════════════════════════ */
function initBasicMode() {
  const stored = localStorage.getItem('vs-basic-mode');
  S.basicMode = stored === 'true';
  applyBasicMode(S.basicMode);

  const checkbox = document.getElementById('basic-mode-checkbox');
  if (checkbox) {
    checkbox.checked = S.basicMode;
    checkbox.addEventListener('change', async (e) => {
      S.basicMode = e.target.checked;
      localStorage.setItem('vs-basic-mode', String(S.basicMode));
      applyBasicMode(S.basicMode);

      // Persist to server
      if (S.authToken) {
        try {
          await fetch('/api/auth/preferences', {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ basic_mode: S.basicMode })
          });
        } catch (err) {
          console.warn('Failed to save basic mode preference:', err);
        }
      }

      // Re-apply video constraints if in a meeting
      if (S.localStream) {
        const videoTrack = S.localStream.getVideoTracks()[0];
        if (videoTrack) {
          const constraints = getBasicModeVideoConstraints();
          try {
            await videoTrack.applyConstraints(constraints);
          } catch (err) {
            console.warn('Failed to apply basic mode video constraints:', err);
          }
        }
      }
    });
  }
}

function applyBasicMode(enabled) {
  if (enabled) {
    document.body.classList.add('basic-mode');
  } else {
    document.body.classList.remove('basic-mode');
  }
  const checkbox = document.getElementById('basic-mode-checkbox');
  if (checkbox) checkbox.checked = enabled;
}

function getBasicModeVideoConstraints() {
  if (S.basicMode) {
    return {
      width: { ideal: 320, max: 320 },
      height: { ideal: 240, max: 240 },
      frameRate: { ideal: 10, max: 15 }
    };
  }
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOT INJECTION PANEL — Developer+ stress testing
   ═══════════════════════════════════════════════════════════════════════════ */
function initBotPanel() {
  const injectBtn = document.getElementById('bot-inject-btn');
  const removeBtn = document.getElementById('bot-remove-all-btn');
  const closeBtn = document.querySelector('#bot-inject-modal .modal-close');

  if (injectBtn) {
    injectBtn.addEventListener('click', () => {
      const count = parseInt(document.getElementById('bot-count').value) || 5;
      const videoEnabled = document.getElementById('bot-video')?.checked ?? true;
      const audioEnabled = document.getElementById('bot-audio')?.checked ?? true;
      const simulateActivity = document.getElementById('bot-activity')?.checked ?? true;
      const errorEl = document.getElementById('bot-inject-error');
      if (errorEl) errorEl.style.display = 'none';

      if (S.socket && S.roomId) {
        S.socket.emit('inject-bots', {
          roomId: S.roomId,
          count: Math.min(count, 50),
          options: { videoEnabled, audioEnabled, simulateActivity }
        }, (res) => {
          if (res?.success) {
            updateBotStatus('✅ Injected ' + (res.botsCreated?.length || count) + ' bots (' + res.totalParticipants + ' total)');
          } else {
            updateBotStatus('❌ ' + (res?.error || 'Failed to inject bots'));
            if (errorEl) { errorEl.textContent = res?.error || 'Failed'; errorEl.style.display = 'block'; }
          }
        });
        updateBotStatus('Injecting ' + count + ' bots...');
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      if (S.socket && S.roomId) {
        S.socket.emit('remove-bots', { roomId: S.roomId }, (res) => {
          if (res?.success) {
            updateBotStatus('Removed ' + (res.removed || 0) + ' bots (' + res.totalParticipants + ' remaining)');
          } else {
            updateBotStatus('❌ ' + (res?.error || 'Failed to remove bots'));
          }
        });
        updateBotStatus('Removing all bots...');
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('bot-inject-modal').style.display = 'none';
    });
  }

  // Listen for bot status updates
  if (S.socket) {
    S.socket.on('bot-update', (data) => {
      updateBotStatus(data.message || 'Bots: ' + (data.botCount || 0));
    });
  }
}

function openBotPanel() {
  const modal = document.getElementById('bot-inject-modal');
  if (modal) {
    modal.style.display = 'flex';
    if (S.socket && S.roomId) {
      S.socket.emit('get-bot-count', { roomId: S.roomId }, (res) => {
        if (res) updateBotStatus('Active bots: ' + (res.bots || 0) + ' / ' + (res.total || 0) + ' total');
      });
    }
    // Show status bar
    const statusBar = document.getElementById('bot-status-bar');
    if (statusBar) statusBar.style.display = 'block';
  }
}
window.openBotPanel = openBotPanel;

function updateBotStatus(msg) {
  const el = document.getElementById('bot-status-text');
  if (el) el.textContent = msg;
  const bar = document.getElementById('bot-status-bar');
  if (bar) bar.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════════════════════
   STUDENT CLASSROOM ASSIGNMENTS — Admin assigns students to classrooms
   ═══════════════════════════════════════════════════════════════════════════ */
function openAssignStudents(classroomId, classroomName) {
  const modal = document.getElementById('assign-students-modal');
  if (!modal) return;
  modal.dataset.classroomId = classroomId;
  const title = modal.querySelector('h3');
  if (title) title.textContent = 'Assign Students \u2014 ' + classroomName;
  modal.style.display = 'flex';
  refreshAssignmentLists(classroomId);

  const closeBtn = modal.querySelector('.modal-close');
  if (closeBtn) {
    closeBtn.onclick = () => { modal.style.display = 'none'; };
  }

  const searchInput = document.getElementById('assign-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase();
      modal.querySelectorAll('.assign-student-row').forEach(row => {
        const name = row.textContent.toLowerCase();
        row.style.display = name.includes(q) ? '' : 'none';
      });
    };
  }
}
window.openAssignStudents = openAssignStudents;

async function refreshAssignmentLists(classroomId) {
  try {
    const [assignedRes, studentsRes] = await Promise.all([
      fetch('/api/classrooms/' + classroomId + '/assignments', { headers: getAuthHeaders() }),
      fetch('/api/users/students', { headers: getAuthHeaders() })
    ]);
    const assigned = await assignedRes.json();
    const allStudents = await studentsRes.json();
    const assignedIds = new Set((assigned || []).map(a => a.student_id));

    const currentList = document.getElementById('current-assigned-list');
    if (currentList) {
      if (!assigned || assigned.length === 0) {
        currentList.innerHTML = '<p style="color:#999;font-size:0.85rem;">No students assigned yet</p>';
      } else {
        currentList.innerHTML = assigned.map(a =>
          '<div class="assign-student-row">' +
            '<span>' + escHtml(a.student_name || a.student_id) + '</span>' +
            '<button class="assign-btn unassign" onclick="window.unassignStudent(\'' + classroomId + '\',\'' + a.student_id + '\')">Remove</button>' +
          '</div>'
        ).join('');
      }
    }

    const unassignedList = document.getElementById('unassigned-students-list');
    if (unassignedList) {
      const unassigned = allStudents.filter(s => !assignedIds.has(s.id));
      if (unassigned.length === 0) {
        unassignedList.innerHTML = '<p style="color:#999;font-size:0.85rem;">All students are assigned</p>';
      } else {
        unassignedList.innerHTML = unassigned.map(s =>
          '<div class="assign-student-row">' +
            '<span>' + escHtml(s.username) + ' (' + escHtml(s.email) + ')</span>' +
            '<button class="assign-btn assign" onclick="window.assignStudent(\'' + classroomId + '\',\'' + s.id + '\')">Assign</button>' +
          '</div>'
        ).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load assignment lists:', err);
  }
}

async function assignStudent(classroomId, studentId) {
  try {
    await fetch('/api/classrooms/' + classroomId + '/assignments', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ studentIds: [studentId] })
    });
    refreshAssignmentLists(classroomId);
  } catch (err) {
    console.error('Failed to assign student:', err);
  }
}
window.assignStudent = assignStudent;

async function unassignStudent(classroomId, studentId) {
  try {
    await fetch('/api/classrooms/' + classroomId + '/assignments/' + studentId, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    refreshAssignmentLists(classroomId);
  } catch (err) {
    console.error('Failed to unassign student:', err);
  }
}
window.unassignStudent = unassignStudent;

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
//  AUTH SYSTEM
// ═══════════════════════════════════════════════════════════════════════
S.authToken = null;
S.authUser = null;

function getAuthHeaders() {
  if (!S.authToken) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.authToken };
}

async function authFetch(url, opts = {}) {
  opts.headers = { ...getAuthHeaders(), ...(opts.headers || {}) };
  return fetch(url, opts);
}

async function tryAutoLogin() {
  const token = localStorage.getItem('vs-token');
  if (!token) return false;
  try {
    const resp = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!resp.ok) { localStorage.removeItem('vs-token'); return false; }
    const user = await resp.json();
    S.authToken = token;
    S.authUser = user;
    S.userName = user.name;
    S.userRole = user.role;
    return true;
  } catch(e) {
    localStorage.removeItem('vs-token');
    return false;
  }
}

function applyAuthUser() {
  // Apply basic mode from server preference
  if (S.authUser && S.authUser.basic_mode !== undefined) {
    S.basicMode = !!S.authUser.basic_mode;
    localStorage.setItem('vs-basic-mode', String(S.basicMode));
    applyBasicMode(S.basicMode);
  }
  if (!S.authUser) return;
  S.userName = S.authUser.name;
  S.userRole = S.authUser.role;
  // Update sidebar
  const nameInput = $('#user-name-input');
  if (nameInput) { nameInput.value = S.userName; nameInput.disabled = true; }
  const roleSelect = $('#user-role-select');
  if (roleSelect) { roleSelect.value = S.userRole; roleSelect.disabled = true; }
  $('#sidebar-user-name').textContent = S.userName;
  $('#sidebar-avatar').textContent = initials(S.userName);
  $('#sidebar-user-role').textContent = S.userRole;
  // Header badge
  const badge = $('#header-user-display');
  if (badge) badge.textContent = `${S.userName} (${S.userRole})`;
  localStorage.setItem('vs-name', S.userName);
  localStorage.setItem('vs-role', S.userRole);
}

function logout() {
  S.authToken = null;
  S.authUser = null;
  localStorage.removeItem('vs-token');
  localStorage.removeItem('vs-name');
  localStorage.removeItem('vs-role');
  if (S.socket) { S.socket.disconnect(); S.socket = null; }
  showPage('auth-page');
}
window._logout = logout;

// ═══════════════════════════════════════════════════════════════════════
//  CHAT POP-OUT WINDOW
// ═══════════════════════════════════════════════════════════════════════
let _chatWindow = null;
window._openChat = function() {
  // If chat window is already open and not closed, focus it
  if (_chatWindow && !_chatWindow.closed) {
    _chatWindow.focus();
    return;
  }

  const token = S.authToken || localStorage.getItem('vs-token');
  if (!token) {
    toast('Please log in first to use chat', 'error');
    return;
  }

  // Check if we're in Electron — use IPC to open a child window
  if (window.electronAPI && window.electronAPI.openChatWindow) {
    window.electronAPI.openChatWindow(token);
    return;
  }

  // Fallback for web: open as pop-out browser window
  const width = 900;
  const height = 650;
  const left = window.screenX + window.outerWidth - width - 20;
  const top = window.screenY + 60;
  const chatUrl = `/chat/index.html?token=${encodeURIComponent(token)}`;
  _chatWindow = window.open(
    chatUrl,
    'VirtualStudioChat',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no`
  );
  if (_chatWindow) _chatWindow.focus();
};

function initAuthListeners() {
  // Toggle between login/register
  $('#show-register').addEventListener('click', (e) => {
    e.preventDefault();
    $('#login-form').style.display = 'none';
    $('#register-form').style.display = '';
    $('#login-error').style.display = 'none';
    $('#register-error').style.display = 'none';
  });
  $('#show-login').addEventListener('click', (e) => {
    e.preventDefault();
    $('#register-form').style.display = 'none';
    $('#login-form').style.display = '';
    $('#login-error').style.display = 'none';
    $('#register-error').style.display = 'none';
  });

  // Login
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) return;
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Signing in...';
    $('#login-error').style.display = 'none';
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await resp.json();
      if (!resp.ok) {
        $('#login-error').textContent = data.error || 'Login failed';
        $('#login-error').style.display = '';
        return;
      }
      S.authToken = data.token;
      S.authUser = data.user;
      localStorage.setItem('vs-token', data.token);
      applyAuthUser();
      applyRoleVisibility();
      showPage('dashboard-page');
      loadDashboard();
      toast('👋 Welcome back, ' + data.user.name + '!', 'success');
    } catch(err) {
      $('#login-error').textContent = 'Connection error. Please try again.';
      $('#login-error').style.display = '';
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Sign In';
    }
  });

  // Register
  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#reg-name').value.trim();
    const username = $('#reg-username').value.trim();
    const email = $('#reg-email').value.trim();
    const password = $('#reg-password').value;
    if (!name || !username || !password) return;
    if (password.length < 6) {
      $('#register-error').textContent = 'Password must be at least 6 characters';
      $('#register-error').style.display = '';
      return;
    }
    const btn = $('#register-btn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating account...';
    $('#register-error').style.display = 'none';
    try {
      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, email, password })
      });
      const data = await resp.json();
      if (!resp.ok) {
        $('#register-error').textContent = data.error || 'Registration failed';
        $('#register-error').style.display = '';
        return;
      }
      S.authToken = data.token;
      S.authUser = data.user;
      localStorage.setItem('vs-token', data.token);
      applyAuthUser();
      applyRoleVisibility();
      showPage('dashboard-page');
      loadDashboard();
      toast('🎉 Account created! Welcome, ' + data.user.name + '!', 'success');
    } catch(err) {
      $('#register-error').textContent = 'Connection error. Please try again.';
      $('#register-error').style.display = '';
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create Account';
    }
  });
}

function init(){
  // Init auth listeners first
  initAuthListeners();
  initBasicMode();
  initBotPanel();

  // Sidebar nav
  $$('.sidebar-item[data-view]').forEach(item=>{
    item.addEventListener('click',()=>{S.currentView=item.dataset.view;loadDashboard();});
  });

  // User name/role (will be overridden by auth)
  const saved=localStorage.getItem('vs-name');if(saved)$('#user-name-input').value=saved;
  const savedRole=localStorage.getItem('vs-role');if(savedRole)$('#user-role-select').value=savedRole;
  $('#user-name-input').addEventListener('input',e=>{S.userName=e.target.value;localStorage.setItem('vs-name',e.target.value);
    $('#sidebar-user-name').textContent=e.target.value||'User';$('#sidebar-avatar').textContent=initials(e.target.value||'User');});
  $('#user-role-select').addEventListener('change',e=>{S.userRole=e.target.value;localStorage.setItem('vs-role',e.target.value);$('#sidebar-user-role').textContent=e.target.value;applyRoleVisibility();});
  S.userName=$('#user-name-input').value||'User';S.userRole=$('#user-role-select').value;
  $('#sidebar-user-name').textContent=S.userName;$('#sidebar-avatar').textContent=initials(S.userName);$('#sidebar-user-role').textContent=S.userRole;

  // Create classroom
  $('#cls-create-btn').addEventListener('click',async()=>{
    const name=$('#cls-name').value.trim();if(!name){toast('Name required','warning');return;}
    await fetch('/api/classrooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:$('#cls-desc').value,maxStudents:parseInt($('#cls-max').value)||50,instructorId:S.userName,instructorName:S.userName})});
    closeModal('create-classroom-modal');$('#cls-name').value='';$('#cls-desc').value='';toast('✅ Classroom created','success');loadDashboard();
  });

  // Create meeting
  $('#mtg-create-btn').addEventListener('click',async()=>{
    const name=$('#mtg-name').value.trim();if(!name){toast('Name required','warning');return;}
    await fetch('/api/meeting-rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:$('#mtg-desc').value,createdBy:S.userName,maxParticipants:parseInt($('#mtg-max').value)||100})});
    closeModal('create-meeting-modal');$('#mtg-name').value='';$('#mtg-desc').value='';toast('✅ Meeting room created','success');loadDashboard();
  });

  // Create breakout
  $('#bo-create-btn').addEventListener('click',()=>{
    const name=$('#bo-name').value.trim()||`Breakout ${Date.now()%1000}`;
    S.socket.emit('create-breakout',{name,assignedStudents:[]});
    closeModal('create-breakout-modal');$('#bo-name').value='';
  });

  // Lobby
  $('#lobby-mic-btn').addEventListener('click',()=>{S.audioEnabled=!S.audioEnabled;if(S.localStream)S.localStream.getAudioTracks().forEach(t=>{t.enabled=S.audioEnabled;});updateLobbyControls();});
  $('#lobby-cam-btn').addEventListener('click',()=>{S.videoEnabled=!S.videoEnabled;if(S.localStream)S.localStream.getVideoTracks().forEach(t=>{t.enabled=S.videoEnabled;});
    $('#lobby-video').style.display=S.videoEnabled?'block':'none';$('#lobby-placeholder').style.display=S.videoEnabled?'none':'flex';updateLobbyControls();});
  $('#lobby-back-btn').addEventListener('click',()=>{if(S.localStream){S.localStream.getTracks().forEach(t=>t.stop());S.localStream=null;}showPage('dashboard-page');});
  $('#lobby-join-btn').addEventListener('click',()=>{
    connectSocket();
    // Wait for connection
    const tryJoin=()=>{
      if(!S.socket.connected){setTimeout(tryJoin,200);return;}
      if(S.isHost){
        S.socket.emit('create-room',{roomId:S.roomId,type:S.roomType,name:S.roomName,hostName:S.userName,settings:{}},(r)=>{
          if(r.success)enterMeeting(r);else toast('❌ '+r.error,'error');
        });
      }else{
        S.socket.emit('join-room',{roomId:S.roomId,userName:S.userName,userRole:S.userRole},(r)=>{
          if(r.success){if(r.waiting){$('#lobby-join-btn').style.display='none';$('#lobby-waiting').style.display='flex';}else enterMeeting(r);}
          else toast('❌ '+r.error,'error');
        });
      }
    };
    tryJoin();
  });
  $('#lobby-cancel-wait').addEventListener('click',()=>{if(S.socket)S.socket.emit('leave-room');$('#lobby-waiting').style.display='none';$('#lobby-join-btn').style.display='';showPage('dashboard-page');});

  // Toolbar
  $('#toolbar-mic').addEventListener('click',()=>toggleAudio());
  $('#toolbar-camera').addEventListener('click',()=>toggleVideo());
  $('#toolbar-screen').addEventListener('click',toggleScreenShare);
  $('#toolbar-participants').addEventListener('click',()=>togglePanel('participants'));
  $('#toolbar-chat').addEventListener('click',()=>togglePanel('chat'));
  $('#toolbar-transcript').addEventListener('click',()=>togglePanel('transcript'));
  $('#toolbar-reactions').addEventListener('click',()=>{$('#reactions-picker').classList.toggle('open');});
  $('#toolbar-hand').addEventListener('click',()=>{S.handRaised=!S.handRaised;S.socket.emit('toggle-hand',{raised:S.handRaised});updateToolbar();updateVideoGrid();});
  $('#toolbar-record').addEventListener('click',toggleRecording);
  $('#toolbar-breakout').addEventListener('click',()=>togglePanel('breakout'));
  $('#toolbar-leave').addEventListener('click',()=>openModal('leave-modal'));

  // ── Toolbar Collapse / Expand ──
  $('#toolbar-collapse-btn').addEventListener('click', () => {
    const tb = $('#meeting-toolbar');
    tb.classList.toggle('collapsed');
    localStorage.setItem('vs-toolbar-collapsed', tb.classList.contains('collapsed'));
  });
  // Restore collapse state
  if (localStorage.getItem('vs-toolbar-collapsed') === 'true') {
    $('#meeting-toolbar').classList.add('collapsed');
  }

  // ── Toolbar Drag (from all edges) + Reset ──
  (function initToolbarDrag() {
    const tb = $('#meeting-toolbar');
    let isDragging = false, startX, startY, origLeft, origTop;
    let dragOffsetX = 0, dragOffsetY = 0;

    function makeFloating() {
      if (tb.classList.contains('floating')) return;
      const rect = tb.getBoundingClientRect();
      tb.classList.add('floating');
      tb.style.left = rect.left + rect.width / 2 + 'px';
      tb.style.bottom = (window.innerHeight - rect.bottom + 16) + 'px';
      tb.style.transform = 'translateX(-50%)';
    }

    function resetToolbarPosition() {
      tb.classList.remove('floating');
      tb.style.left = '';
      tb.style.top = '';
      tb.style.bottom = '';
      tb.style.transform = '';
      tb.style.right = '';
      toast('\u2705 Toolbar reset', 'info');
    }
    // Expose globally for the reset button
    window._resetToolbar = resetToolbarPosition;

    // Make the entire toolbar edge-draggable (not just the handle)
    tb.addEventListener('mousedown', (e) => {
      // Don't drag if clicking a button, input, or interactive element
      const tag = e.target.tagName.toLowerCase();
      const isInteractive = tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' ||
                            e.target.closest('button') || e.target.closest('.toolbar-btn') || e.target.closest('.toolbar-btn-end');
      // Allow drag from: the drag handle, the toolbar background, toolbar dividers
      const isDragHandle = e.target.id === 'toolbar-drag-handle' || e.target.classList.contains('toolbar-divider');
      // Allow drag from edges: if click is near top/bottom 8px of toolbar, or the gap between buttons
      const rect = tb.getBoundingClientRect();
      const nearEdge = (e.clientY - rect.top < 8) || (rect.bottom - e.clientY < 8);

      if(!isDragHandle && !nearEdge && isInteractive) return;

      e.preventDefault();
      makeFloating();
      isDragging = true;
      tb.classList.add('dragging');
      const tbRect = tb.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = tbRect.left + tbRect.width / 2;
      origTop = tbRect.top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = origLeft + dx;
      const newTop = origTop + dy;
      // Clamp to viewport
      const clampedLeft = Math.max(tb.offsetWidth / 2, Math.min(window.innerWidth - tb.offsetWidth / 2, newLeft));
      const clampedTop = Math.max(0, Math.min(window.innerHeight - 60, newTop));
      tb.style.left = clampedLeft + 'px';
      tb.style.bottom = 'auto';
      tb.style.top = clampedTop + 'px';
      tb.style.transform = 'translateX(-50%)';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      tb.classList.remove('dragging');
    });

    // Double-click anywhere on toolbar to reset
    tb.addEventListener('dblclick', (e) => {
      // Don't reset if double-clicking a button
      if(e.target.closest('button') || e.target.closest('.toolbar-btn') || e.target.closest('.toolbar-btn-end')) return;
      resetToolbarPosition();
    });
  })();
    $('#toolbar-annotate').addEventListener('click',()=>{
    S.annotating=!S.annotating;
    $('#annotation-toolbar').classList.toggle('open',S.annotating);
    $('#annotation-canvas').classList.toggle('active',S.annotating);
    updateToolbar();
  });
  $('#toolbar-remote').addEventListener('click',()=>{
    if(S.remoteControlling){
      // Already controlling - stop
      S.socket.emit('revoke-remote-control');
      S.remoteControlling=null;
      hideRemoteControlBar();
      cleanupRemoteControl();
      toast('🖱️ Remote control ended','info');
    } else {
      const sharer=Array.from(S.peers.entries()).find(([_,p])=>p.screenSharing);
      if(sharer){
        S.socket.emit('request-remote-control',{targetId:sharer[0]});
        toast('🖱️ Requesting remote control...','info');
      } else {
        toast('No one is sharing their screen','warning');
      }
    }
  });

  // Remote control approval modal buttons
  $('#rc-approve-btn').addEventListener('click',()=>{
    if(S.rcPendingRequest){
      clearTimeout(S._rcTimeout);
      S.remoteControlledBy=S.rcPendingRequest.fromId;
      S.socket.emit('grant-remote-control',{toId:S.rcPendingRequest.fromId});
      showRemoteControlBar(`${S.rcPendingRequest.fromName} is controlling your screen`,false);
      S.rcPendingRequest=null;
      closeModal('remote-control-modal');
    }
  });
  $('#rc-deny-btn').addEventListener('click',()=>{
    if(S.rcPendingRequest){
      clearTimeout(S._rcTimeout);
      S.socket.emit('deny-remote-control',{toId:S.rcPendingRequest.fromId});
      S.rcPendingRequest=null;
      closeModal('remote-control-modal');
    }
  });
  $('#rc-bar-stop').addEventListener('click',()=>{
    if(S.remoteControlling){
      S.socket.emit('revoke-remote-control');
      S.remoteControlling=null;
      cleanupRemoteControl();
    }
    if(S.remoteControlledBy){
      S.socket.emit('revoke-remote-control');
      S.remoteControlledBy=null;
    }
    hideRemoteControlBar();
    toast('🖱️ Remote control ended','info');
  });

  // Annotation tools
  $$('.annotation-tool').forEach(t=>{
    t.addEventListener('click',()=>{
      const tool=t.dataset.tool;
      if(tool==='undo'){S.socket.emit('annotation-undo');return;}
      if(tool==='clear'){S.socket.emit('annotation-clear');clearCanvas();return;}
      if(tool==='close'){S.annotating=false;$('#annotation-toolbar').classList.remove('open');$('#annotation-canvas').classList.remove('active');updateToolbar();return;}
      S.annotationTool=tool;
      $$('.annotation-tool').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
    });
  });
  $$('.annotation-color').forEach(c=>{
    c.addEventListener('click',()=>{S.annotationColor=c.dataset.color;$$('.annotation-color').forEach(x=>x.classList.remove('active'));c.classList.add('active');});
  });
  $('#annotation-size').addEventListener('input',e=>{S.annotationSize=parseInt(e.target.value);});

  // Reactions
  $$('.reaction-option').forEach(o=>{o.addEventListener('click',()=>{S.socket.emit('reaction',{emoji:o.dataset.emoji});$('#reactions-picker').classList.remove('open');});});
  document.addEventListener('click',e=>{if(!$('#reactions-picker').contains(e.target)&&!$('#toolbar-reactions').contains(e.target))$('#reactions-picker').classList.remove('open');});

  // Chat
  $('#chat-send-btn').addEventListener('click',sendChat);
  $('#chat-input').addEventListener('keypress',e=>{if(e.key==='Enter')sendChat();});
  $('#chat-close-btn').addEventListener('click',()=>togglePanel('chat'));
  $('#participants-close-btn').addEventListener('click',()=>togglePanel('participants'));
  $('#transcript-close-btn').addEventListener('click',()=>togglePanel('transcript'));
  $('#breakout-close-btn').addEventListener('click',()=>togglePanel('breakout'));

  // View toggle
  $('#gallery-view-btn').addEventListener('click',()=>{S.viewMode='gallery';$('#gallery-view-btn').classList.add('active');$('#speaker-view-btn').classList.remove('active');updateVideoGrid();});
  $('#speaker-view-btn').addEventListener('click',()=>{S.viewMode='speaker';$('#speaker-view-btn').classList.add('active');$('#gallery-view-btn').classList.remove('active');updateVideoGrid();});

  // Meeting ID copy
  $('#meeting-id-display').addEventListener('click',()=>{if(S.roomId)navigator.clipboard.writeText(S.roomId).then(()=>toast('📋 Copied','success'));});

  // Leave modal
  $('#leave-btn').addEventListener('click',()=>{closeModal('leave-modal');leaveMeeting();});
  $('#end-meeting-btn').addEventListener('click',()=>{closeModal('leave-modal');if(S.socket)S.socket.emit('end-meeting');leaveMeeting();});

  // Keyboard shortcuts
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
    if(e.altKey){
      switch(e.key.toLowerCase()){
        case'a':e.preventDefault();if(S.roomId)toggleAudio();break;
        case'v':e.preventDefault();if(S.roomId)toggleVideo();break;
        case's':e.preventDefault();if(S.roomId)toggleScreenShare();break;
        case'h':e.preventDefault();if(S.roomId)togglePanel('chat');break;
        case'u':e.preventDefault();if(S.roomId)togglePanel('participants');break;
        case'y':e.preventDefault();if(S.roomId)$('#toolbar-hand').click();break;
        case'f':e.preventDefault();if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen();break;
      }
    }
  });

  // Modal close on overlay click
  $$('.modal-overlay').forEach(m=>{m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');});});

  // Apply role-based visibility
  applyRoleVisibility();

  // Load dashboard
  loadDashboard();
  // Auto-refresh dashboard every 10s
  setInterval(()=>{if($('#dashboard-page').classList.contains('active'))loadDashboard();},10000);

  initThemeListeners();
  initIntegrationListeners();
  console.log('🎓 Virtual Studio initialized');
}

function initIntegrationListeners() {
  const addBtn = $('#add-integration-btn');
  const form = $('#integration-form');
  const cancelBtn = $('#int-cancel-btn');
  const saveBtn = $('#int-save-btn');

  if (addBtn) addBtn.addEventListener('click', () => {
    form.style.display = 'block';
    $('#int-name').value = '';
    $('#int-url').value = '';
    $('#int-type').value = 'slack';
    $('#int-evt-summary').checked = true;
    $('#int-evt-recording').checked = false;
    $('#int-evt-meeting').checked = false;
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
  });

  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const type = $('#int-type').value;
    const name = $('#int-name').value.trim();
    const url = $('#int-url').value.trim();
    if (!name || !url) { toast('Name and URL are required', 'warning'); return; }

    const events = [];
    if ($('#int-evt-summary').checked) events.push('summary_generated');
    if ($('#int-evt-recording').checked) events.push('recording_uploaded');
    if ($('#int-evt-meeting').checked) events.push('meeting_started', 'meeting_ended');

    try {
      await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name, config: { webhookUrl: url }, events })
      });
      toast('✅ Integration added!', 'success');
      form.style.display = 'none';
      await loadIntegrations();
    } catch (e) { toast('Failed to save integration', 'error'); }
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  STARTUP — Check auth then init
// ═══════════════════════════════════════════════════════════════════════
(async function startup() {
  init();
  const loggedIn = await tryAutoLogin();
  if (loggedIn) {
    applyAuthUser();
    applyRoleVisibility();
    showPage('dashboard-page');
    loadDashboard();
  } else {
    showPage('auth-page');
  }
})();
})();