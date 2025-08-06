const { activeUsers, activeSessions, todayEvents, pageViews, dashboardClients } = require('../config/constants');

function createCompositeKey(userId, websiteUrl, widgetId) {
    const cleanWebsiteUrl = websiteUrl || 'unknown';
    const cleanWidgetId = widgetId || 'unknown';
    return `${userId}|${cleanWebsiteUrl}|${cleanWidgetId}`;
}

function createPageKey(path, websiteUrl, widgetId) {
    const cleanWebsiteUrl = websiteUrl || 'unknown';
    const cleanWidgetId = widgetId || 'unknown';
    return `${path}|${cleanWebsiteUrl}|${cleanWidgetId}`;
}

function cleanupDailyData() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();
    
    
    activeSessions.forEach((session, sessionKey) => {
        if (session.sessionStart < todayTimestamp) {
            activeSessions.delete(sessionKey);
        }
    });
    
    todayEvents.clear();
    
}

function broadcastUserCount() {
    const count = activeUsers.size;
    const data = {
        type: 'live_users_count',
        count: count
    };
    
    activeUsers.forEach((user) => {
        if (user.socket.connected) {
            user.socket.emit('live_users_count', data);
        }
    });
    
}

function getRealTimeUsersByCountry() {
    try {
        const countryCount = new Map();
        
        
        activeUsers.forEach((userData, userId) => {
            const country = userData.country || 'Unknown';
            countryCount.set(country, (countryCount.get(country) || 0) + 1);
        });
        
        const result = Array.from(countryCount.entries()).map(([country, count]) => ({
            country: country,
            user_count: count
        })).sort((a, b) => b.user_count - a.user_count);
        
        // ✅ Only log when there are actual users
        if (result.length > 0) {
        }
        return result;
    } catch (error) {
        console.error('❌ Error in getRealTimeUsersByCountry:', error);
        return [];
    }
}

function getRealTimeUsersByCity() {
    try {
        const cityCount = new Map();
        
        
        activeUsers.forEach((userData, userId) => {
            const city = userData.city || 'Unknown';
            const country = userData.country || 'Unknown';
            const cityKey = `${city}, ${country}`;
            cityCount.set(cityKey, (cityCount.get(cityKey) || 0) + 1);
        });
        
        const result = Array.from(cityCount.entries()).map(([city, count]) => ({
            city: city,
            user_count: count
        })).sort((a, b) => b.user_count - a.user_count);
        
        if (result.length > 0) {
        }
        return result;
    } catch (error) {
        console.error('❌ Error in getRealTimeUsersByCity:', error);
        return [];
    }
}

module.exports = {
    createCompositeKey,
    createPageKey,
    cleanupDailyData,
    broadcastUserCount,
    getRealTimeUsersByCountry,
    getRealTimeUsersByCity
};
