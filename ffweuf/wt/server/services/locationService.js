const { getDB } = require('../config/database');
const { 
    activeUsers,
    LOCATIONIQ_TOKEN,
    API_RATE_LIMIT,
    locationCache,
    pendingRequests
} = require('../config/constants');
const { createCompositeKey, broadcastUserCount, normalizeCityName } = require('../utils/helpers');

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
    
    // Extract raw city name from API response
    const rawCity = locationResponse.address?.city ||
                   locationResponse.address?.town ||
                   locationResponse.address?.village ||
                   locationResponse.address?.municipality ||
                   locationResponse.address?.hamlet || 'Unknown';

    // ✅ Normalize city name to handle duplicates like "Delhi" and "New Delhi"
    const normalizedCity = normalizeCityName(rawCity);

    const result = {
        display_name: locationResponse.display_name || 'Unknown location',
        country: locationResponse.address?.country || 'Unknown',
        city: normalizedCity, // Use normalized city name
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
        user.city = addressData.city; // This is already normalized in makeLocationIQRequest
        activeUsers.set(userCompositeKey, user);

        broadcastUserCount();
        const { broadcastDashboardData } = require('./dashboardService');
        broadcastDashboardData();
    }
}

/**
 * ✅ Normalize existing users' city names to fix duplicates
 * This function should be called once to migrate existing data
 */
function normalizeExistingUserCities() {
    let updatedCount = 0;

    activeUsers.forEach((userData, userKey) => {
        if (userData.city && userData.city !== 'Unknown') {
            const originalCity = userData.city;
            const normalizedCity = normalizeCityName(originalCity);

            if (originalCity !== normalizedCity) {
                userData.city = normalizedCity;
                activeUsers.set(userKey, userData);
                updatedCount++;
                console.log(`🔄 Normalized city: "${originalCity}" → "${normalizedCity}" for user ${userData.userId}`);
            }
        }
    });

    if (updatedCount > 0) {
        console.log(`✅ Normalized ${updatedCount} user city names`);
        broadcastUserCount();
        const { broadcastDashboardData } = require('./dashboardService');
        broadcastDashboardData();
    }

    return updatedCount;
}

async function storeToDatabaseAsync(userId, timestamp, latitude, longitude, addressData, accuracy, altitude, speed, userAgent, url, websiteUrl, widgetId) {
    try {
        const db = getDB();
        const locationCollection = db.collection('location_stats');

        const locationDocument = {
            user_id: userId,
            timestamp: timestamp,
            latitude: latitude,
            longitude: longitude,
            city: addressData.city,
            country: addressData.country,
            region: addressData.region,
            state: addressData.state,
            postcode: addressData.postcode,
            road: addressData.road,
            suburb: addressData.suburb,
            county: addressData.county,
            display_name: addressData.display_name,
            country_code: addressData.country_code,
            accuracy: accuracy,
            altitude: altitude,
            speed: speed,
            user_agent: userAgent,
            url: url,
            website_url: websiteUrl,
            widget_id: widgetId,
            created_at: new Date()
        };

        await locationCollection.insertOne(locationDocument);

    } catch (error) {
        console.error('❌ Database storage error:', error);
    }
}

module.exports = {
    processLocationData,
    processLocationWithRetry,
    makeLocationIQRequest,
    updateUserLocation,
    storeToDatabaseAsync,
    normalizeExistingUserCities
};
