import request from "supertest";
import app from "../app";

describe("POST /api/auth/google", () => {
  /*
   * A missing token is answered the same way a forged one is.
   *
   * This used to be 400, from a presence check that ran ahead of
   * verification. The check decided nothing verifyIdToken does not already
   * decide, and it made a condition on attacker-supplied input the thing
   * standing in front of account creation. Removing it means an absent
   * credential and a bad credential are now indistinguishable from outside,
   * which is the answer an authentication endpoint should be giving anyway.
   */
  it("returns 401 when idToken is missing, as for any credential that fails", async () => {
    const res = await request(app).post("/api/auth/google").send({});
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid idToken", async () => {
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "invalid-token" });
    expect(res.statusCode).toBe(401);
  });

  it("logs the underlying verification error instead of swallowing it", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/api/auth/google")
      .send({ idToken: "invalid-token" });

    expect(errorSpy).toHaveBeenCalled();
    const loggedMessage = errorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(loggedMessage).toMatch(/google/i);
    expect(loggedMessage.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });
});
