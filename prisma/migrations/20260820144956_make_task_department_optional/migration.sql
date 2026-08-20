-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_departmentId_fkey";

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "departmentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
