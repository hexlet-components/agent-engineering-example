export function localApiBase() {
  const port = Number(process.env.LOCAL_MODEL_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("LOCAL_MODEL_PORT must be between 1 and 65535");
  }
  return `http://127.0.0.1:${port}/v1`;
}

export function localModelName() {
  return process.env.LOCAL_MODEL || "default_model";
}
