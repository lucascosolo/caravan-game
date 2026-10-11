import { APP_DB_ROLE, APP_DB_ROLE_DEFAULT_PASSWORD, testDatabaseUrl } from "../src/config.js";

/** The test database URL, with a guard against pointing the destructive suite at dev data. */
export function resolveTestDatabaseUrl(): string {
  const url = testDatabaseUrl();
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run tests against '${url}': TEST_DATABASE_URL must name a database containing 'test'`);
  }
  return url;
}

/**
 * The same database, connected as the app role that db/roles.sql creates. Override the
 * password with TEST_APP_DB_PASSWORD if the local role was given a different one.
 */
export function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_DB_ROLE;
  url.password = process.env["TEST_APP_DB_PASSWORD"] ?? APP_DB_ROLE_DEFAULT_PASSWORD;
  return url.toString();
}
