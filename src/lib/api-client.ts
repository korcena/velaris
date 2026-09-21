"use client";

/**
 * Thin typed fetch helpers used by client components to talk to the Velaris
 * REST API. Errors are normalized into a message string for sonner toasts.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError(0, "Network error — is the server running?");
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const msg =
      (body as { error?: string })?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }

  return body as T;
}
