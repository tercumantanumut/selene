export async function readAuthResponseError(res: Response) {
  const text = await res.text();
  if (!text) return "";

  try {
    const data = JSON.parse(text) as { error?: unknown };
    return typeof data.error === "string" ? data.error : text;
  } catch {
    return text;
  }
}
