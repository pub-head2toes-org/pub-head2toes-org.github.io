import { describe, it } from "node:test";
import assert from "node:assert";

function formatFileSize(sizeBytes) {
  if (sizeBytes === 0) {
    return '0B';
  }
  const sizeName = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(sizeBytes) / Math.log(1024));
  const p = Math.pow(1024, i);
  const s = (sizeBytes / p).toFixed(2);
  return `${s} ${sizeName[i]}`;
}

describe("formatFileSize function", () => {
  it('should return "1.00 GB" for sizeBytes = 1073741824', () => {
    assert.strictEqual(formatFileSize(1073741824), "1.00 GB");
  });
});
