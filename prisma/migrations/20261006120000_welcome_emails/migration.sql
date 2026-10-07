-- Welcome emails: accounts created with an emailed temporary password must pick their own on first sign-in.
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "tempPasswordExpiresAt" TIMESTAMP(3);
