import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;

  const prisma = {
    user: { findUnique: vi.fn(), create: vi.fn() },
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed-token') };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('stores a hash, never the plain password (FR-AUTH-3)', async () => {
      (prisma.user.create as Mock).mockResolvedValue({ id: 'u1' });

      await service.register({
        email: 'a@b.com',
        password: 'supersecret1',
        fullName: 'A B',
      });

      const data = (prisma.user.create as Mock).mock.calls[0][0].data;
      expect(data.passwordHash).not.toBe('supersecret1');
      expect(data.passwordHash.startsWith('$argon2')).toBe(true);
    });

    it('throws Conflict when the email already exists', async () => {
      (prisma.user.create as Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.register({ email: 'a@b.com', password: 'supersecret1', fullName: 'A' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('returns a token for valid credentials (FR-AUTH-2)', async () => {
      const passwordHash = await argon2.hash('supersecret1');
      (prisma.user.findUnique as Mock).mockResolvedValue({ id: 'u1', email: 'a@b.com', passwordHash });

      const result = await service.login({ email: 'a@b.com', password: 'supersecret1' });

      expect(result.accessToken).toBe('signed-token');
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1', email: 'a@b.com' });
    });

    it('rejects a wrong password', async () => {
      const passwordHash = await argon2.hash('supersecret1');
      (prisma.user.findUnique as Mock).mockResolvedValue({ id: 'u1', email: 'a@b.com', passwordHash });

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an unknown email', async () => {
      (prisma.user.findUnique as Mock).mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@b.com', password: 'whatever123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
