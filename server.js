// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Allow Render to set PORT; fallback to 3000
const PORT = process.env.PORT || 3000;

const io = new Server(server);

// Serve static client files
app.use(express.static(path.join(__dirname, 'public')));

// Simple rooms map: roomId -> Set(socketId)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const set = rooms.get(roomId);

    // Inform the joining client about existing participants
    const otherUsers = Array.from(set);
    socket.emit('existing-users', otherUsers);

    // Add to room
    set.add(socket.id);

    // Notify others that a new user joined
    socket.to(roomId).emit('user-joined', socket.id);

    socket.on('offer', (payload) => {
      // payload: { target, sdp, sender }
      io.to(payload.target).emit('offer', payload);
    });

    socket.on('answer', (payload) => {
      // payload: { target, sdp, sender }
      io.to(payload.target).emit('answer', payload);
    });

    socket.on('ice-candidate', (payload) => {
      // payload: { target, candidate, sender }
      io.to(payload.target).emit('ice-candidate', payload);
    });

    socket.on('send-chat', (msg) => {
      // broadcast to room
      io.to(roomId).emit('chat', { sender: socket.id, text: msg, ts: Date.now() });
    });

    socket.on('disconnect', () => {
      console.log('Disconnected', socket.id);
      // Remove from room sets and notify others
      if (rooms.has(roomId)) {
        const s = rooms.get(roomId);
        s.delete(socket.id);
        socket.to(roomId).emit('user-left', socket.id);
        if (s.size === 0) rooms.delete(roomId);
      }
    });

    // allow explicit leave
    socket.on('leave-room', () => {
      socket.leave(roomId);
      if (rooms.has(roomId)) {
        const s = rooms.get(roomId);
        s.delete(socket.id);
        socket.to(roomId).emit('user-left', socket.id);
        if (s.size === 0) rooms.delete(roomId);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
