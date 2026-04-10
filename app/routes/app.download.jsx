import { db } from "../models/db.server";

export async function loader() {
  const [rows] = await db.execute("SELECT * FROM customers");

  let csv = "email,name,phone,address,product,qty\n";

  rows.forEach(r => {
    csv += `${r.email},${r.name},${r.phone},${r.address},${r.product},${r.qty}\n`;
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=data.csv"
    }
  });
}