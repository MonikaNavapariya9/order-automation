import { db } from "../models/db.server";
import { sendEmail } from "../services/email.server";
import { authenticate } from "../shopify.server"; // ✅ FIX

export async function action({ request }) {
  const { id } = await request.json();

  const [rows] = await db.execute("SELECT * FROM customers WHERE id=?", [id]);
  const user = rows[0];

  // ✅ Get admin client
  const { admin } = await authenticate.admin(request);

  // 1️⃣ Create Customer
  const customerRes = await admin.graphql(`
    mutation {
      customerCreate(input:{
        email:"${user.email}",
        firstName:"${user.name}"
      }) {
        customer { id }
      }
    }
  `);

  const customerId = customerRes.data.customerCreate.customer.id;

  // 2️⃣ Draft Order
  const draftRes = await admin.graphql(`
    mutation {
      draftOrderCreate(input:{
        customerId:"${customerId}",
        email: "${user.email}",
      tags: ["send-email"],
      lineItems:[{
        title:"${user.product}",
        quantity:${user.qty},
        originalUnitPrice:${user.deposit}
      }]
      }) {
        draftOrder { invoiceUrl }
      }
    }
  `);

  const checkoutUrl = draftRes.data.draftOrderCreate.draftOrder.invoiceUrl;

  // 3️⃣ Send Email
  await sendEmail(user.email, {
    subject: "Complete your order",
    body: `Click here: ${checkoutUrl}`
  });

  return new Response("Done");
}