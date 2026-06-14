import express, { Application } from 'express';
import healthRouter from './app/api/health';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 requests per window
  message: { error: 'Too many requests, please try again later.' }
});

const app: Application = express();

app.use('/api/auth', authLimiter);
app.use('/api/users/delete-account', authLimiter);
app.use(express.json());
app.use(healthRouter);
app.use(helmet());

export default app;