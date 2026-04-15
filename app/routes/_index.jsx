import { redirect } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return redirect("/auth/login");
  }

  return redirect(`/auth/login?shop=${shop}`);
};

export default function Index() {
  return null;
}
