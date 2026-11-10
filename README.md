# HaxBola

Jogo de futebol multiplayer no navegador, inspirado no Haxball.

- Servidor Node.js autoritativo (física a 60 Hz) + WebSocket (`ws`)
- Cliente em canvas com interpolação de snapshots
- Salas **públicas** (listadas no lobby) e **privadas** (apenas por código/link), ambas com senha opcional
- Administrador da sala: move jogadores entre times, define limite de gols/tempo, inicia/encerra/pausa, expulsa e passa o admin
- Gols com autor/assistência/gol contra, prorrogação com gol de ouro, chat, `/avatar XX`
- Controles: setas/WASD para mover, Espaço/X para chutar, Enter para chat, Esc abre os times, P pausa (admin)
- Controles de toque (joystick + botão de chute) em celulares

## Rodando

```bash
npm install
npm start          # http://localhost:3000  (use PORT=xxxx para mudar)
```

Convide amigos pelo botão **Convidar** (link `http://host:3000/#CODIGO`) ou pelo código da sala.

## Estrutura

- `server.js` — HTTP estático, WebSocket, lobby e salas
- `game.js` — física (discos, traves, rede, chute, saída de bola) e regras da partida
- `public/` — cliente (`index.html`, `style.css`, `client.js`)
