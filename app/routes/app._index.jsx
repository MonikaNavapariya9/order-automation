import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";

const DEFAULT_DATA_URL =
  "https://dashcharger.webrootinfosoft.com/get-data.php";

/** ---------------- NORMALIZE ---------------- */
function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.data && Array.isArray(payload.data)) return payload.data;
  if (payload?.rows && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

/** ---------------- SAFE PHONE (FIXED E.164) ---------------- */
function normalizePhone(raw) {
  if (!raw) return null;

  let digits = String(raw).replace(/\D/g, "");

  if (digits.length < 10) return null;
  if (digits.length > 15) return null;

  digits = digits.replace(/^0+/, "");

  const countryCode = "91";

  if (digits.length === 10) {
    return `+${countryCode}${digits}`;
  }

  return `+${digits}`;
}

/** ---------------- FIND VARIANT ID (FIXED CORE ISSUE) ---------------- */
async function findVariantId(admin, productName, variantName) {
  if (!productName || !variantName) return null;

  try {
    const res = await admin.graphql(
      `#graphql
      query ($q: String!) {
        products(first: 1, query: $q) {
          edges {
            node {
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                  }
                }
              }
            }
          }
        }
      }`,
      {
        variables: {
          q: productName,
        },
      },
    );

    const json = await res.json();

    const variants =
      json?.data?.products?.edges?.[0]?.node?.variants?.edges || [];

    const match = variants.find(
      (v) => v.node.title === variantName,
    );

    return match?.node?.id || null;
  } catch (e) {
    return null;
  }
}

/** ---------------- LOAD SHOPIFY DRAFTS ---------------- */
async function fetchDraftOrders(admin) {
  const res = await admin.graphql(
    `#graphql
    query {
      draftOrders(first: 100, reverse: true) {
        edges {
          node {
            id
            name
            invoiceUrl
            status
            customer {
              email
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }`,
  );

  const json = await res.json();

  return (
    json?.data?.draftOrders?.edges?.map((e) => {
      const d = e.node;

      return {
        id: d.id,
        email: d.customer?.email?.toLowerCase() || "",
        invoiceUrl: d.invoiceUrl,
        status: d.status,
        lines: d.lineItems.edges.map((l) => l.node),
      };
    }) || []
  );
}

/** ---------------- LOAD ---------------- */
export const loader = async ({ request }) => {
  try {
    const res = await fetch(DEFAULT_DATA_URL);
    const json = await res.json();

    const rows = normalizeRows(json);

    const { admin } = await authenticate.admin(request);
    const drafts = await fetchDraftOrders(admin);

    const merged = rows.map((row) => {
      const email = row["Email Address"]?.toLowerCase();
      const product = row["Product Name"];
      const variant = row["Variant Name"];
      const qty = Number(row["Qty"] || 1);

      const match = drafts.find((d) => {
        return (
          d.email === email &&
          d.lines?.some(
            (l) =>
              l.title === product && Number(l.quantity) === qty,
          )
        );
      });

      if (match) {
        return {
          ...row,
          status: "approved",
          invoiceUrl: match.invoiceUrl,
          draftOrderId: match.id,
        };
      }

      return row;
    });

    return { data: merged, loadError: null };
  } catch (e) {
    return { data: [], loadError: "Failed to load data" };
  }
};

/** ---------------- ACTION ---------------- */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json();

  const email = body["Email Address"]?.trim();
  const phone = body["Phone Number"];
  const firstName = body["First name"] || "";
  const lastName = body["Last name"] || "";
  const product = body["Product Name"];
  const variant = body["Variant Name"];
  const qty = Number(body["Qty"] || 1);

  if (!email) {
    return { success: false, message: "Email required" };
  }

  const phoneE164 = normalizePhone(phone);

  /** ---------------- FIND CUSTOMER ---------------- */
  const customerRes = await admin.graphql(
    `#graphql
    query ($q: String!) {
      customers(first: 1, query: $q) {
        edges { node { id } }
      }
    }`,
    { variables: { q: `email:${email}` } },
  );

  const customerJson = await customerRes.json();

  let customerId =
    customerJson.data?.customers?.edges?.[0]?.node?.id || null;

  /** ---------------- CREATE CUSTOMER ---------------- */
  if (!customerId) {
    const input = {
      email,
      firstName,
      lastName,
      tags: ["dashboard_customer", "auto_created"],
    };

    if (phoneE164) input.phone = phoneE164;

    const createRes = await admin.graphql(
      `#graphql
      mutation ($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { message }
        }
      }`,
      { variables: { input } },
    );

    const createJson = await createRes.json();

    if (createJson.data?.customerCreate?.userErrors?.length) {
      return {
        success: false,
        message: createJson.data.customerCreate.userErrors[0].message,
      };
    }

    customerId = createJson.data.customerCreate.customer.id;
  }

  
/** ---------------- GET VARIANT ID ---------------- */
const variantId = await findVariantId(admin, product, variant);

/** ❌ STOP if variant not found (IMPORTANT) */
if (!variantId) {
  return {
    success: false,
    message: `Variant not found → ${variant}`,
  };
}

/** ---------------- CREATE DRAFT ORDER ---------------- */
const draftRes = await admin.graphql(
  `#graphql
  mutation ($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }`,
  {
    variables: {
      input: {
        customerId,
        tags: ["draft_order"],

        lineItems: [
          {
            variantId: variantId, // ✅ REAL VARIANT ATTACHED
            quantity: qty,
          },
        ],
      },
    },
  }
);



  const draftJson = await draftRes.json();

  if (draftJson.data?.draftOrderCreate?.userErrors?.length) {
    return {
      success: false,
      message: draftJson.data.draftOrderCreate.userErrors[0].message,
    };
  }

  const draft = draftJson.data?.draftOrderCreate?.draftOrder;

  return {
    success: true,
    invoiceUrl: draft?.invoiceUrl,
    draftOrderName: draft?.name,
  };
};

/** ---------------- UI (UNCHANGED) ---------------- */
export default function CustomerTable() {
  const { data, loadError } = useLoaderData();
  const fetcher = useFetcher();

  const [tableData, setTableData] = useState(data);
  const [preview, setPreview] = useState(null);
  const [activeIndex, setActiveIndex] = useState(null);

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success) {
      setTableData((prev) =>
        prev.map((row, i) => {
          if (i !== activeIndex) return row;

          return {
            ...row,
            status: "approved",
            invoiceUrl: fetcher.data.invoiceUrl,
            draftOrderName: fetcher.data.draftOrderName,
          };
        }),
      );
    } else if (fetcher.data.success === false) {
      alert(fetcher.data.message);
    }
  }, [fetcher.data]);

  const handleApprove = (item, index) => {
    setActiveIndex(index);

    fetcher.submit(JSON.stringify(item), {
      method: "POST",
      encType: "application/json",
    });
  };

  return (
    <div style={{ padding: 20, fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif", }}>
      <h2>Customer Orders</h2>

      {loadError && <p style={{ color: "red" }}>{loadError}</p>}
<div
        style={{
          overflow: "auto",
          maxHeight: "75vh",
          borderBottom: "1px solid #000",
          borderRadius: 0,
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        }}
      >
        <table
  style={{
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: 0,
    fontSize: 14,
  }}
>
  <thead>
    <tr style={{ textAlign: "left" }}>
      {[
        "Id",
        "Participating Party Name",
        "Participating Party Address",
        "First name",
        "Last name",
        "Email Address",
        "Phone Number",
        "Street Address",
        "City",
        "Province",
        "Postal Code",
        "Country",
        "Product Name",
        "Variant Name",
        "Qty",
        "Status",
        "Checkout",
        "Action",
        "View",
      ].map((h, i) => (
        <th
          key={i}
          style={{
            padding: "12px 14px",
            background: "#f6f6f7",
            color: "#202223",
            fontWeight: 600,
            borderBottom: "1px solid #e1e3e5",
            whiteSpace: "nowrap",
          }}
        >
          {h}
        </th>
      ))}
    </tr>
  </thead>

  <tbody>
    {tableData.map((item, i) => {
      const done = item.status === "approved" || item.invoiceUrl;

      return (
        <tr
          key={i}
          style={{
            background: "#fff",
          }}
        >
          {Object.keys(item).slice(0, 15).map((k) => (
           <td
           key={k}
           style={{
             padding: "12px 14px",
             borderBottom: "1px solid #f1f1f1",
             color: "#202223",
             maxWidth: 180,
             overflow: "hidden",
             textOverflow: "ellipsis",
             whiteSpace: "nowrap",
           }}
         >
           {item[k]}
         </td>
          ))}

          {/* STATUS */}
          <td style={{ padding: "12px 14px", borderBottom: "1px solid #f1f1f1" }}>
            <span
              style={{
                display: "inline-block",
                padding: "4px 10px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 600,
                background: done ? "#fde68a" : "#e5e7eb",
                color: "#202223",
              }}
            >
              {done ? "Open" : "Pending"}
            </span>
          </td>

          {/* CHECKOUT */}
          <td style={{ padding: "12px 14px", borderBottom: "1px solid #f1f1f1" }}>
            {item.invoiceUrl ? (
              <a
                href={item.invoiceUrl}
                target="_blank"
                style={{
                  color: "#2c6ecb",
                  textDecoration: "none",
                  fontWeight: 500,
                }}
              >
                Open
              </a>
            ) : (
              "-"
            )}
          </td>

          {/* ACTION */}
          <td style={{ padding: "12px 14px", borderBottom: "1px solid #f1f1f1" }}>
            <button
              onClick={() => handleApprove(item, i)}
              disabled={done}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #c9cccf",
                background: done ? "#f6f6f7" : "#202223",
                color: done ? "#8c9196" : "#fff",
                cursor: done ? "not-allowed" : "pointer",
              }}
            >
              {done ? "Approved" : "Approve"}
            </button>
          </td>

          {/* VIEW */}
          <td style={{ padding: "12px 14px", borderBottom: "1px solid #f1f1f1" }}>
            <button
              onClick={() => setPreview(item)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #c9cccf",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              View
            </button>
          </td>
        </tr>
      );
    })}
  </tbody>
</table>
      </div>

     

{/* MODAL */}
{/* ✅ ONLY IMPROVED MODAL UI */}
{preview && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              background: "#fff",
              width: "100%",
              maxWidth: 600,
              maxHeight: "85vh",
              overflowY: "auto",
              borderRadius: 14,
              padding: 20,
              boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            }}
          >
            <h3 style={{ marginBottom: 15 }}>Customer Details</h3>

            <div style={{ display: "grid", gap: 10 }}>
              {Object.entries(preview).map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    borderBottom: "1px solid #eee",
                    paddingBottom: 6,
                  }}
                >
                  <strong style={{ color: "#333" }}>{k}</strong>
                  <span style={{ color: "#555", textAlign: "right" }}>
                    {String(v)}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={() => setPreview(null)}
              style={{
                marginTop: 15,
                width: "100%",
                padding: 10,
                borderRadius: 10,
                border: "none",
                background: "#111",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}