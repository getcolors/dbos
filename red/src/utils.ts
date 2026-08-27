// Bump on any change a launcher pinned to an older commit could not survive.
export const contract = 1;

// The registrable domain of a host: its last two labels, the port of
// io.github.getcolors.dbos.utils/registrable-domain.
export function registrableDomain(host: unknown): string {
  return String(host ?? "").split(".").slice(-2).join(".");
}

// Jinja expression resolving a secret under the one parameter namespace every
// colour shares; identical bytes in green, red, and blue.
export function parLookup(key: string): string {
  return `{{ lookup('env','COLORS_PAR_${key.toUpperCase().replaceAll("-", "_")}') }}`;
}
