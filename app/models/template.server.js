import { db } from "./db.server";

export async function getTemplateByState(state) {
  const [rows] = await db.execute(
    `SELECT * FROM email_templates WHERE state=? OR is_default=1 LIMIT 1`,
    [state]
  );
  return rows[0];
}