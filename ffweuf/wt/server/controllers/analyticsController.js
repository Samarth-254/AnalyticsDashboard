const { pool } = require('../config/database');
const { getRealTimeAnalytics, getWidgetAnalyticsHistory } = require('../services/analyticsService');

async function getAnalyticsOverview(req, res) {
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
}

async function getAnalyticsPages(req, res) {
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
}

async function getAnalyticsBehavior(req, res) {
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
        
        const connection = await pool.getConnection();
        
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
