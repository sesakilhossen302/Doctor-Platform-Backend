-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('DEMO', 'BKASH');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CallMedia" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "ConsultationStatus" AS ENUM ('RINGING', 'ONGOING', 'ENDED', 'REJECTED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CallRequestStatus" AS ENUM ('PAYMENT_PENDING', 'QUEUED', 'CONNECTED', 'TRANSFERRED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "appointmentId" UUID,
    "callRequestId" UUID,
    "provider" "PaymentProvider" NOT NULL,
    "amount" INTEGER NOT NULL,
    "serviceFee" INTEGER NOT NULL,
    "platformFee" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "providerPaymentId" TEXT,
    "trxId" TEXT,
    "failureReason" TEXT,
    "raw" JSONB,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" UUID NOT NULL,
    "appointmentId" UUID,
    "callRequestId" UUID,
    "patientUserId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "media" "CallMedia" NOT NULL,
    "channelName" TEXT NOT NULL,
    "status" "ConsultationStatus" NOT NULL DEFAULT 'RINGING',
    "ringingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_requests" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "patientUserId" UUID NOT NULL,
    "status" "CallRequestStatus" NOT NULL DEFAULT 'PAYMENT_PENDING',
    "media" "CallMedia" NOT NULL DEFAULT 'AUDIO',
    "reason" TEXT,
    "specialtyId" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "agentId" UUID,
    "notes" TEXT,
    "channelName" TEXT NOT NULL,
    "serviceFee" INTEGER NOT NULL,
    "platformFee" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "transferredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_code_key" ON "payments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payments_trxId_key" ON "payments"("trxId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payments_appointmentId_idx" ON "payments"("appointmentId");

-- CreateIndex
CREATE INDEX "payments_callRequestId_idx" ON "payments"("callRequestId");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "consultations_doctorId_status_idx" ON "consultations"("doctorId", "status");

-- CreateIndex
CREATE INDEX "consultations_patientUserId_createdAt_idx" ON "consultations"("patientUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "consultations_appointmentId_idx" ON "consultations"("appointmentId");

-- CreateIndex
CREATE INDEX "consultations_callRequestId_idx" ON "consultations"("callRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "call_requests_code_key" ON "call_requests"("code");

-- CreateIndex
CREATE UNIQUE INDEX "call_requests_channelName_key" ON "call_requests"("channelName");

-- CreateIndex
CREATE INDEX "call_requests_status_priority_queuedAt_idx" ON "call_requests"("status", "priority" DESC, "queuedAt");

-- CreateIndex
CREATE INDEX "call_requests_patientUserId_createdAt_idx" ON "call_requests"("patientUserId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_callRequestId_fkey" FOREIGN KEY ("callRequestId") REFERENCES "call_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_patientUserId_fkey" FOREIGN KEY ("patientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_callRequestId_fkey" FOREIGN KEY ("callRequestId") REFERENCES "call_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_patientUserId_fkey" FOREIGN KEY ("patientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_requests" ADD CONSTRAINT "call_requests_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
