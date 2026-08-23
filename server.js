async function loadRooms() {
  const grid = $('roomGrid');
  grid.innerHTML = '<div class="empty-state"><div class="icon">🎵</div><p>Carregando salas...</p></div>';
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const r = await fetch('/api/rooms', { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!r.ok) throw new Error('Erro ao buscar salas');
    
    const roomsData = await r.json();
    
    if (!roomsData.length) { 
      grid.innerHTML = '<div class="empty-state"><div class="icon">🎵</div><p>Nenhuma sala ainda. Crie a primeira!</p></div>'; 
      return; 
    }
    
    roomsData.sort((a,b) => b.listenerCount - a.listenerCount);
    grid.innerHTML = '';
    roomsData.forEach(r => {
      const card = document.createElement('div');
      card.className = 'room-card' + (r.isPlaying ? ' live' : '');
      if (r.color) card.style.borderColor = r.color;
      card.onclick = () => joinRoom(r.slug);
      const track = r.currentTrack;
      const thumb = track ? `<img src="https://img.youtube.com/vi/${track.id}/mqdefault.jpg" alt="">` : '<div style="padding:30px;text-align:center;font-size:40px;">🎧</div>';
      const live = r.isPlaying ? '<div class="room-live-badge"><span class="live-dot"></span> AO VIVO</div>' : '';
      const playingIndicator = r.isPlaying ? `<div class="playing-indicator"><span></span><span></span><span></span><span></span></div>` : '';
      const genreTag = (currentUser && currentUser.estilos && currentUser.estilos.length > 0) ? `<span class="genre-tag">🎵 ${currentUser.estilos[0]}</span>` : '';
      const eventBadge = r.eventStartTime ? '<span class="event-badge">📅 Evento</span>' : '';
      card.innerHTML = `
        <div class="room-thumb">${thumb} ${live} <div class="room-listeners-badge"><span class="icon">🎧</span> ${r.listenerCount || 0}</div>${playingIndicator}</div>
        <div class="room-card-body">
          <h3>${escapeHtml(r.name)} ${r.radioMode ? '📻' : ''} ${eventBadge}</h3>
          <div class="meta">
            <span class="listeners"><span class="icon">👥</span> <span class="count">${r.listenerCount || 0}</span> ouvintes</span>
            <span>🎶 ${r.queueLength || 0} na fila</span>
            ${genreTag}
          </div>
          <div class="room-avatars"><span class="avatar-mini">👤</span><span class="avatar-mini">👤</span><span class="avatar-mini">👤</span></div>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch(e) {
    grid.innerHTML = '<div class="empty-state"><div class="icon">😕</div><p>Erro ao carregar salas. Verifique sua conexão.</p></div>';
    console.error('Erro em loadRooms:', e);
  }
}
