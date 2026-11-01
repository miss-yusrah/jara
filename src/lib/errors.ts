/** An error whose message is safe to show to the user. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status })
  console.error(err)
  return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new ApiError('Request body must be a JSON object')
}
