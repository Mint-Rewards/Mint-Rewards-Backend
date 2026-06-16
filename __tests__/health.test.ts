/// <reference types="jest" />

import request from "supertest";
import app from "../app";

describe("Health Check", () => {
  it("GET /api/health returns 200", async () => {
    const res = await request(app).get("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
