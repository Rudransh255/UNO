const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state storage
const rooms = new Map();

// UNO card colors and values
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const WILD_CARDS = ['wild', 'wild_draw4'];

// Create a deck of UNO cards
function createDeck() {
    const deck = [];

    // Add colored cards
    COLORS.forEach(color => {
        // One 0 per color
        deck.push({ color, value: '0', id: uuidv4() });

        // Two of each 1-9, skip, reverse, draw2
        VALUES.slice(1).forEach(value => {
            deck.push({ color, value, id: uuidv4() });
            deck.push({ color, value, id: uuidv4() });
        });
    });

    // Add wild cards (4 of each)
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'wild', value: 'wild', id: uuidv4() });
        deck.push({ color: 'wild', value: 'wild_draw4', id: uuidv4() });
    }

    return shuffleDeck(deck);
}

// Shuffle deck using Fisher-Yates algorithm
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Draw cards from deck
function drawCards(room, count) {
    const cards = [];
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            // Reshuffle discard pile except top card
            const topCard = room.discardPile.pop();
            room.deck = shuffleDeck(room.discardPile);
            room.discardPile = [topCard];
        }
        if (room.deck.length > 0) {
            cards.push(room.deck.pop());
        }
    }
    return cards;
}

// Check if a card can be played
function canPlayCard(card, topCard, chosenColor) {
    if (card.color === 'wild') return true;
    if (card.color === (chosenColor || topCard.color)) return true;
    if (card.value === topCard.value) return true;
    return false;
}

// Get next player index
function getNextPlayer(room) {
    const direction = room.direction;
    const currentIndex = room.currentPlayerIndex;
    const playerCount = room.players.length;

    let nextIndex = (currentIndex + direction + playerCount) % playerCount;
    return nextIndex;
}

// Generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create a new room
    socket.on('createRoom', (playerName) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            players: [{
                id: socket.id,
                name: playerName,
                cards: [],
                isHost: true,
                saidUno: false,
                canBeCaught: false,
                catchTimeout: null
            }],
            deck: [],
            discardPile: [],
            currentPlayerIndex: 0,
            direction: 1,
            chosenColor: null,
            gameStarted: false,
            winner: null
        };

        rooms.set(roomCode, room);
        socket.join(roomCode);
        socket.roomCode = roomCode;

        socket.emit('roomCreated', { roomCode, player: room.players[0] });
        io.to(roomCode).emit('playerList', room.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.cards.length,
            isHost: p.isHost
        })));
    });

    // Join an existing room
    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode.toUpperCase());

        if (!room) {
            socket.emit('error', { message: 'Room not found!' });
            return;
        }

        if (room.gameStarted) {
            socket.emit('error', { message: 'Game already in progress!' });
            return;
        }

        if (room.players.length >= 10) {
            socket.emit('error', { message: 'Room is full!' });
            return;
        }

        const player = {
            id: socket.id,
            name: playerName,
            cards: [],
            isHost: false,
            saidUno: false,
            canBeCaught: false,
            catchTimeout: null
        };

        room.players.push(player);
        socket.join(roomCode.toUpperCase());
        socket.roomCode = roomCode.toUpperCase();

        socket.emit('roomJoined', { roomCode: roomCode.toUpperCase(), player });
        io.to(roomCode.toUpperCase()).emit('playerList', room.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.cards.length,
            isHost: p.isHost
        })));
    });

    // Start the game
    socket.on('startGame', () => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) {
            socket.emit('error', { message: 'Only the host can start the game!' });
            return;
        }

        if (room.players.length < 2) {
            socket.emit('error', { message: 'Need at least 2 players to start!' });
            return;
        }

        // Initialize game
        room.deck = createDeck();
        room.gameStarted = true;
        room.currentPlayerIndex = 0;
        room.direction = 1;

        // Deal 7 cards to each player
        room.players.forEach(p => {
            p.cards = drawCards(room, 7);
        });

        // Place first card (make sure it's not a wild card)
        let firstCard;
        do {
            firstCard = room.deck.pop();
            if (firstCard.color === 'wild') {
                room.deck.unshift(firstCard);
            }
        } while (firstCard.color === 'wild');

        room.discardPile.push(firstCard);

        // Handle special first cards
        if (firstCard.value === 'skip') {
            room.currentPlayerIndex = getNextPlayer(room);
        } else if (firstCard.value === 'reverse') {
            room.direction *= -1;
        } else if (firstCard.value === 'draw2') {
            const nextPlayer = room.players[0];
            nextPlayer.cards.push(...drawCards(room, 2));
            room.currentPlayerIndex = getNextPlayer(room);
        }

        // Send game state to all players
        room.players.forEach(p => {
            io.to(p.id).emit('gameStarted', {
                cards: p.cards,
                topCard: room.discardPile[room.discardPile.length - 1],
                currentPlayer: room.players[room.currentPlayerIndex].id,
                direction: room.direction,
                players: room.players.map(player => ({
                    id: player.id,
                    name: player.name,
                    cardCount: player.cards.length,
                    isHost: player.isHost
                }))
            });
        });
    });

    // Play a card
    socket.on('playCard', ({ cardId, chosenColor }) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.currentPlayerIndex) {
            socket.emit('error', { message: "It's not your turn!" });
            return;
        }

        const player = room.players[playerIndex];
        const cardIndex = player.cards.findIndex(c => c.id === cardId);
        if (cardIndex === -1) {
            socket.emit('error', { message: 'Card not found!' });
            return;
        }

        const card = player.cards[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];

        if (!canPlayCard(card, topCard, room.chosenColor)) {
            socket.emit('error', { message: 'Invalid card!' });
            return;
        }

        // Remove card from player's hand
        player.cards.splice(cardIndex, 1);
        room.discardPile.push(card);
        room.chosenColor = chosenColor || null;

        // Check for winner
        if (player.cards.length === 0) {
            room.winner = player;
            room.gameStarted = false;
            // Clear any pending catch timeouts
            room.players.forEach(p => {
                if (p.catchTimeout) {
                    clearTimeout(p.catchTimeout);
                    p.catchTimeout = null;
                }
            });
            io.to(socket.roomCode).emit('gameOver', {
                winner: { id: player.id, name: player.name }
            });
            return;
        }

        // UNO Logic: Check if player is going down to 1 card
        if (player.cards.length === 1) {
            if (!player.saidUno) {
                // Player didn't say UNO! They can be caught for 5 seconds
                player.canBeCaught = true;
                player.catchTimeout = setTimeout(() => {
                    player.canBeCaught = false;
                    player.catchTimeout = null;
                }, 5000);

                // Notify all players that this player might have forgotten UNO
                io.to(socket.roomCode).emit('unoForgotten', {
                    playerId: player.id,
                    playerName: player.name
                });
            } else {
                // Player said UNO, they're safe
                io.to(socket.roomCode).emit('unoSafe', {
                    playerId: player.id,
                    playerName: player.name
                });
            }
        }

        // Reset UNO status for next round
        player.saidUno = false;

        // Handle special cards
        let skipNext = false;
        if (card.value === 'skip') {
            skipNext = true;
        } else if (card.value === 'reverse') {
            room.direction *= -1;
            if (room.players.length === 2) {
                skipNext = true;
            }
        } else if (card.value === 'draw2') {
            room.currentPlayerIndex = getNextPlayer(room);
            const nextPlayer = room.players[room.currentPlayerIndex];
            nextPlayer.cards.push(...drawCards(room, 2));
            io.to(nextPlayer.id).emit('cardsDrawn', { cards: nextPlayer.cards });
            skipNext = true;
        } else if (card.value === 'wild_draw4') {
            room.currentPlayerIndex = getNextPlayer(room);
            const nextPlayer = room.players[room.currentPlayerIndex];
            nextPlayer.cards.push(...drawCards(room, 4));
            io.to(nextPlayer.id).emit('cardsDrawn', { cards: nextPlayer.cards });
            skipNext = true;
        }

        // Move to next player
        room.currentPlayerIndex = getNextPlayer(room);
        if (skipNext) {
            room.currentPlayerIndex = getNextPlayer(room);
        }

        // Send updated game state
        const sendGameState = () => {
            room.players.forEach(p => {
                io.to(p.id).emit('gameState', {
                    cards: p.cards,
                    topCard: room.discardPile[room.discardPile.length - 1],
                    currentPlayer: room.players[room.currentPlayerIndex].id,
                    direction: room.direction,
                    chosenColor: room.chosenColor,
                    players: room.players.map(pl => ({
                        id: pl.id,
                        name: pl.name,
                        cardCount: pl.cards.length,
                        isHost: pl.isHost,
                        canBeCaught: pl.canBeCaught
                    })),
                    lastPlayedBy: socket.id
                });
            });
        };

        sendGameState();
    });

    // Draw a card
    socket.on('drawCard', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.currentPlayerIndex) {
            socket.emit('error', { message: "It's not your turn!" });
            return;
        }

        const player = room.players[playerIndex];
        const drawnCards = drawCards(room, 1);
        player.cards.push(...drawnCards);

        // Check if drawn card can be played
        const topCard = room.discardPile[room.discardPile.length - 1];
        const canPlay = drawnCards.length > 0 && canPlayCard(drawnCards[0], topCard, room.chosenColor);

        socket.emit('cardDrawn', {
            card: drawnCards[0],
            cards: player.cards,
            canPlayDrawnCard: canPlay
        });

        // If can't play, move to next player
        if (!canPlay) {
            room.currentPlayerIndex = getNextPlayer(room);
            room.chosenColor = null;

            room.players.forEach(p => {
                io.to(p.id).emit('gameState', {
                    cards: p.cards,
                    topCard: room.discardPile[room.discardPile.length - 1],
                    currentPlayer: room.players[room.currentPlayerIndex].id,
                    direction: room.direction,
                    chosenColor: room.chosenColor,
                    players: room.players.map(player => ({
                        id: player.id,
                        name: player.name,
                        cardCount: player.cards.length,
                        isHost: player.isHost
                    }))
                });
            });
        }
    });

    // Say UNO - call this BEFORE playing your second-to-last card
    socket.on('sayUno', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Player can say UNO when they have 2 cards (before playing) or 1 card (after playing)
        if (player.cards.length <= 2) {
            player.saidUno = true;

            // If they already played and were catchable, they're now safe
            if (player.canBeCaught) {
                player.canBeCaught = false;
                if (player.catchTimeout) {
                    clearTimeout(player.catchTimeout);
                    player.catchTimeout = null;
                }
            }

            io.to(socket.roomCode).emit('unoSaid', {
                playerId: player.id,
                playerName: player.name
            });
        }
    });

    // Catch a player who forgot to say UNO
    socket.on('catchUno', (targetPlayerId) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) {
            console.log('Catch failed: No room or game not started');
            return;
        }

        const catcher = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetPlayerId);

        console.log('Catch attempt:', {
            catcherId: socket.id,
            targetId: targetPlayerId,
            targetFound: !!target,
            canBeCaught: target?.canBeCaught,
            targetCards: target?.cards?.length
        });

        if (!catcher || !target) {
            console.log('Catch failed: Catcher or target not found');
            socket.emit('error', { message: 'Player not found!' });
            return;
        }

        // Can't catch yourself
        if (catcher.id === target.id) {
            socket.emit('error', { message: "You can't catch yourself!" });
            return;
        }

        // Check if target can be caught
        if (target.canBeCaught && target.cards.length === 1) {
            console.log('✅ Catch successful!', target.name);
            // Target is caught! They draw 2 cards as penalty
            target.canBeCaught = false;
            if (target.catchTimeout) {
                clearTimeout(target.catchTimeout);
                target.catchTimeout = null;
            }

            const penaltyCards = drawCards(room, 2);
            target.cards.push(...penaltyCards);

            // Notify everyone
            io.to(socket.roomCode).emit('unoCaught', {
                catcherName: catcher.name,
                targetId: target.id,
                targetName: target.name,
                penaltyCards: 2
            });

            // Send updated cards to the caught player
            io.to(target.id).emit('cardsDrawn', { cards: target.cards });

            // Update game state for everyone
            room.players.forEach(p => {
                io.to(p.id).emit('gameState', {
                    cards: p.cards,
                    topCard: room.discardPile[room.discardPile.length - 1],
                    currentPlayer: room.players[room.currentPlayerIndex].id,
                    direction: room.direction,
                    chosenColor: room.chosenColor,
                    players: room.players.map(pl => ({
                        id: pl.id,
                        name: pl.name,
                        cardCount: pl.cards.length,
                        isHost: pl.isHost,
                        canBeCaught: pl.canBeCaught
                    }))
                });
            });
        } else {
            console.log('Catch failed: Target not catchable', { canBeCaught: target.canBeCaught, cards: target.cards.length });
            socket.emit('error', { message: 'Too late! Player is safe now.' });
        }
    });

    // Chat message
    socket.on('chatMessage', (message) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            io.to(socket.roomCode).emit('chatMessage', {
                playerName: player.name,
                message: message
            });
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        if (socket.roomCode) {
            const room = rooms.get(socket.roomCode);
            if (room) {
                const playerIndex = room.players.findIndex(p => p.id === socket.id);
                if (playerIndex !== -1) {
                    const player = room.players[playerIndex];
                    room.players.splice(playerIndex, 1);

                    if (room.players.length === 0) {
                        rooms.delete(socket.roomCode);
                    } else {
                        // If host left, assign new host
                        if (player.isHost && room.players.length > 0) {
                            room.players[0].isHost = true;
                        }

                        // Adjust current player index if needed
                        if (room.gameStarted) {
                            if (room.currentPlayerIndex >= room.players.length) {
                                room.currentPlayerIndex = 0;
                            }
                        }

                        io.to(socket.roomCode).emit('playerLeft', {
                            playerName: player.name,
                            players: room.players.map(p => ({
                                id: p.id,
                                name: p.name,
                                cardCount: p.cards.length,
                                isHost: p.isHost
                            }))
                        });

                        if (room.gameStarted && room.players.length < 2) {
                            room.gameStarted = false;
                            io.to(socket.roomCode).emit('gameCancelled', {
                                message: 'Not enough players to continue!'
                            });
                        }
                    }
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 UNO Server running on http://localhost:${PORT}`);
});
