const { getDB } = require('../config/database');
const { getRealTimeAnalytics, getWidgetAnalyticsHistory } = require('../services/analyticsService');

async function getAnalyticsOverview(req, res) {
    try {
        const realTimeData = getRealTimeAnalytics();

        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayTimestamp = todayStart.getTime();

        // Get today's stats
        const todayStatsAgg = await analyticsCollection.aggregate([
            { $match: { timestamp: { $gte: todayTimestamp } } },
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

        // Get top events
        const topEventsAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    timestamp: { $gte: todayTimestamp },
                    event_type: { $ne: 'location_update' }
                }
            },
            {
                $group: {
                    _id: { event_type: "$event_type", path: "$path" },
                    event_count: { $sum: 1 },
                    unique_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    event_type: "$_id.event_type",
                    path: "$_id.path",
                    event_count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { event_count: -1 } },
            { $limit: 20 }
        ]).toArray();

        res.json({
            success: true,
            data: {
                realTime: realTimeData,
                today: todayStatsAgg[0] || { unique_users: 0, total_events: 0 },
                topEvents: topEventsAgg,
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
}

async function getAnalyticsPages(req, res) {
    try {
        const { date, limit = 50 } = req.query;
        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        let matchCondition = { event_type: 'page_view' };

        if (date) {
            const dayStart = new Date(date).getTime();
            const dayEnd = dayStart + (24 * 60 * 60 * 1000);
            matchCondition.timestamp = { $gte: dayStart, $lt: dayEnd };
        }

        const pageStatsAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: { path: "$path", title: "$title" },
                    unique_users: { $addToSet: "$user_id" },
                    page_views: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    path: "$_id.path",
                    title: "$_id.title",
                    unique_users: { $size: "$unique_users" },
                    page_views: 1
                }
            },
            { $sort: { unique_users: -1 } },
            { $limit: parseInt(limit) }
        ]).toArray();

        res.json({
            success: true,
            data: pageStatsAgg,
            date: date || 'all-time'
        });

    } catch (error) {
        console.error('❌ Page analytics error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
}

async function getAnalyticsBehavior(req, res) {
    try {
        const { date } = req.query;
        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        let matchCondition = {};

        if (date) {
            const dayStart = new Date(date).getTime();
            const dayEnd = dayStart + (24 * 60 * 60 * 1000);
            matchCondition.timestamp = { $gte: dayStart, $lt: dayEnd };
        }

        const interactionStatsAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: "$event_type",
                    count: { $sum: 1 },
                    unique_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    event_type: "$_id",
                    count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { count: -1 } }
        ]).toArray();

        res.json({
            success: true,
            data: {
                interactions: interactionStatsAgg
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
}

async function getCombinedInteractions(req, res) {
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
}

async function getPageSpecificInteractions(req, res) {
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
}

async function getWidgetHistory(req, res) {
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
}

async function getAnalyticsAvailableDates(req, res) {
    try {
        const { websiteUrl, widgetId } = req.query;

        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        let matchCondition = { created_at: { $exists: true, $ne: null } };

        if (websiteUrl && websiteUrl !== 'all') {
            matchCondition.website_url = websiteUrl;
        }

        if (widgetId && widgetId !== 'all') {
            matchCondition.widget_id = widgetId;
        }

        const datesAgg = await analyticsCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: "%Y-%m-%d",
                            date: "$created_at"
                        }
                    },
                    event_count: { $addToSet: "$session_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    date: "$_id",
                    event_count: { $size: "$event_count" }
                }
            },
            { $sort: { date: -1 } }
        ]).toArray();

        res.json({
            success: true,
            dates: datesAgg
        });

    } catch (error) {
        console.error('❌ Error fetching available dates:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch available dates',
            details: error.message
        });
    }
}

// Get widget analytics history for a specific date (POST)
async function postWidgetHistory(req, res) {
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

        const db = getDB();
        const analyticsCollection = db.collection('analytics_events');

        // Get summary metrics (excluding the specified fields)
        const summaryAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    created_at: { $gte: startOfDay, $lte: endOfDay }
                }
            },
            {
                $group: {
                    _id: null,
                    unique_users: { $addToSet: "$user_id" },
                    unique_sessions: { $addToSet: "$session_id" },
                    total_events: { $sum: 1 },
                    page_views: {
                        $sum: {
                            $cond: [
                                { $in: ["$event_type", ["page_view", "page_enter"]] },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    unique_users: { $size: "$unique_users" },
                    unique_sessions: { $size: "$unique_sessions" },
                    total_events: 1,
                    page_views: 1,
                    avg_time_on_page: 0, // Excluded field
                    avg_scroll_depth: 0  // Excluded field
                }
            }
        ]).toArray();

        // Get top pages (excluding the specified fields)
        const topPagesAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    event_type: { $in: ["page_view", "page_enter"] },
                    created_at: { $gte: startOfDay, $lte: endOfDay }
                }
            },
            {
                $group: {
                    _id: {
                        path: { $ifNull: ["$path", "Unknown"] },
                        title: { $ifNull: ["$title", "Untitled"] }
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
                    unique_users: { $size: "$unique_users" },
                    page_views: 1,
                    avg_time_on_page: 0, // Excluded field
                    avg_scroll_depth: 0  // Excluded field
                }
            },
            { $sort: { page_views: -1 } },
            { $limit: 10 }
        ]).toArray();

        // Get event type breakdown
        const eventTypesAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    created_at: { $gte: startOfDay, $lte: endOfDay }
                }
            },
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

        // Get page-specific event breakdown (with website and widget info)
        const pageSpecificEventsAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    created_at: { $gte: startOfDay, $lte: endOfDay },
                    path: { $ne: null, $ne: "Unknown" }
                }
            },
            {
                $group: {
                    _id: {
                        page_path: { $ifNull: ["$path", "Unknown"] },
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
                    page_path: "$_id.page_path",
                    event_type: "$_id.event_type",
                    websiteUrl: "$_id.websiteUrl",
                    widgetId: "$_id.widgetId",
                    event_count: 1,
                    unique_users: { $size: "$unique_users" }
                }
            },
            { $sort: { event_count: -1 } }
        ]).toArray();

        // Get website and widget breakdown
        const websiteWidgetBreakdownAgg = await analyticsCollection.aggregate([
            {
                $match: {
                    created_at: { $gte: startOfDay, $lte: endOfDay }
                }
            },
            {
                $group: {
                    _id: {
                        website: { $ifNull: ["$website_url", "Unknown"] },
                        widget_id: { $ifNull: ["$widget_id", "default"] }
                    },
                    unique_users: { $addToSet: "$user_id" },
                    total_events: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    website: "$_id.website",
                    widget_id: "$_id.widget_id",
                    unique_users: { $size: "$unique_users" },
                    total_events: 1
                }
            },
            { $sort: { total_events: -1 } }
        ]).toArray();

        const summary = summaryAgg[0] || { unique_users: 0, unique_sessions: 0, total_events: 0, page_views: 0 };

        const result = {
            summary: {
                unique_users: summary.unique_users,
                unique_sessions: summary.unique_sessions,
                total_events: summary.total_events,
                page_views: summary.page_views,
                avg_time_on_page: "0.00", // Excluded field
                avg_scroll_depth: "0.00"  // Excluded field
            },
            top_pages: topPagesAgg.map(page => ({
                ...page,
                avg_time_on_page: "0.00", // Excluded field
                avg_scroll_depth: "0.00"  // Excluded field
            })),
            event_types: eventTypesAgg,
            page_specific_events: pageSpecificEventsAgg,
            website_widget_breakdown: websiteWidgetBreakdownAgg,
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
}

module.exports = {
    getAnalyticsOverview,
    getAnalyticsPages,
    getAnalyticsBehavior,
    getCombinedInteractions,
    getPageSpecificInteractions,
    getWidgetHistory,
    getAnalyticsAvailableDates,
    postWidgetHistory
};
