/* ═══════════════════════════════════════════════════════════════════════
   Virtual Studio — Chat Frontend (Slack-Style Pop-out Window)
   Connects to Socket.IO /chat namespace
   ═══════════════════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const initials = name => (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const EMOJIS = [
    '👍','👎','😂','❤️','🔥','👀','🎉','😮','😢','🙏',
    '💯','✅','❌','🚀','💡','⚡','🤔','👏','💪','😍',
    '🤝','⭐','🎯','📌','🔔','💬','📝','🎓','📚','🧠'
  ];

  // Slack-style avatar background colors
  const AVATAR_COLORS = [
    '#4a154b','#1264a3','#2bac76','#e8912d','#7c3aed',
    '#e01e5a','#36c5f0','#ecb22e','#611f69','#2eb67d'
  ];

  function userColor(userId) {
    if (!userId) return AVATAR_COLORS[0];
    let hash = 0;
    for (let i = 0; i < userId.length; i++) hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  // ─── State ───────────────────────────────────────────────────────
  const state = {
    socket: null,
    token: null,
    user: null,
    channels: [],
    activeChannel: null,
    messages: [],
    typingUsers: {},
    onlineUsers: new Set(),
    threadParent: null,
    pendingRequests: [],
    searchTimeout: null,
    emojiPickerTarget: null,
  };

  // ─── Initialization ──────────────────────────────────────────────
  async function init() {
    const urlParams = new URLSearchParams(window.location.search);
    state.token = urlParams.get('token') || localStorage.getItem('vs-token');

    if (!state.token) {
      showError('Not authenticated. Please log in to Virtual Studio first.');
      return;
    }

    try {
      const resp = await fetch('/api/auth/me', {
        headers: { 'Authorization': 'Bearer ' + state.token }
      });
      if (!resp.ok) throw new Error('Auth failed');
      state.user = await resp.json();
    } catch(e) {
      showError('Authentication failed. Please log in again.');
      return;
    }

    updateCurrentUser();
    connectSocket();
    bindEvents();
  }

  function showError(msg) {
    const empty = $('#emptyState');
    if (empty) {
      empty.querySelector('.chat-empty-title').textContent = 'Something went wrong';
      empty.querySelector('.chat-empty-desc').textContent = msg;
      empty.querySelector('.chat-empty-icon').textContent = '⚠';
    }
  }

  function updateCurrentUser() {
    if (!state.user) return;
    const ini = initials(state.user.name);
    $('#currentUserAvatar').style.background = userColor(state.user.id);
    const avatarText = document.createTextNode(ini);
    const avatar = $('#currentUserAvatar');
    // Insert initials before the status dot
    avatar.insertBefore(avatarText, avatar.firstChild);
    $('#currentUserName').textContent = state.user.name;
    $('#sidebarUserName').textContent = state.user.name;
    $('#currentUserStatus').textContent = 'Active';
    document.title = `Virtual Studio — Chat · ${state.user.name}`;
  }

  // ─── Socket.IO Connection ────────────────────────────────────────
  function connectSocket() {
    const origin = window.location.origin;
    state.socket = io(origin + '/chat', {
      auth: { token: state.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 50,
      reconnectionDelay: 1000
    });

    const s = state.socket;

    s.on('connect', () => {
      console.log('[Chat] Connected:', s.id);
      hideConnectionBar();
      s.emit('get_channels', {}, (resp) => {
        if (resp.success) {
          state.channels = resp.channels;
          renderChannelList();
          if (!state.activeChannel && state.channels.length > 0) {
            const general = state.channels.find(c => c.name === 'general' && c.type === 'public');
            selectChannel(general || state.channels[0]);
          }
        }
      });
    });

    s.on('disconnect', () => {
      showConnectionBar('disconnected', 'Connection lost — reconnecting…');
    });

    s.on('reconnecting', () => {
      showConnectionBar('reconnecting', 'Reconnecting…');
    });

    s.on('connect_error', (err) => {
      console.error('[Chat] Connection error:', err.message);
      showConnectionBar('disconnected', 'Unable to connect — retrying…');
    });

    // ─── Socket Event Handlers ───────────────────────────────────
    s.on('new_message', (msg) => {
      if (state.activeChannel && msg.channel_id === state.activeChannel.id) {
        state.messages.push(msg);
        appendMessage(msg);
        scrollToBottom();
        s.emit('mark_read', { channelId: msg.channel_id });
      } else {
        updateUnreadBadge(msg.channel_id);
      }
    });

    s.on('message_edited', (data) => {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        const contentEl = msgEl.querySelector('.chat-msg-content');
        if (contentEl) contentEl.innerHTML = formatContent(data.content) + ' <span class="chat-msg-edited">(edited)</span>';
      }
      // Update state
      const msg = state.messages.find(m => m.id === data.messageId);
      if (msg) { msg.content = data.content; msg.is_edited = true; }
    });

    s.on('message_deleted', (data) => {
      const msgEl = document.querySelector(`[data-msg-id="${data.messageId}"]`);
      if (msgEl) {
        msgEl.classList.add('chat-system-message');
        msgEl.style.padding = '4px 20px';
        msgEl.innerHTML = '<em>This message was deleted.</em>';
      }
    });

    s.on('reaction_updated', (data) => {
      updateReactions(data.messageId, data.reactions);
    });

    s.on('user_typing', (data) => {
      if (state.activeChannel && data.channelId === state.activeChannel.id) {
        state.typingUsers[data.userId] = { name: data.userName, ts: Date.now() };
        renderTypingIndicator();
      }
    });

    s.on('user_stop_typing', (data) => {
      delete state.typingUsers[data.userId];
      renderTypingIndicator();
    });

    s.on('user_online', (data) => {
      state.onlineUsers.add(data.userId);
      updateDmOnlineStatus(data.userId, true);
    });

    s.on('user_offline', (data) => {
      state.onlineUsers.delete(data.userId);
      updateDmOnlineStatus(data.userId, false);
    });

    s.on('channel_created', (channel) => {
      state.channels.push(channel);
      renderChannelList();
    });

    s.on('member_added', (data) => {
      if (state.activeChannel && data.channelId === state.activeChannel.id) {
        appendSystemMessage(`${data.userName} joined the channel`);
      }
    });

    s.on('member_removed', (data) => {
      if (state.activeChannel && data.channelId === state.activeChannel.id) {
        appendSystemMessage(`${data.userName} left the channel`);
      }
    });

    s.on('member_request', (data) => {
      state.pendingRequests.push(data);
      showMemberRequestToast(data);
    });

    s.on('request_approved', (data) => {
      toast(`${data.userName} was added to the channel`, 'success');
    });

    s.on('request_denied', () => {
      toast('Request to add member was denied', 'info');
    });

    s.on('added_to_channel', (data) => {
      s.emit('get_channels', {}, (resp) => {
        if (resp.success) {
          state.channels = resp.channels;
          renderChannelList();
        }
      });
      toast(`You were added to #${data.channelName}`, 'success');
    });
  }

  // ─── Connection Bar ──────────────────────────────────────────────
  function showConnectionBar(type, msg) {
    const bar = $('#connectionBar');
    bar.className = 'chat-connection-bar ' + type;
    bar.textContent = msg;
  }
  function hideConnectionBar() {
    $('#connectionBar').className = 'chat-connection-bar';
    $('#connectionBar').style.display = 'none';
  }

  // ─── Channel List ────────────────────────────────────────────────
  function renderChannelList() {
    const channelContainer = $('#channelList');
    const dmContainer = $('#dmList');
    channelContainer.innerHTML = '';
    dmContainer.innerHTML = '';

    const channels = state.channels.filter(c => c.type === 'public' || c.type === 'private');
    const dms = state.channels.filter(c => c.type === 'dm');

    channels.forEach(ch => {
      const el = document.createElement('div');
      const isActive = state.activeChannel && state.activeChannel.id === ch.id;
      const hasUnread = ch._unread > 0;
      el.className = 'chat-channel-item' + (isActive ? ' active' : '') + (hasUnread ? ' unread' : '');
      el.dataset.channelId = ch.id;
      const icon = ch.type === 'private' ? '🔒' : '<span style="font-family:serif;font-weight:400;">#</span>';
      el.innerHTML = `
        <span class="channel-icon">${icon}</span>
        <span class="channel-name">${escHtml(ch.name)}</span>
        ${hasUnread ? `<span class="chat-unread-badge">${ch._unread}</span>` : ''}
      `;
      el.addEventListener('click', () => selectChannel(ch));
      channelContainer.appendChild(el);
    });

    dms.forEach(ch => {
      const otherName = ch._otherUser || ch.name || 'DM';
      const el = document.createElement('div');
      const isActive = state.activeChannel && state.activeChannel.id === ch.id;
      const hasUnread = ch._unread > 0;
      el.className = 'chat-channel-item' + (isActive ? ' active' : '') + (hasUnread ? ' unread' : '');
      el.dataset.channelId = ch.id;
      const isOnline = ch._otherUserId && state.onlineUsers.has(ch._otherUserId);
      const color = userColor(ch._otherUserId);
      el.innerHTML = `
        <div class="chat-dm-avatar ${isOnline ? 'online' : ''}" data-user-id="${ch._otherUserId || ''}" style="background:${color};">${initials(otherName)}</div>
        <span class="channel-name">${escHtml(otherName)}</span>
        ${hasUnread ? `<span class="chat-unread-badge">${ch._unread}</span>` : ''}
      `;
      el.addEventListener('click', () => selectChannel(ch));
      dmContainer.appendChild(el);
    });
  }

  function updateUnreadBadge(channelId) {
    const ch = state.channels.find(c => c.id === channelId);
    if (ch) {
      ch._unread = (ch._unread || 0) + 1;
      renderChannelList();
    }
  }

  function updateDmOnlineStatus(userId, online) {
    document.querySelectorAll(`.chat-dm-avatar[data-user-id="${userId}"]`).forEach(a => {
      a.classList.toggle('online', online);
    });
  }

  // ─── Channel Selection ───────────────────────────────────────────
  function selectChannel(channel) {
    state.activeChannel = channel;
    state.messages = [];
    state.typingUsers = {};
    channel._unread = 0;

    renderChannelList();
    $('#emptyState').style.display = 'none';
    $('#chatHeader').style.display = 'flex';
    $('#messagesContainer').style.display = 'flex';
    $('#chatInputArea').style.display = 'block';

    const isDm = channel.type === 'dm';
    const displayName = isDm ? (channel._otherUser || channel.name) : channel.name;
    $('#headerChannelIcon').innerHTML = isDm ? '' : (channel.type === 'private' ? '🔒 ' : '<span style="font-family:serif;font-weight:400;margin-right:2px;">#</span>');
    $('#headerChannelName').textContent = displayName;
    $('#headerTopic').textContent = channel.description || '';
    $('#headerMemberCount').textContent = '';

    $('#messagesContainer').innerHTML = '';
    $('#typingIndicator').innerHTML = '';
    closeThread();

    $('#messageInput').placeholder = isDm ? `Message ${channel._otherUser || 'user'}` : `Message #${channel.name}`;
    $('#messageInput').focus();

    state.socket.emit('join_channel', { channelId: channel.id });
    loadMessages(channel.id);
    state.socket.emit('mark_read', { channelId: channel.id });
  }

  function loadMessages(channelId, before) {
    state.socket.emit('get_messages', { channelId, limit: 50, before }, (resp) => {
      if (resp.success) {
        state.messages = resp.messages.reverse();
        renderAllMessages();
        scrollToBottom();
      }
    });
  }

  // ─── Message Rendering ───────────────────────────────────────────
  function renderAllMessages() {
    const container = $('#messagesContainer');
    container.innerHTML = '';
    let lastUser = null;
    let lastDate = null;

    state.messages.forEach((msg, i) => {
      const msgDate = formatDate(msg.created_at);
      if (msgDate !== lastDate) {
        container.appendChild(createDateDivider(msgDate));
        lastDate = msgDate;
        lastUser = null;
      }
      if (msg.type === 'system') {
        container.appendChild(createSystemMsg(msg.content));
        lastUser = null;
        return;
      }
      const isCont = (lastUser === msg.user_id) &&
        (i > 0 && (new Date(msg.created_at) - new Date(state.messages[i-1].created_at)) < 300000);
      container.appendChild(createMessageEl(msg, isCont));
      lastUser = msg.user_id;
    });
  }

  function appendMessage(msg) {
    const container = $('#messagesContainer');
    const lastMsg = state.messages.length > 1 ? state.messages[state.messages.length - 2] : null;

    const msgDate = formatDate(msg.created_at);
    if (lastMsg) {
      const lastDate = formatDate(lastMsg.created_at);
      if (msgDate !== lastDate) container.appendChild(createDateDivider(msgDate));
    }
    if (msg.type === 'system') {
      container.appendChild(createSystemMsg(msg.content));
      return;
    }
    const isCont = lastMsg && lastMsg.user_id === msg.user_id &&
      msg.type !== 'system' && lastMsg.type !== 'system' &&
      (new Date(msg.created_at) - new Date(lastMsg.created_at)) < 300000;
    container.appendChild(createMessageEl(msg, isCont));
  }

  function createDateDivider(dateStr) {
    const d = document.createElement('div');
    d.className = 'chat-date-divider';
    d.innerHTML = `<span>${dateStr}</span>`;
    return d;
  }

  function createSystemMsg(text) {
    const d = document.createElement('div');
    d.className = 'chat-system-message';
    d.textContent = text;
    return d;
  }

  function createMessageEl(msg, isContinuation) {
    const el = document.createElement('div');
    el.className = 'chat-message' + (isContinuation ? ' continuation' : '');
    el.dataset.msgId = msg.id;

    const time = new Date(msg.created_at);
    const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const compactTime = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    const role = msg.user_role || 'student';
    const isOwn = state.user && msg.user_id === state.user.id;
    const showBadge = role !== 'student';
    const color = userColor(msg.user_id);

    let reactions = {};
    try { reactions = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions || '{}') : (msg.reactions || {}); } catch(e) {}

    el.innerHTML = `
      <div class="chat-msg-compact-time">${compactTime}</div>
      <div class="chat-msg-avatar role-${role}" style="background:${color};">${initials(msg.user_name)}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-header">
          <span class="chat-msg-name">${escHtml(msg.user_name)}</span>
          ${showBadge ? `<span class="chat-msg-role-badge ${role}">${role}</span>` : ''}
          <span class="chat-msg-time-header">${timeStr}</span>
        </div>
        <div class="chat-msg-content">${formatContent(msg.content)}${msg.is_edited ? ' <span class="chat-msg-edited">(edited)</span>' : ''}</div>
        ${renderReactionsHtml(msg.id, reactions)}
        ${msg.reply_count > 0 ? `<div class="chat-msg-thread-link" data-parent-id="${msg.id}">
          <span style="font-size:14px;">💬</span> ${msg.reply_count} ${msg.reply_count === 1 ? 'reply' : 'replies'}
        </div>` : ''}
      </div>
      <div class="chat-msg-actions">
        <button class="chat-msg-action-btn" data-action="react" data-msg-id="${msg.id}" title="Add reaction">☺</button>
        <button class="chat-msg-action-btn" data-action="thread" data-msg-id="${msg.id}" title="Reply in thread">💬</button>
        ${isOwn ? `<button class="chat-msg-action-btn" data-action="edit" data-msg-id="${msg.id}" title="Edit">✏</button>` : ''}
        ${isOwn ? `<button class="chat-msg-action-btn" data-action="delete" data-msg-id="${msg.id}" title="Delete">🗑</button>` : ''}
      </div>
    `;

    const threadLink = el.querySelector('.chat-msg-thread-link');
    if (threadLink) threadLink.addEventListener('click', () => openThread(msg));

    return el;
  }

  function renderReactionsHtml(msgId, reactions) {
    if (!reactions || Object.keys(reactions).length === 0) return '';
    let html = '<div class="chat-msg-reactions">';
    for (const [emoji, users] of Object.entries(reactions)) {
      const reacted = state.user && users.includes(state.user.id);
      html += `<span class="chat-reaction ${reacted ? 'reacted' : ''}" data-msg-id="${msgId}" data-emoji="${emoji}">
        <span class="reaction-emoji">${emoji}</span>
        <span class="reaction-count">${users.length}</span>
      </span>`;
    }
    html += '</div>';
    return html;
  }

  function updateReactions(messageId, reactions) {
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!msgEl) return;
    const body = msgEl.querySelector('.chat-msg-body');
    const existing = body.querySelector('.chat-msg-reactions');
    let parsed = {};
    try { parsed = typeof reactions === 'string' ? JSON.parse(reactions) : reactions; } catch(e) {}
    const html = renderReactionsHtml(messageId, parsed);
    if (existing) existing.outerHTML = html;
    else {
      const content = body.querySelector('.chat-msg-content');
      content.insertAdjacentHTML('afterend', html);
    }
  }

  function formatContent(text) {
    if (!text) return '';
    let html = escHtml(text);
    // Code block
    html = html.replace(/```([\s\S]+?)```/g, '<pre><code>$1</code></pre>');
    // Bold
    html = html.replace(/\*(.+?)\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\_(.+?)\_/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    // Links
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // @mentions
    html = html.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
    return html;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function appendSystemMessage(text) {
    const container = $('#messagesContainer');
    container.appendChild(createSystemMsg(text));
    scrollToBottom();
  }

  function scrollToBottom() {
    const c = $('#messagesContainer');
    requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
  }

  // ─── Typing Indicator ────────────────────────────────────────────
  function renderTypingIndicator() {
    const indicator = $('#typingIndicator');
    const now = Date.now();
    for (const uid of Object.keys(state.typingUsers)) {
      if (now - state.typingUsers[uid].ts > 5000) delete state.typingUsers[uid];
    }
    const names = Object.values(state.typingUsers).map(u => u.name);
    if (names.length === 0) {
      indicator.innerHTML = '';
    } else if (names.length === 1) {
      indicator.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div> <strong>${escHtml(names[0])}</strong> is typing…`;
    } else if (names.length <= 3) {
      indicator.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div> <strong>${names.map(escHtml).join('</strong>, <strong>')}</strong> are typing…`;
    } else {
      indicator.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div> Several people are typing…`;
    }
  }

  // ─── Thread Panel ────────────────────────────────────────────────
  function openThread(parentMsg) {
    state.threadParent = parentMsg;
    const panel = $('#threadPanel');
    panel.classList.add('open');
    const threadMsgs = $('#threadMessages');
    threadMsgs.innerHTML = '';

    const parentEl = createMessageEl(parentMsg, false);
    parentEl.style.borderBottom = '1px solid var(--slack-border)';
    parentEl.style.paddingBottom = '12px';
    parentEl.style.marginBottom = '8px';
    threadMsgs.appendChild(parentEl);

    state.socket.emit('get_messages', {
      channelId: state.activeChannel.id,
      parentId: parentMsg.id,
      limit: 50
    }, (resp) => {
      if (resp.success) {
        resp.messages.reverse().forEach(m => {
          threadMsgs.appendChild(createMessageEl(m, false));
        });
      }
    });

    $('#threadInput').focus();
  }

  function closeThread() {
    state.threadParent = null;
    $('#threadPanel').classList.remove('open');
  }

  // ─── Send Message ────────────────────────────────────────────────
  function sendMessage() {
    const input = $('#messageInput');
    const content = input.value.trim();
    if (!content || !state.activeChannel) return;

    state.socket.emit('send_message', {
      channelId: state.activeChannel.id,
      content
    }, (resp) => {
      if (resp.success) {
        input.value = '';
        input.style.height = 'auto';
        updateSendButton();
        state.socket.emit('stop_typing', { channelId: state.activeChannel.id });
      } else {
        toast(resp.error || 'Failed to send message', 'error');
      }
    });
  }

  function sendThreadReply() {
    const input = $('#threadInput');
    const content = input.value.trim();
    if (!content || !state.activeChannel || !state.threadParent) return;

    state.socket.emit('send_message', {
      channelId: state.activeChannel.id,
      content,
      parentId: state.threadParent.id
    }, (resp) => {
      if (resp.success) {
        input.value = '';
        const el = createMessageEl(resp.message, false);
        $('#threadMessages').appendChild(el);
      }
    });
  }

  // ─── Channel/DM Creation ─────────────────────────────────────────
  function createChannel() {
    const name = $('#newChannelName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const description = $('#newChannelDesc').value.trim();
    const type = $('#newChannelType').value;
    if (!name) { toast('Channel name is required', 'error'); return; }

    state.socket.emit('create_channel', { name, type, description }, (resp) => {
      if (resp.success) {
        closeModal('newChannelModal');
        $('#newChannelName').value = '';
        $('#newChannelDesc').value = '';
        state.channels.push(resp.channel);
        renderChannelList();
        selectChannel(resp.channel);
        toast(`#${name} was created`, 'success');
      } else {
        toast(resp.error || 'Failed to create channel', 'error');
      }
    });
  }

  function openNewDmModal() {
    openModal('newDmModal');
    $('#dmUserSearch').value = '';
    $('#dmUserList').innerHTML = '<div style="text-align:center;color:var(--slack-text-muted);padding:20px;font-size:13px;">Type to find someone…</div>';
    fetchUsers('');
    setTimeout(() => $('#dmUserSearch').focus(), 100);
  }

  async function fetchUsers(query) {
    try {
      const resp = await fetch('/api/admin/users', {
        headers: { 'Authorization': 'Bearer ' + state.token }
      });
      if (!resp.ok) return;
      const users = await resp.json();
      const filtered = users.filter(u =>
        u.id !== state.user.id &&
        (!query || u.name.toLowerCase().includes(query.toLowerCase()))
      );
      renderDmUserList(filtered);
    } catch(e) {
      console.error('Failed to fetch users:', e);
    }
  }

  function renderDmUserList(users) {
    const container = $('#dmUserList');
    if (users.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:var(--slack-text-muted);padding:20px;font-size:13px;">No users found</div>';
      return;
    }
    container.innerHTML = '';
    users.forEach(user => {
      const el = document.createElement('div');
      el.className = 'chat-channel-item';
      el.style.height = 'auto';
      el.style.padding = '8px';
      const color = userColor(user.id);
      el.innerHTML = `
        <div class="chat-dm-avatar" style="background:${color};">${initials(user.name)}</div>
        <span class="channel-name" style="color:var(--slack-text-primary);">${escHtml(user.name)}</span>
        <span style="font-size:13px;color:var(--slack-text-muted);margin-left:auto;">${user.role}</span>
      `;
      el.addEventListener('click', () => startDm(user));
      container.appendChild(el);
    });
  }

  function startDm(targetUser) {
    state.socket.emit('send_private_message', {
      targetUserId: targetUser.id,
      content: ''
    }, (resp) => {
      if (resp.success || resp.channel) {
        closeModal('newDmModal');
        state.socket.emit('get_channels', {}, (chResp) => {
          if (chResp.success) {
            state.channels = chResp.channels;
            renderChannelList();
            const dmCh = state.channels.find(c => c.id === (resp.channel ? resp.channel.id : resp.channelId));
            if (dmCh) selectChannel(dmCh);
          }
        });
      } else {
        toast(resp.error || 'Failed to start DM', 'error');
      }
    });
  }

  // ─── Emoji Picker ────────────────────────────────────────────────
  function initEmojiPicker() {
    const grid = $('#emojiGrid');
    EMOJIS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'chat-emoji-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => onEmojiSelect(emoji));
      grid.appendChild(btn);
    });
  }

  function toggleEmojiPicker(target) {
    state.emojiPickerTarget = target;
    $('#emojiPicker').classList.toggle('open');
  }

  function onEmojiSelect(emoji) {
    if (state.emojiPickerTarget === 'input') {
      const input = $('#messageInput');
      input.value += emoji;
      input.focus();
    } else if (state.emojiPickerTarget) {
      state.socket.emit('toggle_reaction', { messageId: state.emojiPickerTarget, emoji });
    }
    $('#emojiPicker').classList.remove('open');
    state.emojiPickerTarget = null;
  }

  // ─── Member Request Handling ─────────────────────────────────────
  function showMemberRequestToast(request) {
    const t = $('#memberRequestToast');
    $('#requestToastTitle').textContent = 'Member request';
    $('#requestToastBody').textContent = `${request.requestedByName} wants to add ${request.userToAddName} to #${request.channelName}`;
    t.classList.add('show');
    t.dataset.requestId = request.requestId;
    setTimeout(() => t.classList.remove('show'), 30000);
  }

  function handleMemberRequest(approved) {
    const t = $('#memberRequestToast');
    const requestId = t.dataset.requestId;
    if (!requestId) return;
    const action = approved ? 'approve_member_request' : 'deny_member_request';
    state.socket.emit(action, { requestId }, (resp) => {
      if (resp.success) t.classList.remove('show');
    });
  }

  // ─── Search ──────────────────────────────────────────────────────
  function doSearch(query) {
    if (!query.trim()) return;
    state.socket.emit('search_messages', { query, limit: 20 }, (resp) => {
      if (resp.success && resp.messages.length > 0) {
        const first = resp.messages[0];
        const ch = state.channels.find(c => c.id === first.channel_id);
        if (ch) selectChannel(ch);
        toast(`Found ${resp.messages.length} results`, 'info');
      } else {
        toast('No results found', 'info');
      }
    });
  }

  // ─── Modal Helpers ───────────────────────────────────────────────
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // ─── Toast ───────────────────────────────────────────────────────
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'chat-toast ' + (type || 'info');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ─── Utilities ───────────────────────────────────────────────────
  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function updateSendButton() {
    $('#btnSend').disabled = !$('#messageInput').value.trim();
  }

  // ─── Event Bindings ──────────────────────────────────────────────
  function bindEvents() {
    const msgInput = $('#messageInput');
    let typingTimer = null;

    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px';
      updateSendButton();
      if (state.activeChannel) {
        state.socket.emit('typing', { channelId: state.activeChannel.id });
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          state.socket.emit('stop_typing', { channelId: state.activeChannel.id });
        }, 3000);
      }
    });

    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    $('#btnSend').addEventListener('click', sendMessage);

    // Thread
    const threadInput = $('#threadInput');
    threadInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); }
    });
    threadInput.addEventListener('input', () => { $('#btnThreadSend').disabled = !threadInput.value.trim(); });
    $('#btnThreadSend').addEventListener('click', sendThreadReply);
    $('#threadClose').addEventListener('click', closeThread);

    // New channel
    $('#btnNewChannel').addEventListener('click', () => openModal('newChannelModal'));
    $$('[data-section="channels"]').forEach(b => b.addEventListener('click', () => openModal('newChannelModal')));
    $('#newChannelClose').addEventListener('click', () => closeModal('newChannelModal'));
    $('#newChannelCancel').addEventListener('click', () => closeModal('newChannelModal'));
    $('#newChannelCreate').addEventListener('click', createChannel);

    // New DM
    $$('[data-section="dms"]').forEach(b => b.addEventListener('click', openNewDmModal));
    $('#newDmClose').addEventListener('click', () => closeModal('newDmModal'));
    $('#newDmCancel').addEventListener('click', () => closeModal('newDmModal'));
    $('#dmUserSearch').addEventListener('input', (e) => {
      clearTimeout(state.searchTimeout);
      state.searchTimeout = setTimeout(() => fetchUsers(e.target.value), 250);
    });

    // Emoji
    initEmojiPicker();
    $('#btnEmoji').addEventListener('click', () => toggleEmojiPicker('input'));

    // Formatting
    $('#btnFormatBold').addEventListener('click', () => wrapSelection('*'));
    $('#btnFormatItalic').addEventListener('click', () => wrapSelection('_'));
    $('#btnFormatCode').addEventListener('click', () => wrapSelection('`'));

    // Search
    $('#chatSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(e.target.value); });

    // Message action delegation
    document.addEventListener('click', (e) => {
      const reaction = e.target.closest('.chat-reaction');
      if (reaction) {
        state.socket.emit('toggle_reaction', { messageId: reaction.dataset.msgId, emoji: reaction.dataset.emoji });
        return;
      }

      const actionBtn = e.target.closest('.chat-msg-action-btn');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        const msgId = actionBtn.dataset.msgId;
        if (action === 'react') toggleEmojiPicker(msgId);
        else if (action === 'thread') { const m = state.messages.find(x => x.id === msgId); if (m) openThread(m); }
        else if (action === 'edit') handleEditMessage(msgId);
        else if (action === 'delete') handleDeleteMessage(msgId);
        return;
      }

      // Close popovers on outside click
      if (!e.target.closest('.chat-emoji-picker') && !e.target.closest('[data-action="react"]') && !e.target.closest('#btnEmoji')) {
        $('#emojiPicker').classList.remove('open');
      }
      if (e.target.classList.contains('chat-modal-overlay')) e.target.classList.remove('open');
    });

    // Member requests
    $('#requestApprove').addEventListener('click', () => handleMemberRequest(true));
    $('#requestDeny').addEventListener('click', () => handleMemberRequest(false));

    // File attach
    $('#btnAttachFile').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) { $('#filePreview').classList.add('show'); $('#filePreviewName').textContent = file.name; }
    });
    $('#filePreviewRemove').addEventListener('click', () => {
      $('#fileInput').value = '';
      $('#filePreview').classList.remove('show');
    });

    $('#btnMembers').addEventListener('click', () => toast('Members panel coming soon', 'info'));
  }

  // ─── Edit / Delete ───────────────────────────────────────────────
  function handleEditMessage(msgId) {
    const msg = state.messages.find(m => m.id === msgId);
    if (!msg) return;
    const newContent = prompt('Edit message:', msg.content);
    if (newContent !== null && newContent.trim() !== msg.content) {
      state.socket.emit('edit_message', { messageId: msgId, content: newContent.trim() }, (resp) => {
        if (!resp.success) toast(resp.error || 'Failed to edit', 'error');
      });
    }
  }

  function handleDeleteMessage(msgId) {
    if (confirm('Delete this message? This can\'t be undone.')) {
      state.socket.emit('delete_message', { messageId: msgId }, (resp) => {
        if (!resp.success) toast(resp.error || 'Failed to delete', 'error');
      });
    }
  }

  // ─── Text Formatting ────────────────────────────────────────────
  function wrapSelection(char) {
    const input = $('#messageInput');
    const s = input.selectionStart, e = input.selectionEnd, t = input.value;
    if (s !== e) {
      input.value = t.slice(0, s) + char + t.slice(s, e) + char + t.slice(e);
      input.setSelectionRange(s + char.length, e + char.length);
    } else {
      input.value = t.slice(0, s) + char + char + t.slice(s);
      input.setSelectionRange(s + char.length, s + char.length);
    }
    input.focus();
    updateSendButton();
  }

  // ─── Boot ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();