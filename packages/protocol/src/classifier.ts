import type { ActionFamily } from "@snapmeter/contracts";

export const SNAPCHAIN_UPSTREAM_SHA = "6152402aea2dbe732fb73076f674b038bfd4aee5";
export const HYPERSNAP_UPSTREAM_SHA = "2eee4c9f2a7833ce7971dfef028480abbe9c4720";
export const HYPERSNAP_PUBLIC_COMPAT_SHA = "ce408646fd09d886f275b74757341a1d328728ab";
export const HYPERSNAP_CLASSIFIER_VERSION = `${HYPERSNAP_UPSTREAM_SHA.slice(0, 12)}.1`;

export const MESSAGE_TYPES = {
  NONE: 0,
  CAST_ADD: 1,
  CAST_REMOVE: 2,
  REACTION_ADD: 3,
  REACTION_REMOVE: 4,
  LINK_ADD: 5,
  LINK_REMOVE: 6,
  VERIFICATION_ADD_ETH_ADDRESS: 7,
  VERIFICATION_REMOVE: 8,
  USER_DATA_ADD: 11,
  USERNAME_PROOF: 12,
  FRAME_ACTION: 13,
  LINK_COMPACT_STATE: 14,
  LEND_STORAGE: 15,
  KEY_ADD: 16,
  KEY_REMOVE: 17,
  CHANNEL_UPDATE: 18,
  CHANNEL_MEMBER: 19,
  CHANNEL_PIN: 20,
  CHANNEL_MODERATE: 21
} as const;

const NAME_TO_NUMBER = new Map<string, number>(Object.entries(MESSAGE_TYPES).map(([name, value]) => [`MESSAGE_TYPE_${name}`, value]));

const HYPER_ELIGIBLE = new Set<number>([
  MESSAGE_TYPES.CAST_ADD,
  MESSAGE_TYPES.CAST_REMOVE,
  MESSAGE_TYPES.REACTION_ADD,
  MESSAGE_TYPES.REACTION_REMOVE,
  MESSAGE_TYPES.LINK_ADD,
  MESSAGE_TYPES.LINK_REMOVE,
  MESSAGE_TYPES.LINK_COMPACT_STATE,
  MESSAGE_TYPES.USER_DATA_ADD,
  MESSAGE_TYPES.VERIFICATION_ADD_ETH_ADDRESS,
  MESSAGE_TYPES.VERIFICATION_REMOVE,
  MESSAGE_TYPES.USERNAME_PROOF,
  MESSAGE_TYPES.LEND_STORAGE
]);

const SNAPCHAIN_QUALIFYING = new Set<number>([
  ...HYPER_ELIGIBLE,
  MESSAGE_TYPES.FRAME_ACTION,
  MESSAGE_TYPES.KEY_ADD,
  MESSAGE_TYPES.KEY_REMOVE,
  MESSAGE_TYPES.CHANNEL_UPDATE,
  MESSAGE_TYPES.CHANNEL_MEMBER,
  MESSAGE_TYPES.CHANNEL_PIN,
  MESSAGE_TYPES.CHANNEL_MODERATE
]);

export function messageTypeNumber(type: number | string | undefined): number | null {
  if (typeof type === "number" && Number.isInteger(type)) return type;
  if (typeof type === "string") {
    if (/^\d+$/.test(type)) return Number(type);
    return NAME_TO_NUMBER.get(type) ?? null;
  }
  return null;
}

export function isHyperEligible(type: number | string | undefined): boolean {
  const value = messageTypeNumber(type);
  return value !== null && HYPER_ELIGIBLE.has(value);
}

export function isSnapchainQualifying(type: number | string | undefined): boolean {
  const value = messageTypeNumber(type);
  return value !== null && SNAPCHAIN_QUALIFYING.has(value);
}

export function actionFamilyForMessage(type: number | string | undefined): ActionFamily | null {
  const value = messageTypeNumber(type);
  if (value === null || !SNAPCHAIN_QUALIFYING.has(value)) return null;
  if (value === MESSAGE_TYPES.CAST_ADD || value === MESSAGE_TYPES.CAST_REMOVE) return "cast";
  if (value === MESSAGE_TYPES.REACTION_ADD || value === MESSAGE_TYPES.REACTION_REMOVE) return "reaction";
  if (value === MESSAGE_TYPES.LINK_ADD || value === MESSAGE_TYPES.LINK_REMOVE || value === MESSAGE_TYPES.LINK_COMPACT_STATE) return "link";
  if (value === MESSAGE_TYPES.VERIFICATION_ADD_ETH_ADDRESS || value === MESSAGE_TYPES.VERIFICATION_REMOVE) return "verification";
  if (value === MESSAGE_TYPES.USER_DATA_ADD) return "user-data";
  if (value === MESSAGE_TYPES.USERNAME_PROOF) return "username-proof";
  if (value === MESSAGE_TYPES.LEND_STORAGE) return "storage-lending";
  if (value === MESSAGE_TYPES.KEY_ADD || value === MESSAGE_TYPES.KEY_REMOVE) return "key";
  if (value >= MESSAGE_TYPES.CHANNEL_UPDATE && value <= MESSAGE_TYPES.CHANNEL_MODERATE) return "channel";
  if (value === MESSAGE_TYPES.FRAME_ACTION) return "other";
  return null;
}
