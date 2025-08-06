const express = require('express');
const router = express.Router();
const {
    getAnalyticsOverview,
    getAnalyticsPages,
    getAnalyticsBehavior,
    getCombinedInteractions,
    getPageSpecificInteractions,
    getWidgetHistory,
    getAnalyticsAvailableDates,
    postWidgetHistory
} = require('../controllers/analyticsController');

router.get('/overview', getAnalyticsOverview);
router.get('/pages', getAnalyticsPages);
router.get('/behavior', getAnalyticsBehavior);
router.get('/interactions/combined', getCombinedInteractions);
router.get('/interactions/page-specific', getPageSpecificInteractions);
router.get('/widget/history', getWidgetHistory);
router.get('/available-dates', getAnalyticsAvailableDates);
router.post('/widget/history', postWidgetHistory);

module.exports = router;
