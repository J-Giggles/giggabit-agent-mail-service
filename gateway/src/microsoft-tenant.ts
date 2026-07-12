const tenantPattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export function microsoftTenant(value: string | undefined): string {
  const tenant = (value ?? "consumers").trim().toLowerCase();
  if (!tenantPattern.test(tenant) || tenant.includes("..")) {
    throw new Error("Microsoft tenant is invalid");
  }
  return tenant;
}

export function microsoftOAuthBase(tenant: string): string {
  return `https://login.microsoftonline.com/${microsoftTenant(tenant)}/oauth2/v2.0`;
}
