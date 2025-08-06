// Global constants and configuration
const LOCATIONIQ_TOKEN = 'pk.9f2ecb3b178c89ff2ddcd2aa6d9d74bf';
const API_RATE_LIMIT = 1000;

// In-memory stores
const activeUsers = new Map();
const activeSessions = new Map();
const dashboardClients = new Set();
const pageViews = new Map(); 
const todayEvents = new Map(); 

// Location services
const locationCache = new Map();
const pendingRequests = new Map();
let lastApiCall = 0;

module.exports = {
    LOCATIONIQ_TOKEN,
    API_RATE_LIMIT,
    activeUsers,
    activeSessions,
    dashboardClients,
    pageViews,
    todayEvents,
    locationCache,
    pendingRequests,
    get lastApiCall() { return lastApiCall; },
    set lastApiCall(value) { lastApiCall = value; }
};
