declare const sandboxOwnerBrand: unique symbol;

export type SandboxOwner = string & { readonly [sandboxOwnerBrand]: true };

export function parseSandboxOwner(value: string): SandboxOwner;
export function ownerFromEnv(env?: Record<string, string | undefined>): SandboxOwner | undefined;
export function sandboxOwner(): SandboxOwner;
export function sandboxLabels(owner: SandboxOwner): Record<string, string>;
export function ownedSandboxFilter(owner: SandboxOwner): { label: string[] };
export function ownedSandboxFilterArgs(owner: SandboxOwner): string[];
export function allSandboxesFilter(): { label: string[] };
