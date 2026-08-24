import request from "supertest";
import app from "../app";

describe("DELETE /api/users/delete-account", () => {
  it("returns 401 when no authorization header is provided", async () => {
    const res = await request(app).delete("/api/users/delete-account").send({});
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid/unverifiable token", async () => {
    const res = await request(app)
      .delete("/api/users/delete-account")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.statusCode).toBe(401);
  });
});
