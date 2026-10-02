import { describe, expect, it } from 'vitest';
import { identityFieldError, validateIdentity } from './identity-logic';

describe('validateIdentity', () => {
  it("name not empty and e-mail with an arobase", () => {
    expect(validateIdentity('Ada', 'ada@x.io')).toEqual({ ok: true, name: null, email: null });
    expect(validateIdentity(' ', 'ada@x.io')).toEqual({ ok: false, name: 'name', email: null });
    expect(validateIdentity('Ada', 'ada')).toEqual({ ok: false, name: null, email: 'email' });
    expect(validateIdentity('Ada', 'ada@')).toMatchObject({ ok: false, email: 'email' });
    expect(validateIdentity('', '')).toMatchObject({ ok: false, name: 'name', email: 'email' });
  });
});

describe('identityFieldError', () => {
  it("INVALID_ARGUMENT { field } covers a field", () => {
    expect(identityFieldError({ code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'email' } })).toBe('email');
    expect(identityFieldError({ code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'name' } })).toBe('name');
    expect(identityFieldError({ code: 'INVALID_ARGUMENT', message: 'x', details: { field: 'scope' } })).toBeNull();
    expect(identityFieldError({ code: 'GIT_FAILED', message: 'x' })).toBeNull();
  });
});
