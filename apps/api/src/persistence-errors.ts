import { Prisma } from './generated/prisma/client';

/** A unique constraint refused the write (Prisma P2002), for example a concurrent insert of the same name. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
