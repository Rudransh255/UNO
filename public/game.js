// Socket connection with explicit configuration
const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000
});

// Connection status handlers
socket.on('connect', () => {
    console.log('✅ Connected to server:', socket.id);
});

socket.on('connect_error', (error) => {
    console.error('❌ Connection error:', error.message);
});

socket.on('disconnect', (reason) => {
    console.log('🔌 Disconnected:', reason);
});

// Game state
let myId = null;
let myCards = [];
let isMyTurn = false;
let topCard = null;
let chosenColor = null;
let pendingWildCard = null;
let calledUno = false;
let catchablePlayers = [];

// DOM Elements
const menuScreen = document.getElementById('menuScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const gameScreen = document.getElementById('gameScreen');
const playerNameInput = document.getElementById('playerName');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const joinRoomSection = document.getElementById('joinRoomSection');
const roomCodeInput = document.getElementById('roomCodeInput');
const confirmJoinBtn = document.getElementById('confirmJoinBtn');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const playersList = document.getElementById('playersList');
const startGameBtn = document.getElementById('startGameBtn');
const waitingText = document.getElementById('waitingText');
const opponentsArea = document.getElementById('opponentsArea');
const discardPile = document.getElementById('discardPile');
const drawPile = document.getElementById('drawPile');
const playerHand = document.getElementById('playerHand');
const cardCount = document.getElementById('cardCount');
const unoBtn = document.getElementById('unoBtn');
const turnIndicator = document.getElementById('turnIndicator');
const directionIndicator = document.getElementById('directionIndicator');
const colorIndicator = document.getElementById('colorIndicator');
const playersListGame = document.getElementById('playersListGame');
const colorPickerModal = document.getElementById('colorPickerModal');
const gameOverModal = document.getElementById('gameOverModal');
const winnerName = document.getElementById('winnerName');
const backToLobbyBtn = document.getElementById('backToLobbyBtn');
const toastContainer = document.getElementById('toastContainer');

// Switch screens
function showScreen(screen) {
    [menuScreen, lobbyScreen, gameScreen].forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
}

// Show toast notification
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// Create card element
function createCardElement(card, isPlayable = true) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${card.color}`;
    cardEl.dataset.id = card.id;

    let displayValue = card.value;
    if (card.value === 'skip') displayValue = '⊘';
    else if (card.value === 'reverse') displayValue = '⇄';
    else if (card.value === 'draw2') displayValue = '+2';
    else if (card.value === 'wild') displayValue = 'W';
    else if (card.value === 'wild_draw4') displayValue = '+4';

    cardEl.innerHTML = `<span class="card-value">${displayValue}</span>`;

    if (!isPlayable) {
        cardEl.classList.add('not-playable');
    } else if (isMyTurn) {
        cardEl.classList.add('playable');
    }

    return cardEl;
}

// Check if card can be played
function canPlayCard(card) {
    if (!topCard || !isMyTurn) return false;
    if (card.color === 'wild') return true;
    const activeColor = chosenColor || topCard.color;
    if (card.color === activeColor) return true;
    if (card.value === topCard.value) return true;
    return false;
}

// Render player's hand
function renderHand() {
    playerHand.innerHTML = '';
    myCards.forEach(card => {
        const isPlayable = canPlayCard(card);
        const cardEl = createCardElement(card, isPlayable);
        cardEl.addEventListener('click', () => handleCardClick(card));
        playerHand.appendChild(cardEl);
    });
    cardCount.textContent = `${myCards.length} card${myCards.length !== 1 ? 's' : ''}`;

    // Show UNO button when player has 2 cards (need to call UNO before playing)
    // or 1 card and they forgot (they can still call it to become safe)
    const shouldShowUno = (myCards.length === 2 && !calledUno) ||
        (myCards.length === 1 && !calledUno);
    unoBtn.classList.toggle('hidden', !shouldShowUno);

    // Update UNO button text based on state
    if (myCards.length === 2) {
        unoBtn.textContent = 'UNO!';
    } else if (myCards.length === 1 && !calledUno) {
        unoBtn.textContent = 'SAY UNO!';
    }
}

// Render top card
function renderTopCard() {
    if (!topCard) return;
    discardPile.innerHTML = '';
    const cardEl = createCardElement(topCard);
    cardEl.style.cursor = 'default';
    discardPile.appendChild(cardEl);

    // Update color indicator for wild cards
    if (chosenColor) {
        colorIndicator.className = `color-indicator active ${chosenColor}`;
    } else {
        colorIndicator.className = 'color-indicator';
    }
}

// Render opponents
function renderOpponents(players, currentPlayerId) {
    opponentsArea.innerHTML = '';
    playersListGame.innerHTML = '';

    // Update catchable players list
    catchablePlayers = players.filter(p => p.canBeCaught && p.id !== myId);

    players.forEach(player => {
        if (player.id === myId) return;

        const isActive = player.id === currentPlayerId;
        const isCatchable = player.canBeCaught && player.cardCount === 1;
        const opponentEl = document.createElement('div');
        opponentEl.className = `opponent ${isActive ? 'active' : ''} ${isCatchable ? 'catchable' : ''}`;
        opponentEl.innerHTML = `
            <div class="opponent-name">${player.name}</div>
            <div class="opponent-cards">${player.cardCount} card${player.cardCount !== 1 ? 's' : ''}</div>
            ${isCatchable ? '<button class="catch-btn" data-player-id="' + player.id + '">🚨 CATCH!</button>' : ''}
        `;
        opponentsArea.appendChild(opponentEl);

        // Add click handler for catch button
        if (isCatchable) {
            const catchBtn = opponentEl.querySelector('.catch-btn');
            catchBtn.addEventListener('click', () => {
                socket.emit('catchUno', player.id);
            });
        }
    });

    // Sidebar player list
    players.forEach(player => {
        const isActive = player.id === currentPlayerId;
        const isCatchable = player.canBeCaught && player.cardCount === 1 && player.id !== myId;
        const infoEl = document.createElement('div');
        infoEl.className = `player-info-game ${isActive ? 'active' : ''} ${isCatchable ? 'catchable' : ''}`;
        infoEl.innerHTML = `
            <span>${player.name}${player.id === myId ? ' (You)' : ''}${isCatchable ? ' ⚠️' : ''}</span>
            <span>${player.cardCount}</span>
        `;
        playersListGame.appendChild(infoEl);
    });
}

// Handle card click
function handleCardClick(card) {
    if (!isMyTurn) {
        showToast("It's not your turn!");
        return;
    }

    if (!canPlayCard(card)) {
        showToast("You can't play this card!");
        return;
    }

    // Wild card - show color picker
    if (card.color === 'wild') {
        pendingWildCard = card;
        colorPickerModal.classList.remove('hidden');
        return;
    }

    socket.emit('playCard', { cardId: card.id, chosenColor: null });
}

// Handle draw card
drawPile.addEventListener('click', () => {
    if (!isMyTurn) {
        showToast("It's not your turn!");
        return;
    }
    socket.emit('drawCard');
});

// Color picker
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        colorPickerModal.classList.add('hidden');
        if (pendingWildCard) {
            socket.emit('playCard', { cardId: pendingWildCard.id, chosenColor: color });
            pendingWildCard = null;
        }
    });
});

// UNO button
unoBtn.addEventListener('click', () => {
    socket.emit('sayUno');
    calledUno = true;
    showToast('🎉 UNO!', 2000);
    renderHand(); // Re-render to hide button
});

// Menu event listeners
createRoomBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    if (!name) {
        showToast('Please enter your name!');
        return;
    }
    socket.emit('createRoom', name);
});

joinRoomBtn.addEventListener('click', () => {
    joinRoomSection.classList.toggle('hidden');
});

confirmJoinBtn.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!name) {
        showToast('Please enter your name!');
        return;
    }
    if (!code || code.length !== 6) {
        showToast('Please enter a valid room code!');
        return;
    }
    socket.emit('joinRoom', { roomCode: code, playerName: name });
});

copyCodeBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(roomCodeDisplay.textContent);
    showToast('Room code copied!');
});

startGameBtn.addEventListener('click', () => {
    socket.emit('startGame');
});

backToLobbyBtn.addEventListener('click', () => {
    gameOverModal.classList.add('hidden');
    location.reload();
});

// Socket event handlers
socket.on('roomCreated', ({ roomCode, player }) => {
    myId = player.id;
    roomCodeDisplay.textContent = roomCode;
    startGameBtn.classList.remove('hidden');
    waitingText.classList.add('hidden');
    showScreen(lobbyScreen);
});

socket.on('roomJoined', ({ roomCode, player }) => {
    myId = player.id;
    roomCodeDisplay.textContent = roomCode;
    showScreen(lobbyScreen);
});

socket.on('playerList', (players) => {
    playersList.innerHTML = '';
    players.forEach(player => {
        const card = document.createElement('div');
        card.className = `player-card ${player.isHost ? 'host' : ''}`;
        card.innerHTML = `
            <div class="player-avatar">${player.name.charAt(0).toUpperCase()}</div>
            <div class="player-name">${player.name}</div>
            ${player.isHost ? '<span class="host-badge">HOST</span>' : ''}
        `;
        playersList.appendChild(card);
    });
});

socket.on('gameStarted', (data) => {
    myCards = data.cards;
    topCard = data.topCard;
    isMyTurn = data.currentPlayer === myId;
    chosenColor = null;
    calledUno = false; // Reset UNO state for new game

    showScreen(gameScreen);
    renderHand();
    renderTopCard();
    renderOpponents(data.players, data.currentPlayer);

    turnIndicator.classList.toggle('active', isMyTurn);
    directionIndicator.classList.toggle('reverse', data.direction === -1);

    if (isMyTurn) showToast("It's your turn!");
});

socket.on('gameState', (data) => {
    myCards = data.cards;
    topCard = data.topCard;
    isMyTurn = data.currentPlayer === myId;
    chosenColor = data.chosenColor;

    renderHand();
    renderTopCard();
    renderOpponents(data.players, data.currentPlayer);

    turnIndicator.classList.toggle('active', isMyTurn);
    directionIndicator.classList.toggle('reverse', data.direction === -1);

    if (isMyTurn) showToast("It's your turn!");
});

socket.on('cardDrawn', (data) => {
    myCards = data.cards;
    // Reset UNO state when we draw cards (we now have more than 2)
    if (myCards.length > 2) calledUno = false;
    renderHand();
    if (!data.canPlayDrawnCard) {
        showToast('You drew a card but cannot play it');
    } else {
        showToast('You can play the drawn card!');
    }
});

socket.on('cardsDrawn', (data) => {
    myCards = data.cards;
    // Reset UNO state when we're forced to draw cards
    if (myCards.length > 2) calledUno = false;
    renderHand();
});

socket.on('unoSaid', ({ playerId, playerName }) => {
    if (playerId === myId) {
        showToast('🎉 You called UNO!', 2000);
    } else {
        showToast(`${playerName} called UNO!`, 2000);
    }
});

socket.on('unoForgotten', ({ playerId, playerName }) => {
    if (playerId === myId) {
        showToast('⚠️ You forgot to say UNO! Say it now or get caught!', 4000);
    } else {
        showToast(`🚨 ${playerName} forgot UNO! Click CATCH to penalize!`, 4000);
    }
});

socket.on('unoSafe', ({ playerId, playerName }) => {
    if (playerId !== myId) {
        showToast(`✅ ${playerName} is safe - called UNO in time!`, 2000);
    }
});

socket.on('unoCaught', ({ catcherName, targetId, targetName, penaltyCards }) => {
    if (targetId === myId) {
        showToast(`😱 ${catcherName} caught you! Draw ${penaltyCards} cards!`, 3000);
        calledUno = false;
    } else {
        showToast(`🎯 ${catcherName} caught ${targetName}! +${penaltyCards} cards penalty!`, 3000);
    }
});

socket.on('playerLeft', ({ playerName, players }) => {
    showToast(`${playerName} left the game`);
    renderOpponents(players, null);
});

socket.on('gameOver', ({ winner }) => {
    winnerName.textContent = `${winner.name} Wins!`;
    gameOverModal.classList.remove('hidden');
    calledUno = false; // Reset for next game
});

socket.on('gameCancelled', ({ message }) => {
    showToast(message);
    setTimeout(() => location.reload(), 2000);
});

socket.on('error', ({ message }) => {
    showToast(message);
});
