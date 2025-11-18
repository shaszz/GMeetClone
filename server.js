// server.js
// Mini-Meet signaling + static server
// Requirements:
//  - Node >= 14
//  - package.json start script: "node server.js"
// - Place your client files in ./public (index.html, client.js, style.css, etc.)

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configuration via environment
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Optional: allow framing (iframe embedding) when ALLOW_EMBED=true
// Configure ALLOWED_FRAME_ANCESTORS to a space-separated list of allowed origins
const ALLOW_EMBED = (process.env.ALLOW_EMBED || '').toLowerCase() === 'true';
const ALLOWED_FRAME_ANCESTORS = process.env.ALLOWED_FRAME_ANCESTORS || '*'; // e.g. "https://your-extension-origin.com"

// Middleware: optional security header tweaks for embedding
app.use((req, res, next) => {
  // remove older header if present
  res.removeHeader('X-Frame-Options');

  if (ALLOW_EMBED) {
    // Allow specified frame-ancestors (or * for testing; prefer specific origins in production)
    // Example value for ALLOWED_FRAME_ANCESTORS: "'self' https://your-extension-origin"
    res.setHeader('Content-Security-Policy', `frame-ancestors ${ALLOWED_FRAME_ANCESTORS};`);
  }
  next();
});

// Serve static client files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// Basic health route
app.get('/health', (req, res) => {
  res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() });
});

// ICE endpoint: returns iceServers JSON read from env var ICE_SERVERS
// Set ICE_SERVERS in Render (or env) as JSON string, e.g.:
// [{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"p"}]
app.get('/ice', (req, res) => {
  let ice = [];
  try {
    if (process.env.ICE_SERVERS) {
      ice = JSON.parse(process.env.ICE_SERVERS);
      if (!Array.isArray(ice)) throw new Error('ICE_SERVERS must be a JSON array');
    } else {
      // fallback
      ice = [{ urls: ['stun:stun.l.google.com:19302'] }];
    }
  } catch (err) {
    console.error('[ice] invalid ICE_SERVERS env, falling back to default STUN', err);
    ice = [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
  res.json({ iceServers: ice });
});

// ========================================================
// FIX: Serve index.html for any unknown route (SPA Fallback)
// This fixes the "Cannot GET /RoomID" error
// ========================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Create Socket.io server attached to the same http server.
// For development allow CORS "*" but in prod set allowed origins appropriately.
const io = new Server(server, {
  // When deploying behind proxies / platforms this helps, but tighten in production
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// rooms map: roomId -> Set of socketIds
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('[io] connection:', socket.id);

  // Relay live-share events to room
  socket.on('live-event', (payload) => {
    // payload must include: { room, type, data, sender }
    try {
      const room = payload && payload.room;
      if (!room) return;
      // broadcast to everyone else in the room
      socket.to(room).emit('live-event', payload);
    } catch (err) {
      console.error('[live-event] relay error', err);
    }
  });


  // join-room: client sends roomId to join
  socket.on('join-room', (roomId) => {
    try {
      if (!roomId || typeof roomId !== 'string') {
        socket.emit('error-msg', 'missing-room-id');
        return;
      }

      // Save room on socket and join
      socket.join(roomId);
      socket.data.roomId = roomId;

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      // Send list of existing participants (socket ids) to the joiner
      const others = Array.from(set).filter(id => id !== socket.id);
      socket.emit('existing-users', others);

      set.add(socket.id);
      console.log(`[room:${roomId}] joined: ${socket.id} (count=${set.size})`);

      // Notify others in room
      socket.to(roomId).emit('user-joined', socket.id);

    } catch (err) {
      console.error('join-room error', err);
    }
  });

  // Signaling relays: offer, answer, ice-candidate
  socket.on('offer', (payload) => {
    if (!payload || !payload.target) return;
    // payload: { target, sdp, sender, roomId }
    io.to(payload.target).emit('offer', payload);
  });

  socket.on('answer', (payload) => {
    if (!payload || !payload.target) return;
    io.to(payload.target).emit('answer', payload);
  });

  socket.on('ice-candidate', (payload) => {
    if (!payload || !payload.target) return;
    io.to(payload.target).emit('ice-candidate', payload);
  });

  // Simple chat relay
  socket.on('send-chat', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const message = { sender: socket.id, text, ts: Date.now() };
    io.to(roomId).emit('chat', message);
  });

  // Explicit leave
  socket.on('leave-room', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    leaveRoomCleanup(socket, roomId);
  });

  socket.on('disconnect', (reason) => {
    const roomId = socket.data.roomId;
    console.log('[io] disconnect', socket.id, 'reason:', reason, 'room:', roomId);
    if (roomId) leaveRoomCleanup(socket, roomId);
  });

  // defensive: handle unexpected errors
  socket.on('error', (err) => {
    console.error('[socket] error', socket.id, err);
  });
});

function leaveRoomCleanup(socket, roomId) {
  try {
    socket.leave(roomId);
    const set = rooms.get(roomId);
    if (set) {
      set.delete(socket.id);
      socket.to(roomId).emit('user-left', socket.id);
      console.log(`[room:${roomId}] left: ${socket.id} (remaining=${set.size})`);
      if (set.size === 0) {
        rooms.delete(roomId);
        console.log(`[room:${roomId}] removed (empty)`);
      }
    }
    delete socket.data.roomId;
  } catch (err) {
    console.error('leaveRoomCleanup error', err);
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (env=${NODE_ENV})`);
  console.log(`Static files served from ${path.join(__dirname, 'public')}`);
  if (ALLOW_EMBED) {
    console.log('Embedding allowed via ALLOW_EMBED=true; CONTENT-SECURITY-POLICY frame-ancestors:', ALLOWED_FRAME_ANCESTORS);
  }
  if (process.env.ICE_SERVERS) {
    console.log('ICE_SERVERS provided via environment.');
  } else {
    console.log('No ICE_SERVERS env — using public STUN fallback.');
  }
});

// graceful shutdown
function shutdown(signal) {
  console.log('Received', signal, 'shutting down...');
  try {
    io.close();
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    // Force exit if not closed within 5s
    setTimeout(() => {
      console.warn('Forcing shutdown');
      process.exit(1);
    }, 5000).unref();
  } catch (err) {
    console.error('Shutdown error', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));