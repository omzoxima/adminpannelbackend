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
- `middlewares/` - Express middlewares (JWT, etc)
- `services/` - External services (GCS, etc)
- `utils/` - Helper functions (JWT, etc)
- `config/` - DB config

## Auth
- JWT-based authentication
- Example login: `POST /api/admin/login`
- Example protected: `GET /api/admin/profile` (requires Bearer token) 