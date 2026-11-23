/** A load-balanced RPC may route a pinned read to a node one block behind.
 * Retry the identical read; never fall back to an older block or replay writes. */
export async function retryBlockRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read() }
    catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || !/block (?:is )?out of range/i.test(error.message)) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
}
