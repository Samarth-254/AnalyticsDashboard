const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');

const app = express();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'usertracking',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function verifySchema() {
    try {
        await pool.execute(`
            ALTER TABLE analytics_events
            ADD COLUMN IF NOT EXISTS website_url VARCHAR(255),
            ADD COLUMN IF NOT EXISTS widget_id VARCHAR(50)
        `);
        await pool.execute(`
            ALTER TABLE location_stats
            ADD COLUMN IF NOT EXISTS website_url VARCHAR(255),
            ADD COLUMN IF NOT EXISTS widget_id VARCHAR(50)
        `);
        console.log('✅ Verified database schema');
    } catch (error) {
        console.error('❌ Schema verification error:', error);
    }
}

verifySchema();

app.use(express.json());
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

const activeUsers = new Map();
const activeSessions = new Map();
const dashboardClients = new Set();
const pageViews = new Map(); 
const todayEvents = new Map(); 
const LOCATIONIQ_TOKEN = 'pk.9f2ecb3b178c89ff2ddcd2aa6d9d74bf';

const locationCache = new Map();
const pendingRequests = new Map();
let lastApiCall = 0;
const API_RATE_LIMIT = 1000;


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

setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        cleanupDailyData();
    }
}, 60000); 

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

async function getWidgetAnalyticsHistory(dateInput, filterWebsiteUrl = null, filterWidgetId = null) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Parse the input date
        let dateOnly;
        if (dateInput.includes('T')) {
            dateOnly = dateInput.split('T')[0];
        } else {
            dateOnly = dateInput;
        }
        
        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateOnly)) {
            throw new Error(`Invalid date format: ${dateInput}. Expected YYYY-MM-DD`);
        }
        
        // Create timestamps for the specific date
        const startOfDay = new Date(`${dateOnly}T00:00:00.000Z`);
        const endOfDay = new Date(`${dateOnly}T23:59:59.999Z`);
        const startTimestamp = startOfDay.getTime();
        const endTimestamp = endOfDay.getTime();

        // ✅ NEW: Build WHERE clause for website filtering
        let whereClause = 'timestamp >= ? AND timestamp <= ?';
        let queryParams = [startTimestamp, endTimestamp];
        
        if (filterWebsiteUrl && filterWebsiteUrl !== 'all') {
            whereClause += ' AND website_url = ?';
            queryParams.push(filterWebsiteUrl);
        }
        
        if (filterWidgetId && filterWidgetId !== 'all') {
            whereClause += ' AND widget_id = ?';
            queryParams.push(filterWidgetId);
        }
        const [summary] = await connection.execute(`
            SELECT 
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as total_events
            FROM analytics_events
            WHERE ${whereClause}
        `, queryParams);

        // 2. Get event type breakdown (interactions) with filtering
        const [eventTypes] = await connection.execute(`
            SELECT 
                event_type,
                path,
                COALESCE(website_url, 'unknown') as websiteUrl,
                COALESCE(widget_id, 'unknown') as widgetId,
                COUNT(*) as event_count,
                COUNT(DISTINCT user_id) as unique_users
            FROM analytics_events
            WHERE ${whereClause}
            GROUP BY event_type, path, website_url, widget_id
            ORDER BY event_count DESC
        `, queryParams);

        // 3. Get top pages with filtering and website info
        const [topPages] = await connection.execute(`
            SELECT 
                path,
                title,
                COALESCE(website_url, 'unknown') as websiteUrl,
                COALESCE(widget_id, 'unknown') as widgetId,
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as page_views
            FROM analytics_events
            WHERE ${whereClause}
              AND (event_type = 'page_view' OR event_type = 'page_enter')
            GROUP BY path, title, website_url, widget_id
            ORDER BY page_views DESC
            LIMIT 10
        `, queryParams);

        // 4. Get website and widget breakdown (always show all for context)
        const [widgetBreakdown] = await connection.execute(`
            SELECT 
                COALESCE(website_url, 'unknown') as website_url,
                COALESCE(widget_id, 'unknown') as widget_id,
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as total_events
            FROM analytics_events
            WHERE timestamp >= ? AND timestamp <= ?
            GROUP BY website_url, widget_id
            ORDER BY unique_users DESC
        `, [startTimestamp, endTimestamp]);

        // ✅ NEW: Create separate combined and page-specific events for frontend compatibility
        const combinedEvents = [];
        const pageSpecificEvents = [];
        
        // Group events by type for combined view
        const eventTypeGroups = {};
        eventTypes.forEach(event => {
            if (!eventTypeGroups[event.event_type]) {
                eventTypeGroups[event.event_type] = {
                    event_type: event.event_type,
                    event_count: 0,
                    unique_users: new Set()
                };
            }
            eventTypeGroups[event.event_type].event_count += event.event_count;
            // Add unique users (assuming user_id is unique per event type)
            eventTypeGroups[event.event_type].unique_users.add(event.unique_users);
        });
        
        // Convert to final format
        Object.values(eventTypeGroups).forEach(group => {
            combinedEvents.push({
                event_type: group.event_type,
                event_count: group.event_count,
                unique_users: group.unique_users.size,
                websiteUrl: filterWebsiteUrl || 'all',
                widgetId: filterWidgetId || 'all'
            });
        });
        
        // Page-specific events for filtering
        eventTypes.forEach(event => {
            pageSpecificEvents.push({
                event_type: event.event_type,
                page_path: event.path,
                event_count: event.event_count,
                unique_users: event.unique_users,
                websiteUrl: event.websiteUrl,
                widgetId: event.widgetId
            });
        });

        const result = {
            date: dateOnly,
            totalUsers: summary[0]?.unique_users || 0,
            totalEvents: summary[0]?.total_events || 0,
            topPages: topPages,
            topEvents: combinedEvents,
            pageSpecificEvents: pageSpecificEvents,
            websiteWidgetBreakdown: widgetBreakdown.map(item => ({
                websiteUrl: item.website_url,
                widgetId: item.widget_id,
                userCount: item.unique_users,
                totalEvents: item.total_events
            })),
            // Legacy support
            summary: {
                unique_users: summary[0]?.unique_users || 0,
                total_events: summary[0]?.total_events || 0
            },
            event_types: eventTypes,
            top_pages: topPages,
            widget_breakdown: widgetBreakdown
        };

        return result;

    } catch (error) {
        console.error('❌ Error fetching widget analytics history:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Add this new endpoint with website filtering support
app.get('/api/analytics/widget/history', async (req, res) => {
    try {
        const { date, websiteUrl, widgetId } = req.query;
        if (!date) {
            return res.status(400).json({ error: 'Date parameter is required' });
        }

        const widgetHistory = await getWidgetAnalyticsHistory(date, websiteUrl, widgetId);
        res.json(widgetHistory);
    } catch (error) {
        console.error('Error fetching widget analytics history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch widget analytics history',
            details: error.message 
        });
    }
});


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
    
    // ✅ FIXED: Store today's events for history (but exclude location_update and location_error events)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();
    
    if (timestamp >= todayTimestamp && eventType !== 'location_update' && eventType !== 'location_error') {
        // ✅ FIXED: Ensure widget events have path information
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
            return; // Exit early without storing or broadcasting

        default:
            return;
    }

    // ✅ FIXED: Smart broadcasting - only on significant user state changes
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
    
    // Also track in today's events for history
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();
    
    if (data.timestamp >= todayTimestamp) {
        const eventKey = `interaction_${eventType}_${userData.userId}_${Date.now()}`;
        todayEvents.set(eventKey, {
            userId: userData.userId,
            eventType: eventType,
            timestamp: data.timestamp,
            url: data.url,
            path: data.path, // This should now have the corrected path
            eventData: eventData || { path: data.path, title: data.title },
            websiteUrl: userData.websiteUrl,
            widgetId: userData.widgetId
        });
        
    }
    
    // Better logging with appropriate data
    const logData = eventData || { path: path, title: title };
}



// ✅ SIMPLIFIED: Real-time analytics for your requirements
function getRealTimeAnalytics() {
    const totalUsers = activeUsers.size;
    const totalSessions = activeSessions.size;
    
    // Live users on pages (Active pages) with website/widget info
    const topPages = Array.from(pageViews.entries())
        .map(([pageCompositeKey, users]) => {
            // ✅ FIXED: Extract path, websiteUrl, and widgetId from composite key (path|websiteUrl|widgetId)
            const [actualPath, websiteUrl, widgetId] = pageCompositeKey.split('|');
            return {
                path: actualPath,
                websiteUrl: websiteUrl || 'unknown',
                widgetId: widgetId || 'unknown',
                users: users.size,
                unique_users: users.size, // Add for compatibility
                user_count: users.size    // Add for compatibility
            };
        })
        .sort((a, b) => b.users - a.users)
        .slice(0, 10);
    
    // Calculate active vs idle users
    const now = Date.now();
    let activeCount = 0;
    let idleCount = 0;
    
    activeUsers.forEach((user) => {
        const timeSinceLastActivity = now - user.lastSeen;
        if (timeSinceLastActivity < 60000) {
            activeCount++;
        } else {
            idleCount++;
        }
    });

    // Today's events for history
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();

    const todayEventsArray = Array.from(todayEvents.values()).filter(event => 
        event.timestamp >= todayTimestamp
    );
    
    // Count unique users for today
    const todayUniqueUsers = new Set(todayEventsArray.map(event => event.userId)).size;
    
    // Count total events for today
    const todayTotalEvents = todayEventsArray.length;
    
    // Page stats for today
    const pagePerformance = new Map();
    todayEventsArray.forEach(event => {
        if (event.eventType === 'page_view' || event.eventType === 'page_enter') {
            const path = event.path;
            if (!pagePerformance.has(path)) {
                pagePerformance.set(path, {
                    path: path,
                    title: event.title,
                    unique_users: new Set(),
                    page_views: 0
                });
            }
            const page = pagePerformance.get(path);
            page.unique_users.add(event.userId);
            page.page_views++;
        }
    });

    const pageStats = Array.from(pagePerformance.entries()).map(([path, data]) => ({
        path: data.path,
        title: data.title,
        unique_users: data.unique_users.size,
        page_views: data.page_views
    })).sort((a, b) => b.unique_users - a.unique_users);

    // Count event types for interactions
    const eventTypeCounts = new Map();
    todayEventsArray.forEach(event => {
        eventTypeCounts.set(event.eventType, (eventTypeCounts.get(event.eventType) || 0) + 1);
    });
    
    if (todayEventsArray.length > 0) {
    }

    const pageInteractionsMap = new Map(); // Format: "eventType|path|websiteUrl|widgetId" -> {event_type, path, count, unique_users, websiteUrl, widgetId}
    const combinedInteractionsMap = new Map(); // Format: "eventType|websiteUrl|widgetId" -> {event_type, count, unique_users, websiteUrl, widgetId}
    
    todayEventsArray.forEach(event => {
        const eventType = event.eventType;
        const path = event.path || event.url_path || '/'; // Use path from event data
        const websiteUrl = event.websiteUrl || 'unknown';
        const widgetId = event.widgetId || 'unknown';
        
        const pageKey = `${eventType}|${path}|${websiteUrl}|${widgetId}`;
        const combinedKey = `${eventType}|${websiteUrl}|${widgetId}`;
        
        // ✅ Page-specific interactions (for filtered view) with website/widget info
        if (!pageInteractionsMap.has(pageKey)) {
            pageInteractionsMap.set(pageKey, {
                event_type: eventType,
                path: path,
                page_path: path, // Add both for compatibility
                websiteUrl: websiteUrl,
                widgetId: widgetId,
                count: 0,
                unique_users: new Set()
            });
        }
        
        const pageInteraction = pageInteractionsMap.get(pageKey);
        pageInteraction.count++;
        pageInteraction.unique_users.add(event.userId);
        
        // ✅ Combined interactions (for all interactions view) with website/widget info
        if (!combinedInteractionsMap.has(combinedKey)) {
            combinedInteractionsMap.set(combinedKey, {
                event_type: eventType,
                path: null, // No specific path for combined view
                page_path: null,
                websiteUrl: websiteUrl,
                widgetId: widgetId,
                count: 0,
                unique_users: new Set()
            });
        }
        
        const combinedInteraction = combinedInteractionsMap.get(combinedKey);
        combinedInteraction.count++;
        combinedInteraction.unique_users.add(event.userId);
    });

    // Convert page-specific interactions to final format with website/widget info
    const pageSpecificInteractions = Array.from(pageInteractionsMap.values()).map(interaction => {
        let count = interaction.count;
        // ✅ FIXED: Divide page_enter and page_exit counts by 2 to fix double counting
        if (interaction.event_type === 'page_enter' || interaction.event_type === 'page_exit') {
            count = Math.round(count / 2);
        }
        
        return {
            event_type: interaction.event_type,
            path: interaction.path,
            page_path: interaction.page_path,
            websiteUrl: interaction.websiteUrl,
            widgetId: interaction.widgetId,
            count: count,
            unique_users: interaction.unique_users.size
        };
    }).sort((a, b) => b.count - a.count);
    
    // Convert combined interactions to final format with website/widget info
    const combinedInteractions = Array.from(combinedInteractionsMap.values()).map(interaction => {
        let count = interaction.count;
        // ✅ FIXED: Divide page_enter and page_exit counts by 2 to fix double counting
        if (interaction.event_type === 'page_enter' || interaction.event_type === 'page_exit') {
            count = Math.round(count / 2);
        }
        
        return {
            event_type: interaction.event_type,
            path: null, // No specific path for combined view
            page_path: null,
            websiteUrl: interaction.websiteUrl,
            widgetId: interaction.widgetId,
            count: count,
            unique_users: interaction.unique_users.size
        };
    }).sort((a, b) => b.count - a.count);
    
    // ✅ Use combined interactions as the main topEvents, and page-specific for filtering
    const interactions = combinedInteractions;
    
    if (interactions.length > 0) {
    }
    
    // Breakdown by website and widget
    const websiteWidgetBreakdown = new Map();
    activeUsers.forEach((userData, compositeKey) => {
        const websiteUrl = userData.websiteUrl || 'unknown';
        const widgetId = userData.widgetId || 'unknown';
        const key = `${websiteUrl}|${widgetId}`;

        if (!websiteWidgetBreakdown.has(key)) {
            websiteWidgetBreakdown.set(key, {
                websiteUrl,
                widgetId,
                userCount: 0,
                countries: new Set(),
                cities: new Set()
            });
        }

        const breakdown = websiteWidgetBreakdown.get(key);
        breakdown.userCount++;
        breakdown.countries.add(userData.country || 'Unknown');
        breakdown.cities.add(userData.city || 'Unknown');
    });

    const websiteWidgetStats = Array.from(websiteWidgetBreakdown.values()).map(breakdown => ({
        websiteUrl: breakdown.websiteUrl,
        widgetId: breakdown.widgetId,
        userCount: breakdown.userCount,
        countries: Array.from(breakdown.countries),
        cities: Array.from(breakdown.cities)
    }));

    return {
        // Real-time metrics
        totalUsers,
        totalSessions,
        activeUsers: activeCount,
        idleUsers: idleCount,
        topPages, // Active pages with live users
        usersByCountry: getRealTimeUsersByCountry(),
        usersByCity: getRealTimeUsersByCity(),

        // Website and widget breakdown
        websiteWidgetBreakdown: websiteWidgetStats,
        
        // Today's stats
        todayStats: {
            unique_users: todayUniqueUsers,
            total_events: todayTotalEvents
        },
        
        // Top events (interactions) - combined view for all interactions
        topEvents: interactions,
        
        // Page-specific interactions for filtering
        pageSpecificInteractions: pageSpecificInteractions,
        
        // Page performance 
        pageStats: pageStats
    };
}


// ✅ SIMPLIFIED: Store analytics events to database
async function storeAnalyticsEvent(data) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        await connection.execute(`
            INSERT INTO analytics_events (
                user_id, event_type, timestamp, url, path, title,
                device_info, browser_info, location_data, event_data,
                referrer, is_active, website_url, widget_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            data.userId || null,
            data.eventType || null,
            data.timestamp || Date.now(),
            data.url || null,
            data.path || null,
            data.title || null,
            JSON.stringify(data.device || {}),
            JSON.stringify(data.browser || {}),
            JSON.stringify(data.location || {}),
            JSON.stringify(data.eventData || {}),
            data.referrer || null,
            data.isActive || false,
            data.websiteUrl || null,
            data.widgetId || null
        ]);
        
    } catch (error) {
        console.error('❌ [ANALYTICS] Database storage error:', error);
    } finally {
        if (connection) connection.release();
    }
}

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
        await processLocationWithRetry(userId, data);
    }
    
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

app.get('/api/analytics/interactions/combined', async (req, res) => {
    try {
        const realTimeAnalytics = getRealTimeAnalytics();
        
        res.json({
            success: true,
            data: {
                interactions: realTimeAnalytics.topEvents, // Combined interactions with path: null
                todayStats: realTimeAnalytics.todayStats,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        console.error('❌ Combined interactions API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch combined interactions' 
        });
    }
});

app.get('/api/analytics/interactions/page-specific', async (req, res) => {
    try {
        const realTimeAnalytics = getRealTimeAnalytics();
        
        res.json({
            success: true,
            data: {
                interactions: realTimeAnalytics.pageSpecificInteractions, // Page-specific interactions with actual paths
                todayStats: realTimeAnalytics.todayStats,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        console.error('❌ Page-specific interactions API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch page-specific interactions' 
        });
    }
});

// ✅ SIMPLIFIED: Analytics overview API
app.get('/api/analytics/overview', async (req, res) => {
    try {
        const realTimeData = getRealTimeAnalytics();
        
        const connection = await pool.getConnection();
        
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTimestamp = todayStart.getTime();
        
        const [todayStats] = await connection.execute(`
            SELECT 
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as total_events
            FROM analytics_events 
            WHERE timestamp >= ?
        `, [todayTimestamp]);
        
        const [topEvents] = await connection.execute(`
            SELECT 
                event_type,
                path,
                COUNT(*) as event_count,
                COUNT(DISTINCT user_id) as unique_users
            FROM analytics_events 
            WHERE timestamp >= ? AND event_type != 'location_update'
            GROUP BY event_type, path
            ORDER BY event_count DESC
            LIMIT 20
        `, [todayTimestamp]);
        
        connection.release();
        
        res.json({
            success: true,
            data: {
                realTime: realTimeData,
                today: todayStats[0] || {},
                topEvents: topEvents,
                timestamp: Date.now()
            }
        });
        
    } catch (error) {
        console.error('❌ Analytics overview error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ✅ SIMPLIFIED: Pages analytics API
app.get('/api/analytics/pages', async (req, res) => {
    try {
        const { date, limit = 50 } = req.query;
        const connection = await pool.getConnection();
        
        let whereClause = '';
        const params = [parseInt(limit)];
        
        if (date) {
            const dayStart = new Date(date).getTime();
            const dayEnd = dayStart + (24 * 60 * 60 * 1000);
            whereClause = 'WHERE timestamp >= ? AND timestamp < ?';
            params.unshift(dayStart, dayEnd);
        }
        
        const [pageStats] = await connection.execute(`
            SELECT 
                path,
                title,
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as page_views
            FROM analytics_events 
            WHERE event_type = 'page_view' ${whereClause.replace('WHERE', 'AND')}
            GROUP BY path, title
            ORDER BY unique_users DESC
            LIMIT ?
        `, params);
        
        connection.release();
        
        res.json({
            success: true,
            data: pageStats,
            date: date || 'all-time'
        });
        
    } catch (error) {
        console.error('❌ Page analytics error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ✅ SIMPLIFIED: User interactions/behavior API
app.get('/api/analytics/behavior', async (req, res) => {
    try {
        const { date } = req.query;
        const connection = await pool.getConnection();
        
        let whereClause = '';
        const params = [];
        
        if (date) {
            const dayStart = new Date(date).getTime();
            const dayEnd = dayStart + (24 * 60 * 60 * 1000);
            whereClause = 'WHERE timestamp >= ? AND timestamp < ?';
            params.push(dayStart, dayEnd);
        }
        
        const [interactionStats] = await connection.execute(`
            SELECT 
                event_type,
                COUNT(*) as count,
                COUNT(DISTINCT user_id) as unique_users
            FROM analytics_events 
            ${whereClause}
            GROUP BY event_type
            ORDER BY count DESC
        `, params);
        
        connection.release();
        
        res.json({
            success: true,
            data: {
                interactions: interactionStats
            },
            date: date || 'all-time'
        });
        
    } catch (error) {
        console.error('❌ Behavior analytics error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// Your existing API endpoints
app.get('/api/available-dates', async (req, res) => {
    try {
        
        const connection = await pool.getConnection();
        
        // ✅ Get raw timestamps and handle timezone in JavaScript
        const [rows] = await connection.execute(`
            SELECT 
                timestamp,
                COUNT(DISTINCT user_id) as user_count
            FROM location_stats 
            WHERE timestamp IS NOT NULL
            GROUP BY DATE(FROM_UNIXTIME(timestamp/1000))
            ORDER BY timestamp DESC
        `);
        
        connection.release();
        
        // ✅ Process dates in JavaScript to avoid SQL timezone issues
        const dateGroups = {};
        
        rows.forEach(row => {
            // Create date in UTC to avoid timezone shifts
            const date = new Date(row.timestamp);
            const dateKey = date.getUTCFullYear() + '-' + 
                           String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getUTCDate()).padStart(2, '0');
            
            if (!dateGroups[dateKey]) {
                dateGroups[dateKey] = row.user_count;
            }
        });
        
        // Convert to array format
        const cleanDates = Object.entries(dateGroups)
            .map(([date, user_count]) => ({ date, user_count }))
            .sort((a, b) => b.date.localeCompare(a.date));
        
        
        res.json({
            success: true,
            dates: cleanDates,
            totalDates: cleanDates.length
        });
    } catch (error) {
        console.error('❌ Available dates API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// ✅ NEW: POST route for available-dates with website filtering
app.post('/api/available-dates', async (req, res) => {
    try {
        const { websiteUrl, widgetId } = req.body;
        
        const connection = await pool.getConnection();
        
        let query = `
            SELECT 
                timestamp,
                COUNT(DISTINCT user_id) as user_count
            FROM location_stats 
            WHERE timestamp IS NOT NULL
        `;
        
        const queryParams = [];
        
        // Add website filtering if provided
        if (websiteUrl && widgetId) {
            query += ` AND website_url = ? AND widget_id = ?`;
            queryParams.push(websiteUrl, widgetId);
        }
        
        query += `
            GROUP BY DATE(FROM_UNIXTIME(timestamp/1000))
            ORDER BY timestamp DESC
        `;
        
        const [rows] = await connection.execute(query, queryParams);
        connection.release();
        
        // ✅ Process dates in JavaScript to avoid SQL timezone issues
        const dateGroups = {};
        
        rows.forEach(row => {
            // Create date in UTC to avoid timezone shifts
            const date = new Date(row.timestamp);
            const dateKey = date.getUTCFullYear() + '-' + 
                           String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getUTCDate()).padStart(2, '0');
            
            if (!dateGroups[dateKey]) {
                dateGroups[dateKey] = row.user_count;
            }
        });
        
        // Convert to array format
        const cleanDates = Object.entries(dateGroups)
            .map(([date, user_count]) => ({ date, user_count }))
            .sort((a, b) => b.date.localeCompare(a.date));
        
        
        res.json({
            success: true,
            dates: cleanDates,
            totalDates: cleanDates.length
        });
    } catch (error) {
        console.error('❌ Available dates (filtered) API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// Get historical data for a specific date
app.post('/api/historical-dashboard', async (req, res) => {
    try {
        const { date, websiteUrl, widgetId } = req.body; // ✅ ENHANCED: Added website filtering
        
        if (!date) {
            return res.status(400).json({ 
                success: false, 
                error: 'Date is required' 
            });
        }


        const historicalData = await getHistoricalData(date, websiteUrl, widgetId); // ✅ Pass filtering parameters
        
        res.json({
            success: true,
            data: historicalData,
            date: date,
            dataType: 'historical'
        });
    } catch (error) {
        console.error('❌ Historical dashboard API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// Get available dates with analytics events (with optional website filtering)
app.get('/api/analytics/available-dates', async (req, res) => {
    try {
        const { websiteUrl, widgetId } = req.query;
        
        const connection = await pool.getConnection();
        
        // ✅ NEW: Build WHERE clause for website filtering
        let whereClause = 'created_at IS NOT NULL';
        let queryParams = [];
        
        if (websiteUrl && websiteUrl !== 'all') {
            whereClause += ' AND website_url = ?';
            queryParams.push(websiteUrl);
        }
        
        if (widgetId && widgetId !== 'all') {
            whereClause += ' AND widget_id = ?';
            queryParams.push(widgetId);
        }
        
        // Get raw timestamps and handle timezone in JavaScript
        const [rows] = await connection.execute(`
            SELECT 
                UNIX_TIMESTAMP(created_at) * 1000 as timestamp,
                COUNT(DISTINCT session_id) as event_count
            FROM analytics_events 
            WHERE ${whereClause}
            GROUP BY DATE(FROM_UNIXTIME(UNIX_TIMESTAMP(created_at)))
            ORDER BY timestamp DESC
        `, queryParams);
        
        connection.release();
        
        // Process dates in JavaScript to avoid SQL timezone issues
        const dateGroups = {};
        
        rows.forEach(row => {
            // Create date in UTC to avoid timezone shifts
            const date = new Date(row.timestamp);
            const dateKey = date.getUTCFullYear() + '-' + 
                         String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                         String(date.getUTCDate()).padStart(2, '0');
            
            if (!dateGroups[dateKey]) {
                dateGroups[dateKey] = row.event_count;
            }
        });
        
        const dates = Object.keys(dateGroups).map(date => ({
            date: date,
            event_count: dateGroups[date]
        }));
        
        
        res.json({
            success: true,
            dates: dates
        });
        
    } catch (error) {
        console.error('❌ Error fetching available dates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch available dates',
            details: error.message
        });
    }
});

// Get widget analytics history for a specific date
app.post('/api/analytics/widget/history', async (req, res) => {
    try {
        const { date } = req.body;
        
        if (!date) {
            return res.status(400).json({ 
                success: false, 
                error: 'Date is required' 
            });
        }

        let dateOnly = date;
        if (date.includes('T')) {
            dateOnly = date.split('T')[0];
        }
        
        const startOfDay = new Date(`${dateOnly}T00:00:00.000Z`);
        const endOfDay = new Date(`${dateOnly}T23:59:59.999Z`);
        
        // Get summary metrics
        const [summary] = await pool.query(`
            SELECT 
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(DISTINCT session_id) as unique_sessions,
                COUNT(*) as total_events,
                SUM(CASE WHEN event_type = 'page_view' OR event_type = 'page_enter' THEN 1 ELSE 0 END) as page_views,
                AVG(time_on_page) as avg_time_on_page,
                AVG(scroll_depth) as avg_scroll_depth
            FROM analytics_events
            WHERE created_at >= ? AND created_at <= ?
        `, [startOfDay, endOfDay]);
        
        // Get top pages
        const [topPages] = await pool.query(`
            SELECT 
                COALESCE(path, 'Unknown') as path,
                COALESCE(title, 'Untitled') as title,
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as page_views,
                AVG(time_on_page) as avg_time_on_page,
                AVG(scroll_depth) as avg_scroll_depth
            FROM analytics_events
            WHERE (event_type = 'page_view' OR event_type = 'page_enter')
            AND created_at >= ? AND created_at <= ?
            GROUP BY path, title
            ORDER BY page_views DESC
            LIMIT 10
        `, [startOfDay, endOfDay]);
        
        // Get event type breakdown
        const [eventTypes] = await pool.query(`
            SELECT 
                event_type,
                COUNT(*) as event_count,
                COUNT(DISTINCT user_id) as unique_users
            FROM analytics_events
            WHERE created_at >= ? AND created_at <= ?
            GROUP BY event_type
            ORDER BY event_count DESC
        `, [startOfDay, endOfDay]);
        
        // ✅ IMPROVED: Get page-specific event breakdown with session-based page association
        const [pageSpecificEvents] = await pool.query(`
            SELECT 
                page_events.page_path,
                page_events.event_type,
                COUNT(*) as event_count,
                COUNT(DISTINCT page_events.user_id) as unique_users
            FROM (
                -- Get events with their associated page context
                SELECT 
                    e1.user_id,
                    e1.session_id,
                    e1.event_type,
                    e1.created_at,
                    -- Use the most recent page_enter/page_view event for the same session to determine page context
                    COALESCE(
                        (SELECT e2.path 
                         FROM analytics_events e2 
                         WHERE e2.user_id = e1.user_id 
                         AND e2.session_id = e1.session_id
                         AND e2.event_type IN ('page_enter', 'page_view')
                         AND e2.created_at <= e1.created_at
                         ORDER BY e2.created_at DESC 
                         LIMIT 1),
                        e1.path,
                        'Unknown'
                    ) as page_path
                FROM analytics_events e1
                WHERE e1.created_at >= ? AND e1.created_at <= ?
            ) page_events
            WHERE page_events.page_path != 'Unknown'
            GROUP BY page_events.page_path, page_events.event_type
            ORDER BY event_count DESC
        `, [startOfDay, endOfDay]);
        
        // Get website and widget breakdown
        const [websiteWidgetBreakdown] = await pool.query(`
            SELECT 
                COALESCE(website_url, 'Unknown') as website,
                COALESCE(widget_id, 'default') as widget_id,
                COUNT(DISTINCT user_id) as unique_users,
                COUNT(*) as total_events
            FROM analytics_events
            WHERE created_at >= ? AND created_at <= ?
            GROUP BY website_url, widget_id
            ORDER BY total_events DESC
        `, [startOfDay, endOfDay]);
        
        const result = {
            summary: {
                unique_users: summary[0]?.unique_users || 0,
                unique_sessions: summary[0]?.unique_sessions || 0,
                total_events: summary[0]?.total_events || 0,
                page_views: summary[0]?.page_views || 0,
                avg_time_on_page: parseFloat(summary[0]?.avg_time_on_page || 0).toFixed(2),
                avg_scroll_depth: parseFloat(summary[0]?.avg_scroll_depth || 0).toFixed(2)
            },
            top_pages: topPages.map(page => ({
                ...page,
                avg_time_on_page: parseFloat(page.avg_time_on_page || 0).toFixed(2),
                avg_scroll_depth: parseFloat(page.avg_scroll_depth || 0).toFixed(2)
            })),
            event_types: eventTypes,
            page_specific_events: pageSpecificEvents, // ✅ NEW: Add page-specific events
            website_widget_breakdown: websiteWidgetBreakdown,
            date: dateOnly
        };
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ Error in widget analytics history API:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch widget analytics history',
            details: error.message 
        });
    }
});

// ✅ ENHANCED: Function to get historical data with website filtering
async function getHistoricalData(dateInput, websiteUrl = null, widgetId = null) {
    let connection;
    try {
        connection = await pool.getConnection();
        
        let dateOnly;
        if (dateInput.includes('T')) {
            dateOnly = dateInput.split('T')[0];
        } else {
            dateOnly = dateInput;
        }
        
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(dateOnly)) {
            throw new Error(`Invalid date format: ${dateInput}. Expected YYYY-MM-DD`);
        }
        
        const startOfDay = new Date(`${dateOnly}T00:00:00.000Z`);
        const endOfDay = new Date(`${dateOnly}T23:59:59.999Z`);
        
        const startTimestamp = startOfDay.getTime();
        const endTimestamp = endOfDay.getTime();
        
        if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
            throw new Error(`Invalid timestamps generated from date: ${dateOnly}`);
        }
        
        // ✅ ENHANCED: Build base WHERE clause with website filtering
        let baseWhereClause = `timestamp >= ? AND timestamp <= ?`;
        let baseParams = [startTimestamp, endTimestamp];
        
        if (websiteUrl && widgetId) {
            baseWhereClause += ` AND website_url = ? AND widget_id = ?`;
            baseParams.push(websiteUrl, widgetId);
        }
        
        // ✅ ENHANCED: Debug query with website filtering
        const [debugResult] = await connection.execute(`
            SELECT 
                user_id,
                timestamp,
                FROM_UNIXTIME(timestamp/1000) as readable_time,
                city,
                country,
                website_url,
                widget_id
            FROM location_stats 
            WHERE ${baseWhereClause}
            ORDER BY timestamp DESC
            LIMIT 5
        `, baseParams);
        
        
        const [totalResult] = await connection.execute(`
            SELECT COUNT(DISTINCT user_id) as total_users
            FROM location_stats 
            WHERE ${baseWhereClause}
        `, baseParams);
        
        
        const [countryResult] = await connection.execute(`
            SELECT 
                country,
                COUNT(DISTINCT user_id) as user_count
            FROM location_stats 
            WHERE ${baseWhereClause}
            AND country IS NOT NULL 
            AND country != ''
            AND country != 'Unknown'
            GROUP BY country
            ORDER BY user_count DESC
        `, baseParams);
        
        // ✅ ENHANCED: Get users by city with website filtering
        const [cityResult] = await connection.execute(`
            SELECT 
                CONCAT(city, ', ', country) as city,
                COUNT(DISTINCT user_id) as user_count
            FROM location_stats 
            WHERE ${baseWhereClause}
            AND city IS NOT NULL 
            AND city != ''
            AND city != 'Unknown'
            AND country IS NOT NULL 
            AND country != ''
            AND country != 'Unknown'
            GROUP BY city, country
            ORDER BY user_count DESC
        `, baseParams);
        
        const historicalData = {
            totalOnline: totalResult[0].total_users,
            usersByCountry: countryResult.map(row => ({
                country: row.country,
                user_count: row.user_count
            })),
            usersByCity: cityResult.map(row => ({
                city: row.city,
                user_count: row.user_count
            })),
            timestamp: Date.now(),
            dataType: 'historical',
            date: dateOnly,
            // ✅ ADDED: Include debug info
            queryRange: {
                start: startOfDay.toISOString(),
                end: endOfDay.toISOString(),
                startTimestamp,
                endTimestamp
            }
        };        
        return historicalData;
        
    } catch (error) {
        console.error('❌ Error fetching historical data:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

// Existing endpoints
app.get('/api/dashboard', async (req, res) => {
    try {
        const realTimeAnalytics = getRealTimeAnalytics();
        
        res.json({
            ...realTimeAnalytics,
            timestamp: Date.now(),
            dataType: 'real-time-analytics'
        });
    } catch (error) {
        console.error('❌ Dashboard API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        online_users: activeUsers.size,
        active_sessions: activeSessions.size,
        dashboard_clients: dashboardClients.size,
        location_cache_size: locationCache.size,
        page_views: pageViews.size
    });
});

setInterval(() => {
    const now = Date.now();
    const INACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    
    let cleaned = 0;
    
    // Clean inactive users
    activeUsers.forEach((user, userId) => {
        if (now - user.lastSeen > INACTIVE_THRESHOLD) {
            activeUsers.delete(userId);
            cleaned++;
        }
    });
    
    // Clean inactive sessions
    activeSessions.forEach((session, sessionKey) => {
        if (now - session.lastActivity > INACTIVE_THRESHOLD) {
            activeSessions.delete(sessionKey);
        }
    });
    
    // Clean page views
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
    }
}, 10 * 60 * 1000); // Changed to 10 minutes

// Cache cleanup (run every 30 minutes)
setInterval(() => {
    locationCache.clear();
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
});
