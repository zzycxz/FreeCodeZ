// E-S3 冻结迁移（0004_automation_sandbox）：automations 表新增 sandbox_enabled 列。
// 不能改 AUTOMATION_SCHEMA 常量——0001 的 checksum 已冻结该文本，改动会让存量库
// checksum mismatch 拒启。列添加需幂等（PRAGMA 检查），兼容 0001-0003 各代库。
export const AUTOMATION_SANDBOX_MIGRATION_SQL = `
ALTER TABLE automations ADD COLUMN sandbox_enabled INTEGER NOT NULL DEFAULT 0;
`;
