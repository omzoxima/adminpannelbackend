import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import adminRoutes from './routes/admin.js';
import seriesRoutes from './routes/series.js';
import categoryRoutes from './routes/category.js';
import episodeRoutes from './routes/episode.js';
import userRoutes from './routes/user.js';

import { sequelize } from './models/index.js';
import { authenticateToken } from './utils/jwt.js';

const app = express();

app.use(cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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