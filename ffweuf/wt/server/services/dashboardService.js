const { dashboardClients } = require('../config/constants');
const { getRealTimeAnalytics } = require('./analyticsService');

async function sendDashboardData(socket) {
    try {
        
        const realTimeAnalytics = getRealTimeAnalytics();
        
        const dashboardData = {
            type: 'dashboard_data',
            ...realTimeAnalytics,
            timestamp: Date.now(),
            dataType: 'real-time-analytics'
        };
                
        if (socket.connected) {
            socket.emit('dashboard_data', dashboardData);
        } else {
        }
    } catch (error) {
        console.error('❌ [DASHBOARD] Error sending dashboard data:', error);
    }
}

async function broadcastDashboardData() {
    if (dashboardClients.size === 0) {
        return;
    }
    
    try {
        
        const realTimeAnalytics = getRealTimeAnalytics();
        
        const dashboardData = {
            type: 'dashboard_data',
            totalUsers: realTimeAnalytics.totalUsers,
            totalSessions: realTimeAnalytics.totalSessions,
            activeUsers: realTimeAnalytics.activeUsers,
            idleUsers: realTimeAnalytics.idleUsers,
            topPages: realTimeAnalytics.topPages,
            usersByCountry: realTimeAnalytics.usersByCountry,
            usersByCity: realTimeAnalytics.usersByCity,
            websiteWidgetBreakdown: realTimeAnalytics.websiteWidgetBreakdown,
            todayStats: realTimeAnalytics.todayStats,
            topEvents: realTimeAnalytics.topEvents,
            pageSpecificInteractions: realTimeAnalytics.pageSpecificInteractions,
            timestamp: Date.now(),
            dataType: 'real-time-analytics'
        };
        
        dashboardClients.forEach((client) => {
            if (client.connected) {
                client.emit('dashboard_data', dashboardData);
            } else {
                dashboardClients.delete(client);
            }
        });
        
    } catch (error) {
        console.error('❌ [BROADCAST] Error broadcasting dashboard data:', error);
    }
}

module.exports = {
    sendDashboardData,
    broadcastDashboardData
};
