const express = require('express');
const router = express.Router();

const analyticsRoutes = require('./analyticsRoutes');
const dashboardRoutes = require('./dashboardRoutes');

router.use('/api/analytics', analyticsRoutes);
router.use('/api', dashboardRoutes);

router.get('/socket.io.min.js', (req, res) => {
    res.sendFile(require('path').join(__dirname, '../node_modules/socket.io/client-dist/socket.io.min.js'));
});

module.exports = router;
