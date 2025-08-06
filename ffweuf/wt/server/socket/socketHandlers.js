const { 
    activeUsers, 
    activeSessions, 
    dashboardClients, 
    pageViews 
} = require('../config/constants');
const { createCompositeKey, broadcastUserCount } = require('../utils/helpers');
const { handleAnalyticsEvent, handleLegacyUserOnline } = require('../services/eventHandlers');
const { sendDashboardData, broadcastDashboardData } = require('../services/dashboardService');

function handleSocketConnection(io) {
    io.on('connection', (socket) => {
        let userId = null;
        let websiteUrl = null;
        let widgetId = null;
        let isDashboard = false;
        
        socket.on('user_online', async (data) => {
            userId = data.userId;
            await handleLegacyUserOnline(socket, data);
        });
        
        socket.on('analytics_event', async (data) => {
            if (!userId) userId = data.userId;
            if (!websiteUrl) websiteUrl = data.websiteUrl;
            if (!widgetId) widgetId = data.widgetId;
            await handleAnalyticsEvent(socket, data);
        });
        
        socket.on('dashboard_connect', async (data) => {
            isDashboard = true;
            dashboardClients.add(socket);
            await sendDashboardData(socket);
        });
        
        socket.on('disconnect', () => {
            
            if (userId && websiteUrl && widgetId) {

                const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);

                if (activeUsers.has(userCompositeKey)) {
                    activeUsers.delete(userCompositeKey);
                }

                if (activeSessions.has(userCompositeKey)) {
                    activeSessions.delete(userCompositeKey);
                }
                
                let pagesCleanedUp = 0;
                pageViews.forEach((users, pageCompositeKey) => {
                    if (users.has(userCompositeKey)) {
                        users.delete(userCompositeKey);
                        pagesCleanedUp++;

                        if (users.size === 0) {
                            pageViews.delete(pageCompositeKey);
                        }
                    }
                });

                
                broadcastUserCount();
                broadcastDashboardData();
            }
            else {
                let foundUserId = null;
                
                activeUsers.forEach((userData, id) => {
                    if (userData.socket === socket) {
                        foundUserId = id;
                    }
                });
                
                if (foundUserId) {
                    activeUsers.delete(foundUserId);
                    
                activeSessions.forEach((session, sessionKey) => {
                    if (session.userId === foundUserId) {
                        activeSessions.delete(sessionKey);
                    }
                });                pageViews.forEach((users, page) => {
                        if (users.has(foundUserId)) {
                            users.delete(foundUserId);
                            if (users.size === 0) {
                                pageViews.delete(page);
                            }
                        }
                    });
                    
                    broadcastUserCount();
                    broadcastDashboardData();
                }
            }
            
            if (isDashboard) {
                dashboardClients.delete(socket);
            }
        });
        
        socket.on('error', (error) => {
            console.error(`❌ [SOCKET ERROR] User: ${userId}, Error:`, error);
        });
    });
}

module.exports = {
    handleSocketConnection
};
