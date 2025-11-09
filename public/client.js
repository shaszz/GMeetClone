// client.js - simple mesh WebRTC client using Socket.io for signaling
const socket = io();

let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection
const remoteVideoContainers = {}; // socketId -> element

const videoArea = document.getElementById('videoArea');
const joinBtn = document.getElementById('joinBtn');
const roomIdInput = document.getElementById('roomIdInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const btnToggleAudio = document.getElementById('btnToggleAudio');
const btnToggleVideo = document.getElementById('btnToggleVideo');
const leaveBtn = document.getElementById('leaveBtn');
const btnShare = document.getElementById('btnShare');

const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatWindow = document.getElementById('chatWindow');

let roomId = null;
let localVideoElem = null;
let audioEnabled = true;
let videoEnabled = true;

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // add TURN here for production
  ]
};

async function initLocalStream(){
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addLocalVideo();
  } catch (e) {
    alert('Could not get camera/mic: ' + e.message);
  }
}

function addLocalVideo(){
  // create container with label "You"
  localVideoElem = document.createElement('video');
  localVideoElem.autoplay = true;
  localVideoElem.muted = true;
  localVideoElem.playsInline = true;
  localVideoElem.srcObject = localStream;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.appendChild(localVideoElem);
  const label = document.createElement('div');
  label.className = 'label';
  label.innerText = 'You';
  card.appendChild(label);

  videoArea.prepend(card); // local video on top-left
}

function createRemoteVideo(socketId){
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.id = 'video_' + socketId;

  const card = document.createElement('div');
  card.className = 'video-card';
  card.appendChild(video);

  const label = document.createElement('div');
  label.className = 'label';
  label.innerText = socketId;
  card.appendChild(label);

  videoArea.appendChild(card);
  remoteVideoContainers[socketId] = { card, video };
  return video;
}

function removeRemoteVideo(socketId){
  const entry = remoteVideoContainers[socketId];
  if(entry){
    entry.card.remove();
    delete remoteVideoContainers[socketId];
  }
}

// create PeerConnection for a remote peer
function createPeerConnection(targetSocketId){
  const pc = new RTCPeerConnection(STUN_SERVERS);

  // add local tracks
  if(localStream){
    for(const track of localStream.getTracks()){
      pc.addTrack(track, localStream);
    }
  }

  // on track -> attach to remote video elements
  pc.ontrack = (ev) => {
    const el = remoteVideoContainers[targetSocketId]?.video || createRemoteVideo(targetSocketId);
    if (el.srcObject !== ev.streams[0]) {
      el.srcObject = ev.streams[0];
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: targetSocketId, candidate: event.candidate, sender: socket.id, roomId });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed'){
      // cleanup
      if(peers[targetSocketId]){
        try { peers[targetSocketId].close(); } catch(e){}
        delete peers[targetSocketId];
      }
      removeRemoteVideo(targetSocketId);
    }
  };

  peers[targetSocketId] = pc;
  return pc;
}

// Called when joining a room
joinBtn.addEventListener('click', async () => {
  if (!roomIdInput.value.trim()) {
    // create a random room id
    roomId = Math.random().toString(36).slice(2, 9);
    roomIdInput.value = roomId;
  } else {
    roomId = roomIdInput.value.trim();
  }

  await initLocalStream();
  socket.emit('join-room', roomId);
  // update share button link
  updateShareLink();
  joinBtn.disabled = true;
  roomIdInput.disabled = true;
});

// copy link
copyLinkBtn.addEventListener('click', () => {
  const url = location.origin + '/?room=' + encodeURIComponent(roomIdInput.value.trim());
  navigator.clipboard.writeText(url).then(()=> alert('Link copied!'));
});

// share button
btnShare.addEventListener('click', () => {
  const url = location.origin + '/?room=' + encodeURIComponent(roomIdInput.value.trim());
  if (navigator.share) {
    navigator.share({ title: 'Join my meeting', url }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(url).then(()=> alert('Link copied!'));
  }
});

btnToggleAudio.addEventListener('click', () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
  btnToggleAudio.innerText = audioEnabled ? 'Mute' : 'Unmute';
});

btnToggleVideo.addEventListener('click', () => {
  if (!localStream) return;
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  btnToggleVideo.innerText = videoEnabled ? 'Stop Video' : 'Start Video';
});

leaveBtn.addEventListener('click', () => {
  if (!roomId) return;
  socket.emit('leave-room');
  cleanupAll();
  joinBtn.disabled = false;
  roomIdInput.disabled = false;
});

function cleanupAll(){
  // stop local tracks
  if(localStream){
    localStream.getTracks().forEach(t=>t.stop());
    localStream = null;
  }
  // remove local video
  if(localVideoElem){
    localVideoElem.srcObject = null;
  }
  // close peers
  for(const id in peers){
    try { peers[id].close(); } catch(e){}
  }
  Object.keys(peers).forEach(k => delete peers[k]);
  // remove remote vids
  Object.keys(remoteVideoContainers).forEach(removeRemoteVideo);
  // clear chat
  chatWindow.innerHTML = '';
  // reset UI
  roomId = null;
}

function updateShareLink(){
  // show link based on room input
  // (no UI element dedicated; copy/share does it)
}

// Chat
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !roomId) return;
  socket.emit('send-chat', text);
  appendChat({ sender: 'You', text, ts: Date.now() });
  chatInput.value = '';
});

function appendChat({ sender, text, ts }) {
  const d = new Date(ts);
  const el = document.createElement('div');
  el.className = 'chatMessage';
  el.innerHTML = `<div class="meta">${sender} • ${d.toLocaleTimeString()}</div><div>${escapeHtml(text)}</div>`;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(s){
  return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

/* Socket handlers */

// If page loaded with ?room=XYZ, prefill
(function prefillFromQuery(){
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if (r) roomIdInput.value = r;
})();

socket.on('existing-users', async (users) => {
  // users = array of socketIds already in room. We are the new arrival.
  // For each existing user, create an RTCPeerConnection and make an offer.
  for (const otherId of users) {
    // create pc and offer
    const pc = createPeerConnection(otherId);

    // ensure remote video container exists
    createRemoteVideo(otherId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: otherId, sdp: offer, sender: socket.id, roomId });
  }
});

socket.on('user-joined', async (socketId) => {
  // someone new joined; they will create offers to existing participants.
  // We don't need to do anything here unless we want to act as the existing user.
  // But to support both flows, create pc so that when they send an offer we can answer.
  createRemoteVideo(socketId);
});

socket.on('offer', async (payload) => {
  const { sender, sdp } = payload;
  // create pc if not exists
  const pc = peers[sender] || createPeerConnection(sender);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { target: sender, sdp: answer, sender: socket.id, roomId });
});

socket.on('answer', async (payload) => {
  const { sender, sdp } = payload;
  const pc = peers[sender];
  if (!pc) {
    console.warn('No pc for answer from', sender);
    return;
  }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async (payload) => {
  const { sender, candidate } = payload;
  const pc = peers[sender];
  if (!pc) {
    console.warn('No pc for incoming candidate from', sender);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('Error adding ICE candidate', e);
  }
});

socket.on('chat', (msg) => {
  appendChat({ sender: msg.sender, text: msg.text, ts: msg.ts });
});

socket.on('user-left', (socketId) => {
  // cleanup remote
  if(peers[socketId]) {
    try { peers[socketId].close(); } catch(e){}
    delete peers[socketId];
  }
  removeRemoteVideo(socketId);
});
