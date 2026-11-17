import { getAdminPrincipal } from "./principal";
import {
  downloadAdminBackup,
  restoreAdminBackup,
} from "./backup";
import {
  deleteAdminCartridge,
  getAdminCartridge,
  getAdminModerationCartridge,
  listAdminCartridges,
  listAdminModerationInventory,
  moderateAdminCartridge,
  updateAdminCartridge,
} from "./catalog";
import {
  createAdminGroup,
  deleteAdminGroup,
  getAdminRoles,
  listAdminGroups,
  renameAdminGroup,
} from "./groups";
import { getAdminAuditEvent, listAdminAudit } from "./audit";
import {
  getAdminSettings,
  deleteAdminAsset,
  sendAdminSmtpTestMessage,
  testAdminSmtpConnection,
  updateAdminSettings,
  uploadAdminAsset,
} from "./settings";
import { revokeAdminToken, listAdminTokens } from "./tokens";
import {
  createAdminUser,
  deleteAdminUser,
  getAdminUser,
  listAdminUsers,
  replaceAdminUserGroups,
  setAdminUserRole,
  setAdminUserStatus,
  updateAdminUser,
} from "./users";

export * from "./backup";
export * from "./catalog";
export * from "./groups";
export * from "./audit";
export * from "./settings";
export * from "./tokens";
export * from "./transport";
export * from "./types";
export * from "./users";

/** Stable domain facade used by administration workspaces and hooks. */
export const adminApi = {
  getPrincipal: getAdminPrincipal,
  getSettings: getAdminSettings,
  updateSettings: updateAdminSettings,
  testSmtpConnection: testAdminSmtpConnection,
  sendSmtpTestMessage: sendAdminSmtpTestMessage,
  uploadAsset: uploadAdminAsset,
  deleteAsset: deleteAdminAsset,
  listUsers: listAdminUsers,
  getUser: getAdminUser,
  createUser: createAdminUser,
  updateUser: updateAdminUser,
  setUserStatus: setAdminUserStatus,
  setUserRole: setAdminUserRole,
  replaceUserGroups: replaceAdminUserGroups,
  deleteUser: deleteAdminUser,
  listGroups: listAdminGroups,
  createGroup: createAdminGroup,
  renameGroup: renameAdminGroup,
  deleteGroup: deleteAdminGroup,
  getRoles: getAdminRoles,
  listTokens: listAdminTokens,
  revokeToken: revokeAdminToken,
  listCartridges: listAdminCartridges,
  listModerationInventory: listAdminModerationInventory,
  getCartridge: getAdminCartridge,
  getModerationCartridge: getAdminModerationCartridge,
  updateCartridge: updateAdminCartridge,
  deleteCartridge: deleteAdminCartridge,
  moderateCartridge: moderateAdminCartridge,
  listAudit: listAdminAudit,
  getAuditEvent: getAdminAuditEvent,
  downloadBackup: downloadAdminBackup,
  restoreBackup: restoreAdminBackup,
};
