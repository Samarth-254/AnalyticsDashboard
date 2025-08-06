const { pool } = require('../config/database');
const { 
    activeUsers, 
    activeSessions, 
    dashboardClients, 
    locationCache, 
    pageViews 
} = require('../config/constants');
const { getRealTimeAnalytics } = require('../services/analyticsService');

async function getDashboard(req, res) {
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
}

function getHealth(req, res) {
    res.json({ 
        status: 'healthy',
        online_users: activeUsers.size,
        active_sessions: activeSessions.size,
        dashboard_clients: dashboardClients.size,
        location_cache_size: locationCache.size,
        page_views: pageViews.size
    });
}

// Get available dates
async function getAvailableDates(req, res) {
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
        
        const dateGroups = {};
        
        rows.forEach(row => {
            const date = new Date(row.timestamp);
            const dateKey = date.getUTCFullYear() + '-' + 
                           String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getUTCDate()).padStart(2, '0');
            
            if (!dateGroups[dateKey]) {
                dateGroups[dateKey] = row.user_count;
            }
        });
        
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
}

async function postAvailableDates(req, res) {
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
        
        const dateGroups = {};
        
        rows.forEach(row => {
            const date = new Date(row.timestamp);
            const dateKey = date.getUTCFullYear() + '-' + 
                           String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                           String(date.getUTCDate()).padStart(2, '0');
            
            if (!dateGroups[dateKey]) {
                dateGroups[dateKey] = row.user_count;
            }
        });
        
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
}

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
        
        let baseWhereClause = `timestamp >= ? AND timestamp <= ?`;
        let baseParams = [startTimestamp, endTimestamp];
        
        if (websiteUrl && widgetId) {
            baseWhereClause += ` AND website_url = ? AND widget_id = ?`;
            baseParams.push(websiteUrl, widgetId);
        }
        
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

async function postHistoricalDashboard(req, res) {
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
}

module.exports = {
    getDashboard,
    getHealth,
    getAvailableDates,
    postAvailableDates,
    getHistoricalData,
    postHistoricalDashboard
};
