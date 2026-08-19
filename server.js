// ===== VOTAÇÃO =====
const DISLIKE_THRESHOLD = 10;

socket.on('voteSong', ({ index, type, room }) => {
  if (!room || !socket.userName) return;
  
  const roomData = rooms.get(room);
  if (!roomData) return;
  
  // Não pode votar na música atual
  if (roomData.currentIndex === index) {
    socket.emit('error', 'Não é possível votar na música atual');
    return;
  }
  
  // Verifica se a música existe
  if (index >= roomData.queue.length) {
    socket.emit('error', 'Música não encontrada');
    return;
  }
  
  const votes = getRoomVotes(room);
  
  if (!votes[index]) {
    votes[index] = { up: [], down: [] };
  }
  
  const data = votes[index];
  
  // Remove voto anterior do usuário
  const upIndex = data.up.indexOf(socket.userName);
  if (upIndex > -1) data.up.splice(upIndex, 1);
  
  const downIndex = data.down.indexOf(socket.userName);
  if (downIndex > -1) data.down.splice(downIndex, 1);
  
  // Adiciona novo voto
  if (type === 'up') {
    data.up.push(socket.userName);
  } else if (type === 'down') {
    data.down.push(socket.userName);
  }
  
  // Verifica se atingiu o limite de dislikes
  if (data.down.length >= DISLIKE_THRESHOLD) {
    // Remove a música da fila
    const removed = roomData.queue.splice(index, 1)[0];
    if (index < roomData.currentIndex) {
      roomData.currentIndex--;
    }
    broadcastState(room);
    
    // Remove os votos da música removida
    delete votes[index];
    // Reindexa os votos
    const newVotes = {};
    roomData.queue.forEach((_, i) => {
      if (votes[i + 1]) {
        newVotes[i] = votes[i + 1];
      }
    });
    roomVotes.set(room, newVotes);
    
    // Notifica todos
    io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down });
    io.to(room).emit('voteUpdate', { index: -1, removed: true });
    
    addSystemMsg(room, `👎 "${removed.title}" foi removida por votação! (${data.down.length} votos negativos)`);
    toast('👎 Música removida por votação!', 'error');
    return;
  }
  
  // Atualiza todos na sala
  io.to(room).emit('voteUpdate', { 
    index, 
    up: data.up, 
    down: data.down 
  });
});
