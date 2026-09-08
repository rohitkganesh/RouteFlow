# RouteFlow Backend

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Run migrations
npm run migrate

# Start development server
npm run dev
```

## Project Structure

```
src/
├── config/         # Configuration (env, database, JWT, encryption)
├── controllers/    # Request handlers
├── middlewares/    # Express middlewares (auth, validation, errors)
├── models/         # TypeScript interfaces & validation schemas
├── routes/         # Route definitions
├── services/       # Business logic layer
├── utils/          # Utility functions & error classes
└── index.ts        # Application entry point
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled production build |
| `npm run migrate` | Run database migrations |
| `npm run migrate:rollback` | Rollback last migration |
| `npm test` | Run tests |

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user



### Orders (Seller/Admin)
- `POST /api/orders` - Create order
- `GET /api/orders` - List orders (paginated, filterable)
- `GET /api/orders/:id` - Get order details
- `PATCH /api/orders/:id/status` - Update order status

### Drivers
- `POST /api/drivers/profile` - Create driver profile
- `PATCH /api/drivers/location` - Update current location
- `PATCH /api/drivers/availability` - Update availability
- `GET /api/drivers/nearby` - Find nearby drivers (Admin/Seller)

### Routes (Admin/Driver)
- `POST /api/routes` - Create route (Admin)
- `GET /api/routes` - List driver's routes
- `GET /api/routes/:id` - Get route details

## Security Features

- **Password Hashing**: bcrypt with configurable rounds (default 12)
- **JWT Authentication**: Short-lived access tokens (15min) + refresh tokens (7d)
- **Role-Based Access Control**: Admin, Seller, Driver roles
- **AES-256-GCM Encryption**: For PII in profile_details and parcel_details
- **Helmet**: Security headers
- **CORS**: Configurable origin
- **Input Validation**: Zod schemas with express-validator

## Environment Variables

See `.env.example` for all required variables. Key ones:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Min 32 chars for access token signing |
| `JWT_REFRESH_SECRET` | Min 32 chars for refresh token signing |
| `ENCRYPTION_KEY` | Base64-encoded 32-byte key for AES-256 |
| `BCRYPT_ROUNDS` | Cost factor for password hashing |

## Database Schema

Run migrations to create tables:
- `users` - Authentication & profiles
- `orders` - Delivery orders with geolocation
- `drivers` - Driver profiles & location
- `routes` - Optimized routes with polylines

## Development

```bash
# Watch mode with tsx
npm run dev

# Type checking
npx tsc --noEmit
```