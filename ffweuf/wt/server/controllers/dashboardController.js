const { getDB } = require('../config/database');
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
        const db = getDB();
        const locationCollection = db.collection('location_stats');

        const datesAgg = await locationCollection.aggregate([
            {
                $match: {
                    timestamp: { $exists: true, $ne: null }
                }
            },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: "%Y-%m-%d",
                            date: { $toDate: "$timestamp" }
                        }
                    },
                    user_count: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    date: "$_id",
                    user_count: { $size: "$user_count" }
                }
            },
            { $sort: { date: -1 } }
        ]).toArray();

        res.json({
            success: true,
            dates: datesAgg,
            totalDates: datesAgg.length
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

        const db = getDB();
        const locationCollection = db.collection('location_stats');

        let matchCondition = {
            timestamp: { $exists: true, $ne: null }
        };

        if (websiteUrl && widgetId) {
            matchCondition.website_url = websiteUrl;
            matchCondition.widget_id = widgetId;
        }

        const datesAgg = await locationCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: "%Y-%m-%d",
                            date: { $toDate: "$timestamp" }
                        }
                    },
                    user_count: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    date: "$_id",
                    user_count: { $size: "$user_count" }
                }
            },
            { $sort: { date: -1 } }
        ]).toArray();

        res.json({
            success: true,
            dates: datesAgg,
            totalDates: datesAgg.length
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
    try {
        const db = getDB();
        const locationCollection = db.collection('location_stats');

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

        let matchCondition = {
            timestamp: { $gte: startTimestamp, $lte: endTimestamp }
        };

        if (websiteUrl && widgetId) {
            matchCondition.website_url = websiteUrl;
            matchCondition.widget_id = widgetId;
        }

        // Get total users count
        const totalUsersAgg = await locationCollection.aggregate([
            { $match: matchCondition },
            {
                $group: {
                    _id: null,
                    total_users: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    total_users: { $size: "$total_users" }
                }
            }
        ]).toArray();

        // Get users by country
        const countryAgg = await locationCollection.aggregate([
            {
                $match: {
                    ...matchCondition,
                    country: { $exists: true, $ne: null, $ne: "", $ne: "Unknown" }
                }
            },
            {
                $group: {
                    _id: "$country",
                    user_count: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    country: "$_id",
                    user_count: { $size: "$user_count" }
                }
            },
            { $sort: { user_count: -1 } }
        ]).toArray();

        // Get users by city with normalization
        const cityAgg = await locationCollection.aggregate([
            {
                $match: {
                    ...matchCondition,
                    city: { $exists: true, $ne: null, $ne: "", $ne: "Unknown" },
                    country: { $exists: true, $ne: null, $ne: "", $ne: "Unknown" }
                }
            },
            {
                $addFields: {
                    normalizedCity: {
                        $switch: {
                            branches: [
                                // Delhi variations
                                { case: { $in: [{ $toLower: "$city" }, ["new delhi", "delhi", "delhi ncr", "new delhi district", "central delhi", "south delhi", "north delhi", "east delhi", "west delhi"]] }, then: "Delhi" },
                                // Mumbai variations
                                { case: { $in: [{ $toLower: "$city" }, ["mumbai", "bombay", "greater mumbai", "mumbai city"]] }, then: "Mumbai" },
                                // Bangalore variations
                                { case: { $in: [{ $toLower: "$city" }, ["bangalore", "bengaluru", "bengaluru urban", "bangalore urban"]] }, then: "Bangalore" },
                                // Chennai variations
                                { case: { $in: [{ $toLower: "$city" }, ["chennai", "madras", "chennai city"]] }, then: "Chennai" },
                                // Hyderabad variations
                                { case: { $in: [{ $toLower: "$city" }, ["hyderabad", "secunderabad", "cyberabad"]] }, then: "Hyderabad" },
                                // Kolkata variations
                                { case: { $in: [{ $toLower: "$city" }, ["kolkata", "calcutta", "kolkata city"]] }, then: "Kolkata" },
                                // Pune variations
                                { case: { $in: [{ $toLower: "$city" }, ["pune", "poona", "pune city"]] }, then: "Pune" }
                            ],
                            default: "$city"
                        }
                    }
                }
            },
            {
                $group: {
                    _id: { city: "$normalizedCity", country: "$country" },
                    user_count: { $addToSet: "$user_id" }
                }
            },
            {
                $project: {
                    _id: 0,
                    city: { $concat: ["$_id.city", ", ", "$_id.country"] },
                    user_count: { $size: "$user_count" }
                }
            },
            { $sort: { user_count: -1 } }
        ]).toArray();

        const totalUsers = totalUsersAgg[0]?.total_users || 0;

        const historicalData = {
            totalOnline: totalUsers,
            usersByCountry: countryAgg,
            usersByCity: cityAgg,
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
