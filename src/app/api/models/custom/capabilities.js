export async function detectCustomModelCapabilities(model, capabilities = {}, probe) {
  if (capabilities.vision === true) return { ...capabilities, vision: true };
  const detected = await probe(model);
  return { ...capabilities, vision: detected.vision === true || capabilities.vision === true };
}
