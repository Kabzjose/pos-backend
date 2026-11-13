# 08 – Security (living document)

## Authentication
- Passwords hashed with argon2id; plain passwords are never stored or logged.
- JWT access token, signed with JWT_SECRET (min 32 chars), expires after JWT_EXPIRES_IN_SECONDS.
- Token payload contains only user id and email, no roles or shop id.
- All routes require a valid token by default; public routes are marked @Public().
- Login errors are generic to prevent email enumeration.

## Known gaps (to address later)
- No rate limiting or lockout on login (brute force risk)
- No refresh tokens / token revocation
- No email verification or password reset