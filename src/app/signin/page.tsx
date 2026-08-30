import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { requestSignIn } from "./actions";
import { SENT_MESSAGE, SignInForm } from "./sign-in-form";

/**
 * The only public page (middleware matcher exclusion). Auth.js redirects land
 * here too: verifyRequest → ?sent=1, every error → ?error=… — the error copy
 * stays generic (one line for all error codes) because the default Auth.js
 * pages are an enumeration oracle and distinct copy would reopen it.
 *
 * Because the page sits outside the matcher, nothing upstream bounces an
 * already-authenticated visitor — so it self-guards below.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  // Deliberately NOT a bare session check. A deactivated user holding a
  // still-valid JWT is bounced here by the (app) layout's `requireRole` —
  // which is what rejects them, on every gated route — so a bare
  // `session → redirect(…)` would ping-pong that user until the browser gives
  // up, locking out exactly the leavers the kill-switch targets.
  //
  // This rationale previously named src/app/page.tsx as the redirector. That
  // was true when `/` lived inside the (app) group; `/` is now the public
  // landing page and redirects nobody. The guard is unchanged and still
  // required — only the mechanism that makes it necessary is named correctly.
  //
  // Status is DB-read for the same reason requireRole reads it, and only when
  // a session exists: the anonymous path (the one exposed to unauthenticated
  // traffic) touches no database.
  const session = await auth();
  if (session?.user?.id) {
    const user = await getDb().user.findUnique({
      where: { id: session.user.id },
      select: { deactivatedAt: true },
    });
    if (user && user.deactivatedAt === null) {
      // /assets, not "/". Since `/` became the public landing page, sending an
      // active signed-in user there drops them on marketing copy after a
      // successful magic link — which reads as "sign-in is broken". The
      // register is where a completed sign-in belongs.
      redirect("/assets");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Asset Register
        </h1>
        <p className="text-muted-foreground text-sm">
          Sign in with your work email.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm">
          That sign-in link is invalid or has expired. Enter your email to
          request a new one.
        </p>
      ) : null}
      {sent ? (
        <p role="status" className="text-muted-foreground text-sm">
          {SENT_MESSAGE}
        </p>
      ) : (
        <SignInForm action={requestSignIn} />
      )}
    </main>
  );
}
