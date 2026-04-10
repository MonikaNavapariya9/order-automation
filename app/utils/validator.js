export function validateRow(row) {
  if (!row.email || !row.product) return false;
  return true;
}