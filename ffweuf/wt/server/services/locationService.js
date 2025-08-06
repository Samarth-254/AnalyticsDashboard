const { pool } = require('../config/database');
const { 
    activeUsers,
    LOCATIONIQ_TOKEN,
    API_RATE_LIMIT,
    locationCache,
    pendingRequests
} = require('../config/constants');
const { createCompositeKey, broadcastUserCount } = require('../utils/helpers');

// Use a module-level variable for lastApiCall
let lastApiCall = 0;

async function processLocationData(userId, data) {
    const locationData = data.location;
    if (!locationData || !locationData.latitude || !locationData.longitude) {
        return;
    }

    await processLocationWithRetry(userId, {
        locationData: locationData,
        timestamp: data.timestamp,
        userAgent: data.browser?.userAgent,
        url: data.url,
        websiteUrl: data.websiteUrl,
        widgetId: data.widgetId
    });
}

async function processLocationWithRetry(userId, data, retryCount = 0) {
    try {
        const { timestamp, userAgent, url, locationData, permissionState, locationStatus, errorCode, errorMessage, websiteUrl, widgetId } = data;
        
        if (!locationData) {
            const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);
            const userData = activeUsers.get(userCompositeKey);
            if (userData) {
                userData.country = 'Unknown';
                userData.city = 'Unknown';
                userData.locationStatus = locationStatus || 'no_location_data';
                activeUsers.set(userCompositeKey, userData);
            }
            return;
        }
        
        const { latitude, longitude, accuracy, altitude, speed } = locationData;
                
        if (!latitude || !longitude || typeof latitude !== 'number' || typeof longitude !== 'number') {
            const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);
            const userData = activeUsers.get(userCompositeKey);
            if (userData) {
                userData.country = 'Unknown';
                userData.city = 'Unknown';
                userData.locationStatus = 'invalid_coordinates';
                activeUsers.set(userCompositeKey, userData);
            }
            return;
        }
        
        if (latitude === 0 && longitude === 0) {
            const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);
            const userData = activeUsers.get(userCompositeKey);
            if (userData) {
                userData.country = 'Unknown';
                userData.city = 'Unknown';
                userData.locationStatus = 'zero_coordinates';
                activeUsers.set(userCompositeKey, userData);
            }
            return;
        }
        
        
        const roundedLat = Math.round(latitude * 100) / 100;
        const roundedLon = Math.round(longitude * 100) / 100;
        const cacheKey = `${roundedLat},${roundedLon}`;
        
        if (locationCache.has(cacheKey)) {
            const cachedData = locationCache.get(cacheKey);
            updateUserLocation(userId, cachedData, websiteUrl, widgetId);
            await storeToDatabaseAsync(userId, timestamp, latitude, longitude, cachedData, accuracy, altitude, speed, userAgent, url, websiteUrl, widgetId);
            return;
        }
        
        if (pendingRequests.has(cacheKey)) {
            try {
                const cachedData = await pendingRequests.get(cacheKey);
                updateUserLocation(userId, cachedData, websiteUrl, widgetId);
                await storeToDatabaseAsync(userId, timestamp, latitude, longitude, cachedData, accuracy, altitude, speed, userAgent, url, websiteUrl, widgetId);
                const { broadcastDashboardData } = require('./dashboardService');
                broadcastDashboardData();
                return;
            } catch (error) {
                console.warn(`⚠️ [DEBUG] Pending request failed for ${userId}:`, error);
            }
        }
        
        const now = Date.now();
        const timeSinceLastCall = now - lastApiCall;
        if (timeSinceLastCall < API_RATE_LIMIT) {
            const waitTime = API_RATE_LIMIT - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        const locationPromise = makeLocationIQRequest(latitude, longitude);
        pendingRequests.set(cacheKey, locationPromise);
        
        try {
            const addressData = await locationPromise;
            
            locationCache.set(cacheKey, addressData);
            updateUserLocation(userId, addressData, websiteUrl, widgetId);
            
            
            await storeToDatabaseAsync(userId, timestamp, latitude, longitude, addressData, accuracy, altitude, speed, userAgent, url, websiteUrl, widgetId);
            
        } catch (error) {
            console.error(`❌ [DEBUG] LocationIQ API failed for ${userId}:`, error);
            
            if (retryCount < 3) {
                setTimeout(() => {
                    processLocationWithRetry(userId, data, retryCount + 1);
                }, (retryCount + 1) * 2000);
            } else {
                console.error(`❌ [DEBUG] Max retries reached for ${userId}, keeping as Unknown`);
                const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);
                const userData = activeUsers.get(userCompositeKey);
                if (userData) {
                    userData.country = 'Unknown';
                    userData.city = 'Unknown';
                    userData.locationStatus = 'api_failed';
                    activeUsers.set(userCompositeKey, userData);
                }
            }
        } finally {
            pendingRequests.delete(cacheKey);
            lastApiCall = Date.now();
        }
        
    } catch (error) {
        console.error(`❌ [DEBUG] Location processing error for ${userId}:`, error);
    }
}

async function makeLocationIQRequest(latitude, longitude) {
    const apiUrl = 'https://us1.locationiq.com/v1/reverse.php';
    const params = new URLSearchParams({
        key: LOCATIONIQ_TOKEN,
        lat: latitude,
        lon: longitude,
        format: 'json',
        addressdetails: 1
    });


    const response = await fetch(`${apiUrl}?${params}`);
    
    if (!response.ok) {
        console.error(`❌ [DEBUG] LocationIQ API error: ${response.status} ${response.statusText}`);
        throw new Error(`LocationIQ API error: ${response.status} ${response.statusText}`);
    }
    
    const locationResponse = await response.json();
    
    if (!locationResponse.address) {
        console.warn(`⚠️ [DEBUG] LocationIQ returned no address data:`, locationResponse);
        return {
            display_name: 'Unknown location',
            country: 'Unknown',
            city: 'Unknown',
            region: 'Unknown',
            state: 'Unknown',
            postcode: '',
            road: '',
            suburb: '',
            county: '',
            country_code: ''
        };
    }
    
    const result = {
        display_name: locationResponse.display_name || 'Unknown location',
        country: locationResponse.address?.country || 'Unknown',
        city: locationResponse.address?.city || 
              locationResponse.address?.town || 
              locationResponse.address?.village || 
              locationResponse.address?.municipality || 
              locationResponse.address?.hamlet || 'Unknown',
        region: locationResponse.address?.region || 
               locationResponse.address?.state || 
               locationResponse.address?.province || 'Unknown',
        state: locationResponse.address?.state || 
              locationResponse.address?.province || 
              locationResponse.address?.region || 'Unknown',
        postcode: locationResponse.address?.postcode || '',
        road: locationResponse.address?.road || 
             locationResponse.address?.street || '',
        suburb: locationResponse.address?.suburb || 
               locationResponse.address?.neighbourhood || 
               locationResponse.address?.quarter || '',
        county: locationResponse.address?.county || '',
        country_code: locationResponse.address?.country_code || ''
    };
    
    return result;
}

function updateUserLocation(userId, addressData, websiteUrl, widgetId) {
    // ✅ CRITICAL FIX: Use composite key to find and update user location
    const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);
    const user = activeUsers.get(userCompositeKey);
    if (user) {
        user.country = addressData.country;
        user.city = addressData.city;
        activeUsers.set(userCompositeKey, user);

        broadcastUserCount();
        const { broadcastDashboardData } = require('./dashboardService');
        broadcastDashboardData();
    }
}

async function storeToDatabaseAsync(userId, timestamp, latitude, longitude, addressData, accuracy, altitude, speed, userAgent, url, websiteUrl, widgetId) {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.execute(`
            INSERT INTO location_stats (
                user_id, timestamp, latitude, longitude, city, country, region,
                state, postcode, road, suburb, county, display_name, country_code, accuracy,
                altitude, speed, user_agent, url, website_url, widget_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId, timestamp, latitude, longitude,
            addressData.city, addressData.country, addressData.region,
            addressData.state, addressData.postcode, addressData.road,
            addressData.suburb, addressData.county, addressData.display_name,
            addressData.country_code, accuracy, altitude, speed,
            userAgent, url, websiteUrl, widgetId
        ]);
        
        
    } catch (error) {
        console.error('❌ Database storage error:', error);
    } finally {
        if (connection) connection.release();
    }
}

module.exports = {
    processLocationData,
    processLocationWithRetry,
    makeLocationIQRequest,
    updateUserLocation,
    storeToDatabaseAsync
};
