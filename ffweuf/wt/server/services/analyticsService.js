const { getDB } = require('../config/database');
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
        // ✅ FIXED: Use actual count without division - MongoDB aggregation is accurate
        const count = interaction.count;

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
        // ✅ FIXED: Use actual count without division - MongoDB aggregation is accurate
        const count = interaction.count;

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

    // ✅ NEW: Create truly aggregated interactions by event_type for "All Websites" view
    // This aggregates across all websites/widgets for each event type
    const fullyAggregatedInteractions = new Map();

    // Build aggregated map from the original combinedInteractionsMap to preserve user sets
    combinedInteractionsMap.forEach((interaction, key) => {
        const eventType = interaction.event_type;

        if (!fullyAggregatedInteractions.has(eventType)) {
            fullyAggregatedInteractions.set(eventType, {
                event_type: eventType,
                path: null,
                page_path: null,
                websiteUrl: 'all',
                widgetId: 'all',
                count: 0,
                unique_users: new Set()
            });
        }

        const aggregated = fullyAggregatedInteractions.get(eventType);
        aggregated.count += interaction.count;
        // Merge user sets to get true unique count across all websites
        interaction.unique_users.forEach(userId => aggregated.unique_users.add(userId));
    });

    // Convert to final format
    const fullyAggregatedArray = Array.from(fullyAggregatedInteractions.values()).map(interaction => ({
        event_type: interaction.event_type,
        path: null,
        page_path: null,
        websiteUrl: 'all',
        widgetId: 'all',
        count: interaction.count,
        unique_users: interaction.unique_users.size
    })).sort((a, b) => b.count - a.count);

    // ✅ Use appropriate interactions based on context
    // For frontend "All Websites" aggregation, provide fully aggregated data
    // For specific website filtering, use website-specific data
    const interactions = fullyAggregatedArray;
    
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
        
        // Top events (interactions) - fully aggregated across all websites
        topEvents: fullyAggregatedArray,

        // Website-specific interactions for website filtering
        topEventsByWebsite: combinedInteractions,

        // Page-specific interactions for page filtering
        pageSpecificInteractions: pageSpecificInteractions,
        
        // Page performance 
        pageStats: pageStats
    };
}

// ✅ SIMPLIFIED: Store analytics events to database (excluding specified fields)
async function storeAnalyticsEvent(data) {
    try {
        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        const eventDocument = {
            user_id: data.userId || null,
            event_type: data.eventType || null,
            timestamp: data.timestamp || Date.now(),
            url: data.url || null,
            path: data.path || null,
            title: data.title || null,
            device_info: data.device || {},
            browser_info: data.browser || {},
            location_data: data.location || {},
            event_data: data.eventData || {},
            referrer: data.referrer || null,
            is_active: data.isActive || false,
            website_url: data.websiteUrl || null,
            widget_id: data.widgetId || null,
            created_at: new Date(),
            session_id: data.sessionId || null
            // Note: Excluded fields (session_duration, time_on_page, scroll_depth, click_count, keystrokes) are not included
        };

        await analyticsCollection.insertOne(eventDocument);

    } catch (error) {
        console.error('❌ [ANALYTICS] Database storage error:', error);
    }
}

async function getWidgetAnalyticsHistory(dateInput, filterWebsiteUrl = null, filterWidgetId = null) {
    try {
        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

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

        // Build match condition for filtering
        let matchCondition = {
            timestamp: { $gte: startTimestamp, $lte: endTimestamp }
        };

        if (filterWebsiteUrl && filterWebsiteUrl !== 'all') {
            matchCondition.website_url = filterWebsiteUrl;
        }

        if (filterWidgetId && filterWidgetId !== 'all') {
            matchCondition.widget_id = filterWidgetId;
        }

        // Get summary
        const summaryAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: null,
                    unique_users: { $addToSet: "$user_id" },
                    total_events: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    unique_users: { $size: "$unique_users" },
                    total_events: 1
                }
            }
        ]).toArray();

        // Get event type breakdown (interactions) with filtering - detailed by page/website
        const eventTypesAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: {
                        event_type: "$event_type",
                        path: "$path",
                        websiteUrl: { $ifNull: ["$website_url", "unknown"] },
                        widgetId: { $ifNull: ["$widget_id", "unknown"] }
                    },
                    event_count: { $sum: 1 },
                    unique_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    event_type: "$_id.event_type",
                    path: "$_id.path",
                    websiteUrl: "$_id.websiteUrl",
                    widgetId: "$_id.widgetId",
                    event_count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { event_count: -1 } }
        ]).toArray();

        // ✅ NEW: Get fully aggregated interactions by event_type only (for "All Websites" view)
        const fullyAggregatedAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: "$event_type",
                    event_count: { $sum: 1 },
                    unique_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    event_type: "$_id",
                    event_count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { event_count: -1 } }
        ]).toArray();

        // ✅ NEW: Get website-specific aggregated interactions (for specific website filtering)
        const websiteAggregatedAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: {
                        event_type: "$event_type",
                        websiteUrl: { $ifNull: ["$website_url", "unknown"] },
                        widgetId: { $ifNull: ["$widget_id", "unknown"] }
                    },
                    event_count: { $sum: 1 },
                    unique_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    event_type: "$_id.event_type",
                    websiteUrl: "$_id.websiteUrl",
                    widgetId: "$_id.widgetId",
                    event_count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { event_count: -1 } }
        ]).toArray();

        // Get top pages with filtering and website info
        const topPagesAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    ...matchCondition,
                    event_type: { $in: ["page_view", "page_enter"] }
                }
            },
            {
                $group: {
                    _id: {
                        path: "$path",
                        title: "$title",
                        websiteUrl: { $ifNull: ["$website_url", "unknown"] },
                        widgetId: { $ifNull: ["$widget_id", "unknown"] }
                    },
                    unique_users: { $addToSet: "$user_id" },
                    page_views: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    path: "$_id.path",
                    title: "$_id.title",
                    websiteUrl: "$_id.websiteUrl",
                    widgetId: "$_id.widgetId",
                    unique_users: { $size: "$unique_users" },
                    page_views: 1
                }
            },
            { $sort: { page_views: -1 } },
            { $limit: 10 }
        ]).toArray();

        // Get website and widget breakdown (always show all for context)
        const widgetBreakdownAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    timestamp: { $gte: startTimestamp, $lte: endTimestamp }
                }
            },
            {
                $group: {
                    _id: {
                        website_url: { $ifNull: ["$website_url", "unknown"] },
                        widget_id: { $ifNull: ["$widget_id", "unknown"] }
                    },
                    unique_users: { $addToSet: "$user_id" },
                    total_events: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    website_url: "$_id.website_url",
                    widget_id: "$_id.widget_id",
                    unique_users: { $size: "$unique_users" },
                    total_events: 1
                }
            },
            { $sort: { unique_users: -1 } }
        ]).toArray();

        // ✅ NEW: Use properly aggregated data from MongoDB
        const pageSpecificEvents = [];

        // Convert fully aggregated data to the format expected by frontend
        const fullyAggregatedEvents = fullyAggregatedAgg.map(event => ({
            event_type: event.event_type,
            event_count: event.event_count,
            unique_users: event.unique_users,
            websiteUrl: 'all',
            widgetId: 'all',
            path: null,
            page_path: null
        }));

        // Convert website-specific aggregated data to the format expected by frontend
        const websiteSpecificEvents = websiteAggregatedAgg.map(event => ({
            event_type: event.event_type,
            event_count: event.event_count,
            unique_users: event.unique_users,
            websiteUrl: event.websiteUrl,
            widgetId: event.widgetId,
            path: null,
            page_path: null
        }));

        // Page-specific events for filtering (only include events with valid paths)
        eventTypesAgg
            .filter(event => event.path && event.path !== null && event.path !== "Unknown")
            .forEach(event => {
                pageSpecificEvents.push({
                    event_type: event.event_type,
                    page_path: event.path,
                    event_count: event.event_count,
                    unique_users: event.unique_users,
                    websiteUrl: event.websiteUrl,
                    widgetId: event.widgetId
                });
            });

        const summary = summaryAgg[0] || { unique_users: 0, total_events: 0 };

        const result = {
            date: dateOnly,
            totalUsers: summary.unique_users,
            totalEvents: summary.total_events,
            topPages: topPagesAgg,
            // ✅ NEW: Provide both fully aggregated and website-specific data
            topEvents: fullyAggregatedEvents,
            topEventsByWebsite: websiteSpecificEvents,
            pageSpecificEvents: pageSpecificEvents,
            websiteWidgetBreakdown: widgetBreakdownAgg.map(item => ({
                websiteUrl: item.website_url,
                widgetId: item.widget_id,
                userCount: item.unique_users,
                totalEvents: item.total_events
            })),
            // Legacy support
            summary: {
                unique_users: summary.unique_users,
                total_events: summary.total_events
            },
            event_types: eventTypesAgg,
            top_pages: topPagesAgg,
            widget_breakdown: widgetBreakdownAgg
        };

        return result;

    } catch (error) {
        console.error('❌ Error fetching widget analytics history:', error);
        throw error;
    }
}

module.exports = {
    getRealTimeAnalytics,
    storeAnalyticsEvent,
    getWidgetAnalyticsHistory
};
