import request from 'supertest';
import app from '../app';

describe('DELETE /api/users/delete-account', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .delete('/api/users/delete-account')
      .send({});
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a non-existent user', async () => {
    const res = await request(app)
      .delete('/api/users/delete-account')
      .send({ email: 'doesnotexist@test.com' });
    expect(res.statusCode).toBe(404);
  });
});