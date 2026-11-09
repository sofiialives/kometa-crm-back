-- Персональный профиль мотивации: условия одного человека.
ALTER TABLE "MotivationProfile" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "MotivationProfile_userId_key" ON "MotivationProfile"("userId");
ALTER TABLE "MotivationProfile" ADD CONSTRAINT "MotivationProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
