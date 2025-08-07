const { 
    activeUsers, 
    activeSessions, 
    todayEvents, 
    pageViews 
} = require('../config/constants');
const { createCompositeKey, createPageKey, broadcastUserCount } = require('../utils/helpers');
const { storeAnalyticsEvent } = require('../services/analyticsService');
const { processLocationData } = require('../services/locationService');
const { broadcastDashboardData } = require('../services/dashboardService');

// ✅ SIMPLIFIED: Handle analytics events 
async function handleAnalyticsEvent(socket, data) {
    const { userId, eventType, timestamp, url, location, websiteUrl, widgetId } = data;

    const userCompositeKey = createCompositeKey(userId, websiteUrl, widgetId);

    if (!activeUsers.has(userCompositeKey)) {
        activeUsers.set(userCompositeKey, {
            socket: socket,
            userId: userId,
            websiteUrl: websiteUrl,
            widgetId: widgetId,
            lastSeen: timestamp,
            country: 'Unknown',
            city: 'Unknown',
            currentUrl: url,
            isActive: true
        });
    }

    if (!activeSessions.has(userCompositeKey)) {
        activeSessions.set(userCompositeKey, {
            userId: userId,
            websiteUrl: websiteUrl,
            widgetId: widgetId,
            sessionStart: timestamp,
            lastActivity: timestamp,
            pageViews: [],
            events: []
        });
    }
    
    const userData = activeUsers.get(userCompositeKey);
    const sessionData = activeSessions.get(userCompositeKey);
    
    userData.lastSeen = timestamp;
    sessionData.lastActivity = timestamp;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();
    
    if (timestamp >= todayTimestamp && eventType !== 'location_update' && eventType !== 'location_error') {
        let eventPath = data.path;
        if (!eventPath && sessionData && sessionData.pageViews.length > 0 && 
            (eventType === 'widget_open' || eventType === 'widget_close' || eventType === 'whatsapp_send_click')) {
            // Get the most recent page view for widget events
            const lastPageView = sessionData.pageViews[sessionData.pageViews.length - 1];
            eventPath = lastPageView.path;
        }
        
        const eventKey = `${eventType}_${userId}_${Date.now()}`;
        todayEvents.set(eventKey, {
            userId,
            eventType,
            timestamp,
            url,
            path: eventPath, // Use the resolved path
            url_path: eventPath, // Add for compatibility
            title: data.title,
            websiteUrl,
            widgetId
        });
        
    }
    
    // Handle different event types
    switch (eventType) {
        case 'page_view':
        case 'page_enter':
            await handlePageView(data, userData, sessionData);
            await handleUserInteraction(data, userData, sessionData); // Also track as interaction
            await storeAnalyticsEvent(data);
            break;

        case 'page_exit':
            await handlePageExit(data, userData, sessionData);
            await handleUserInteraction(data, userData, sessionData); // Also track as interaction
            await storeAnalyticsEvent(data);
            break;

        case 'widget_open':
        case 'widget_close':
        case 'whatsapp_click':
        case 'whatsapp_send_click':
            // ✅ FIXED: Ensure widget events have path information from current session
            if (!data.path && sessionData && sessionData.pageViews.length > 0) {
                // Get the most recent page view for this user
                const lastPageView = sessionData.pageViews[sessionData.pageViews.length - 1];
                data.path = lastPageView.path;
                data.url = lastPageView.url || data.url;
                data.title = lastPageView.title || data.title;
            }
            await handleUserInteraction(data, userData, sessionData);
            await storeAnalyticsEvent(data);
            break;

        case 'location_update':
            if (location) {
                await processLocationData(userId, data);
            }
            break;

        case 'location_error':
            return; 

        default:
            return;
    }

    const shouldBroadcast = 
        eventType === 'page_enter' ||       // New page views affect top pages
        eventType === 'page_view' ||        // New page views affect top pages 
        eventType === 'page_exit' ||        // Page exits affect interactions
        eventType === 'user_online' ||      // New users joining
        eventType === 'widget_open' ||      // Widget interactions affect dashboard
        eventType === 'widget_close' ||     // Widget interactions affect dashboard
        eventType === 'whatsapp_send_click' || // WhatsApp clicks affect interactions
        eventType === 'whatsapp_click';     // WhatsApp clicks affect interactions
    
    if (shouldBroadcast) {
        broadcastUserCount();
        broadcastDashboardData();
    }
}

// ✅ SIMPLIFIED: Handle page view events
async function handlePageView(data, userData, sessionData) {
    const { url, path, title, location } = data;

    // Prevent duplicate page view tracking
    const lastPageView = sessionData.pageViews[sessionData.pageViews.length - 1];
    if (lastPageView && lastPageView.path === path &&
        (data.timestamp - lastPageView.timestamp) < 1000) { // Less than 1 second ago
        return;
    }

    userData.currentUrl = url;

    // Process location data if available (for city/country calculation)
    if (location && location.latitude && location.longitude) {
        await processLocationData(userData.userId, data);
    }

    // Track live users on pages using composite key
    const pageCompositeKey = createPageKey(path, userData.websiteUrl, userData.widgetId);
    if (!pageViews.has(pageCompositeKey)) {
        pageViews.set(pageCompositeKey, new Set());
    }
    const userCompositeKey = createCompositeKey(userData.userId, userData.websiteUrl, userData.widgetId);
    pageViews.get(pageCompositeKey).add(userCompositeKey);

    // Add to session page views 
    sessionData.pageViews.push({
        url: url,
        path: path,
        title: title,
        timestamp: data.timestamp
    });
}

// ✅ SIMPLIFIED: Handle page exits - remove from live tracking
async function handlePageExit(data, userData, sessionData) {
    const { path } = data;

    // Remove from live page views using composite keys
    const pageCompositeKey = createPageKey(path, userData.websiteUrl, userData.widgetId);
    const userCompositeKey = createCompositeKey(userData.userId, userData.websiteUrl, userData.widgetId);

    if (pageViews.has(pageCompositeKey)) {
        pageViews.get(pageCompositeKey).delete(userCompositeKey);
        if (pageViews.get(pageCompositeKey).size === 0) {
            pageViews.delete(pageCompositeKey);
        }
    }
}

// ✅ SIMPLIFIED: Handle user interaction events
async function handleUserInteraction(data, userData, sessionData) {
    const { eventType, eventData, path, title } = data;
    
    // Map of recognized interaction events
    const INTERACTION_EVENTS = {
        'whatsapp_click': 'WhatsApp Click',
        'whatsapp_send_click': 'WhatsApp Click',
        'widget_open': 'Widget Opened',
        'widget_close': 'Widget Closed',
        'page_enter': 'Page Enter',
        'page_exit': 'Page Exit'
    };
    
    // Only track recognized interaction events
    if (!INTERACTION_EVENTS[eventType]) {
        return;
    }
    
    // Create interaction event with appropriate data
    const interactionEvent = {
        eventType: eventType,
        eventName: INTERACTION_EVENTS[eventType],
        timestamp: data.timestamp,
        eventData: eventData || { path: path, title: title }, // Use path/title for page events
        url: data.url,
        path: data.path
    };
    
    sessionData.events.push(interactionEvent);

    // ✅ REMOVED: Duplicate storage in todayEvents - this is already handled by handleAnalyticsEvent
    // The main handleAnalyticsEvent function stores all events in todayEvents on line 64
    // Storing here was causing double counting in live mode
    
    // Better logging with appropriate data
    const logData = eventData || { path: path, title: title };
}

async function handleLegacyUserOnline(socket, data) {
    const userId = data.userId;
    
    const userData = {
        socket: socket,
        userId: userId,
        lastSeen: Date.now(),
        country: 'Unknown',
        city: 'Unknown',
        currentUrl: data.url,
        isActive: true
    };
    
    activeUsers.set(userId, userData);
    
    if (data.locationData?.latitude && data.locationData?.longitude) {
        const { processLocationWithRetry } = require('../services/locationService');
        await processLocationWithRetry(userId, data);
    }
}

module.exports = {
    handleAnalyticsEvent,
    handlePageView,
    handlePageExit,
    handleUserInteraction,
    handleLegacyUserOnline
};
