import express, { Application, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import healthRouter from './app/api/health';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { POST as googleAuthHandler } from './app/api/auth/google/route';
import { DELETE as deleteAccountHandler } from './app/api/users/delete-account/route';

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

// Adapts a Next.js App Router handler (Web Fetch Request/Response) so it can
// be mounted on the Express app used for the test suite.
function adaptWebHandler(handler: (req: any) => Promise<Response>) {
  return async (req: ExpressRequest, res: ExpressResponse) => {
    const webRequest = new Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });

    const webResponse = await handler(webRequest);
    const data = await webResponse.json();
    res.status(webResponse.status).json(data);
  };
}

app.post('/api/auth/google', adaptWebHandler(googleAuthHandler));
app.delete('/api/users/delete-account', adaptWebHandler(deleteAccountHandler));

export default app;
