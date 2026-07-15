import { LoginForm } from "@/components/LoginForm";

// Presenter sign-in. A thin SERVER page so it can (1) read the ?pending= /
// ?error= codes the Google OAuth callback redirects back with, and (2) check
// GOOGLE_CLIENT_ID/SECRET server-side — the client form only learns a boolean,
// never the env values. The interactive form lives in components/LoginForm.
export const dynamic = "force-dynamic"; // env + searchParams per request

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pending = sp.pending === "1";
  const oauthError = typeof sp.error === "string" ? sp.error : null;
  const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return <LoginForm googleConfigured={googleConfigured} pending={pending} oauthError={oauthError} />;
}
