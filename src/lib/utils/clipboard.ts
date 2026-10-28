/**
 * Copies text to the clipboard. Inside the Sitecore iframe the Clipboard API requires the
 * "clipboard-write" iframe permission; when it is unavailable this falls back to execCommand.
 * Resolves to false when neither method works, so the caller can report the failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn("Clipboard API unavailable, trying fallback", error);
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch (error) {
    console.warn("Clipboard fallback failed", error);
    return false;
  } finally {
    area.remove();
  }
}
