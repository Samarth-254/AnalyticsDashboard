const { activeUsers, activeSessions, todayEvents, pageViews, dashboardClients } = require('../config/constants');

// ✅ City normalization mapping to handle duplicate cities
const CITY_NORMALIZATION_MAP = {
    // Delhi variations
    'new delhi': 'Delhi',
    'delhi': 'Delhi',
    'delhi ncr': 'Delhi',
    'new delhi district': 'Delhi',
    'central delhi': 'Delhi',
    'south delhi': 'Delhi',
    'north delhi': 'Delhi',
    'east delhi': 'Delhi',
    'west delhi': 'Delhi',

    // Mumbai variations
    'mumbai': 'Mumbai',
    'bombay': 'Mumbai',
    'greater mumbai': 'Mumbai',
    'mumbai city': 'Mumbai',

    // Bangalore variations
    'bangalore': 'Bangalore',
    'bengaluru': 'Bangalore',
    'bengaluru urban': 'Bangalore',
    'bangalore urban': 'Bangalore',

    // Chennai variations
    'chennai': 'Chennai',
    'madras': 'Chennai',
    'chennai city': 'Chennai',

    // Hyderabad variations
    'hyderabad': 'Hyderabad',
    'secunderabad': 'Hyderabad',
    'cyberabad': 'Hyderabad',

    // Kolkata variations
    'kolkata': 'Kolkata',
    'calcutta': 'Kolkata',
    'kolkata city': 'Kolkata',

    // Pune variations
    'pune': 'Pune',
    'poona': 'Pune',
    'pune city': 'Pune',

    // Add more city mappings as needed
};

/**
 * Normalize city names to handle duplicates like "Delhi" and "New Delhi"
 * @param {string} cityName - The original city name from the API
 * @returns {string} - The normalized city name
 */
function normalizeCityName(cityName) {
    if (!cityName || cityName === 'Unknown') {
        return cityName;
    }

    const normalizedKey = cityName.toLowerCase().trim();
    return CITY_NORMALIZATION_MAP[normalizedKey] || cityName;
}

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
            const rawCity = userData.city || 'Unknown';
            // ✅ Normalize city name to handle duplicates like "Delhi" and "New Delhi"
            const normalizedCity = normalizeCityName(rawCity);
            const country = userData.country || 'Unknown';
            const cityKey = `${normalizedCity}, ${country}`;
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
    getRealTimeUsersByCity,
    normalizeCityName
};
