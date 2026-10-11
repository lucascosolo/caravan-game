import { testDatabaseUrl } from "../src/config.js";

/** The test database URL, with a guard against pointing the destructive suite at dev data. */
export function resolveTestDatabaseUrl(): string {
  const url = testDatabaseUrl();
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run tests against '${url}': TEST_DATABASE_URL must name a database containing 'test'`);
  }
  return url;
}
