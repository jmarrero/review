// Who wrote something, when the bot writes as its user account
// (BOT_LOGIN) or as one of its role apps (ROLE_APPS).

import { BOT_LOGIN, ROLE_APPS } from "./config.ts";

type RoleApps = typeof ROLE_APPS;

/** The role of the app whose bot login this is, if it is one of ours. */
export function roleOf(login: string | undefined, apps: RoleApps = ROLE_APPS): string | undefined {
  const l = login?.toLowerCase();
  return l ? apps.find((a) => a.login.toLowerCase() === l)?.role : undefined;
}

/** Whether our automation wrote this: the bot's user account or one of its role apps. */
export function isBot(login: string | undefined, apps: RoleApps = ROLE_APPS): boolean {
  return (!!login && login.toLowerCase() === BOT_LOGIN.toLowerCase()) || roleOf(login, apps) !== undefined;
}

/** A login as the UI shows it: with the role, for one of the role apps. */
export function authorLabel(login: string, apps: RoleApps = ROLE_APPS): string {
  const role = roleOf(login, apps);
  return role ? `${login} (${role})` : login;
}
