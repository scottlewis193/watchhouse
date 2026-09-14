// Metadata can unlock speculative preparation, but callers must await validated
// before exposing any output. Both promises always have rejection handlers.
export function validatedPreparation(inspect) {
  let resolveMetadata, rejectMetadata;
  const metadata = new Promise((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; });
  const validated = Promise.resolve().then(() => inspect(resolveMetadata)).catch(error => { rejectMetadata(error); throw error; });
  void metadata.catch(() => {}); void validated.catch(() => {});
  return { metadata, validated };
}

export function createValidatedPreparationCache() {
  const sources = new WeakMap();
  return {
    get(source, scope, inspect, signal) {
      let variants = sources.get(source);
      if (!variants) { variants = new Map(); sources.set(source, variants); }
      if (variants.get(scope)?.signal?.aborted) variants.delete(scope);
      if (!variants.has(scope)) {
        const entry = { ...validatedPreparation(inspect), signal };
        variants.set(scope, entry);
        void entry.validated.catch(() => { if (variants.get(scope) === entry) variants.delete(scope); });
      }
      return variants.get(scope);
    }
  };
}
