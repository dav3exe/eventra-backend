import express, { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import cors from 'cors'
import helmet from 'helmet'
import { connectDB, gracefulShutDown } from './config/database.js'
import { env } from './config/keys.js'
import logger, { logError } from './config/logger.js'
import createSessionMiddleware from './config/session.js'
import { globalLimiter } from './middlewares/rateLimit.middleware.js'
import emailRoutes from './routes/email.routes.js'
import authRoutes from './routes/auth.routes.js'
import ticketRoutes from './routes/ticket.routes.js'
import paymentRoutes from './routes/payment.routes.js'
import eventRoutes from './routes/event.routes.js'
import categoryRoutes from './routes/category.routes.js'
import organizerRoutes from './routes/organizer.routes.js'
import adminRoutes from './routes/admin.routes.js'
import userRoutes from './routes/user.routes.js'
import promotionRoutes from './routes/promotion.routes.js'
import cronRoutes from './routes/cron.routes.js'
import uploadRoutes from './routes/upload.routes.js'

import {
  appErrorHandler,
  createExpressLogger,
  notFoundRoutes,
  setupGlobalErrorHandlers,
} from './middlewares/error.middleware.js'

// import dns from 'dns';

// dns.setServers(['8.8.8.8', '8.8.4.4']);

declare global {
  namespace Express {
    interface Request {
      requestTime?: string
      rawBody?: Buffer
    }
  }
}

// Extend express-session SessionData interface
declare module 'express-session' {
  interface SessionData {
    userId?: string
    role?: 'attendee' | 'organizer' | 'admin'
    // Set once a guest proves ownership of an email via the OTP flow (see
    // verifyGuestTicketAccess in ticket.controller.ts) — trusted the same
    // way userId is, but only for actions scoped to tickets/orders with a
    // matching guestEmail/attendeeEmail. Never implies an actual account.
    guestEmail?: string
  }
}

const app = express()

setupGlobalErrorHandlers()

// lean path - cron doesn't need CORS, sessions or body
app.use('/api', emailRoutes)

// ---- CORS configuration ----

// Strip trailing slashes so env values like "https://example.com/"
// still match the Origin header, which browsers always send WITHOUT
// a trailing slash.
const normalizeOrigin = (url: string): string => url.replace(/\/+$/, '')

const allowedOrigins = [
  env.CLIENT_URL,
  'http://localhost:4000',
  'http://localhost:4001',
  'http://localhost:4002',
  'http://127.0.0.1:4000',
  'http://127.0.0.1:4001',
  'http://127.0.0.1:4002',
]
  .filter(Boolean)
  .map(normalizeOrigin)

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests without an Origin header (Postman, mobile apps, server-to-server)
    if (!origin) {
      return callback(null, true)
    }

    if (allowedOrigins.includes(normalizeOrigin(origin))) {
      return callback(null, true)
    }

    console.error(`❌ CORS blocked origin: ${origin}`)
    return callback(new Error(`Origin ${origin} is not allowed by CORS`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range', 'x-refresh-token', 'set-cookie'],
  optionsSuccessStatus: 200,
}

app.use(createExpressLogger()) // pino http logger middleware for request logging
// Use session middleware before defining routes
app.use(createSessionMiddleware())

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors(corsOptions))
app.use(globalLimiter) // Apply rate limiting to all requests
app.use(
  express.json({
    limit: '25mb',
    verify: (req: Request, res: Response, buf: Buffer) => {
      req.rawBody = buf
    },
  })
)
app.use(express.urlencoded({ extended: true, limit: '25mb' }))
app.disable('x-powered-by')

app.use((req: Request, res: Response, next: NextFunction) => {
  req.requestTime = new Date().toISOString()
  next()
})

app.use('/health', async (req: Request, res: Response, next: NextFunction) => {
  const dbState = mongoose.connection.readyState // 1 = connected
  let dbReachable = dbState === 1

  if (dbReachable) {
    try {
      await mongoose.connection.db?.admin().ping()
    } catch {
      dbReachable = false
    }
  }

  res.status(dbReachable ? 200 : 503).json({
    status: dbReachable ? 'success' : 'error',
    message: dbReachable ? 'Server is running' : 'Database is unreachable',
    environment: env.NODE_ENV,
    timestamp: req.requestTime,
    uptime: process.uptime(),
    database: dbReachable ? 'connected' : 'disconnected',
  })
})

app.use('/api/v1/auth', authRoutes)
app.use('/api/v1/tickets', ticketRoutes)
app.use('/api/v1/payments', paymentRoutes)
app.use('/api/v1/events', eventRoutes)
app.use('/api/v1/categories', categoryRoutes)
app.use('/api/v1/organizers', organizerRoutes)
app.use('/api/v1/admin', adminRoutes)
app.use('/api/v1/users', userRoutes)
app.use('/api/v1/promotions', promotionRoutes)
app.use('/api', cronRoutes)
app.use('/api/v1/uploads', uploadRoutes)

// Handle 404
app.use(notFoundRoutes)
// Global error handler
app.use(appErrorHandler)

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000

const startServer = async (): Promise<void> => {
  let server: any
  try {
    await connectDB()
    server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running in ${env.NODE_ENV} mode on port ${PORT}`)
      logger.info(`http://localhost:${PORT}`)
    })

    process.on('unhandledRejection', (reason: unknown) => {
      console.error(`UNHANDLED REJECTION! Shutting down...`)
      const error = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
      logger.error({ reason: error }, 'Unhandled rejection')

      server.close(() => {
        logger.info(`Process terminated due to unhandled rejection`)
        logger.info('Server shutdown complete')
      })
    })

    process.on('SIGTERM', gracefulShutDown)
    process.on('SIGINT', gracefulShutDown)

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.syscall !== 'listen') throw error

      switch (error.code) {
        case 'EACCES':
          logger.error(`Port ${PORT} requires elevated privileges`)
          process.exit(1)
        case 'EADDRINUSE':
          logger.error(`Port ${PORT} is already in use`)
          process.exit(1)
        default:
          throw error
      }
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logError(`Failed to start server: ${errorMessage}`)
    process.exit(1)
  }
}

if (!process.env.VERCEL) {
  startServer()
} else {
  connectDB().catch(err => {
    console.error('Serverless DB connection failed:', err)
  })
}

export default app