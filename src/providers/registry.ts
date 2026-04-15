import type { Provider } from "./types.ts";
import type { ProviderId } from "@/types.ts";

const providers = new Map<ProviderId, Provider>();

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: ProviderId): Provider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}. Register it first with registerProvider().`);
  }
  return provider;
}

/** Clear all registered providers. Use in test teardown only. @lintignore */
export function clearProviders(): void {
  providers.clear();
}
