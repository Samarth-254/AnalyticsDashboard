const express = require('express');
const router = express.Router();
const {
    getDashboard,
    getHealth,
    getAvailableDates,
    postAvailableDates,
    postHistoricalDashboard
} = require('../controllers/dashboardController');

router.get('/', getDashboard);
router.get('/health', getHealth);
router.get('/available-dates', getAvailableDates);
router.post('/available-dates', postAvailableDates);
router.post('/historical-dashboard', postHistoricalDashboard);

module.exports = router;
