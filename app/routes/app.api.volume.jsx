import prisma from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * CREATE CUSTOMER + DRAFT ORDER
 */
async function createOrderFlow({ shop, name, email, phone, address, productVariantId, quantity }) {
  try {
    const { admin } = await authenticate.admin(shop);

    // 1. CREATE CUSTOMER
    const customerRes = await admin.graphql(`
      mutation {
        customerCreate(input: {
          firstName: "${name}",
          email: "${email}",
          phone: "${phone}",
          addresses: [{
            address1: "${address}"
          }]
        }) {
          customer {
            id
          }
        }
      }
    `);

    const customerData = await customerRes.json();
    const customerId = customerData?.data?.customerCreate?.customer?.id;

    // 2. CREATE DRAFT ORDER
    const draftRes = await admin.graphql(`
      mutation {
        draftOrderCreate(input: {
          customerId: "${customerId}",
          lineItems: [{
            variantId: "gid://shopify/ProductVariant/${productVariantId}",
            quantity: ${quantity}
          }],
          useCustomerDefaultAddress: true
        }) {
          draftOrder {
            id
            invoiceUrl
          }
        }
      }
    `);

    const draftData = await draftRes.json();
    const draftOrder = draftData?.data?.draftOrderCreate?.draftOrder;

    return {
      success: true,
      checkoutUrl: draftOrder?.invoiceUrl
    };

  } catch (error) {
    console.error("ERROR:", error);
    return { success: false, error: error.message };
  }
}

/**
 * LOADER (GET API)
 */
export const loader = async ({ request }) => {
  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders()
    });
  }

  try {
    await authenticate.public.appProxy(request);
  } catch (err) {
    return new Response(JSON.stringify({ error: "Auth failed" }), {
      status: 401,
      headers: corsHeaders()
    });
  }

  return new Response(JSON.stringify({ message: "API working" }), {
    headers: corsHeaders()
  });
};

/**
 * ACTION (POST API)
 */
export const action = async ({ request }) => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders()
    });
  }

  try {
    await authenticate.public.appProxy(request);
  } catch (err) {
    return new Response(JSON.stringify({ error: "Auth failed" }), {
      status: 401,
      headers: corsHeaders()
    });
  }

  try {
    const formData = await request.formData();

    const name = formData.get("name");
    const email = formData.get("email");
    const phone = formData.get("phone");
    const address = formData.get("address");
    const productVariantId = formData.get("variantId");
    const quantity = parseInt(formData.get("qty") || 1);

    const shop = new URL(request.url).searchParams.get("shop");

    // ✅ SAVE IN MYSQL (PRISMA)
    const saved = await prisma.customer.create({
      data: {
        name,
        email,
        phone,
        address,
        product: productVariantId,
        qty: quantity
      }
    });

    // ✅ CREATE ORDER FLOW
    const result = await createOrderFlow({
      shop,
      name,
      email,
      phone,
      address,
      productVariantId,
      quantity
    });

    return new Response(JSON.stringify({
      success: true,
      db: saved,
      checkoutUrl: result.checkoutUrl
    }), {
      headers: corsHeaders()
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders()
    });
  }
};

/**
 * CORS HEADERS
 */
function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}