const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════
   Room Storage
   ═══════════════════════════════════════════ */
const rooms = {}; // pin → { pin, adminId, teams[], activity, state }

function makePin() {
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[pin]);
  return pin;
}

function teamList(room) {
  return room.teams
    .map(t => ({ teamName: t.teamName, score: t.score }))
    .sort((a, b) => b.score - a.score);
}

function myRoom(socket, role) {
  const d = socket.data;
  if (!d || !d.pin || !rooms[d.pin]) return null;
  if (role && d.role !== role) return null;
  return rooms[d.pin];
}

function relay(socket, event, data) {
  const room = myRoom(socket, 'admin');
  if (room) socket.to(socket.data.pin).emit(event, data);
}

/* ═══════════════════════════════════════════
   Socket.io
   ═══════════════════════════════════════════ */
io.on('connection', (socket) => {

  /* ───── Room Management ───── */

  socket.on('create-room', () => {
    const pin = makePin();
    rooms[pin] = {
      pin,
      adminId: socket.id,
      teams: [],
      activity: null,
      state: {}
    };
    socket.join(pin);
    socket.data = { pin, role: 'admin' };
    socket.emit('room-created', { pin });
    console.log(`Room ${pin} created`);
  });

  socket.on('join-room', ({ pin, teamName }) => {
    const room = rooms[pin];
    if (!room) return socket.emit('join-error', { message: 'Geçersiz PIN kodu!' });
    if (!teamName || !teamName.trim()) return socket.emit('join-error', { message: 'Takım adı boş olamaz!' });
    teamName = teamName.trim();
    if (room.teams.some(t => t.teamName === teamName))
      return socket.emit('join-error', { message: 'Bu takım adı zaten alınmış!' });

    room.teams.push({ id: socket.id, teamName, score: 0 });
    socket.join(pin);
    socket.data = { pin, role: 'student', teamName };

    const list = teamList(room);
    socket.emit('joined', { teamName, teams: list });
    io.to(room.adminId).emit('student-joined', { teams: list });

    // If an activity is already running, send it to the newcomer
    if (room.activity) socket.emit('activity-started', room.activity);
    console.log(`${teamName} → Room ${pin} (${room.teams.length} teams)`);
  });

  /* ───── Activity Lifecycle ───── */

  socket.on('start-activity', (data) => {
    const room = myRoom(socket, 'admin');
    if (!room) return;
    room.activity = data;
    room.state = { answers: {}, data: [], winners: [] };
    socket.to(socket.data.pin).emit('activity-started', data);
    console.log(`Activity ${data.id} started in Room ${room.pin}`);
  });

  socket.on('end-activity', () => {
    const room = myRoom(socket, 'admin');
    if (!room) return;
    room.activity = null;
    socket.to(socket.data.pin).emit('activity-ended');
  });

  /* ───── Student → Server → Admin ───── */

  socket.on('submit-answer', (payload) => {
    const room = myRoom(socket, 'student');
    if (!room) return;
    const team = socket.data.teamName;
    room.state.answers[team] = payload;
    io.to(room.adminId).emit('answer-received', {
      teamName: team,
      answer: payload,
      allAnswers: { ...room.state.answers },
      totalTeams: room.teams.length
    });
  });

  socket.on('submit-data', (payload) => {
    const room = myRoom(socket, 'student');
    if (!room) return;
    const pt = { teamName: socket.data.teamName, ...payload };
    room.state.data.push(pt);
    io.to(room.adminId).emit('data-received', {
      point: pt,
      allData: [...room.state.data]
    });
  });

  socket.on('shadow-attempt', (payload) => {
    const room = myRoom(socket, 'student');
    if (!room) return;
    io.to(room.adminId).emit('shadow-attempt', {
      teamName: socket.data.teamName,
      ...payload
    });
  });

  /* ───── Admin → Server → Students ───── */

  socket.on('reveal-answer', (d) => relay(socket, 'answer-revealed', d));
  socket.on('set-shadow-target', (d) => relay(socket, 'shadow-target', d));
  socket.on('announce-winners', (d) => relay(socket, 'winners-announced', d));
  socket.on('next-item', (d) => relay(socket, 'next-item', d));
  socket.on('admin-message', (d) => relay(socket, 'admin-message', d));

  socket.on('update-score', ({ teamName, delta }) => {
    const room = myRoom(socket, 'admin');
    if (!room) return;
    const t = room.teams.find(x => x.teamName === teamName);
    if (t) {
      t.score = Math.max(0, t.score + delta);
      io.to(room.pin).emit('scores-updated', { teams: teamList(room) });
    }
  });

  socket.on('bulk-scores', (arr) => {
    const room = myRoom(socket, 'admin');
    if (!room) return;
    arr.forEach(({ teamName, delta }) => {
      const t = room.teams.find(x => x.teamName === teamName);
      if (t) t.score = Math.max(0, t.score + delta);
    });
    io.to(room.pin).emit('scores-updated', { teams: teamList(room) });
  });

  socket.on('reset-activity-state', () => {
    const room = myRoom(socket, 'admin');
    if (!room) return;
    room.state = { answers: {}, data: [], winners: [] };
  });

  /* ───── Disconnect ───── */

  socket.on('disconnect', () => {
    const d = socket.data;
    if (!d || !d.pin || !rooms[d.pin]) return;
    const room = rooms[d.pin];

    if (d.role === 'admin') {
      io.to(d.pin).emit('room-closed');
      delete rooms[d.pin];
      console.log(`Room ${d.pin} closed (admin left)`);
    } else {
      room.teams = room.teams.filter(t => t.id !== socket.id);
      io.to(room.adminId).emit('student-left', { teams: teamList(room) });
      console.log(`${d.teamName} left Room ${d.pin}`);
    }
  });
});

/* ═══════════════════════════════════════════
   Start
   ═══════════════════════════════════════════ */
server.listen(3000, () => {
  console.log('');
  console.log('🔦  Işık Ünitesi Sunucusu Çalışıyor');
  console.log('   Admin:   http://localhost:3000/admin.html');
  console.log('   Öğrenci: http://localhost:3000/student.html');
  console.log('');
});
