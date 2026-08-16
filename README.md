# 🎸 Sonora Fan — Palco

Música e bate-papo em tempo real com visual de **palco de show**. Adicione músicas do YouTube, converse com amigos e sinta a vibe de um show ao vivo.

## ✨ Novidades da v2.0

- 🎤 **Visual de palco** — Layout imersivo com luzes de show, gradientes e vibe de concerto
- 💬 **Chat maior** — Sidebar dedicada com chat expandido para conversas fluírem
- 🔐 **Sistema de Admin** — Login com senha de administrador. Apenas admins podem kickar/banir
- 🗑️ **Fila consumível** — A música toca e some da fila automaticamente. Quando acaba, a próxima começa
- 🎧 **Cabines de DJ** — 5 slots para DJs com visual de palco
- 👑 **Badges de Admin** — Identificação visual de quem é admin na sala e no chat
- 🎵 **Miniaturas na fila** — Thumbnails do YouTube na lista de músicas

## 🔐 Senha de Admin

A senha padrão é: **`admin123`**

Para mudar, defina a variável de ambiente:
```bash
ADMIN_PASSWORD=suasenha node server.js
```

> **Dica:** Marque "Sou administrador" no login e digite a senha para ter poderes de admin.

## 🚀 Como rodar

### Replit (online, grátis)
1. Acesse [replit.com](https://replit.com) e crie conta
2. **Create → Node.js**
3. Apague os arquivos padrão
4. Arraste os arquivos para o Replit
5. Clique em **Run**

### Local
```bash
npm install
npm start
# Acesse http://localhost:3000
```

### Render (deploy gratuito)
1. Crie um Web Service no [Render](https://render.com)
2. Conecte seu repositório GitHub
3. Defina `Build Command`: `npm install`
4. Defina `Start Command`: `node server.js`
5. (Opcional) Adicione a env var `ADMIN_PASSWORD` com sua senha

## 📋 Como usar

1. Entre com seu nome
2. Marque "Sou administrador" e digite a senha se quiser ser admin
3. Entre em uma sala ou crie uma nova
4. Adicione músicas do YouTube (link ou ID)
5. Espere 10 segundos para adicionar a próxima (cooldown)
6. Converse no chat enquanto ouve
7. Suba numa cabine de DJ para tocar suas músicas

## 🎵 Fila consumível

Diferente da versão anterior, agora as músicas **são removidas automaticamente** ao terminar:
- A música atual toca → quando acaba, some da fila
- A próxima música começa automaticamente
- Quando a fila esvazia, o player para e avisa para adicionar mais

## 🛡️ Permissões de Admin

- ✅ Kickar usuários
- ✅ Banir usuários permanentemente
- ✅ Remover qualquer música da fila
- ✅ Pular para qualquer música
- Badge visual no chat e na lista de usuários
