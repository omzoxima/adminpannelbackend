require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
const db = require('./config/db');
const adminRoutes = require('./routes/admin');
const seriesRoutes = require('./routes/series');
const categoryRoutes = require('./routes/category');
const episodeRoutes = require('./routes/episode');
const userRoutes = require('./routes/user');
const bodyParser = require('body-parser');
const { sequelize } = require('./models/index.js');
const { authenticateToken } = require('./utils/jwt');
const { 
  securityHeadersMiddleware, 
  rateLimitMiddleware, 
  deviceValidationMiddleware 
} = require('./utils/security');

// Security middleware
app.use(helmet());
app.use(securityHeadersMiddleware);
app.use(rateLimitMiddleware);

// CORS configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID', 'X-Platform']
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// JWT middleware for all /api routes except /api/admin/login
app.use((req, res, next) => {
  if (req.path === '/api/admin/login') {
    return next();
  }
  // Only protect /api/* routes
  if (req.path.startsWith('/api/')) {
    return authenticateToken(req, res, next);
  }
  next();
});

// Mount admin routes
app.use('/api/admin', adminRoutes);
app.use('/api/series', seriesRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/episodes', episodeRoutes);
app.use('/api/users', userRoutes);

// Health check
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 5000;
sequelize.sync()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Database synced successfully');
    });
  })
  .catch(err => {
    console.error('Unable to sync database:', err);
  });