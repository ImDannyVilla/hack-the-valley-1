// Idempotency keys for admin writes: the same action (method + path + payload)
// keeps its key until it is completed, so a retry after a timeout or a double
// click is recognized by the server as the same request, and an edited payload
// gets a new key. Used by sponsorship saves and message drafts.
export function createMutationKeyStore(makeKey = () => crypto.randomUUID()) {
  const pending = new Map();
  const identity = (method, path, payload) => JSON.stringify([method, path, payload]);
  return {
    key(method, path, payload) {
      const name = identity(method, path, payload);
      if (!pending.has(name)) pending.set(name, makeKey());
      return pending.get(name);
    },
    complete(method, path, payload) { pending.delete(identity(method, path, payload)); },
  };
}
