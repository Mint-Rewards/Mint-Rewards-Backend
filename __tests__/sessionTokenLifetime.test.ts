/**
 * The app holds one token and has no refresh mechanism, so this value is the
 * entire session lifetime — when it lapses, the client deletes the stored
 * token and drops the user on the login screen. Every issuer must agree on it;
 * the login route previously kept its own default and could have drifted.
 */

import jwt from 'jsonwebtoken';

const ISSUER_ROUTES = [
  '../app/api/users/login/route',
  '../app/api/users/signup/route',
  '../app/api/auth/google/route',
  '../app/api/auth/apple/route',
  '../app/api/users/verify-email-otp/route',
];

describe('session token lifetime', () => {
  it('defaults to 30 days when JWT_EXPIRES_IN is unset', () => {
    const original = process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_EXPIRES_IN;
    jest.resetModules();

    const { serverEnv } = require('../lib/env');
    expect(serverEnv.jwtExpiresIn).toBe('30d');

    if (original === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = original;
    jest.resetModules();
  });

  it('signs a token whose lifetime really is 30 days', () => {
    // Deliberately independent of whatever JWT_EXPIRES_IN this machine sets,
    // so the assertion is about the default rather than local config.
    const original = process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_EXPIRES_IN;
    jest.resetModules();

    const { serverEnv } = require('../lib/env');
    const token = jwt.sign({ id: 'user' }, 'test-secret', {
      expiresIn: serverEnv.jwtExpiresIn,
    });

    if (original === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = original;
    jest.resetModules();

    const decoded = jwt.decode(token) as { iat: number; exp: number };
    const lifetimeDays = (decoded.exp - decoded.iat) / 86400;

    expect(lifetimeDays).toBeGreaterThanOrEqual(30);
  });

  it('leaves no issuer with its own hardcoded fallback', () => {
    const fs = require('fs');
    const path = require('path');

    for (const route of ISSUER_ROUTES) {
      const file = path.join(__dirname, `${route}.ts`);
      const source = fs.readFileSync(file, 'utf8');

      expect(source).not.toMatch(/JWT_EXPIRES_IN\s*=\s*process\.env\.JWT_EXPIRES_IN/);
    }
  });
});
