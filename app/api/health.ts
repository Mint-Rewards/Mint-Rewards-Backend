// routes/health.ts
import { Router, Request, Response } from "express";

const router = Router();

router.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
