# 🎸 Sonora Fan — Palco de Show

Música e bate-papo em tempo real com visual de **palco de show**. Adicione músicas do YouTube, converse com amigos e sinta a vibe de um concerto ao vivo.

---

## ✨ Funcionalidades

### 🎵 Música
- **Fila consumível** — A música toca e some da fila automaticamente. Quando acaba, a próxima começa
- **Player do YouTube** integrado com sincronização em tempo real para todos na sala
- **Capa do vídeo** — Thumbnail do YouTube exibida no player como capa da música tocando
- **Prévia antes de adicionar** — Mostra thumbnail, título e duração real do vídeo; a música só entra na fila depois que você confirma (evita links errados)
- **Curtir música** — Cada música adicionada gera um card no chat que pode ser curtido (❤️) por todos na sala
- **Histórico de tocadas** — Veja as últimas músicas que passaram e clique para readicionar
- **Volume individual** — Slider de volume no player, com indicador de porcentagem
- **Indicador "Ao vivo"** com equalizer animado enquanto toca
- **Cooldown de 10s** — Evita spam de músicas na fila
- **Limite de 20 músicas** na fila por sala

### 💬 Chat
- **Chat em tempo real** com histórico persistente
- **Auto-scroll inteligente** — O chat desce sozinho com as novas mensagens; se você subir para ler mensagens antigas, aparece o botão "↓ Novas mensagens"
- **Reações** (❤️ 🔥 😂 👍 😮 🎵) em mensagens
- **Menções** (@nome) com destaque visual e som de notificação
- **Emojis** no chat com painel visual
- **Censura automática** de palavrões (PT-BR e EN)
- **Indicador de "digitando"**
- **Comando `/confetti`** — Solta confete para todo mundo na sala

### 👑 Admin
- **Senha de admin** no login (`admin123` por padrão)
- **Kick/Ban** de usuários
- **Remover músicas** da fila (inclusive a que está tocando — avança automaticamente)
- **Pular para qualquer música** da fila
- **Limpar chat**
- **Badge visual** no chat e lista de usuários

### 🎨 Temas
- **Dark** (padrão) — `🌙`
- **Light** — `☀️`
- **Neon** (verde/rosa) — `🟢`
- **Vaporwave** (roxo/laranja) — `🌅`

### 🎭 Personalização
- **12 avatares** para escolher no login (🎸 🎤 🎧 🎹 🥁 🎷 🎺 🎻 🎵 🎶 🎼 🎬)
- **Cores aleatórias** para cada usuário no chat

### 🏠 Salas
- **Criar salas** com nome personalizado
- **Entrar em sala aleatória** — Vai para a sala com mais ouvintes
- **Compartilhar link** da sala (`/?room=nome-da-sala`)
- **Anúncios** de entrada/saída no chat
- **Contador de ouvintes** em tempo real

---

## 🔐 Senha de Admin

A senha padrão é: **`admin123`**

Para mudar, defina a variável de ambiente:
```bash
ADMIN_PASSWORD=suasenha node server.js
```

> Marque "Sou administrador" no login e digite a senha para ter poderes de admin.

---

## 🚀 Como rodar

### Local
```bash
npm install
npm start
# Acesse http://localhost:3000
```

### Replit (online, grátis)
1. Acesse [replit.com](https://replit.com) e crie conta
2. **Create → Node.js**
3. Apague os arquivos padrão
4. Arraste os arquivos para o Replit
5. Clique em **Run**

### Render (deploy gratuito)
1. Crie um Web Service no [Render](https://render.com)
2. Conecte seu repositório GitHub
3. Defina `Build Command`: `npm install`
4. Defina `Start Command`: `node server.js`
5. (Opcional) Adicione a env var `ADMIN_PASSWORD` com sua senha

---

## 📋 Como usar

1. Entre com seu nome e escolha um avatar
2. Marque "Sou administrador" e digite a senha se quiser ser admin
3. Entre em uma sala existente, crie uma nova ou use **Sala aleatória**
4. Adicione músicas do YouTube (cole o link ou o ID do vídeo) e confirme na prévia
5. Curta (❤️) as músicas adicionadas no chat
6. Aguarde 10 segundos para adicionar a próxima (cooldown)
7. Converse no chat enquanto ouve
8. Use `/confetti` para soltar confete 🎉
9. Clique no 🔗 para compartilhar o link da sala

---

## 🎵 Fila consumível

As músicas **são removidas automaticamente** ao terminar:
- A música atual toca → quando acaba, some da fila
- A próxima música começa automaticamente
- Quando a fila esvazia, o player para e avisa para adicionar mais
- O histórico guarda as últimas tocadas

---

## 🛡️ Permissões de Admin

- ✅ Kickar usuários
- ✅ Banir usuários permanentemente
- ✅ Remover qualquer música da fila (inclusive a atual)
- ✅ Pular para qualquer música
- ✅ Limpar histórico de chat
- Badge visual no chat e na lista de usuários

---

## 🛠️ Stack

- **Node.js** + **Express** — Servidor HTTP
- **Socket.IO** — Comunicação em tempo real
- **YouTube IFrame API** — Player de vídeo
- **Vanilla JS** — Frontend (sem frameworks)

---

Desenvolvido por [Guilherme Giuntini](https://www.linkedin.com/in/ggiuntini/)
