require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');

const { connectToMongoDB } = require('./config/database');
const { 
    activeUsers, 
    activeSessions, 
    locationCache,
    pageViews
} = require('./config/constants');
const { cleanupDailyData } = require('./utils/helpers');

const { handleSocketConnection } = require('./socket/socketHandlers');

const routes = require('./routes');

const app = express();

app.use(express.json());
app.use(cors({ origin: '*' }));

app.use('/', routes);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

handleSocketConnection(io);

setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        cleanupDailyData();
    }
}, 60000); 

setInterval(() => {
    const now = Date.now();
    const INACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    
    let cleaned = 0;
    
    activeUsers.forEach((user, userId) => {
        if (now - user.lastSeen > INACTIVE_THRESHOLD) {
            activeUsers.delete(userId);
            cleaned++;
        }
    });
    
    activeSessions.forEach((session, sessionKey) => {
        if (now - session.lastActivity > INACTIVE_THRESHOLD) {
            activeSessions.delete(sessionKey);
        }
    });
    
    pageViews.forEach((users, page) => {
        users.forEach(userId => {
            if (!activeUsers.has(userId)) {
                users.delete(userId);
            }
        });
        if (users.size === 0) {
            pageViews.delete(page);
        }
    });
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned ${cleaned} inactive users`);
    }
}, 10 * 60 * 1000); 

setInterval(() => {
    locationCache.clear();
    console.log('🧹 Location cache cleared');
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3001;

// Initialize MongoDB connection and start server
async function startServer() {
    try {
        await connectToMongoDB();
        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📊 Dashboard available at http://localhost:${PORT}/api/dashboard`);
            console.log(`⚡ Socket.IO server ready`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
