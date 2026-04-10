/**
 * Sends draft checkout link to the customer.
 *
 * Configure one of:
 * - RESEND_API_KEY + EMAIL_FROM (https://resend.com)
 * - EMAIL_WEBHOOK_URL (POST JSON to your own endpoint / PHP mailer)
 */

function buildCheckoutEmailHtml({ customerName, invoiceUrl, draftName, product, qty }) {
  const safeName = customerName || "there";
  return `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
  <p>Hi ${escapeHtml(safeName)},</p>
  <p>Your order is ready for payment. Use the secure checkout link below:</p>
  <p><a href="${escapeHtml(invoiceUrl)}" style="color: #2563eb;">Complete checkout</a></p>
  <p style="word-break: break-all; font-size: 14px; color: #444;">${escapeHtml(invoiceUrl)}</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
  <p style="font-size: 14px; color: #666;">
    ${draftName ? `Draft: ${escapeHtml(draftName)}<br/>` : ""}
    ${product ? `Item: ${escapeHtml(String(product))} × ${escapeHtml(String(qty))}` : ""}
  </p>
</body>
</html>
`.trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @returns {{ ok: boolean, skipped?: boolean, error?: string }}
 */
export async function sendDraftCheckoutEmail(to, opts) {
  const {
    customerName,
    invoiceUrl,
    draftName,
    product,
    qty,
  } = opts;

  if (!to?.trim() || !invoiceUrl?.trim()) {
    return { ok: false, error: "Missing email or checkout URL" };
  }

  const subject =
    process.env.DRAFT_CHECKOUT_EMAIL_SUBJECT ||
    "Complete your order — checkout link";
  const html = buildCheckoutEmailHtml({
    customerName,
    invoiceUrl,
    draftName,
    product,
    qty,
  });

  const webhookUrl = process.env.EMAIL_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    try {
      const headers = { "Content-Type": "application/json" };
      const secret = process.env.EMAIL_WEBHOOK_SECRET?.trim();
      if (secret) headers["X-Webhook-Secret"] = secret;

      const res = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          to: to.trim(),
          subject,
          html,
          customerName,
          invoiceUrl,
          draftName,
          product,
          qty,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: `Webhook failed (${res.status}): ${text.slice(0, 200)}`,
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || "Webhook request failed" };
    }
  }

  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey) {
    const from =
      process.env.EMAIL_FROM?.trim() || "onboarding@resend.dev";

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to.trim()],
          subject,
          html,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: data?.message || `Resend error (${res.status})`,
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || "Resend request failed" };
    }
  }

  console.warn(
    "[email] No RESEND_API_KEY or EMAIL_WEBHOOK_URL — draft checkout email not sent",
    { to: to.trim() },
  );
  return { ok: false, skipped: true };
}

/** Legacy helper */
export async function sendEmail(to, { subject, body }) {
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, html: `<p>${escapeHtml(body)}</p>` }),
    }).catch(() => {});
    return { ok: true };
  }
  console.log("sendEmail", { to, subject, body });
  return { ok: true };
}
