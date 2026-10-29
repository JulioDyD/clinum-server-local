const TACTILE_FIRMWARE_PATTERN = /^(?:T?HLN|T?VLN)-/i;

export function isTactileFirmware(firmwareVersion?: string | null): boolean {
  if (typeof firmwareVersion !== "string") return false;
  return TACTILE_FIRMWARE_PATTERN.test(firmwareVersion.trim());
}
