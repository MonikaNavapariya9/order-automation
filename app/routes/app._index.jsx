import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { sendDraftCheckoutEmail } from "../services/email.server";

const DEFAULT_DATA_URL = "https://dashcharger.webrootinfosoft.com/get-data.php";

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

/**
 * Shopify Admin API expects E.164. Invalid / local-only numbers are omitted (customer still created).
 * Set PHONE_DEFAULT_COUNTRY_CODE in env (digits only, e.g. 91 for India, 1 for US).
 */
function normalizePhoneForShopify(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const defaultCc = (process.env.PHONE_DEFAULT_COUNTRY_CODE || "91").replace(
    /\D/g,
    "",
  );

  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/\D/g, "");
    if (d.length >= 8 && d.length <= 15) return `+${d}`;
    return null;
  }

  const digits = s.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 10 && defaultCc) {
    return `+${defaultCc}${digits}`;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

function normText(s) {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * Reuse an existing open draft for the same customer + product line (no duplicate drafts).
 */
async function findExistingMatchingDraft(admin, customerGid, productTitle, quantity) {
  const customerNumericId = customerGid?.split("/").pop();
  if (!customerNumericId) return null;

  const wantTitle = normText(productTitle || "Order item");
  const wantQty = Number(quantity) || 1;

  const listRes = await admin.graphql(
    `#graphql
    query DraftOrdersByCustomer($q: String!) {
      draftOrders(first: 30, query: $q, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            invoiceUrl
            status
            lineItems(first: 30) {
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
    { variables: { q: `customer_id:${customerNumericId}` } },
  );

  const parsed = await listRes.json();
  if (parsed.errors?.length) return null;

  const edges = parsed.data?.draftOrders?.edges ?? [];

  for (const { node: draft } of edges) {
    if (draft.status !== "OPEN" && draft.status !== "INVOICE_SENT") continue;

    const lines = draft.lineItems?.edges ?? [];
    for (const { node: line } of lines) {
      const lineQty = Number(line.quantity);
      if (normText(line.title) === wantTitle && lineQty === wantQty) {
        return draft;
      }
    }
  }

  return null;
}

/** Pull open / invoice-sent drafts for matching rows on initial load. */
async function fetchOpenDraftOrdersForHydration(admin) {
  const drafts = [];
  let cursor = null;
  const maxPages = 20;

  for (let page = 0; page < maxPages; page++) {
    const res = await admin.graphql(
      `#graphql
      query DraftOrdersHydrate($first: Int!, $after: String) {
        draftOrders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              invoiceUrl
              status
              email
              customer {
                id
                email
              }
              lineItems(first: 50) {
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
      { variables: { first: 100, after: cursor } },
    );

    const json = await res.json();
    if (json.errors?.length) {
      console.warn("DraftOrders hydrate query:", json.errors[0]?.message);
      break;
    }

    const conn = json.data?.draftOrders;
    if (!conn?.edges?.length) break;

    for (const { node } of conn.edges) {
      if (node.status !== "OPEN" && node.status !== "INVOICE_SENT") continue;

      const emails = new Set();
      if (node.email) emails.add(normText(node.email));
      if (node.customer?.email) emails.add(normText(node.customer.email));

      const lineItems = (node.lineItems?.edges ?? []).map(({ node: line }) => ({
        title: line.title,
        quantity: Number(line.quantity),
      }));

      drafts.push({
        id: node.id,
        name: node.name,
        invoiceUrl: node.invoiceUrl,
        emails,
        lineItems,
      });
    }

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return drafts;
}

/**
 * Mark rows approved when an unused open draft matches email + product line + qty.
 * Each draft is used at most once (first matching row wins).
 */
function hydrateRowsWithMatchingDrafts(rows, drafts) {
  const availableIds = new Set(drafts.map((d) => d.id));

  return rows.map((row) => {
    if (row.status === "approved" || row.invoiceUrl) {
      return { ...row };
    }

    const rowEmail = normText(row.email);
    const wantTitle = normText(row.product || "Order item");
    const wantQty = Number.parseInt(String(row.qty ?? "1"), 10) || 1;

    for (const draft of drafts) {
      if (!availableIds.has(draft.id)) continue;

      const emailOk =
        draft.emails.size > 0 && rowEmail.length > 0 && draft.emails.has(rowEmail);
      if (!emailOk) continue;

      const lineMatch = draft.lineItems.some(
        (l) => normText(l.title) === wantTitle && l.quantity === wantQty,
      );
      if (!lineMatch) continue;

      availableIds.delete(draft.id);
      return {
        ...row,
        status: "approved",
        invoiceUrl: draft.invoiceUrl ?? row.invoiceUrl,
        draftOrderName: draft.name ?? row.draftOrderName,
      };
    }

    return { ...row };
  });
}

// ======================
// ✅ LOAD DATA FROM PHP (graceful if offline / SSL / DNS issues)
// ======================
export const loader = async ({ request }) => {
  const url = process.env.CUSTOMER_DATA_URL || DEFAULT_DATA_URL;

  let data = [];
  let loadError = null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        data: [],
        loadError: `Data source returned ${res.status}`,
      };
    }

    const json = await res.json();
    data = normalizeRows(json);
  } catch (error) {
    console.error("Customer data fetch failed:", error?.message || error);
    return {
      data: [],
      loadError:
        error?.name === "AbortError"
          ? "Data source timed out"
          : "Could not load customer data (network error). Check CUSTOMER_DATA_URL or server availability.",
    };
  }

  try {
    const { admin } = await authenticate.admin(request);
    const drafts = await fetchOpenDraftOrdersForHydration(admin);
    data = hydrateRowsWithMatchingDrafts(data, drafts);
  } catch (e) {
    console.warn("Draft status hydrate skipped:", e?.message || e);
  }

  return { data, loadError };
};

// ======================
// ✅ CREATE CUSTOMER + ORDER
// ======================
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json();

  const email = body.email?.trim();
  const name = (body.name || "").trim() || "Customer";
  const product = body.product;
  const qty = Number.parseInt(String(body.qty ?? "1"), 10) || 1;
  const phoneE164 = normalizePhoneForShopify(body.phone);

  if (!email) {
    return { success: false, message: "Email is required" };
  }
  

  try {
    const customerCheckRes = await admin.graphql(
      `#graphql
      query FindCustomerByEmail($q: String!) {
        customers(first: 1, query: $q) {
          edges {
            node {
              id
            }
          }
        }
      }`,
      { variables: { q: `email:${email}` } },
    );

    const customerCheck = await customerCheckRes.json();
    if (customerCheck.errors?.length) {
      return { success: false, message: customerCheck.errors[0].message };
    }

    let customerId =
      customerCheck?.data?.customers?.edges?.[0]?.node?.id || null;

    if (!customerId) {
      const input = { email, firstName: name,tags: ["customer_create","sent_mail"] };
      if (phoneE164) input.phone = phoneE164;

      const createCustomerRes = await admin.graphql(
        `#graphql
        mutation CustomerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { input } },
      );

      const createCustomer = await createCustomerRes.json();
      if (createCustomer.errors?.length) {
        return { success: false, message: createCustomer.errors[0].message };
      }

      const userErrors = createCustomer.data?.customerCreate?.userErrors ?? [];
      if (userErrors.length) {
        return {
          success: false,
          message: userErrors.map((e) => e.message).join("; "),
        };
      }

      customerId = createCustomer.data.customerCreate.customer.id;
    }

    const productTitle = String(product || "Order item").trim();

    const existingDraft = await findExistingMatchingDraft(
      admin,
      customerId,
      productTitle,
      qty,
    );

    if (existingDraft) {
      const invoiceUrl = existingDraft.invoiceUrl ?? null;
      const payload = {
        success: true,
        message: "This order already has a draft — using existing checkout link.",
        draftOrderId: existingDraft.id ?? null,
        draftOrderName: existingDraft.name ?? null,
        invoiceUrl,
        alreadyHadDraft: true,
      };
      if (invoiceUrl) {
        const mail = await sendDraftCheckoutEmail(email, {
          customerName: name,
          invoiceUrl,
          draftOrderName: payload.draftOrderName,
          product: productTitle,
          qty,
        });
        payload.emailSent = mail.ok;
        payload.emailSkipped = Boolean(mail.skipped);
        if (!mail.ok && mail.error) payload.emailError = mail.error;
      }
      return payload;
    }


    

    const draftOrderRes = await admin.graphql(
      `#graphql
      mutation DraftOrderCreate($input: DraftOrderInput!) {
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
                title: productTitle,
                quantity: qty,
                originalUnitPrice: "100",
              },
            ],
          },
        },
      },
    );

    const draftOrder = await draftOrderRes.json();
    if (draftOrder.errors?.length) {
      return { success: false, message: draftOrder.errors[0].message };
    }

    const draftErrors = draftOrder.data?.draftOrderCreate?.userErrors ?? [];
    if (draftErrors.length) {
      return {
        success: false,
        message: draftErrors.map((e) => e.message).join("; "),
      };
    }

    const created = draftOrder.data?.draftOrderCreate?.draftOrder;
    const invoiceUrl = created?.invoiceUrl ?? null;

    const payload = {
      success: true,
      message: "Draft Order Created",
      draftOrderId: created?.id ?? null,
      draftOrderName: created?.name ?? null,
      invoiceUrl,
      alreadyHadDraft: false,
    };

    if (invoiceUrl) {
      const mail = await sendDraftCheckoutEmail(email, {
        customerName: name,
        invoiceUrl,
        draftOrderName: payload.draftOrderName,
        product: productTitle,
        qty,
      });
      payload.emailSent = mail.ok;
      payload.emailSkipped = Boolean(mail.skipped);
      if (!mail.ok && mail.error) payload.emailError = mail.error;
    }

    return payload;
  } catch (error) {
    return {
      success: false,
      message: error.message,
    };
  }
};

// ======================
// ✅ FRONTEND
// ======================
export default function CustomerTable() {
  const { data, loadError } = useLoaderData();
  const fetcher = useFetcher();

  const [tableData, setTableData] = useState(data || []);
  const [previewData, setPreviewData] = useState(null);
  const [lastApprovedRowIndex, setLastApprovedRowIndex] = useState(null);

  // 🔥 APPROVE CLICK (index so duplicate emails update the correct row only)
  const handleApprove = (item, rowIndex) => {
    setLastApprovedRowIndex(rowIndex);
    fetcher.submit(JSON.stringify(item), {
      method: "POST",
      encType: "application/json",
    });
  };

  // ✅ AFTER SUCCESS
  useEffect(() => {
    if (fetcher.data?.success) {
      const {
        invoiceUrl,
        draftOrderName,
        alreadyHadDraft,
        emailSent,
        emailSkipped,
        emailError,
      } = fetcher.data;
      const linkHint = invoiceUrl
        ? `\n\nCheckout: ${invoiceUrl}`
        : "";
      const headline = alreadyHadDraft
        ? "✅ Draft already existed — linked checkout"
        : "✅ Draft order created";
      let emailHint = "";
      if (emailSent) {
        emailHint = "\n\n📧 Checkout link emailed to the customer.";
      } else if (emailSkipped) {
        emailHint =
          "\n\n📧 Email not sent: add RESEND_API_KEY + EMAIL_FROM, or EMAIL_WEBHOOK_URL in .env";
      } else if (emailError) {
        emailHint = `\n\n📧 Email failed: ${emailError}`;
      }
      alert(
        `${headline}${draftOrderName ? ` (${draftOrderName})` : ""}.${linkHint}${emailHint}`,
      );

      setTableData((prev) =>
        prev.map((d, i) =>
          i === lastApprovedRowIndex
            ? {
                ...d,
                status: "approved",
                invoiceUrl: invoiceUrl ?? d.invoiceUrl,
                draftOrderName: draftOrderName ?? d.draftOrderName,
              }
            : d,
        ),
      );
    }

    if (fetcher.data?.success === false) {
      alert("❌ " + fetcher.data.message);
    }
  }, [fetcher.data, lastApprovedRowIndex]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Customer Orders</h2>

      {loadError ? (
        <p style={{ color: "#b42318", marginBottom: 16 }} role="alert">
          {loadError}
        </p>
      ) : null}

      <table border="1" width="100%" cellPadding="10">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Product</th>
            <th>Qty</th>
            <th>Status</th>
            <th>Draft checkout</th>
            <th>Action</th>
            <th>View</th>
          </tr>
        </thead>

        <tbody>
          {tableData.map((item, index) => {
            const isDone =
              item.status === "approved" || Boolean(item.invoiceUrl);

            return (
            <tr key={`row-${index}-${item.email ?? ""}-${item.phone ?? ""}-${item.product ?? ""}`}>
              <td>{item.email}</td>
              <td>{item.name}</td>
              <td>{item.phone}</td>
              <td>{item.product}</td>
              <td>{item.qty}</td>

              <td>
                {isDone ? "✅ Approved" : "Pending"}
              </td>

              <td>
                {item.invoiceUrl ? (
                  <a
                    href={item.invoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open link
                  </a>
                ) : (
                  "—"
                )}
              </td>

              <td>
                <button
                  onClick={() => handleApprove(item, index)}
                  disabled={isDone}
                >
                  {isDone ? "Approved" : "Approve"}
                </button>
              </td>

              <td>
                <button onClick={() => setPreviewData(item)}>
                  View
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>

      {/* MODAL */}
      {previewData && (
        <div style={{
          position: "fixed",
          top: 0, left: 0,
          width: "100%", height: "100%",
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center"
        }}>
          <div style={{
            background: "#fff",
            padding: 20,
            borderRadius: 10
          }}>
            <h3>Details</h3>
            {Object.entries(previewData).map(([k, v]) => (
              <p key={k}><b>{k}:</b> {v}</p>
            ))}
            <button onClick={() => setPreviewData(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}