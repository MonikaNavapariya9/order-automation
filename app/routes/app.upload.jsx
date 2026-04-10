import prisma from "../db.server";
import { parseCSV } from "../services/csv.server";

// Test (optional)
export const loader = async () => {
  return new Response("Proxy working ✅");
};

// MAIN UPLOAD API
export const action = async ({ request }) => {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return new Response(JSON.stringify({ success: false, error: "No file uploaded" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const text = await file.text();
    const rows = parseCSV(text);

    let savedCount = 0;

    for (let row of rows) {
      await prisma.customer.create({
        data: {
          email: row.email,
          name: row.name,
          phone: row.phone,
          address: row.address,
          product: row.product,
          qty: Number(row.qty || 0),
          deposit: Number(row.deposit || 0),
          state: row.state,
          partner: row.partner
        }
      });

      savedCount++;
    }

    return new Response(JSON.stringify({
      success: true,
      savedCount
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("UPLOAD ERROR:", error);

    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};