import request from 'supertest';
import app from '../app';

describe('POST /api/auth/google', () => {
  it('returns 400 when idToken is missing', async () => {
    const res = await request(app)
      .post('/api/auth/google')
      .send({});
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for an invalid idToken', async () => {
    const res = await request(app)
      .post('/api/auth/google')
      .send({ idToken: 'invalid-token' });
    expect(res.statusCode).toBe(401);
  });
});