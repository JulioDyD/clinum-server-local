export const SPECIAL_CALL_TYPES = ["type3", "type4", "type5", "type6"];
export function isSpecialCallType(value) {
    return SPECIAL_CALL_TYPES.includes(value);
}
