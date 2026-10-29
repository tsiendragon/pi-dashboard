/** Preview size caps: above these the dashboard does not render, only offers download. */
export const TEXT_PREVIEW_LIMIT = 50 * 1024 * 1024
export const BINARY_PREVIEW_LIMIT = 50 * 1024 * 1024

export function previewLimitFor(fileType: string): number {
  if (fileType === 'download') return 0
  return fileType === 'text' || fileType === 'html' ? TEXT_PREVIEW_LIMIT : BINARY_PREVIEW_LIMIT
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}
