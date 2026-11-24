/** Catalog change fan-out (ACL caches, gateway tool lists) wired in the composition root. */
export interface CatalogEvents {
  serversChanged(): Promise<void>;
  toolsChanged(): Promise<void>;
}
