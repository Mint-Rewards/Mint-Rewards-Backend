import {
  decodeUnverifiedClaims,
  diagnoseFailure,
  logGoogleVerificationFailure,
} from '../lib/googleAuthDiagnostics';
import { Log } from '../lib/models';

const IOS_CLIENT_ID = '78392867949-ios.apps.googleusercontent.com';
const WEB_CLIENT_ID = '78392867949-web.apps.googleusercontent.com';

/** Build an unsigned token whose payload segment carries the given claims. */
const tokenWithClaims = (claims: Record<string, unknown>): string =>
  ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('decodeUnverifiedClaims', () => {
  it('reads claims out of a well-formed token', () => {
    const token = tokenWithClaims({ aud: WEB_CLIENT_ID, email: 'user@example.com', exp: 42 });

    expect(decodeUnverifiedClaims(token)).toMatchObject({
      aud: WEB_CLIENT_ID,
      email: 'user@example.com',
      exp: 42,
    });
  });

  it('returns null for a token that is not a JWT', () => {
    expect(decodeUnverifiedClaims('invalid-token')).toBeNull();
  });

  it('returns null when the payload segment is not JSON', () => {
    expect(decodeUnverifiedClaims('header.bm90LWpzb24.sig')).toBeNull();
  });
});

describe('diagnoseFailure', () => {
  const now = 1_800_000_000;
  const expected = [IOS_CLIENT_ID, WEB_CLIENT_ID];

  it('flags a token minted for a different OAuth client', () => {
    const claims = { aud: '490896222696-old.apps.googleusercontent.com', exp: now + 3600 };

    expect(diagnoseFailure(claims, expected, now)).toBe('AUDIENCE_MISMATCH');
  });

  it('flags a correctly-addressed token that is past its expiry', () => {
    const claims = { aud: WEB_CLIENT_ID, iat: now - 7200, exp: now - 3600 };

    expect(diagnoseFailure(claims, expected, now)).toBe('EXPIRED');
  });

  it('reports MALFORMED when no claims could be read', () => {
    expect(diagnoseFailure(null, expected, now)).toBe('MALFORMED');
  });

  it('reports UNKNOWN when the token looks valid but was still rejected', () => {
    const claims = { aud: IOS_CLIENT_ID, exp: now + 3600 };

    expect(diagnoseFailure(claims, expected, now)).toBe('UNKNOWN');
  });
});

describe('logGoogleVerificationFailure', () => {
  afterEach(async () => {
    await Log.deleteMany({ event: 'GOOGLE_AUTH_VERIFY_FAILED' });
    jest.restoreAllMocks();
  });

  it('persists the diagnosis, staleness and audience of an expired token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = tokenWithClaims({
      aud: WEB_CLIENT_ID,
      iss: 'https://accounts.google.com',
      email: 'user@example.com',
      iat: nowSeconds - 7200,
      exp: nowSeconds - 3600,
    });

    await logGoogleVerificationFailure({
      idToken: token,
      reason: 'Token used too late',
      iosClientId: IOS_CLIENT_ID,
      webClientId: WEB_CLIENT_ID,
    });

    const entry = await Log.findOne({ event: 'GOOGLE_AUTH_VERIFY_FAILED' }).lean();

    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({
      level: 'error',
      userEmail: 'user@example.com',
      platform: 'android',
    });
    const extra = (entry as unknown as { extra: Record<string, unknown> }).extra;
    expect(extra.diagnosis).toBe('EXPIRED');
    expect(extra.reason).toBe('Token used too late');
    expect(extra.audience).toBe(WEB_CLIENT_ID);
    expect(extra.tokenAgeSeconds).toBeGreaterThanOrEqual(7200);
    expect(extra.expiredForSeconds).toBeGreaterThanOrEqual(3600);
  });

  it('still records a failure when the token cannot be decoded', async () => {
    await logGoogleVerificationFailure({
      idToken: 'invalid-token',
      reason: 'Wrong number of segments in token',
      iosClientId: IOS_CLIENT_ID,
      webClientId: WEB_CLIENT_ID,
    });

    const entry = await Log.findOne({ event: 'GOOGLE_AUTH_VERIFY_FAILED' }).lean();
    const extra = (entry as unknown as { extra: Record<string, unknown> }).extra;

    expect(extra.diagnosis).toBe('MALFORMED');
    expect(extra.audience).toBeNull();
  });

  it('never throws when the log write fails', async () => {
    jest.spyOn(Log, 'create').mockRejectedValue(new Error('mongo down') as never);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logGoogleVerificationFailure({
        idToken: 'invalid-token',
        reason: 'Wrong number of segments in token',
        iosClientId: IOS_CLIENT_ID,
        webClientId: WEB_CLIENT_ID,
      }),
    ).resolves.toBeUndefined();
  });
});
