# 🎸 Sonora Fan — Palco v2.1

Música e bate-papo em tempo real com visual de **palco de show**. Agora com **sistema completo de cadastro e login** de usuários!

## ✨ Novidades da v2.1

- 👤 **Cadastro de usuários** — Nome, email, senha, gênero, data de nascimento, bio e avatar musical
- 🔐 **Login persistente** — Sessão salva no navegador, não precisa logar toda vez
- 🎭 **Avatares musicais** — Escolha entre 12 emojis de instrumentos musicais
- 📊 **Painel de estatísticas** — Veja quantos usuários estão online e cadastrados
- 👤 **Perfil do usuário** — Visualize seus dados e estatísticas dentro do app
- 🚪 **Entrar como convidado** — Para quem quer testar sem criar conta
- 🎵 **Gênero musical favorito** — Rock, Pop, Eletrônica, Indie, Hip Hop, Jazz, Clássica, Sertanejo, MPB, Reggae

## 🔐 Senha de Admin

A senha padrão é: **`admin123`**

Para mudar, defina a variável de ambiente:
```bash
ADMIN_PASSWORD=suasenha node server.js
```

> **Dica:** Marque "Sou administrador" no cadastro e digite a senha para ter poderes de admin.

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

## 📋 Fluxo de uso

1. Ao abrir, uma tela de boas-vindas animada é exibida
2. Escolha entre **Entrar** (login), **Criar conta** (cadastro) ou **Entrar como convidado**
3. No cadastro, preencha: nome, email, senha, gênero, data de nascimento, bio e avatar
4. Na lobby, veja as salas disponíveis ou crie uma nova
5. Entre em uma sala, adicione músicas do YouTube e converse
6. Clique no seu perfil no topo para ver seus dados e sair

## 🎵 Fila consumível

- A música atual toca → quando acaba, some da fila
- A próxima música começa automaticamente
- Quando a fila esvazia, o modo rádio ativa com clássicos

## 🛡️ Permissões de Admin

- ✅ Kickar usuários
- ✅ Banir usuários permanentemente
- ✅ Remover qualquer música da fila
- ✅ Pular para qualquer música
- ✅ Limpar o chat
- Badge visual no chat e na lista de usuários

## 💾 Dados armazenados

Os dados dos usuários são salvos em `users.json` (persistência local). Em produção, considere usar um banco de dados real.
