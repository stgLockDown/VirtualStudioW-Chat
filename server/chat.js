/* ═══════════════════════════════════════════════════════════════════════════
   Virtual Studio — Native Chat System (Socket.IO /chat namespace)
   
   Handles channels, DMs, messages, reactions, typing, presence,
   meeting-chat persistence, host-controlled member management.
   ═══════════════════════════════════════════════════════════════════════════ */

const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const { verifyToken } = require('./auth');

// In-memory state
const onlineUsers = new Map();       // userId -> { socketId, name, role, status }
const typingTimers = new Map();      // `${channelId}:${userId}` -> timeout
const rateLimits = new Map();        // `add:${userId}:${channelId}` -> timestamp

function setupChat(io) {
  const chatNs = io.of('/chat');

  chatNs.on('connection', (socket) => {
    let currentUser = null;

    // ── Authentication ──────────────────────────────────────────────
    socket.on('authenticate', async ({ token }, cb) => {
      try {
        const decoded = verifyToken(token);
        if (!decoded) return cb?.({ success: false, error: 'Invalid token' });

        // Fetch fresh user data
        const user = await db.getOne(
          'SELECT id, username, name, role FROM users WHERE id = $1', [decoded.id]);
        if (!user) return cb?.({ success: false, error: 'User not found' });

        currentUser = { id: user.id, name: user.name, role: user.role, username: user.username };
        onlineUsers.set(user.id, { socketId: socket.id, name: user.name, role: user.role, status: 'online' });

        // Join personal room for DM notifications
        socket.join(`user:${user.id}`);

        // Join all channels user is a member of
        const memberships = await db.getAll(
          'SELECT channel_id FROM chat_channel_members WHERE user_id = $1', [user.id]);
        for (const m of memberships) {
          socket.join(`ch:${m.channel_id}`);
        }

        // Ensure #general channel exists, create if not
        await ensureGeneralChannel(user);

        // Update presence
        await db.run(
          `INSERT INTO chat_user_status (user_id, last_active_at) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET last_active_at = $2`,
          [user.id, Date.now()]);

        // Broadcast online status
        chatNs.emit('user_presence', { userId: user.id, online: true, name: user.name });

        cb?.({ success: true, user: currentUser });
      } catch (e) {
        console.error('[Chat] Auth error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Get Channels ────────────────────────────────────────────────
    socket.on('get_channels', async (data, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        // Get channels user is a member of
        const channels = await db.getAll(`
          SELECT c.*, cm.channel_role, cm.last_read_at,
            (SELECT COUNT(*) FROM chat_messages WHERE channel_id = c.id AND deleted_at IS NULL) as message_count,
            (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id) as member_count
          FROM chat_channels c
          INNER JOIN chat_channel_members cm ON cm.channel_id = c.id
          WHERE cm.user_id = $1 AND c.is_archived = $2
          ORDER BY c.created_at ASC
        `, [currentUser.id, false]);

        // Also get public channels user is NOT a member of
        const publicChannels = await db.getAll(`
          SELECT c.*,
            (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id) as member_count
          FROM chat_channels c
          WHERE c.type = 'public' AND c.is_archived = $1
            AND c.id NOT IN (SELECT channel_id FROM chat_channel_members WHERE user_id = $2)
          ORDER BY c.created_at ASC
        `, [false, currentUser.id]);

        // Get unread counts
        for (const ch of channels) {
          const lastRead = ch.last_read_at || 0;
          const unread = await db.getOne(
            'SELECT COUNT(*) as count FROM chat_messages WHERE channel_id = $1 AND created_at > $2 AND deleted_at IS NULL AND user_id != $3',
            [ch.id, lastRead, currentUser.id]);
          ch.unread_count = parseInt(unread?.count || 0);
        }

        cb?.({ success: true, channels, publicChannels });
      } catch (e) {
        console.error('[Chat] get_channels error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Create Channel ──────────────────────────────────────────────
    socket.on('create_channel', async ({ name, type, description, memberIds }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        // Permission check: students can't create private channels
        if (type === 'private' && currentUser.role === 'student') {
          return cb?.({ success: false, error: 'Students cannot create private channels' });
        }

        const id = 'ch-' + uuidv4().slice(0, 8);
        const channelType = type || 'public';
        await db.run(
          'INSERT INTO chat_channels (id, name, type, description, created_by) VALUES ($1,$2,$3,$4,$5)',
          [id, name, channelType, description || '', currentUser.id]);

        // Add creator as owner
        await db.run(
          'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
          ['cm-' + uuidv4().slice(0, 8), id, currentUser.id, 'owner']);
        socket.join(`ch:${id}`);

        // Add initial members
        if (memberIds && Array.isArray(memberIds)) {
          for (const uid of memberIds) {
            if (uid === currentUser.id) continue;
            await db.run(
              'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
              ['cm-' + uuidv4().slice(0, 8), id, uid, 'member']);
            // Notify user if online
            const online = onlineUsers.get(uid);
            if (online) {
              const s = chatNs.sockets.get(online.socketId);
              if (s) s.join(`ch:${id}`);
              chatNs.to(`user:${uid}`).emit('channel_joined', { channelId: id, name, type: channelType });
            }
          }
        }

        // System message
        await insertSystemMessage(id, `${currentUser.name} created this channel`);

        const channel = await db.getOne('SELECT * FROM chat_channels WHERE id = $1', [id]);
        chatNs.to(`ch:${id}`).emit('channel_created', { channel });
        cb?.({ success: true, channel });
      } catch (e) {
        console.error('[Chat] create_channel error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Join Channel ────────────────────────────────────────────────
    socket.on('join_channel', async ({ channelId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const channel = await db.getOne('SELECT * FROM chat_channels WHERE id = $1', [channelId]);
        if (!channel) return cb?.({ success: false, error: 'Channel not found' });
        if (channel.type !== 'public') return cb?.({ success: false, error: 'Cannot join private channel' });

        // Check if already a member
        const existing = await db.getOne(
          'SELECT id FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
          [channelId, currentUser.id]);
        if (!existing) {
          await db.run(
            'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
            ['cm-' + uuidv4().slice(0, 8), channelId, currentUser.id, 'member']);
          await insertSystemMessage(channelId, `${currentUser.name} joined the channel`);
        }
        socket.join(`ch:${channelId}`);
        chatNs.to(`ch:${channelId}`).emit('member_joined', { channelId, userId: currentUser.id, name: currentUser.name });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Leave Channel ───────────────────────────────────────────────
    socket.on('leave_channel', async ({ channelId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        await db.run('DELETE FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
          [channelId, currentUser.id]);
        socket.leave(`ch:${channelId}`);
        await insertSystemMessage(channelId, `${currentUser.name} left the channel`);
        chatNs.to(`ch:${channelId}`).emit('member_left', { channelId, userId: currentUser.id, name: currentUser.name });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Send Message ────────────────────────────────────────────────
    socket.on('send_message', async ({ channelId, content, parentId, meetingId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      if (!content || !content.trim()) return cb?.({ success: false, error: 'Empty message' });
      try {
        // Verify membership
        const member = await db.getOne(
          'SELECT id FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
          [channelId, currentUser.id]);
        if (!member) return cb?.({ success: false, error: 'Not a member of this channel' });

        const id = 'msg-' + uuidv4().slice(0, 8);
        const now = Date.now();
        await db.run(
          `INSERT INTO chat_messages (id, channel_id, user_id, user_name, user_role, content, type, parent_id, meeting_id, sent_from_meeting, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, channelId, currentUser.id, currentUser.name, currentUser.role, content.trim(), 'text', parentId || null, meetingId || null, !!meetingId, now]);

        // Update reply count on parent
        if (parentId) {
          await db.run('UPDATE chat_messages SET reply_count = reply_count + 1 WHERE id = $1', [parentId]);
        }

        const message = {
          id, channelId, userId: currentUser.id, userName: currentUser.name,
          userRole: currentUser.role, content: content.trim(), type: 'text',
          parentId: parentId || null, replyCount: 0, reactions: {},
          meetingId: meetingId || null, sentFromMeeting: !!meetingId,
          createdAt: now, isEdited: false
        };

        // Broadcast to channel
        chatNs.to(`ch:${channelId}`).emit('new_message', { message });

        // Check for @mentions and notify
        const mentions = content.match(/@(\w+)/g);
        if (mentions) {
          for (const mention of mentions) {
            const username = mention.slice(1);
            const mentionedUser = await db.getOne('SELECT id FROM users WHERE username = $1', [username]);
            if (mentionedUser && mentionedUser.id !== currentUser.id) {
              chatNs.to(`user:${mentionedUser.id}`).emit('notification', {
                type: 'mention', message, channelId,
                from: currentUser.name
              });
            }
          }
        }

        cb?.({ success: true, message });
      } catch (e) {
        console.error('[Chat] send_message error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Send Private Message (creates/reuses DM) ────────────────────
    socket.on('send_private_message', async ({ toUserId, content, meetingId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      if (!content || !content.trim()) return cb?.({ success: false, error: 'Empty message' });
      try {
        // Find or create DM channel between these two users
        let dmChannel = await findDmChannel(currentUser.id, toUserId);
        if (!dmChannel) {
          dmChannel = await createDmChannel(currentUser.id, toUserId);
          // Join both users to the channel room
          socket.join(`ch:${dmChannel.id}`);
          const otherOnline = onlineUsers.get(toUserId);
          if (otherOnline) {
            const s = chatNs.sockets.get(otherOnline.socketId);
            if (s) s.join(`ch:${dmChannel.id}`);
          }
        }

        // Send the message
        const id = 'msg-' + uuidv4().slice(0, 8);
        const now = Date.now();
        await db.run(
          `INSERT INTO chat_messages (id, channel_id, user_id, user_name, user_role, content, type, meeting_id, sent_from_meeting, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, dmChannel.id, currentUser.id, currentUser.name, currentUser.role, content.trim(), 'text', meetingId || null, !!meetingId, now]);

        const message = {
          id, channelId: dmChannel.id, userId: currentUser.id, userName: currentUser.name,
          userRole: currentUser.role, content: content.trim(), type: 'text',
          meetingId: meetingId || null, sentFromMeeting: !!meetingId,
          createdAt: now, isEdited: false, reactions: {}
        };

        chatNs.to(`ch:${dmChannel.id}`).emit('new_message', { message });

        // DM notification
        chatNs.to(`user:${toUserId}`).emit('notification', {
          type: 'dm', message, channelId: dmChannel.id,
          from: currentUser.name
        });

        cb?.({ success: true, message, channelId: dmChannel.id });
      } catch (e) {
        console.error('[Chat] send_private_message error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Load Message History ────────────────────────────────────────
    socket.on('load_history', async ({ channelId, before, limit }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const lim = Math.min(parseInt(limit) || 50, 100);
        const beforeTs = parseInt(before) || Date.now() + 1;
        const messages = await db.getAll(`
          SELECT * FROM chat_messages
          WHERE channel_id = $1 AND created_at < $2 AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT $3
        `, [channelId, beforeTs, lim]);

        // Reverse so oldest first
        messages.reverse();

        const formatted = messages.map(m => ({
          id: m.id, channelId: m.channel_id, userId: m.user_id, userName: m.user_name,
          userRole: m.user_role, content: m.content, type: m.type,
          parentId: m.parent_id, replyCount: m.reply_count,
          reactions: JSON.parse(m.reactions || '{}'),
          isEdited: !!m.is_edited, meetingId: m.meeting_id,
          sentFromMeeting: !!m.sent_from_meeting, createdAt: m.created_at
        }));

        cb?.({ success: true, messages: formatted, hasMore: messages.length === lim });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Edit Message ────────────────────────────────────────────────
    socket.on('edit_message', async ({ messageId, content }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const msg = await db.getOne('SELECT * FROM chat_messages WHERE id = $1', [messageId]);
        if (!msg) return cb?.({ success: false, error: 'Message not found' });
        // Only owner or admin+ can edit others' messages
        if (msg.user_id !== currentUser.id && !db.hasRoleAtLeast(currentUser.role, 'admin')) {
          return cb?.({ success: false, error: 'Cannot edit this message' });
        }
        await db.run('UPDATE chat_messages SET content = $1, is_edited = $2, edited_at = $3 WHERE id = $4',
          [content.trim(), true, Date.now(), messageId]);

        chatNs.to(`ch:${msg.channel_id}`).emit('message_updated', {
          messageId, content: content.trim(), isEdited: true, editedAt: Date.now()
        });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Delete Message ──────────────────────────────────────────────
    socket.on('delete_message', async ({ messageId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const msg = await db.getOne('SELECT * FROM chat_messages WHERE id = $1', [messageId]);
        if (!msg) return cb?.({ success: false, error: 'Message not found' });
        if (msg.user_id !== currentUser.id && !db.hasRoleAtLeast(currentUser.role, 'admin')) {
          return cb?.({ success: false, error: 'Cannot delete this message' });
        }
        await db.run('UPDATE chat_messages SET deleted_at = $1 WHERE id = $2', [Date.now(), messageId]);
        chatNs.to(`ch:${msg.channel_id}`).emit('message_deleted', { messageId, channelId: msg.channel_id });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Reactions ───────────────────────────────────────────────────
    socket.on('add_reaction', async ({ messageId, emoji }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const msg = await db.getOne('SELECT id, channel_id, reactions FROM chat_messages WHERE id = $1', [messageId]);
        if (!msg) return cb?.({ success: false, error: 'Message not found' });
        const reactions = JSON.parse(msg.reactions || '{}');
        if (!reactions[emoji]) reactions[emoji] = [];
        if (!reactions[emoji].includes(currentUser.id)) {
          reactions[emoji].push(currentUser.id);
        }
        await db.run('UPDATE chat_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), messageId]);
        chatNs.to(`ch:${msg.channel_id}`).emit('reaction_updated', { messageId, reactions });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    socket.on('remove_reaction', async ({ messageId, emoji }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const msg = await db.getOne('SELECT id, channel_id, reactions FROM chat_messages WHERE id = $1', [messageId]);
        if (!msg) return cb?.({ success: false, error: 'Message not found' });
        const reactions = JSON.parse(msg.reactions || '{}');
        if (reactions[emoji]) {
          reactions[emoji] = reactions[emoji].filter(uid => uid !== currentUser.id);
          if (reactions[emoji].length === 0) delete reactions[emoji];
        }
        await db.run('UPDATE chat_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(reactions), messageId]);
        chatNs.to(`ch:${msg.channel_id}`).emit('reaction_updated', { messageId, reactions });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Typing Indicators ───────────────────────────────────────────
    socket.on('typing_start', ({ channelId }) => {
      if (!currentUser) return;
      const key = `${channelId}:${currentUser.id}`;
      socket.to(`ch:${channelId}`).emit('user_typing', { channelId, userId: currentUser.id, userName: currentUser.name });
      // Auto-stop after 3 seconds
      if (typingTimers.has(key)) clearTimeout(typingTimers.get(key));
      typingTimers.set(key, setTimeout(() => {
        socket.to(`ch:${channelId}`).emit('user_stopped_typing', { channelId, userId: currentUser.id });
        typingTimers.delete(key);
      }, 3000));
    });

    socket.on('typing_stop', ({ channelId }) => {
      if (!currentUser) return;
      const key = `${channelId}:${currentUser.id}`;
      if (typingTimers.has(key)) { clearTimeout(typingTimers.get(key)); typingTimers.delete(key); }
      socket.to(`ch:${channelId}`).emit('user_stopped_typing', { channelId, userId: currentUser.id });
    });

    // ── Mark as Read ────────────────────────────────────────────────
    socket.on('mark_read', async ({ channelId }, cb) => {
      if (!currentUser) return;
      try {
        await db.run(
          'UPDATE chat_channel_members SET last_read_at = $1 WHERE channel_id = $2 AND user_id = $3',
          [Date.now(), channelId, currentUser.id]);
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Request Add Member (Host Control) ───────────────────────────
    socket.on('request_add_member', async ({ channelId, userId, reason }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const channel = await db.getOne('SELECT * FROM chat_channels WHERE id = $1', [channelId]);
        if (!channel) return cb?.({ success: false, error: 'Channel not found' });

        // Rate limit: 1 request per 5 minutes per user per channel
        const rlKey = `add:${currentUser.id}:${channelId}`;
        const lastReq = rateLimits.get(rlKey);
        if (lastReq && Date.now() - lastReq < 300000) {
          return cb?.({ success: false, error: 'Rate limited. Please wait 5 minutes.' });
        }

        // Check max members
        const memberCount = await db.getOne(
          'SELECT COUNT(*) as count FROM chat_channel_members WHERE channel_id = $1', [channelId]);
        if (parseInt(memberCount.count) >= (channel.max_members || 8)) {
          return cb?.({ success: false, error: 'Maximum members reached' });
        }

        // If user is channel owner or admin+, add directly
        const membership = await db.getOne(
          'SELECT channel_role FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
          [channelId, currentUser.id]);
        const isChannelOwner = membership?.channel_role === 'owner';
        const isAdmin = db.hasRoleAtLeast(currentUser.role, 'admin');

        if (isChannelOwner || isAdmin) {
          // Direct add — creates new DM/group if it's a DM type
          await addMemberToChannel(channelId, userId, channel, chatNs);
          rateLimits.set(rlKey, Date.now());
          cb?.({ success: true, directAdd: true });
        } else {
          // Create request for owner/host approval
          const reqId = 'req-' + uuidv4().slice(0, 8);
          await db.run(
            'INSERT INTO chat_member_requests (id, channel_id, requested_by, user_to_add, status, requested_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [reqId, channelId, currentUser.id, userId, 'pending', Date.now()]);
          rateLimits.set(rlKey, Date.now());

          // Notify channel owner
          const owner = await db.getOne(
            'SELECT user_id FROM chat_channel_members WHERE channel_id = $1 AND channel_role = $2',
            [channelId, 'owner']);
          if (owner) {
            const toAddUser = await db.getOne('SELECT name FROM users WHERE id = $1', [userId]);
            chatNs.to(`user:${owner.user_id}`).emit('member_request_created', {
              requestId: reqId, channelId, requestedBy: currentUser.name,
              userToAdd: toAddUser?.name || userId, reason
            });
          }
          cb?.({ success: true, directAdd: false, requestId: reqId });
        }
      } catch (e) {
        console.error('[Chat] request_add_member error:', e.message);
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Approve/Deny Member Request ─────────────────────────────────
    socket.on('approve_member_request', async ({ requestId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const req = await db.getOne('SELECT * FROM chat_member_requests WHERE id = $1 AND status = $2', [requestId, 'pending']);
        if (!req) return cb?.({ success: false, error: 'Request not found or already handled' });

        // Verify requester is channel owner or admin+
        const membership = await db.getOne(
          'SELECT channel_role FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
          [req.channel_id, currentUser.id]);
        if (membership?.channel_role !== 'owner' && !db.hasRoleAtLeast(currentUser.role, 'admin')) {
          return cb?.({ success: false, error: 'Only channel owner or admin can approve' });
        }

        await db.run(
          'UPDATE chat_member_requests SET status = $1, reviewed_at = $2, reviewed_by = $3 WHERE id = $4',
          ['approved', Date.now(), currentUser.id, requestId]);

        const channel = await db.getOne('SELECT * FROM chat_channels WHERE id = $1', [req.channel_id]);
        await addMemberToChannel(req.channel_id, req.user_to_add, channel, chatNs);

        // Notify requester
        chatNs.to(`user:${req.requested_by}`).emit('member_request_approved', {
          requestId, channelId: req.channel_id
        });

        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    socket.on('deny_member_request', async ({ requestId, reason }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const req = await db.getOne('SELECT * FROM chat_member_requests WHERE id = $1 AND status = $2', [requestId, 'pending']);
        if (!req) return cb?.({ success: false, error: 'Request not found' });

        await db.run(
          'UPDATE chat_member_requests SET status = $1, reviewed_at = $2, reviewed_by = $3, review_reason = $4 WHERE id = $5',
          ['denied', Date.now(), currentUser.id, reason || '', requestId]);

        chatNs.to(`user:${req.requested_by}`).emit('member_request_denied', {
          requestId, reason: reason || 'Request denied'
        });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Get Pending Requests ────────────────────────────────────────
    socket.on('get_pending_requests', async ({ channelId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const requests = await db.getAll(`
          SELECT r.*, u1.name as requester_name, u2.name as user_to_add_name
          FROM chat_member_requests r
          LEFT JOIN users u1 ON u1.id = r.requested_by
          LEFT JOIN users u2 ON u2.id = r.user_to_add
          WHERE r.channel_id = $1 AND r.status = 'pending'
          ORDER BY r.requested_at DESC
        `, [channelId]);
        cb?.({ success: true, requests });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Get Channel Members ─────────────────────────────────────────
    socket.on('get_members', async ({ channelId }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const members = await db.getAll(`
          SELECT cm.*, u.name, u.username, u.role, u.avatar_color
          FROM chat_channel_members cm
          INNER JOIN users u ON u.id = cm.user_id
          WHERE cm.channel_id = $1
          ORDER BY cm.joined_at ASC
        `, [channelId]);

        // Add online status
        for (const m of members) {
          m.online = onlineUsers.has(m.user_id);
        }
        cb?.({ success: true, members });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Get Online Users ────────────────────────────────────────────
    socket.on('get_online_users', (data, cb) => {
      const users = [];
      onlineUsers.forEach((info, userId) => {
        users.push({ userId, name: info.name, role: info.role, status: info.status });
      });
      cb?.({ success: true, users });
    });

    // ── Search Messages ─────────────────────────────────────────────
    socket.on('search_messages', async ({ query, channelId, limit }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        const lim = Math.min(parseInt(limit) || 20, 50);
        let messages;
        if (channelId) {
          messages = await db.getAll(`
            SELECT * FROM chat_messages
            WHERE channel_id = $1 AND LOWER(content) LIKE $2 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT $3
          `, [channelId, `%${query.toLowerCase()}%`, lim]);
        } else {
          // Search across all channels user is a member of
          messages = await db.getAll(`
            SELECT m.* FROM chat_messages m
            INNER JOIN chat_channel_members cm ON cm.channel_id = m.channel_id
            WHERE cm.user_id = $1 AND LOWER(m.content) LIKE $2 AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC LIMIT $3
          `, [currentUser.id, `%${query.toLowerCase()}%`, lim]);
        }
        cb?.({ success: true, messages });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Update Status ───────────────────────────────────────────────
    socket.on('update_status', async ({ statusText, statusEmoji, isDnd }, cb) => {
      if (!currentUser) return cb?.({ success: false, error: 'Not authenticated' });
      try {
        await db.run(
          `INSERT INTO chat_user_status (user_id, status_text, status_emoji, is_dnd, last_active_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET status_text=$2, status_emoji=$3, is_dnd=$4, last_active_at=$5`,
          [currentUser.id, statusText || '', statusEmoji || '', isDnd || false, Date.now()]);

        chatNs.emit('user_status_changed', {
          userId: currentUser.id, statusText, statusEmoji, isDnd
        });
        cb?.({ success: true });
      } catch (e) {
        cb?.({ success: false, error: e.message });
      }
    });

    // ── Disconnect ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (currentUser) {
        onlineUsers.delete(currentUser.id);
        chatNs.emit('user_presence', { userId: currentUser.id, online: false });
        // Clean up typing timers
        typingTimers.forEach((timer, key) => {
          if (key.endsWith(`:${currentUser.id}`)) {
            clearTimeout(timer);
            typingTimers.delete(key);
          }
        });
      }
    });
  });

  // ── Helper Functions ────────────────────────────────────────────────

  async function ensureGeneralChannel(user) {
    const general = await db.getOne("SELECT id FROM chat_channels WHERE name = 'general' AND type = 'public'");
    if (!general) {
      const id = 'ch-general';
      await db.run(
        'INSERT INTO chat_channels (id, name, type, description, created_by) VALUES ($1,$2,$3,$4,$5)',
        [id, 'general', 'public', 'General discussion for everyone', user.id]);
      await db.run(
        'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
        ['cm-' + uuidv4().slice(0, 8), id, user.id, 'owner']);
    } else {
      // Ensure user is a member
      const isMember = await db.getOne(
        'SELECT id FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
        [general.id, user.id]);
      if (!isMember) {
        await db.run(
          'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
          ['cm-' + uuidv4().slice(0, 8), general.id, user.id, 'member']);
      }
    }
  }

  async function findDmChannel(userA, userB) {
    // Find existing DM channel between exactly these two users
    const channel = await db.getOne(`
      SELECT c.* FROM chat_channels c
      WHERE c.type = 'dm'
        AND (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id) = 2
        AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = c.id AND user_id = $1)
        AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = c.id AND user_id = $2)
    `, [userA, userB]);
    return channel;
  }

  async function createDmChannel(userA, userB) {
    const userAData = await db.getOne('SELECT name FROM users WHERE id = $1', [userA]);
    const userBData = await db.getOne('SELECT name FROM users WHERE id = $1', [userB]);
    const id = 'dm-' + uuidv4().slice(0, 8);
    const name = `${userAData?.name || 'User'}, ${userBData?.name || 'User'}`;
    await db.run(
      'INSERT INTO chat_channels (id, name, type, description, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, name, 'dm', '', userA]);
    await db.run(
      'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
      ['cm-' + uuidv4().slice(0, 8), id, userA, 'owner']);
    await db.run(
      'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
      ['cm-' + uuidv4().slice(0, 8), id, userB, 'member']);
    return { id, name, type: 'dm' };
  }

  async function addMemberToChannel(channelId, userId, channel, ns) {
    // Check if already a member
    const existing = await db.getOne(
      'SELECT id FROM chat_channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]);
    if (existing) return;

    await db.run(
      'INSERT INTO chat_channel_members (id, channel_id, user_id, channel_role) VALUES ($1,$2,$3,$4)',
      ['cm-' + uuidv4().slice(0, 8), channelId, userId, 'member']);

    const addedUser = await db.getOne('SELECT name FROM users WHERE id = $1', [userId]);
    await insertSystemMessage(channelId, `${addedUser?.name || 'User'} was added to the conversation`);

    // Join socket room if online
    const online = onlineUsers.get(userId);
    if (online) {
      const s = ns.sockets.get(online.socketId);
      if (s) s.join(`ch:${channelId}`);
      ns.to(`user:${userId}`).emit('channel_joined', {
        channelId, name: channel.name, type: channel.type
      });
    }

    ns.to(`ch:${channelId}`).emit('member_joined', {
      channelId, userId, name: addedUser?.name || 'User'
    });
  }

  async function insertSystemMessage(channelId, text) {
    const id = 'msg-' + uuidv4().slice(0, 8);
    await db.run(
      `INSERT INTO chat_messages (id, channel_id, user_id, user_name, user_role, content, type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, channelId, 'system', 'System', 'system', text, 'system', Date.now()]);
    chatNs.to(`ch:${channelId}`).emit('new_message', {
      message: {
        id, channelId, userId: 'system', userName: 'System', userRole: 'system',
        content: text, type: 'system', createdAt: Date.now(), reactions: {}
      }
    });
  }

  return chatNs;
}

module.exports = { setupChat };