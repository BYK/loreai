// Auth logs rejected fetch exceptions before returning them to its caller. Keep
// private transport diagnostics out of the SDK, and never replay credentials on
// redirects. A fixed 499 is nonretryable and contains no upstream error content.
export async function supabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, redirect: "error" });
  } catch {
    return Response.json(
      { msg: "Account service unavailable" },
      { status: 499 },
    );
  }
}
