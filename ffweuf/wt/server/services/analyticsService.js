const { pool } = require('../config/database');
const { 
    activeUsers, 
    activeSessions, 
    todayEvents, 
    pageViews, 
    dashboardClients
} = require('../config/constants');
const { 
    getRealTimeUsersByCountry,
    getRealTimeUsersByCity 
} = require('../utils/helpers');

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

module.exports = {
    getRealTimeAnalytics,
    storeAnalyticsEvent,
    getWidgetAnalyticsHistory
};
