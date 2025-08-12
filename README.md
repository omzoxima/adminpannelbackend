# Admin Portal Backend

Node.js + Express + PostgreSQL + JWT backend for admin portal.

## Setup

1. Copy `.env.example` to `.env` and fill in your values.
2. Install dependencies:
   ```
   npm install
   # or
   yarn install
   ```
3. Run migrations and start the server:
   ```
   npm run dev
   # or
   yarn dev
   ```

## Structure
- `routes/` - Express route definitions
- `controllers/` - Route logic
- `models/` - Sequelize models
- `middlewares` - Express middlewares (JWT, etc)
- `services/` - External services (GCS, etc)
- `utils/` - Helper functions (JWT, etc)
- `config/` - DB config

## Series Management
- **Create Series**: `POST /api/series/create` - Upload thumbnail and optional carousel image
- **Update Series**: `PUT /api/series/update` - Update series details including images
- **Get All Series**: `GET /api/series` - Retrieve all series with signed URLs
- **Get Series by ID**: `GET /api/series/:id` - Get specific series details
- **Update Status**: `POST /api/series/update-status` - Update series status

### File Uploads
- **Thumbnail**: Required image file (JPEG, PNG, GIF, WebP)
- **Carousel Image**: Optional image file (JPEG, PNG, GIF, WebP)
- Files are stored in Google Cloud Storage with signed URLs for access

## Auth
- JWT-based authentication
- Example login: `POST /api/admin/login`
- Example protected: `GET /api/admin/profile` (requires Bearer token) 